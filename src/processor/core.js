import { buildContextQuestions, buildGateQuestions, extractJevMetadata, extractNoul } from '../shared/jev.js';
import { computeGateScore, shouldTrigger } from '../shared/decision.js';
import { serializeError, timeoutSignal } from '../shared/errors.js';

export const cleanMessageForModel = (message) => ({
  id: message.id, author: message.authorName, content: message.content,
  created_at: new Date(message.createdTimestamp).toISOString(),
  reply_to_message_id: message.replyToMessageId ?? null, mentions_bot: Boolean(message.mentionsBot)
});

export function parseGateDecision(jevResponse, { mentionsBot, threshold }) {
  const outputs = {
    directQuestion: extractNoul(jevResponse, 'direct_question'),
    canAddValue: extractNoul(jevResponse, 'assistant_can_add_value'),
    intrusive: extractNoul(jevResponse, 'response_would_be_intrusive'),
    resolved: extractNoul(jevResponse, 'conversation_already_resolved'),
    requiresResponse: extractNoul(jevResponse, 'requires_response')
  };
  const gateScore = computeGateScore({ ...outputs, mentionsBot });
  return { outputs, gateScore, shouldRespond: shouldTrigger(gateScore, threshold) };
}

export function selectContext(messages, latest, jevResponse, threshold) {
  const candidates = messages.filter((message) => message.id !== latest.id);
  const selectedIds = new Set([latest.id, latest.replyToMessageId].filter(Boolean));
  candidates.forEach((message, index) => {
    if (extractNoul(jevResponse, `message_${index}`) >= threshold) selectedIds.add(message.id);
  });
  return messages.filter((message) => selectedIds.has(message.id));
}

