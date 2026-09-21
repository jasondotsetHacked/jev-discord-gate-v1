import fs from 'node:fs';
import path from 'node:path';
import { askJev, buildContextQuestions, buildGateQuestions, extractChoice, extractNoul } from '../src/shared/jev.js';
import { cleanMessageForModel, parseGateDecision, selectContext } from '../src/processor/core.js';
import { resolveAgentRoute } from '../src/shared/agents.js';

const sampleMessages = [
  {
    id: 'demo-1', channelId: 'demo-channel', channelName: 'engineering',
    authorName: 'Maya', content: 'Production alerts stopped after the deploy.',
    createdTimestamp: Date.parse('2026-01-01T12:00:00Z'), mentionsBot: false
  },
  {
    id: 'demo-2', channelId: 'demo-channel', channelName: 'engineering',
    authorName: 'Devin', content: 'Could be the SQS visibility timeout causing Lambda retries.',
    createdTimestamp: Date.parse('2026-01-01T12:00:20Z'), mentionsBot: false
  },
  {
    id: 'demo-3', channelId: 'demo-channel', channelName: 'engineering',
    authorName: 'Maya', content: 'The timeout is three minutes. Messages are sitting in the queue without a receive count.',
    createdTimestamp: Date.parse('2026-01-01T12:00:45Z'), mentionsBot: false
  },
  {
    id: 'demo-4', channelId: 'demo-channel', channelName: 'engineering',
    authorName: 'Maya', content: 'Could the Lambda event source mapping be disabled, and what should I check next?',
    createdTimestamp: Date.parse('2026-01-01T12:01:00Z'), mentionsBot: false
  }
];

function readLocalTypeSafeKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;

  const credentialsPath = path.resolve('credentials.json');
  if (!fs.existsSync(credentialsPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(credentialsPath, 'utf8')).TYPESAFE_API_KEY ?? null;
  } catch (error) {
    throw new Error(`Could not read credentials.json: ${error.message}`);
  }
}

function isPlaceholder(value) {
  return !value || /^(replace-me|your[_-])/i.test(value);
}

function percent(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function printHelp() {
  console.log(`Jev Discord Gate demo

Runs one sample conversation through the real Jev response gate and context selector.

Credentials:
  Set TYPESAFE_API_KEY, or put it in ./credentials.json.

Optional environment variables:
  JEV_MODEL          Default: jev-latest
  GATE_THRESHOLD     Default: 0.58
  CONTEXT_THRESHOLD  Default: 0.55
  AGENT_ROUTE_MIN_PROBABILITY  Default: 0.50`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const apiKey = readLocalTypeSafeKey();
  if (isPlaceholder(apiKey)) {
    throw new Error('Add TYPESAFE_API_KEY to credentials.json or your environment, then run npm run demo again.');
  }

  const model = process.env.JEV_MODEL || 'jev-latest';
  const gateThreshold = Number(process.env.GATE_THRESHOLD || 0.58);
  const contextThreshold = Number(process.env.CONTEXT_THRESHOLD || 0.55);
  const agentRouteMinProbability = Number(process.env.AGENT_ROUTE_MIN_PROBABILITY || 0.50);
  const latest = sampleMessages.at(-1);
  const modelHistory = sampleMessages.map(cleanMessageForModel);
  const latestForModel = cleanMessageForModel(latest);

  console.log('\nSample conversation\n');
  for (const message of sampleMessages) console.log(`${message.authorName}: ${message.content}`);

  console.log('\nAsking Jev whether the assistant should speak...');
  const gateResult = await askJev({
    apiKey,
    model,
    state: {
      assistant: { role: 'A helpful Discord participant that should speak only when it can add meaningful value.' },
      channel: { id: latest.channelId, name: latest.channelName },
      latest_message: latestForModel,
      recent_messages: modelHistory
    },
    questions: buildGateQuestions()
  });

  const decision = parseGateDecision(gateResult, {
    mentionsBot: latest.mentionsBot,
    replyToBot: false,
    cadence: { allowed: true, reason: null, ageSeconds: null },
    policy: {
      gateThreshold,
      explicitRequestThreshold: 0.85,
      organicMinValue: 0.70,
      organicMinNovelty: 0.65,
      organicMinNeed: 0.55,
      organicMaxIntrusive: 0.40,
      organicMaxResolved: 0.50
    }
  });
  const route = resolveAgentRoute(extractChoice(gateResult, 'agent_route'), {
    explicit: decision.triggerMode === 'explicit',
    minProbability: agentRouteMinProbability
  });
  const shouldRespond = decision.shouldRespond && Boolean(route.selectedAgentId);

  const labels = {
    assistantAddressed: 'asks the assistant',
    directQuestion: 'direct question',
    canAddValue: 'can add value',
    novelContribution: 'has something new',
    intrusive: 'would be intrusive',
    resolved: 'already resolved',
    requiresResponse: 'response needed'
  };

  console.log('\nGate probabilities');
  for (const [key, value] of Object.entries(decision.outputs)) {
    console.log(`  ${labels[key].padEnd(22)} ${percent(value)}`);
  }
  console.log(`\n  gate score             ${decision.gateScore.toFixed(3)}`);
  console.log(`  threshold              ${gateThreshold.toFixed(3)}`);
  console.log(`  decision               ${shouldRespond ? 'SPEAK' : 'STAY SILENT'}`);
  console.log(`  trigger mode           ${decision.triggerMode ?? 'none'}`);
  console.log(`  selected agent         ${route.selectedAgentId ?? 'none'}`);

  if (!shouldRespond) {
    console.log(`\nThe pipeline stayed closed (${decision.suppressionReason ?? route.fallbackReason}), so no generative model would be called.`);
    return;
  }

  const contextQuestions = buildContextQuestions(sampleMessages, latest.id);
  const candidates = sampleMessages.filter((message) => message.id !== latest.id);
  const contextResult = await askJev({
    apiKey,
    model,
    state: {
      latest_message: latestForModel,
      candidate_messages: candidates.map(cleanMessageForModel)
    },
    questions: contextQuestions
  });
  const selected = selectContext(sampleMessages, latest, contextResult, contextThreshold);
  const selectedIds = new Set(selected.map((message) => message.id));

  console.log('\nContext selection');
  candidates.forEach((message, index) => {
    const probability = extractNoul(contextResult, `message_${index}`);
    const mark = selectedIds.has(message.id) ? 'SELECT' : 'SKIP';
    console.log(`  ${mark.padEnd(6)} ${percent(probability).padEnd(7)} ${message.authorName}: ${message.content}`);
  });
  console.log(`  SELECT latest  ${latest.authorName}: ${latest.content}`);
  console.log(`\nJev selected ${selected.length} of ${sampleMessages.length} messages. In live mode, only those messages go to OpenAI.`);
}

main().catch((error) => {
  console.error(`\nDemo failed: ${error.message}`);
  process.exitCode = 1;
});
