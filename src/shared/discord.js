import { ExternalServiceError, isRetryableStatus } from './errors.js';

export const DISCORD_MESSAGE_LIMIT = 2000;

export function fitDiscordMessage(content, limit = DISCORD_MESSAGE_LIMIT) {
  const text = String(content ?? '').trim();
  if (text.length <= limit) return text;

  const suffix = '\n…';
  const available = limit - suffix.length;
  const candidate = text.slice(0, available + 1);
  const minimumBreak = Math.floor(available * 0.6);
  const breaks = [candidate.lastIndexOf('\n'), candidate.lastIndexOf('. '), candidate.lastIndexOf(' ')];
  const breakpoint = breaks.find((position) => position >= minimumBreak) ?? available;
  return `${candidate.slice(0, breakpoint).trimEnd()}${suffix}`;
}

export async function postDiscordReply({ token, channelId, replyToMessageId, content, signal }) {
  let response;
  try {
    response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: fitDiscordMessage(content),
        message_reference: { message_id: replyToMessageId },
        allowed_mentions: { parse: [], replied_user: false }
      }),
      signal
    });
  } catch (error) {
    throw new ExternalServiceError(`Discord request outcome is unknown: ${error.message}`, {
      service: 'discord', retryable: false, ambiguous: true, cause: error
    });
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ExternalServiceError(`Discord API ${response.status}: ${JSON.stringify(body)}`, {
      service: 'discord', status: response.status, retryable: isRetryableStatus(response.status),
      ambiguous: false
    });
  }
  return body;
}
