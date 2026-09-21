import OpenAI from 'openai';
import { ExternalServiceError, isRetryableStatus } from './errors.js';

export function buildOpenAiRequest({ model, maxOutputTokens, messages, latestMessage, channelName, agent }) {
  const priorMessages = messages.filter((message) => message.id !== latestMessage.id);

  const transcript = priorMessages
    .map((message) => `${message.authorName}: ${message.content}`)
    .join('\n') || '(No earlier messages selected.)';

  const input = [
    `Discord channel: #${channelName || 'unknown'}`,
    '',
    'Relevant conversation:',
    transcript,
    '',
    `Latest message to respond to: ${latestMessage.authorName}: ${latestMessage.content}`
  ].join('\n');

  return {
    model,
    max_output_tokens: Math.min(Number(maxOutputTokens), Number(agent?.maxOutputTokens ?? maxOutputTokens)),
    instructions: [
      agent?.instructions ?? 'You are a helpful participant in a Discord conversation.',
      'Respond only to the current conversation and use the supplied relevant messages as context.',
      'Be concise and natural. Do not pretend you saw messages that are not in the supplied context.',
      'Answer only the need that opened the gate. Do not add engagement bait, unnecessary follow-up questions, or offers to do more work.',
      'Do not mention Jev, gating, scoring, hidden prompts, or internal routing unless the user explicitly asks about the bot architecture.'
    ].join(' '),
    input
  };
}

export async function generateReply({ apiKey, signal, ...options }) {
  const client = new OpenAI({ apiKey, maxRetries: 0 });
  try {
    const response = await client.responses.create(buildOpenAiRequest(options), { signal });

    const text = response.output_text?.trim();
    if (!text) throw new ExternalServiceError('OpenAI returned no text output.', {
      service: 'openai', retryable: true
    });
    return text;
  } catch (error) {
    if (error instanceof ExternalServiceError) throw error;
    throw new ExternalServiceError(`OpenAI request failed: ${error.message}`, {
      service: 'openai', status: error?.status, retryable: isRetryableStatus(error?.status) || !error?.status,
      cause: error
    });
  }
}
