import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGateQuestions, extractChoice, extractJevMetadata, extractNoul } from '../src/shared/jev.js';
import { parseGateDecision, selectContext } from '../src/processor/core.js';

const policy = {
  gateThreshold: 0.58,
  explicitRequestThreshold: 0.85,
  organicMinValue: 0.70,
  organicMinNovelty: 0.65,
  organicMinNeed: 0.55,
  organicMaxIntrusive: 0.40,
  organicMaxResolved: 0.50
};
const cadence = { allowed: true, reason: null, ageSeconds: null };

test('extracts Noul values and common Jev metadata fields', () => {
  const response = { id: 'req-1', model: 'jev-2026-09', answers: { direct_question: { noul: 0.91 } } };
  assert.equal(extractNoul(response, 'direct_question'), 0.91);
  assert.deepEqual(extractJevMetadata(response), { model: 'jev-2026-09', requestId: 'req-1' });
  assert.equal(extractNoul({}, 'missing'), 0);
});

test('builds an atomic agent choice and extracts its probability distribution', () => {
  const question = buildGateQuestions().agent_route;
  assert.equal(question.type, 'choice');
  assert.ok(question.criteria.fact_checker);
  assert.ok(question.criteria.developer_helper);
  assert.ok(question.criteria.no_suitable_agent);

  const response = { answers: { agent_route: {
    choice: 'developer_helper', confidence: 0.8,
    probabilities: { developer_helper: 0.9, generalist: 0.1 }
  } } };
  assert.deepEqual(extractChoice(response, 'agent_route'), response.answers.agent_route);
});

test('creates a complete gate decision from Jev output', () => {
  const response = { answers: {
    explicit_assistant_request: { noul: 0.1 },
    direct_question: { noul: 1 }, assistant_can_add_value: { noul: 1 },
    assistant_has_novel_contribution: { noul: 1 },
    response_would_be_intrusive: { noul: 0 }, conversation_already_resolved: { noul: 0 },
    requires_response: { noul: 1 }
  } };
  const result = parseGateDecision(response, { mentionsBot: false, replyToBot: false, policy, cadence });
  assert.ok(Math.abs(result.gateScore - 0.91) < 1e-9);
  assert.equal(result.shouldRespond, true);
  assert.equal(result.triggerMode, 'organic');
  assert.equal(result.outputs.requiresResponse, 1);
});

test('an explicit mention opens the gate even when organic signals are negative', () => {
  const response = { answers: {
    explicit_assistant_request: { noul: 0 }, direct_question: { noul: 0 },
    assistant_can_add_value: { noul: 0.1 }, assistant_has_novel_contribution: { noul: 0.1 },
    response_would_be_intrusive: { noul: 1 }, conversation_already_resolved: { noul: 1 },
    requires_response: { noul: 0 }
  } };
  const result = parseGateDecision(response, {
    mentionsBot: true,
    replyToBot: false,
    policy,
    cadence: { allowed: false, reason: 'ORGANIC_COOLDOWN', ageSeconds: 10 }
  });
  assert.equal(result.shouldRespond, true);
  assert.equal(result.triggerMode, 'explicit');
  assert.equal(result.suppressionReason, null);
});

test('replying to a stored bot message is an explicit invocation', () => {
  const response = { answers: {
    explicit_assistant_request: { noul: 0 }, direct_question: { noul: 0 },
    assistant_can_add_value: { noul: 0 }, assistant_has_novel_contribution: { noul: 0 },
    response_would_be_intrusive: { noul: 1 }, conversation_already_resolved: { noul: 1 },
    requires_response: { noul: 0 }
  } };
  const result = parseGateDecision(response, { mentionsBot: false, replyToBot: true, policy, cadence });
  assert.equal(result.shouldRespond, true);
  assert.equal(result.triggerMode, 'explicit');
  assert.equal(result.explicitInvocation.replyToBot, true);
});

test('a high-probability direct assistant request opens without a Discord mention', () => {
  const response = { answers: {
    explicit_assistant_request: { noul: 0.9 }, direct_question: { noul: 1 },
    assistant_can_add_value: { noul: 0.2 }, assistant_has_novel_contribution: { noul: 0.2 },
    response_would_be_intrusive: { noul: 0.9 }, conversation_already_resolved: { noul: 0.9 },
    requires_response: { noul: 0.2 }
  } };
  const result = parseGateDecision(response, { mentionsBot: false, replyToBot: false, policy, cadence });
  assert.equal(result.shouldRespond, true);
  assert.equal(result.triggerMode, 'explicit');
  assert.equal(result.explicitInvocation.inferredExplicit, true);
});

test('hard organic vetoes prevent a high weighted score from becoming chatter', () => {
  const response = { answers: {
    explicit_assistant_request: { noul: 0 }, direct_question: { noul: 1 },
    assistant_can_add_value: { noul: 1 }, assistant_has_novel_contribution: { noul: 1 },
    response_would_be_intrusive: { noul: 0.8 }, conversation_already_resolved: { noul: 0 },
    requires_response: { noul: 1 }
  } };
  const result = parseGateDecision(response, { mentionsBot: false, replyToBot: false, policy, cadence });
  assert.equal(result.shouldRespond, false);
  assert.equal(result.suppressionReason, 'TOO_INTRUSIVE');
});

test('selects relevant messages and always includes latest and its reply target without duplicates', () => {
  const messages = [{ id: 'old' }, { id: 'other' }, { id: 'latest', replyToMessageId: 'old' }];
  const response = { answers: { message_0: { noul: 0 }, message_1: { noul: 0.9 } } };
  assert.deepEqual(selectContext(messages, messages[2], response, 0.55).map((message) => message.id),
    ['old', 'other', 'latest']);
});
