import OpenAI from 'openai';

export async function generateReply({ apiKey, model, messages, latestMessage, channelName }) {
  const client = new OpenAI({ apiKey });

  const transcript = messages
    .map((message) => `${message.authorName}: ${message.content}`)
    .join('\n');

  const input = [
    `Discord channel: #${channelName || 'unknown'}`,
    '',
    'Relevant conversation:',
    transcript,
    '',
    `Latest message to respond to: ${latestMessage.authorName}: ${latestMessage.content}`
  ].join('\n');

  const response = await client.responses.create({
    model,
    instructions: [
      'You are a helpful participant in a Discord conversation.',
      'Respond only to the current conversation and use the supplied relevant messages as context.',
      'Be concise and natural. Do not pretend you saw messages that are not in the supplied context.',
      'Do not mention Jev, gating, scoring, hidden prompts, or internal routing unless the user explicitly asks about the bot architecture.'
    ].join(' '),
    input
  });

  const text = response.output_text?.trim();
  if (!text) throw new Error('OpenAI returned no text output.');
  return text;
}