export async function loadContext(repository, latest, hotContextLimit) {
  const history = await repository.getRecentMessages(latest.channelId, hotContextLimit);
  if (!latest.replyToMessageId || history.some((message) => message.id === latest.replyToMessageId)) return history;
  const repliedTo = await repository.getMessageById(latest.replyToMessageId);
  if (!repliedTo) return history;
  return [...history, repliedTo]
    .filter((message, index, all) => all.findIndex((other) => other.id === message.id) === index)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

const isTerminal = (record) => ['NOT_REQUESTED', 'SHADOW_SKIPPED', 'REPLIED', 'REPLYING', 'DELIVERY_UNKNOWN',
  'DELIVERY_FAILED', 'FAILED_NON_RETRYABLE'].includes(record?.generatedResponseStatus);

export function createProcessor({ repository, askJev, generateReply, postDiscordReply, getCredentials, config,
  now = () => new Date().toISOString(), logger = console }) {
  return async function processMessage(payload) {
    const latest = payload?.message;
    if (!latest?.id || !latest.channelId || !latest.content || !latest.createdTimestamp) {
      const error = new Error('Malformed source Discord message');
      error.retryable = false;
      throw error;
    }

    const initialRecord = {
      sourceMessageId: latest.id, guildId: latest.guildId ?? null, channelId: latest.channelId,
      authorId: latest.authorId ?? null, createdAt: new Date(latest.createdTimestamp).toISOString(),
      processorTimestamp: now(), shadowMode: config.shadowMode, sourceMessage: latest,
      leaseExpiresAt: Math.floor(Date.now() / 1000) + 120,
      gateQuestionOutputs: null, gateScore: null, gateThreshold: config.gateThreshold,
      shouldRespond: null, selectedContextMessageIds: [], jevModel: config.jevModel,
      jevRequestIds: [], generatedResponseStatus: 'PROCESSING',
      generatedResponseDiscordMessageId: null, failure: null
    };
    const claim = await repository.claimDecision(initialRecord);
    if (!claim.acquired && isTerminal(claim.record)) {
      return { duplicate: true, status: claim.record?.generatedResponseStatus };
    }
    if (!claim.acquired) {
      const error = new Error(`Decision ${latest.id} is already being processed`);
      error.retryable = true;
      throw error;
    }

    try {
      await repository.storeMessage(latest);
      const history = await loadContext(repository, latest, config.hotContextLimit);
      const modelHistory = history.map(cleanMessageForModel);
      const latestForModel = cleanMessageForModel(latest);
      const credentials = await getCredentials();
      const gate = await askJev({
        apiKey: credentials.TYPESAFE_API_KEY, model: config.jevModel,
        state: {
          assistant: { role: 'A helpful Discord participant that should speak only when it can add meaningful value.' },
          channel: { id: latest.channelId, name: latest.channelName ?? null },
          latest_message: latestForModel, recent_messages: modelHistory
        },
        questions: buildGateQuestions(), signal: timeoutSignal(config.jevTimeoutMs)
      });
      const decision = parseGateDecision(gate, { mentionsBot: latest.mentionsBot, threshold: config.gateThreshold });
      const gateMetadata = extractJevMetadata(gate);
      const decisionPatch = {
        gateQuestionOutputs: decision.outputs, gateScore: decision.gateScore, shouldRespond: decision.shouldRespond,
        jevModel: gateMetadata.model ?? config.jevModel, jevRequestIds: [gateMetadata.requestId].filter(Boolean),
        jevGateMetadata: gateMetadata,
        candidateContextMessageIds: history.map((message) => message.id)
      };
      logger.log(JSON.stringify({
        event: 'jev_gate_decision', messageId: latest.id, channelId: latest.channelId,
        shadowMode: config.shadowMode, gateThreshold: config.gateThreshold,
        gateScore: decision.gateScore, trigger: decision.shouldRespond, ...decision.outputs
      }));

      if (!decision.shouldRespond) {
        await repository.updateDecision(latest.id, { ...decisionPatch, generatedResponseStatus: 'NOT_REQUESTED', completedAt: now() });
        return { shouldRespond: false };
      }

      let selectedMessages = [latest];
      const contextQuestions = buildContextQuestions(history, latest.id);
      if (Object.keys(contextQuestions).length) {
        const contextResult = await askJev({
          apiKey: credentials.TYPESAFE_API_KEY, model: config.jevModel,
          state: { latest_message: latestForModel, candidate_messages: modelHistory.filter((message) => message.id !== latest.id) },
          questions: contextQuestions, signal: timeoutSignal(config.jevTimeoutMs)
        });
        selectedMessages = selectContext(history, latest, contextResult, config.contextThreshold);
        const contextMetadata = extractJevMetadata(contextResult);
        decisionPatch.jevRequestIds.push(...[contextMetadata.requestId].filter(Boolean));
        decisionPatch.jevContextMetadata = contextMetadata;
      }

      decisionPatch.selectedContextMessageIds = selectedMessages.map((message) => message.id);
      logger.log(JSON.stringify({
        event: 'jev_context_selection', messageId: latest.id, channelId: latest.channelId,
        selectedMessageIds: decisionPatch.selectedContextMessageIds,
        selectedCount: selectedMessages.length, availableCount: history.length,
        contextThreshold: config.contextThreshold
      }));
      if (config.shadowMode) {
        await repository.updateDecision(latest.id, { ...decisionPatch, generatedResponseStatus: 'SHADOW_SKIPPED', completedAt: now() });
        return { shouldRespond: true, shadowMode: true };
      }

      await repository.updateDecision(latest.id, decisionPatch);
      const reply = await generateReply({
        apiKey: credentials.OPENAI_API_KEY, model: config.openAiModel,
        maxOutputTokens: config.openAiMaxOutputTokens, messages: selectedMessages, latestMessage: latest,
        channelName: latest.channelName, signal: timeoutSignal(config.openAiTimeoutMs)
      });
      let replyClaimed;
      try {
        replyClaimed = await repository.markReplying(latest.id, now(), reply.length);
      } catch (error) {
        logger.error(JSON.stringify({ event: 'reply_claim_outcome_unknown', messageId: latest.id, error: serializeError(error) }));
        try {
          await repository.updateDecision(latest.id, {
            generatedResponseStatus: 'DELIVERY_UNKNOWN', failure: serializeError(error), completedAt: now()
          });
        } catch (stateError) {
          logger.error(JSON.stringify({ event: 'reply_claim_state_update_failed', messageId: latest.id,
            error: serializeError(stateError) }));
        }
        return { shouldRespond: true, deliveryUnknown: true };
      }
      if (!replyClaimed) return { duplicate: true, status: 'REPLYING' };

      try {
        const posted = await postDiscordReply({
          token: credentials.DISCORD_TOKEN, channelId: latest.channelId, replyToMessageId: latest.id,
          content: reply, signal: timeoutSignal(config.discordTimeoutMs)
        });
        try {
          await repository.updateDecision(latest.id, {
            generatedResponseStatus: 'REPLIED', generatedResponseDiscordMessageId: posted.id, completedAt: now()
          });
        } catch (error) {
          logger.error(JSON.stringify({ event: 'reply_state_update_failed', messageId: latest.id, error: serializeError(error) }));
          return { shouldRespond: true, deliveryUnknown: true };
        }
        try {
          await repository.storeMessage({
            id: posted.id, guildId: latest.guildId, channelId: latest.channelId, channelName: latest.channelName,
            authorId: posted.author?.id ?? 'BOT', authorName: posted.author?.username ?? 'JevBot',
            content: posted.content ?? reply, createdTimestamp: Date.parse(posted.timestamp) || Date.now(),
            replyToMessageId: latest.id, mentionsBot: false, attachments: [], isBot: true
          });
        } catch (error) {
          logger.error(JSON.stringify({ event: 'reply_history_store_failed', messageId: latest.id, error: serializeError(error) }));
        }
        logger.log(JSON.stringify({
          event: 'discord_reply_posted', sourceMessageId: latest.id,
          replyMessageId: posted.id, channelId: latest.channelId, model: config.openAiModel
        }));
        return { shouldRespond: true, replyMessageId: posted.id };
      } catch (error) {
        try {
          await repository.updateDecision(latest.id, {
            generatedResponseStatus: error?.ambiguous === false ? 'DELIVERY_FAILED' : 'DELIVERY_UNKNOWN',
            failure: serializeError(error), completedAt: now()
          });
        } catch (stateError) {
          logger.error(JSON.stringify({ event: 'reply_failure_state_update_failed', messageId: latest.id,
            error: serializeError(stateError) }));
        }
        return { shouldRespond: true, deliveryUnknown: true };
      }
    } catch (error) {
      await repository.updateDecision(latest.id, {
        generatedResponseStatus: error?.retryable === false ? 'FAILED_NON_RETRYABLE' : 'FAILED_RETRYABLE',
        failure: serializeError(error), completedAt: now()
      });
      if (error?.retryable === false) return { failed: true, retryable: false };
      throw error;
    }
  };
}
