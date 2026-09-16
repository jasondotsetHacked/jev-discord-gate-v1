import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const messagePk = (channelId) => `CHANNEL#${channelId}`;
const messageSk = (timestamp, id) => `MSG#${String(timestamp).padStart(13, '0')}#${id}`;
const isConditional = (error) => error?.name === 'ConditionalCheckFailedException';

function updateExpression(patch) {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  return {
    UpdateExpression: `SET ${entries.map(([,], index) => `#n${index} = :v${index}`).join(', ')}`,
    ExpressionAttributeNames: Object.fromEntries(entries.map(([key], index) => [`#n${index}`, key])),
    ExpressionAttributeValues: Object.fromEntries(entries.map(([, value], index) => [`:v${index}`, value]))
  };
}

export function createRepository({ tableName, decisionTableName, messageTtlDays, decisionTtlDays = messageTtlDays }) {
  const ttl = (days) => Math.floor(Date.now() / 1000) + Number(days) * 86400;
  return {
    async storeMessage(message, overrides = {}) {
      await ddb.send(new PutCommand({ TableName: tableName, Item: {
        pk: messagePk(message.channelId), sk: messageSk(message.createdTimestamp, message.id),
        messageLookupId: message.id, entityType: 'message', expiresAt: ttl(messageTtlDays), ...message, ...overrides
      } }));
    },
    async getRecentMessages(channelId, limit) {
      const result = await ddb.send(new QueryCommand({
        TableName: tableName, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': messagePk(channelId), ':prefix': 'MSG#' },
        ScanIndexForward: false, Limit: Number(limit)
      }));
      return (result.Items || []).reverse();
    },
    async getMessageById(messageId) {
      const result = await ddb.send(new QueryCommand({
        TableName: tableName, IndexName: 'MessageIdIndex', KeyConditionExpression: 'messageLookupId = :id',
        ExpressionAttributeValues: { ':id': messageId }, Limit: 1
      }));
      return result.Items?.[0] ?? null;
    },
    async claimDecision(item) {
      try {
        await ddb.send(new PutCommand({
          TableName: decisionTableName, Item: { ...item, expiresAt: ttl(decisionTtlDays) },
          ConditionExpression: 'attribute_not_exists(sourceMessageId)'
        }));
        return { acquired: true, record: item };
      } catch (error) {
        if (!isConditional(error)) throw error;
      }
      const existing = (await ddb.send(new GetCommand({
        TableName: decisionTableName, Key: { sourceMessageId: item.sourceMessageId }, ConsistentRead: true
      }))).Item;
      const nowEpoch = Math.floor(Date.now() / 1000);
      const retryable = existing?.generatedResponseStatus === 'FAILED_RETRYABLE';
      const expired = existing?.generatedResponseStatus === 'PROCESSING' && Number(existing?.leaseExpiresAt || 0) < nowEpoch;
      if (retryable || expired) {
        try {
          await ddb.send(new UpdateCommand({
            TableName: decisionTableName,
            Key: { sourceMessageId: item.sourceMessageId },
            UpdateExpression: 'SET generatedResponseStatus = :processing, processorTimestamp = :timestamp, leaseExpiresAt = :lease REMOVE failure',
            ConditionExpression: 'generatedResponseStatus = :expected AND leaseExpiresAt = :oldLease',
            ExpressionAttributeValues: {
              ':processing': 'PROCESSING', ':timestamp': item.processorTimestamp,
              ':lease': item.leaseExpiresAt, ':oldLease': existing.leaseExpiresAt,
              ':expected': existing.generatedResponseStatus
            }
          }));
          return { acquired: true, record: { ...existing, ...item } };
        } catch (error) {
          if (!isConditional(error)) throw error;
        }
      }
      return { acquired: false, record: existing };
    },
    async updateDecision(sourceMessageId, patch) {
      return ddb.send(new UpdateCommand({
        TableName: decisionTableName, Key: { sourceMessageId }, ...updateExpression(patch), ReturnValues: 'ALL_NEW'
      }));
    },
    async markReplying(sourceMessageId, timestamp, generatedResponseLength) {
      try {
        await ddb.send(new UpdateCommand({
          TableName: decisionTableName, Key: { sourceMessageId },
          UpdateExpression: 'SET generatedResponseStatus = :replying, responseAttemptedAt = :now, generatedResponseLength = :length',
          ConditionExpression: 'generatedResponseStatus = :processing',
          ExpressionAttributeValues: {
            ':replying': 'REPLYING', ':processing': 'PROCESSING', ':now': timestamp,
            ':length': generatedResponseLength
          }
        }));
        return true;
      } catch (error) {
        if (isConditional(error)) return false;
        throw error;
      }
    }
  };
}
