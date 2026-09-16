const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

export function computeGateScore({
  directQuestion,
  canAddValue,
  requiresResponse,
  intrusive,
  resolved,
  mentionsBot = false
}) {
  const score =
    clamp01(directQuestion) * 0.30 +
    clamp01(canAddValue) * 0.30 +
    clamp01(requiresResponse) * 0.25 +
    (mentionsBot ? 0.15 : 0) -
    clamp01(intrusive) * 0.25 -
    clamp01(resolved) * 0.20;

  return clamp01(score);
}

export function shouldTrigger(score, threshold) {
  return Number(score) >= Number(threshold);
}
