import fs from 'node:fs';
import path from 'node:path';
import { PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const DEFAULT_SECRET_ID = 'jev-discord-gate-v1/credentials';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function isPlaceholder(value) {
  return !value || /^(replace-me|your[_-])/i.test(value);
}

function printHelp() {
  console.log(`Upload credentials.json to AWS Secrets Manager.

Usage:
  npm run configure
  npm run configure -- --file ./credentials.json --secret-id jev-discord-gate-v1/credentials

The CDK stack must be deployed once before this command can update its secret.`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const file = path.resolve(option('--file', 'credentials.json'));
  const secretId = option('--secret-id', process.env.JEV_CREDENTIALS_SECRET_ID || DEFAULT_SECRET_ID);
  if (!fs.existsSync(file)) throw new Error(`Credential file not found: ${file}`);

  let input;
  try {
    input = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Credential file is not valid JSON: ${error.message}`);
  }

  for (const key of ['DISCORD_TOKEN', 'TYPESAFE_API_KEY']) {
    if (isPlaceholder(input[key])) throw new Error(`${key} is missing or still contains a placeholder.`);
  }
  if (typeof input.OPENAI_API_KEY !== 'string' || !input.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY must be present. Use "replace-me" while the bot is in shadow mode.');
  }

  const secret = {
    DISCORD_TOKEN: input.DISCORD_TOKEN,
    TYPESAFE_API_KEY: input.TYPESAFE_API_KEY,
    OPENAI_API_KEY: input.OPENAI_API_KEY
  };
  const client = new SecretsManagerClient({});
  await client.send(new PutSecretValueCommand({
    SecretId: secretId,
    SecretString: JSON.stringify(secret)
  }));

  console.log(`Updated AWS secret ${secretId}. No credential values were printed.`);
  if (isPlaceholder(secret.OPENAI_API_KEY)) {
    console.log('OpenAI is still a placeholder. Keep shadowMode=true until you add a real key.');
  }
}

main().catch((error) => {
  console.error(`Configuration failed: ${error.message}`);
  process.exitCode = 1;
});
