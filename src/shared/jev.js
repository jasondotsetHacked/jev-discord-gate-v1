import { ExternalServiceError, isRetryableStatus } from './errors.js';

const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';

export async function askJev({ apiKey, model = 'jev-latest', state, questions, signal }) {
  let response;
  try {
    response = await fetch(TYPESAFE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ state, model, questions }),
      signal
    });
  } catch (error) {
    throw new ExternalServiceError(`TypeSafe request failed: ${error.message}`, {
      service: 'jev', retryable: true, cause: error
    });
  }

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    throw new ExternalServiceError(`TypeSafe API ${response.status}: ${JSON.stringify(body)}`, {
      service: 'jev', status: response.status, retryable: isRetryableStatus(response.status)
    });
  }

  return body;
}

export function buildGateQuestions() {
  return {
    direct_question: {
      type: 'noul',
      instructions: 'Does `latest_message` ask a direct or implicit question that an informed assistant could reasonably answer?'
    },
    assistant_can_add_value: {
      type: 'noul',
      instructions: 'Would an informed assistant response materially improve the conversation in `recent_messages` at this moment?'
    },
    response_would_be_intrusive: {
      type: 'noul',
      instructions: 'Would the assistant speaking now likely feel like an unwanted interruption to the human conversation in `recent_messages`?'
    },
    conversation_already_resolved: {
      type: 'noul',
      instructions: 'Has the issue or question relevant to `latest_message` already been adequately resolved in `recent_messages`?'
    },
    requires_response: {
      type: 'noul',
      instructions: 'Would failing to respond to `latest_message` likely leave a useful question, request, or correction unanswered?'
    }
  };
}

export function buildContextQuestions(messages, latestMessageId) {
  const questions = {};

  messages
    .filter((message) => message.id !== latestMessageId)
    .forEach((message, index) => {
      questions[`message_${index}`] = {
        type: 'noul',
        instructions: `Would the message in \`candidate_messages\` whose id is \`${message.id}\` provide useful context for correctly responding to \`latest_message\`? Include it only if it helps interpret the request, preserves relevant conversational continuity, supplies facts needed for an answer, or prevents a misleading response.`
      };
    });

  return questions;
}

export function extractNoul(answer, key) {
  return Number(answer?.answers?.[key]?.noul ?? 0);
}

export function extractJevMetadata(answer) {
  return {
    model: answer?.model ?? answer?.version ?? null,
    requestId: answer?.request_id ?? answer?.requestId ?? answer?.id ?? null
  };
}
