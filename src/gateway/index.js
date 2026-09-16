import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const required = ['DISCORD_TOKEN', 'QUEUE_URL'];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const splitIds = (value = '') => new Set(
  value.split(',').map((v) => v.trim()).filter(Boolean)
);

const allowedGuildIds = splitIds(process.env.ALLOWED_GUILD_IDS);
const allowedChannelIds = splitIds(process.env.ALLOWED_CHANNEL_IDS);

const sqs = new SQSClient({
  region: process.env.AWS_REGION_NAME || process.env.AWS_REGION
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const allowed = (message) => {
  if (!message.guildId) return false;
  if (allowedGuildIds.size > 0 && !allowedGuildIds.has(message.guildId)) return false;
  if (allowedChannelIds.size > 0 && !allowedChannelIds.has(message.channelId)) return false;
  return true;
};

client.once('ready', (readyClient) => {
  console.log(JSON.stringify({
    event: 'discord_ready',
    botUserId: readyClient.user.id,
    botName: readyClient.user.tag,
    guildCount: readyClient.guilds.cache.size
  }));
});

client.on('messageCreate', async (message) => {
  try {
    if (!allowed(message)) return;
    if (message.author.bot || message.webhookId) return;
    if (!message.content?.trim()) return;

    const payload = {
      version: 1,
      message: {
        id: message.id,
        guildId: message.guildId,
        channelId: message.channelId,
        channelName: message.channel?.name ?? null,
        authorId: message.author.id,
        authorName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
        content: message.content,
        createdTimestamp: message.createdTimestamp,
        replyToMessageId: message.reference?.messageId ?? null,
        mentionsBot: message.mentions.users.has(client.user.id),
        attachments: [...message.attachments.values()].map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          url: attachment.url,
          contentType: attachment.contentType ?? null
        }))
      }
    };

    await sqs.send(new SendMessageCommand({
      QueueUrl: process.env.QUEUE_URL,
      MessageBody: JSON.stringify(payload),
      MessageGroupId: message.channelId,
      MessageDeduplicationId: message.id
    }));

    console.log(JSON.stringify({
      event: 'message_enqueued',
      messageId: message.id,
      channelId: message.channelId,
      mentionsBot: payload.message.mentionsBot
    }));
  } catch (error) {
    console.error(JSON.stringify({
      event: 'message_enqueue_failed',
      messageId: message.id,
      error: error?.stack ?? String(error)
    }));
  }
});

client.on('error', (error) => {
  console.error(JSON.stringify({ event: 'discord_client_error', error: error?.stack ?? String(error) }));
});

process.on('SIGTERM', async () => {
  console.log(JSON.stringify({ event: 'sigterm' }));
  client.destroy();
  process.exit(0);
});

await client.login(process.env.DISCORD_TOKEN);
