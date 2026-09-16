import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { askJev, buildContextQuestions, buildGateQuestions, extractNoul } from '../shared/jev.js';
import { computeGateScore, shouldTrigger } from '../shared/decision.js';
import { generateReply } from '../shared/openai.js';

const TABLE_NAME = process.env.TABLE_NAME;
const HOT_CONTEXT_LIMIT = Number(process.env.HOT_CONTEXT_LIMIT || 30);
const GATE_THRESHOLD = Number(process.env.GATE_THRESHOLD || 0.58);
const CONTEXT_THRESHOLD = Number(process.env.CONTEXT_THRESHOLD || 0.55);
const MESSAGE_TTL_DAYS = Number(process.env.MESSAGE_TTL_DAYS || 30);
const SHADOW_MODE = String(process.env.SHADOW_MODE || 'true').toLowerCase() !== 'false';
const JEV_MODEL = process.env.JEV_MODEL || 'jev-latest';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-sol';

if (!TABLE_NAME) throw new Error('TABLE_NAME is required.');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true }
});
const secrets = new SecretsManagerClient({});
let credentialsCache = null;

const ttlFromNow = () => Math.floor(Date.now() / 1000) + MESSAGE_TTL_DAYS * 86400;
const messagePk = (channelId) => `CHANNEL#${channelId}`;
const messageSk = (timestamp, id) => `MSG#${String(timestamp).padStart(13, '0')}#${id}`;

async function getCredentials() {
  if (credentialsCache) return credentialsCache;

  const arn = process.env.CREDENTIALS_SECRET_ARN;
  if (!arn) throw new Error('CREDENTIALS_SECRET_ARN is missing.');

  const result = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!result.SecretString) throw new Error(`Secret ${arn} has no SecretString.`);

  credentialsCache = JSON.parse(result.SecretString);
  return credentialsCache;
}

function requireCredential(credentials, key) {
  const value = credentials?.[key];
  if (!value || value === 'replace-me') {
    throw new Error(`Credential ${key} has not been configured in Secrets Manager.`);
  }
  return value;
}

function cleanMessageForModel(message) {
  return {
    id: message.id,
    author: message.authorName,
    content: message.content,
    created_at: new Date(message.createdTimestamp).toISOString(),
    reply_to_message_id: message.replyToMessageId ?? null,
    mentions_bot: Boolean(message.mentionsBot)
  };
}

async function storeMessage(message, overrides = {}) {
  const item = {
    pk: messagePk(message.channelId),
    sk: messageSk(message.createdTimestamp, message.id),
    entityType: 'message',
    expiresAt: ttlFromNow(),
    ...message,
    ...overrides
  };

  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
}

async function getRecentMessages(channelId) {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': messagePk(channelId),
      ':prefix': 'MSG#'
    },
    ScanIndexForward: false,
    Limit: HOT_CONTEXT_LIMIT
  }));

  return (result.Items || []).reverse();
}

function gateValues(jevResponse) {
  return {
    directQuestion: extractNoul(jevResponse, 'direct_question'),
    canAddValue: extractNoul(jevResponse, 'assistant_can_add_value'),
    intrusive: extractNoul(jevResponse, 'response_would_be_intrusive'),
    resolved: extractNoul(jevResponse, 'conversation_already_resolved'),
    requiresResponse: extractNoul(jevResponse, 'requires_response')
  };
}

function selectedContextFromJev(messages, latest, jevResponse) {
  const candidates = messages.filter((message) => message.id !== latest.id);
  const selectedIds = new Set([latest.id]);

  candidates.forEach((message, index) => {
    const score = Number(jevResponse?.answers?.[`message_${index}`]?.noul ?? 0);
    if (score >= CONTEXT_THRESHOLD) selectedIds.add(message.id);
  });

  // A direct Discord reply is strong deterministic context even if Jev scores it low.
  if (latest.replyToMessageId) selectedIds.add(latest.replyToMessageId);

  return messages.filter((message) => selectedIds.has(message.id));
}

