export const DEFAULT_AGENT_ID = 'generalist';
export const NO_SUITABLE_AGENT_ID = 'no_suitable_agent';

export const AGENT_DEFINITIONS = Object.freeze({
  fact_checker: Object.freeze({
    id: 'fact_checker',
    name: 'Fact checker',
    routingCriteria: 'The response should verify or challenge a factual claim, distinguish evidence from inference, or identify what cannot be verified from the supplied context.',
    instructions: [
      'Act as a careful fact checker.',
      'Separate supported facts, reasonable inferences, and unresolved claims.',
      'Never claim that something was independently verified unless the supplied context contains the evidence.',
      'If external sources are required, say exactly what needs verification instead of inventing citations.'
    ].join(' '),
    maxOutputTokens: 500
  }),
  developer_helper: Object.freeze({
    id: 'developer_helper',
    name: 'Developer helper',
    routingCriteria: 'The conversation concerns programming, debugging, APIs, infrastructure, software architecture, logs, commands, or technical implementation.',
    instructions: [
      'Act as a concise senior software developer.',
      'Give concrete diagnoses, implementation guidance, or code when useful.',
      'State assumptions and do not pretend to have inspected files or systems that were not supplied.'
    ].join(' '),
    maxOutputTokens: 700
  }),
  explainer: Object.freeze({
    id: 'explainer',
    name: 'Explainer',
    routingCriteria: 'The main need is to explain, teach, simplify, compare, or clarify a concept rather than verify a claim or implement software.',
    instructions: [
      'Explain the answer in plain language.',
      'Start with the direct answer, then add only the detail needed to make it understandable.',
      'Prefer a small example over jargon.'
    ].join(' '),
    maxOutputTokens: 550
  }),
  summarizer: Object.freeze({
    id: 'summarizer',
    name: 'Summarizer',
    routingCriteria: 'The user wants a recap, synthesis, action list, or concise extraction from the supplied conversation.',
    instructions: [
      'Summarize only the supplied conversation.',
      'Preserve decisions, open questions, risks, and requested actions.',
      'Do not add facts that are absent from the context.'
    ].join(' '),
    maxOutputTokens: 450
  }),
  generalist: Object.freeze({
    id: 'generalist',
    name: 'General helper',
    routingCriteria: 'A useful assistant response is warranted, but none of the specialist definitions is a clearly better fit.',
    instructions: [
      'Act as a helpful, accurate Discord participant.',
      'Answer the need that opened the gate directly and concisely.'
    ].join(' '),
    maxOutputTokens: 600
  })
});

export function buildAgentCriteria() {
  return {
    ...Object.fromEntries(Object.values(AGENT_DEFINITIONS)
      .map((agent) => [agent.id, agent.routingCriteria])),
    [NO_SUITABLE_AGENT_ID]: 'No available agent can add a useful, grounded response to the conversation.'
  };
}

export function getAgentDefinition(agentId) {
  return AGENT_DEFINITIONS[agentId] ?? AGENT_DEFINITIONS[DEFAULT_AGENT_ID];
}

export function resolveAgentRoute(route, { explicit, minProbability }) {
  const choice = route?.choice;
  const probabilities = route?.probabilities && typeof route.probabilities === 'object'
    ? route.probabilities : {};
  const probability = Number(probabilities[choice] ?? 0);
  const confidence = Number(route?.confidence ?? 0);
  const knownAgent = Boolean(AGENT_DEFINITIONS[choice]);

  if (explicit && (!knownAgent || probability < Number(minProbability))) {
    return {
      selectedAgentId: DEFAULT_AGENT_ID,
      probability,
      confidence,
      probabilities,
      fallbackReason: choice === NO_SUITABLE_AGENT_ID ? 'EXPLICIT_NO_SUITABLE_AGENT' : 'EXPLICIT_LOW_ROUTE_CONFIDENCE'
    };
  }

  if (!knownAgent) {
    return {
      selectedAgentId: null,
      probability,
      confidence,
      probabilities,
      fallbackReason: choice === NO_SUITABLE_AGENT_ID ? 'NO_SUITABLE_AGENT' : 'UNKNOWN_AGENT'
    };
  }

  if (probability < Number(minProbability)) {
    return {
      selectedAgentId: null,
      probability,
      confidence,
      probabilities,
      fallbackReason: 'LOW_ROUTE_PROBABILITY'
    };
  }

  return { selectedAgentId: choice, probability, confidence, probabilities, fallbackReason: null };
}
