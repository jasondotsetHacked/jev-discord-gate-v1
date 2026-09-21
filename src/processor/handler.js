import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { askJev } from '../shared/jev.js';
import { generateReply } from '../shared/openai.js';
import { postDiscordReply } from '../shared/discord.js';
import { createProcessor } from './core.js';
import { createRepository } from './repository.js';

const required = ['TABLE_NAME', 'DECISION_TABLE_NAME', 'CREDENTIALS_SECRET_ARN'];
for (const key of required) if (!process.env[key]) throw new Error(`${key} is required.`);

const config = {
  hotContextLimit: Number(process.env.HOT_CONTEXT_LIMIT || 30),
  gateThreshold: Number(process.env.GATE_THRESHOLD || 0.58),
  contextThreshold: Number(process.env.CONTEXT_THRESHOLD || 0.55),
  explicitRequestThreshold: Number(process.env.EXPLICIT_REQUEST_THRESHOLD || 0.85),
  organicMinValue: Number(process.env.ORGANIC_MIN_VALUE || 0.70),
  organicMinNovelty: Number(process.env.ORGANIC_MIN_NOVELTY || 0.65),
  organicMinNeed: Number(process.env.ORGANIC_MIN_NEED || 0.55),
  organicMaxIntrusive: Number(process.env.ORGANIC_MAX_INTRUSIVE || 0.40),
  organicMaxResolved: Number(process.env.ORGANIC_MAX_RESOLVED || 0.50),
  organicCooldownSeconds: Number(process.env.ORGANIC_COOLDOWN_SECONDS || 180),
  agentRouteMinProbability: Number(process.env.AGENT_ROUTE_MIN_PROBABILITY || 0.50),
  shadowMode: String(process.env.SHADOW_MODE || 'true').toLowerCase() !== 'false',
  jevModel: process.env.JEV_MODEL || 'jev-latest',
  openAiModel: process.env.OPENAI_MODEL || 'gpt-5.6-sol',
  openAiMaxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 700),
  jevTimeoutMs: Number(process.env.JEV_TIMEOUT_MS || 15000),
  openAiTimeoutMs: Number(process.env.OPENAI_TIMEOUT_MS || 60000),
  discordTimeoutMs: Number(process.env.DISCORD_TIMEOUT_MS || 10000)
};

const repository = createRepository({
  tableName: process.env.TABLE_NAME,
  decisionTableName: process.env.DECISION_TABLE_NAME,
  messageTtlDays: Number(process.env.MESSAGE_TTL_DAYS || 30),
  decisionTtlDays: Number(process.env.DECISION_TTL_DAYS || 90)
});
const secrets = new SecretsManagerClient({});
let credentialsCache;

async function getCredentials() {
  if (!credentialsCache) {
    const result = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.CREDENTIALS_SECRET_ARN }));
    credentialsCache = JSON.parse(result.SecretString || '{}');
  }
  const keys = ['TYPESAFE_API_KEY', ...(config.shadowMode ? [] : ['OPENAI_API_KEY', 'DISCORD_TOKEN'])];
  for (const key of keys) {
    if (!credentialsCache[key] || credentialsCache[key] === 'replace-me') {
      const error = new Error(`Credential ${key} has not been configured in Secrets Manager.`);
      error.retryable = false;
      throw error;
    }
  }
  return credentialsCache;
}

const processMessage = createProcessor({ repository, askJev, generateReply, postDiscordReply, getCredentials, config });

export async function handler(event) {
  const failures = [];
  for (const record of event?.Records || []) {
    try {
      let payload;
      try {
        payload = JSON.parse(record.body);
      } catch (error) {
        error.retryable = false;
        throw error;
      }
      await processMessage(payload);
    } catch (error) {
      console.error(JSON.stringify({
        event: 'processor_error', messageId: record.messageId, error: error?.stack ?? String(error)
      }));
      if (error?.retryable !== false) failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
