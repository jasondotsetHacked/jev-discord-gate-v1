import { buildContextQuestions, buildGateQuestions, extractChoice, extractJevMetadata, extractNoul } from '../shared/jev.js';
import { computeGateScore, evaluateOrganicCadence, shouldTrigger } from '../shared/decision.js';
import { getAgentDefinition, resolveAgentRoute } from '../shared/agents.js';
import { serializeError, timeoutSignal } from '../shared/errors.js';

export const cleanMessageForModel = (message) => ({
  id: message.id, author: message.authorName, content: message.content,
  created_at: new Date(message.createdTimestamp).toISOString(),
  reply_to_message_id: message.replyToMessageId ?? null, mentions_bot: Boolean(message.mentionsBot)
});

export function parseGateDecision(jevResponse, { mentionsBot, replyToBot, policy, cadence }) {
  const outputs = {
    assistantAddressed: extractNoul(jevResponse, 'explicit_assistant_request'),
    directQuestion: extractNoul(jevResponse, 'direct_question'),
    canAddValue: extractNoul(jevResponse, 'assistant_can_add_value'),
    novelContribution: extractNoul(jevResponse, 'assistant_has_novel_contribution'),
    intrusive: extractNoul(jevResponse, 'response_would_be_intrusive'),
    resolved: extractNoul(jevResponse, 'conversation_already_resolved'),
    requiresResponse: extractNoul(jevResponse, 'requires_response')
  };
  const deterministicExplicit = Boolean(mentionsBot || replyToBot);
  const inferredExplicit = outputs.assistantAddressed >= Number(policy.explicitRequestThreshold);
  const explicit = deterministicExplicit || inferredExplicit;
  const gateScore = computeGateScore(outputs);

  if (explicit) {
    return {
      outputs, gateScore, shouldRespond: true, triggerMode: 'explicit', suppressionReason: null,
      explicitInvocation: { mentionsBot: Boolean(mentionsBot), replyToBot: Boolean(replyToBot), inferredExplicit }
    };
  }

  let suppressionReason = null;
  if (!cadence.allowed) suppressionReason = cadence.reason;
  else if (outputs.intrusive > Number(policy.organicMaxIntrusive)) suppressionReason = 'TOO_INTRUSIVE';
  else if (outputs.resolved > Number(policy.organicMaxResolved)) suppressionReason = 'ALREADY_RESOLVED';
  else if (outputs.canAddValue < Number(policy.organicMinValue)) suppressionReason = 'INSUFFICIENT_VALUE';
  else if (outputs.novelContribution < Number(policy.organicMinNovelty)) suppressionReason = 'NOT_NOVEL';
  else if (Math.max(outputs.directQuestion, outputs.requiresResponse) < Number(policy.organicMinNeed)) {
    suppressionReason = 'INSUFFICIENT_NEED';
  } else if (!shouldTrigger(gateScore, policy.gateThreshold)) suppressionReason = 'BELOW_GATE_THRESHOLD';

  return {
    outputs, gateScore, shouldRespond: suppressionReason === null,
    triggerMode: suppressionReason === null ? 'organic' : null, suppressionReason,
    explicitInvocation: { mentionsBot: false, replyToBot: false, inferredExplicit: false }
  };
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
      shouldRespond: null, triggerMode: null, suppressionReason: null, selectedAgentId: null,
      selectedContextMessageIds: [], jevModel: config.jevModel,
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
      const [history, assistantActivity] = await Promise.all([
        loadContext(repository, latest, config.hotContextLimit),
        repository.getAssistantActivity(latest.channelId)
      ]);
      const modelHistory = history.map(cleanMessageForModel);
      const latestForModel = cleanMessageForModel(latest);
      const replyTarget = latest.replyToMessageId
        ? history.find((message) => message.id === latest.replyToMessageId) : null;
      const replyToBot = Boolean(replyTarget?.isBot);
      const cadence = evaluateOrganicCadence({
        assistantActivity,
        latestTimestamp: latest.createdTimestamp,
        sourceMessageId: latest.id,
        cooldownSeconds: config.organicCooldownSeconds
      });
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
      const decision = parseGateDecision(gate, {
        mentionsBot: latest.mentionsBot,
        replyToBot,
        cadence,
        policy: config
      });
      const route = resolveAgentRoute(extractChoice(gate, 'agent_route'), {
        explicit: decision.triggerMode === 'explicit',
        minProbability: config.agentRouteMinProbability
      });
      let shouldRespond = decision.shouldRespond;
      let suppressionReason = decision.suppressionReason;
      if (shouldRespond && !route.selectedAgentId) {
        shouldRespond = false;
        suppressionReason = route.fallbackReason;
      }
      const gateMetadata = extractJevMetadata(gate);
      const decisionPatch = {
        gateQuestionOutputs: decision.outputs, gateScore: decision.gateScore, shouldRespond,
        triggerMode: shouldRespond ? decision.triggerMode : null,
        suppressionReason,
        explicitInvocation: decision.explicitInvocation,
        organicCadence: cadence,
        selectedAgentId: route.selectedAgentId,
        agentRoute: route,
        jevModel: gateMetadata.model ?? config.jevModel, jevRequestIds: [gateMetadata.requestId].filter(Boolean),
        jevGateMetadata: gateMetadata,
        candidateContextMessageIds: history.map((message) => message.id)
      };
      logger.log(JSON.stringify({
        event: 'jev_gate_decision', messageId: latest.id, channelId: latest.channelId,
        shadowMode: config.shadowMode, gateThreshold: config.gateThreshold,
        gateScore: decision.gateScore, trigger: shouldRespond,
        triggerMode: decisionPatch.triggerMode, suppressionReason,
        selectedAgentId: route.selectedAgentId, ...decision.outputs
      }));

      if (!shouldRespond) {
        await repository.updateDecision(latest.id, { ...decisionPatch, generatedResponseStatus: 'NOT_REQUESTED', completedAt: now() });
        return { shouldRespond: false, suppressionReason };
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
      const assistantActivityRecord = {
        lastAssistantDecisionAt: now(),
        lastAssistantDecisionAtMs: Number(latest.createdTimestamp),
        lastAssistantSourceMessageId: latest.id,
        triggerMode: decision.triggerMode,
        selectedAgentId: route.selectedAgentId,
        shadowMode: config.shadowMode
      };
      if (config.shadowMode) {
        await repository.recordAssistantActivity(latest.channelId, assistantActivityRecord);
        await repository.updateDecision(latest.id, { ...decisionPatch, generatedResponseStatus: 'SHADOW_SKIPPED', completedAt: now() });
        return { shouldRespond: true, shadowMode: true, triggerMode: decision.triggerMode, selectedAgentId: route.selectedAgentId };
      }

      await repository.updateDecision(latest.id, decisionPatch);
      const reply = await generateReply({
        apiKey: credentials.OPENAI_API_KEY, model: config.openAiModel,
        maxOutputTokens: config.openAiMaxOutputTokens, messages: selectedMessages, latestMessage: latest,
        channelName: latest.channelName, agent: getAgentDefinition(route.selectedAgentId),
        signal: timeoutSignal(config.openAiTimeoutMs)
      });
      await repository.recordAssistantActivity(latest.channelId, assistantActivityRecord);
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
          replyMessageId: posted.id, channelId: latest.channelId, model: config.openAiModel,
          triggerMode: decision.triggerMode, selectedAgentId: route.selectedAgentId
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
