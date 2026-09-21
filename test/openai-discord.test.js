import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenAiRequest } from '../src/shared/openai.js';
import { DISCORD_MESSAGE_LIMIT, fitDiscordMessage } from '../src/shared/discord.js';

test('OpenAI request bounds output and does not duplicate the latest message', () => {
  const latest = { id: '2', authorName: 'B', content: 'latest' };
  const request = buildOpenAiRequest({
    model: 'test-model', maxOutputTokens: 321,
    messages: [{ id: '1', authorName: 'A', content: 'prior' }, latest], latestMessage: latest, channelName: 'chat'
  });
  assert.equal(request.max_output_tokens, 321);
  assert.equal(request.input.match(/B: latest/g)?.length, 1);
  assert.match(request.input, /A: prior/);
});

test('selected agent instructions and its tighter output limit are applied', () => {
  const latest = { id: '2', authorName: 'B', content: 'Is this claim true?' };
  const request = buildOpenAiRequest({
    model: 'test-model', maxOutputTokens: 700, messages: [latest], latestMessage: latest,
    channelName: 'chat', agent: {
      id: 'fact_checker', instructions: 'Act as a careful fact checker.', maxOutputTokens: 500
    }
  });
  assert.equal(request.max_output_tokens, 500);
  assert.match(request.instructions, /careful fact checker/);
  assert.match(request.instructions, /Do not add engagement bait/);
});

test('Discord output is intentionally shortened at a readable boundary', () => {
  const result = fitDiscordMessage(`${'word '.repeat(500)}ending`);
  assert.ok(result.length <= DISCORD_MESSAGE_LIMIT);
  assert.ok(result.endsWith('\n…'));
  assert.equal(fitDiscordMessage('short'), 'short');
});
