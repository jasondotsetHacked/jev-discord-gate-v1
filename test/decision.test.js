import test from 'node:test';
import assert from 'node:assert/strict';
import { computeGateScore, evaluateOrganicCadence, shouldTrigger } from '../src/shared/decision.js';

test('high-value novel contribution clears a normal threshold', () => {
  const score = computeGateScore({
    assistantAddressed: 0.1,
    directQuestion: 0.95,
    canAddValue: 0.95,
    novelContribution: 0.9,
    requiresResponse: 0.9,
    intrusive: 0.05,
    resolved: 0.05
  });

  assert.ok(score > 0.75);
  assert.equal(shouldTrigger(score, 0.58), true);
});

test('intrusive resolved chatter stays below the threshold', () => {
  const score = computeGateScore({
    assistantAddressed: 0,
    directQuestion: 0.1,
    canAddValue: 0.3,
    novelContribution: 0.1,
    requiresResponse: 0.1,
    intrusive: 0.9,
    resolved: 0.9
  });

  assert.equal(score, 0);
  assert.equal(shouldTrigger(score, 0.58), false);
});

test('organic cadence blocks recent assistant activity and later resets', () => {
  const activity = { lastAssistantDecisionAtMs: 1_000_000 };
  assert.deepEqual(evaluateOrganicCadence({
    assistantActivity: activity,
    latestTimestamp: 1_120_000,
    cooldownSeconds: 180
  }), { allowed: false, reason: 'ORGANIC_COOLDOWN', ageSeconds: 120 });

  assert.deepEqual(evaluateOrganicCadence({
    assistantActivity: activity,
    latestTimestamp: 1_181_000,
    cooldownSeconds: 180
  }), { allowed: true, reason: null, ageSeconds: 181 });
});

test('a retry of the same source message is not suppressed by its activity record', () => {
  const result = evaluateOrganicCadence({
    assistantActivity: { lastAssistantDecisionAtMs: 1_000_000, lastAssistantSourceMessageId: 'same' },
    latestTimestamp: 1_001_000,
    sourceMessageId: 'same',
    cooldownSeconds: 180
  });
  assert.deepEqual(result, { allowed: true, reason: null, ageSeconds: 0 });
});
