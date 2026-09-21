import test from 'node:test';
import assert from 'node:assert/strict';
import { getAgentDefinition, resolveAgentRoute } from '../src/shared/agents.js';

test('routes a confident choice to one specialist', () => {
  const result = resolveAgentRoute({
    choice: 'developer_helper',
    probabilities: { developer_helper: 0.82, generalist: 0.18 },
    confidence: 0.7
  }, { explicit: false, minProbability: 0.5 });

  assert.equal(result.selectedAgentId, 'developer_helper');
  assert.equal(result.probability, 0.82);
  assert.equal(getAgentDefinition(result.selectedAgentId).name, 'Developer helper');
});

test('organic traffic stays silent when no agent is suitable', () => {
  const result = resolveAgentRoute({
    choice: 'no_suitable_agent',
    probabilities: { no_suitable_agent: 0.9 },
    confidence: 0.9
  }, { explicit: false, minProbability: 0.5 });

  assert.equal(result.selectedAgentId, null);
  assert.equal(result.fallbackReason, 'NO_SUITABLE_AGENT');
});

test('explicit requests fall back to the generalist instead of ignoring the user', () => {
  const result = resolveAgentRoute({
    choice: 'no_suitable_agent',
    probabilities: { no_suitable_agent: 0.9 },
    confidence: 0.9
  }, { explicit: true, minProbability: 0.5 });

  assert.equal(result.selectedAgentId, 'generalist');
  assert.equal(result.fallbackReason, 'EXPLICIT_NO_SUITABLE_AGENT');
});
