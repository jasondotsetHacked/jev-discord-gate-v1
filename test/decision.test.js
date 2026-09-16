import test from 'node:test';
import assert from 'node:assert/strict';
import { computeGateScore, shouldTrigger } from '../src/shared/decision.js';

test('high-value direct question clears a normal threshold', () => {
  const score = computeGateScore({
    directQuestion: 0.95,
    canAddValue: 0.95,
    requiresResponse: 0.9,
    intrusive: 0.05,
    resolved: 0.05,
    mentionsBot: false
  });

  assert.ok(score > 0.7);
  assert.equal(shouldTrigger(score, 0.58), true);
});

test('intrusive resolved chatter stays below the threshold', () => {
  const score = computeGateScore({
    directQuestion: 0.1,
    canAddValue: 0.3,
    requiresResponse: 0.1,
    intrusive: 0.9,
    resolved: 0.9,
    mentionsBot: false
  });

  assert.ok(score < 0.2);
  assert.equal(shouldTrigger(score, 0.58), false);
});

test('mention gives a deterministic boost but does not guarantee a reply', () => {
  const withoutMention = computeGateScore({
    directQuestion: 0.6,
    canAddValue: 0.6,
    requiresResponse: 0.5,
    intrusive: 0.2,
    resolved: 0.1,
    mentionsBot: false
  });

  const withMention = computeGateScore({
    directQuestion: 0.6,
    canAddValue: 0.6,
    requiresResponse: 0.5,
    intrusive: 0.2,
    resolved: 0.1,
    mentionsBot: true
  });

  assert.ok(withMention > withoutMention);
  assert.ok(withMention - withoutMention > 0.14);
});
