import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessor, loadContext } from '../src/processor/core.js';

const latest = {
  id: 'source-1', guildId: 'guild', channelId: 'channel', authorId: 'author', authorName: 'Alice',
  content: 'Can you help?', createdTimestamp: 1_700_000_000_000, replyToMessageId: null, mentionsBot: true
};
const positive = { id: 'jev-req', model: 'jev-test', answers: {
  direct_question: { noul: 1 }, assistant_can_add_value: { noul: 1 }, requires_response: { noul: 1 },
  response_would_be_intrusive: { noul: 0 }, conversation_already_resolved: { noul: 0 }
} };
const config = {
  shadowMode: true, hotContextLimit: 30, gateThreshold: 0.58, contextThreshold: 0.55,
  jevModel: 'jev-test', openAiModel: 'openai-test', openAiMaxOutputTokens: 100,
  jevTimeoutMs: 1000, openAiTimeoutMs: 1000, discordTimeoutMs: 1000
};

function memoryRepository() {
  const decisions = new Map();
  const messages = [];
  return {
    decisions, messages,
    async claimDecision(item) {
      const existing = decisions.get(item.sourceMessageId);
      if (!existing || existing.generatedResponseStatus === 'FAILED_RETRYABLE') {
        decisions.set(item.sourceMessageId, { ...(existing || {}), ...item });
        return { acquired: true, record: item };
      }
      return { acquired: false, record: existing };
    },
    async updateDecision(id, patch) { decisions.set(id, { ...decisions.get(id), ...patch }); },
    async markReplying(id) {
      const record = decisions.get(id);
      if (record.generatedResponseStatus !== 'PROCESSING') return false;
      record.generatedResponseStatus = 'REPLYING';
      return true;
    },
    async storeMessage(message) { messages.push(message); },
    async getRecentMessages() { return [...messages]; },
    async getMessageById() { return null; }
  };
}

function processor(repository, overrides = {}) {
  return createProcessor({
    repository, askJev: async () => positive, generateReply: async () => 'reply',
    postDiscordReply: async () => ({ id: 'reply-1', content: 'reply', timestamp: new Date().toISOString() }),
    getCredentials: async () => ({ TYPESAFE_API_KEY: 'x', OPENAI_API_KEY: 'x', DISCORD_TOKEN: 'x' }),
    config, now: () => '2026-09-16T00:00:00.000Z', logger: { log() {}, error() {} }, ...overrides
  });
}

test('retrieves an older reply target directly and deduplicates it', async () => {
  const target = { id: 'target', createdTimestamp: 1, channelId: 'channel' };
  const current = { ...latest, replyToMessageId: 'target', createdTimestamp: 3 };
  let lookups = 0;
  const repository = {
    async getRecentMessages() { return [current]; },
    async getMessageById(id) { lookups++; assert.equal(id, 'target'); return target; }
  };
  assert.deepEqual((await loadContext(repository, current, 30)).map((message) => message.id), ['target', 'source-1']);
  assert.equal(lookups, 1);
});

test('shadow processing persists one decision and duplicate delivery does no model work', async () => {
  const repository = memoryRepository();
  let calls = 0;
  const process = processor(repository, { askJev: async () => { calls++; return positive; } });
  await process({ message: latest });
  const duplicate = await process({ message: latest });
  assert.equal(calls, 1);
  assert.deepEqual(duplicate, { duplicate: true, status: 'SHADOW_SKIPPED' });
  assert.equal(repository.decisions.size, 1);
  assert.equal(repository.decisions.get(latest.id).generatedResponseStatus, 'SHADOW_SKIPPED');
});

test('retryable pre-delivery failure is recorded, thrown, and can be retried', async () => {
  const repository = memoryRepository();
  let calls = 0;
  const process = processor(repository, { askJev: async () => {
    if (calls++ === 0) { const error = new Error('temporary'); error.retryable = true; throw error; }
    return positive;
  } });
  await assert.rejects(process({ message: latest }), /temporary/);
  assert.equal(repository.decisions.get(latest.id).generatedResponseStatus, 'FAILED_RETRYABLE');
  await process({ message: latest });
  assert.equal(repository.decisions.get(latest.id).generatedResponseStatus, 'SHADOW_SKIPPED');
});

test('malformed source payload is rejected as non-retryable', async () => {
  const error = await processor(memoryRepository())({ message: { id: 'bad' } }).catch((caught) => caught);
  assert.equal(error.retryable, false);
  assert.match(error.message, /Malformed/);
});

test('live duplicate never posts a second Discord reply', async () => {
  const repository = memoryRepository();
  let posts = 0;
  const process = processor(repository, {
    config: { ...config, shadowMode: false },
    postDiscordReply: async () => { posts++; return { id: 'reply-1', content: 'reply', timestamp: new Date().toISOString() }; }
  });
  await process({ message: latest });
  await process({ message: latest });
  assert.equal(posts, 1);
  assert.equal(repository.decisions.get(latest.id).generatedResponseDiscordMessageId, 'reply-1');
});

test('ambiguous Discord failure is terminal and not retried automatically', async () => {
  const repository = memoryRepository();
  let posts = 0;
  const process = processor(repository, {
    config: { ...config, shadowMode: false },
    postDiscordReply: async () => { posts++; throw new Error('connection reset'); }
  });
  assert.equal((await process({ message: latest })).deliveryUnknown, true);
  await process({ message: latest });
  assert.equal(posts, 1);
  assert.equal(repository.decisions.get(latest.id).generatedResponseStatus, 'DELIVERY_UNKNOWN');
});

test('unknown reply-claim outcome never calls Discord or retries the post', async () => {
  const repository = memoryRepository();
  repository.markReplying = async () => { throw new Error('DynamoDB timeout'); };
  let posts = 0;
  const process = processor(repository, {
    config: { ...config, shadowMode: false },
    postDiscordReply: async () => { posts++; }
  });
  assert.equal((await process({ message: latest })).deliveryUnknown, true);
  await process({ message: latest });
  assert.equal(posts, 0);
});
