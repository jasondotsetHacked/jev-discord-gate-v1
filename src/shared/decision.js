const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

export function computeGateScore({
  directQuestion,
  canAddValue,
  novelContribution,
  requiresResponse,
  assistantAddressed,
  intrusive,
  resolved
}) {
  const score =
    clamp01(directQuestion) * 0.15 +
    clamp01(canAddValue) * 0.30 +
    clamp01(novelContribution) * 0.25 +
    clamp01(requiresResponse) * 0.20 +
    clamp01(assistantAddressed) * 0.10 -
    clamp01(intrusive) * 0.30 -
    clamp01(resolved) * 0.25;

  return clamp01(score);
}

export function shouldTrigger(score, threshold) {
  return Number(score) >= Number(threshold);
}

export function evaluateOrganicCadence({ assistantActivity, latestTimestamp, sourceMessageId, cooldownSeconds }) {
  if (!assistantActivity?.lastAssistantDecisionAtMs) return { allowed: true, reason: null, ageSeconds: null };
  if (sourceMessageId && assistantActivity.lastAssistantSourceMessageId === sourceMessageId) {
    return { allowed: true, reason: null, ageSeconds: 0 };
  }
  const ageSeconds = Math.max(0,
    (Number(latestTimestamp) - Number(assistantActivity.lastAssistantDecisionAtMs)) / 1000);
  if (ageSeconds < Number(cooldownSeconds)) {
    return { allowed: false, reason: 'ORGANIC_COOLDOWN', ageSeconds };
  }
  return { allowed: true, reason: null, ageSeconds };
}