async function postDiscordReply({ token, channelId, replyToMessageId, content }) {
  const clipped = content.length > 1950 ? `${content.slice(0, 1947)}...` : content;
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      content: clipped,
      message_reference: { message_id: replyToMessageId },
      allowed_mentions: { parse: [], replied_user: false }
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Discord API ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function processMessage(payload) {
  const latest = payload?.message;
  if (!latest?.id || !latest.channelId || !latest.content) {
    throw new Error(`Invalid queue payload: ${JSON.stringify(payload)}`);
  }

  await storeMessage(latest);
  const history = await getRecentMessages(latest.channelId);
  const modelHistory = history.map(cleanMessageForModel);
  const latestForModel = cleanMessageForModel(latest);

  const credentials = await getCredentials();
  const typeSafeApiKey = requireCredential(credentials, 'TYPESAFE_API_KEY');

  const gateState = {
    assistant: {
      role: 'A helpful Discord participant that should speak only when it can add meaningful value.'
    },
    channel: {
      id: latest.channelId,
      name: latest.channelName ?? null
    },
    latest_message: latestForModel,
    recent_messages: modelHistory
  };

  const gate = await askJev({
    apiKey: typeSafeApiKey,
    model: JEV_MODEL,
    state: gateState,
    questions: buildGateQuestions()
  });

  const values = gateValues(gate);
  const gateScore = computeGateScore({ ...values, mentionsBot: latest.mentionsBot });
  const trigger = shouldTrigger(gateScore, GATE_THRESHOLD);

  console.log(JSON.stringify({
    event: 'jev_gate_decision',
    messageId: latest.id,
    channelId: latest.channelId,
    shadowMode: SHADOW_MODE,
    gateThreshold: GATE_THRESHOLD,
    gateScore,
    trigger,
    mentionsBot: Boolean(latest.mentionsBot),
    ...values
  }));

  if (!trigger) return;

  let selectedMessages = [latest];
  const contextQuestions = buildContextQuestions(history, latest.id);

  if (Object.keys(contextQuestions).length > 0) {
    const contextState = {
      latest_message: latestForModel,
      candidate_messages: modelHistory.filter((message) => message.id !== latest.id)
    };

    const contextResult = await askJev({
      apiKey: typeSafeApiKey,
      model: JEV_MODEL,
      state: contextState,
      questions: contextQuestions
    });

    selectedMessages = selectedContextFromJev(history, latest, contextResult);
  }

  console.log(JSON.stringify({
    event: 'jev_context_selection',
    messageId: latest.id,
    channelId: latest.channelId,
    selectedMessageIds: selectedMessages.map((message) => message.id),
    selectedCount: selectedMessages.length,
    availableCount: history.length,
    contextThreshold: CONTEXT_THRESHOLD
  }));

  if (SHADOW_MODE) return;

  const openAiApiKey = requireCredential(credentials, 'OPENAI_API_KEY');
  const discordToken = requireCredential(credentials, 'DISCORD_TOKEN');

  const reply = await generateReply({
    apiKey: openAiApiKey,
    model: OPENAI_MODEL,
    messages: selectedMessages,
    latestMessage: latest,
    channelName: latest.channelName
  });

  const posted = await postDiscordReply({
    token: discordToken,
    channelId: latest.channelId,
    replyToMessageId: latest.id,
    content: reply
  });

  await storeMessage({
    id: posted.id,
    guildId: latest.guildId,
    channelId: latest.channelId,
    channelName: latest.channelName,
    authorId: posted.author?.id ?? 'BOT',
    authorName: posted.author?.username ?? 'JevBot',
    content: posted.content ?? reply,
    createdTimestamp: Date.parse(posted.timestamp) || Date.now(),
    replyToMessageId: latest.id,
    mentionsBot: false,
    attachments: [],
    isBot: true
  });

  console.log(JSON.stringify({
    event: 'discord_reply_posted',
    sourceMessageId: latest.id,
    replyMessageId: posted.id,
    channelId: latest.channelId,
    model: OPENAI_MODEL
  }));
}

export async function handler(event) {
  const failures = [];

  for (const record of event.Records || []) {
    try {
      await processMessage(JSON.parse(record.body));
    } catch (error) {
      console.error(JSON.stringify({
        event: 'processor_error',
        messageId: record.messageId,
        error: error?.stack ?? String(error)
      }));
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}
