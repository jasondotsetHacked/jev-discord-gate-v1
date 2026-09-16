import test from 'node:test';
import assert from 'node:assert/strict';

test('malformed SQS JSON is classified as non-retryable and acknowledged', async () => {
  process.env.TABLE_NAME = 'messages';
  process.env.DECISION_TABLE_NAME = 'decisions';
  process.env.CREDENTIALS_SECRET_ARN = 'secret';
  const { handler } = await import('../src/processor/handler.js');
  const result = await handler({ Records: [{ messageId: 'sqs-1', body: '{bad json' }] });
  assert.deepEqual(result, { batchItemFailures: [] });
});
