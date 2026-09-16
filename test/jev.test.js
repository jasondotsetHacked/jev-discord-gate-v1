import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJevMetadata, extractNoul } from '../src/shared/jev.js';
import { parseGateDecision, selectContext } from '../src/processor/core.js';

test('extracts Noul values and common Jev metadata fields', () => {
  const response = { id: 'req-1', model: 'jev-2026-09', answers: { direct_question: { noul: 0.91 } } };
  assert.equal(extractNoul(response, 'direct_question'), 0.91);
  assert.deepEqual(extractJevMetadata(response), { model: 'jev-2026-09', requestId: 'req-1' });
  assert.equal(extractNoul({}, 'missing'), 0);
});

test('creates a complete gate decision from Jev output', () => {
  const response = { answers: {
    direct_question: { noul: 1 }, assistant_can_add_value: { noul: 1 },
    response_would_be_intrusive: { noul: 0 }, conversation_already_resolved: { noul: 0 },
    requires_response: { noul: 1 }
  } };
  const result = parseGateDecision(response, { mentionsBot: false, threshold: 0.58 });
  assert.equal(result.gateScore, 0.85);
  assert.equal(result.shouldRespond, true);
  assert.equal(result.outputs.requiresResponse, 1);
});

test('selects relevant messages and always includes latest and its reply target without duplicates', () => {
  const messages = [{ id: 'old' }, { id: 'other' }, { id: 'latest', replyToMessageId: 'old' }];
  const response = { answers: { message_0: { noul: 0 }, message_1: { noul: 0.9 } } };
  assert.deepEqual(selectContext(messages, messages[2], response, 0.55).map((message) => message.id),
    ['old', 'other', 'latest']);
});
