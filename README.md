# Jev Discord Gate

A Discord participant that does not send every message to a generative model and does not answer every conversation.

**TypeSafe Jev is the attention and routing layer.** It decides whether the assistant has a useful reason to speak, chooses one specialist agent, then selects the recent messages that agent needs. OpenAI generates a reply only after those decisions.

```text
Discord conversation
        |
        v
  explicit request? ---- yes ----------+
        |
        no                              |
        v                               |
  strict organic gate ---- stay silent |
        |                               |
        +-------------------------------+
        v
  Jev agent router
        |
        v
  Jev context selector
        |
        v
  selected messages only
        |
        v
  OpenAI -> Discord reply
```

The AWS deployment starts in **shadow mode**. Jev makes and records decisions, but OpenAI is not called and the bot does not reply. This lets you measure its behavior before allowing it to join a live conversation.

> **Status:** Experimental starter. Use one test channel and shadow mode first. The gate weights and thresholds are starting values, not calibrated truth.

## See the idea in two minutes

The local demo sends a sample conversation through the real Jev gate and context selector. It does not need AWS, Discord, Docker, or OpenAI.

```bash
git clone https://github.com/jasondotsetHacked/jev-discord-gate-v1.git
cd jev-discord-gate-v1
npm ci
```

Copy `credentials.example.json` to `credentials.json`, add only your TypeSafe key, then run:

```bash
npm run demo
```

You will see:

- seven independent gate probabilities;
- the gate score and `SPEAK` or `STAY SILENT` decision;
- the explicit or organic trigger mode and selected agent;
- the probability assigned to each context candidate;
- which messages would be sent to OpenAI.

`credentials.json` is gitignored. You can also set `TYPESAFE_API_KEY` in your environment instead. See [decision examples](docs/EXAMPLES.md) for the sample scenario.

## Why this exists

Most chatbots call a generative model for every event or require a command or mention. This project explores a third option: let a fast decision model observe normal conversation and control the expensive model's attention.

For each incoming Discord message, Jev answers seven atomic Noul questions:

- Is the message directly asking the assistant?
- Is this a direct or implicit question?
- Can the assistant materially add value?
- Can it contribute something that humans have not already said?
- Would speaking now be intrusive?
- Is the relevant issue already resolved?
- Would silence leave something useful unanswered?

An explicit mention, reply to the bot, or high-confidence direct assistant request opens the gate. Unsolicited responses must pass the weighted score, hard usefulness/novelty/need requirements, intrusiveness and resolution vetoes, and a per-channel cooldown.

The same Jev call makes one typed `choice` among the available agent definitions. If an organic message has no suitable high-probability agent, the bot stays silent. Explicit requests fall back to the general helper instead of ignoring the user. A second Jev call evaluates recent messages one at a time for context relevance. The selected agent receives only that context.

Keeping the questions atomic and the policy in code makes every decision inspectable and tunable.

## What is included

- TypeSafe Jev response gate and context selection
- Explicit-request guarantees and stricter organic-response policy
- Jev routing across fact-checker, developer, explainer, summarizer, and general agents
- Per-channel cooldown and shadow-mode cadence simulation
- OpenAI Responses API generation after the gate
- Discord Gateway listener on a small ECS Fargate service
- Ordered per-channel processing through SQS FIFO
- Lambda processor with a dead-letter queue
- DynamoDB conversation history and durable decision records
- Source-message idempotency and explicit delivery states
- Shadow mode enabled by default
- Optional guild and channel allowlists
- Configurable data retention
- Local Jev demo, deployment doctor, and credential uploader
- Tests, syntax checks, CI, and Gitleaks secret scanning

## AWS architecture

```text
Discord Gateway (ECS Fargate)
        |
        v
    SQS FIFO + DLQ
        |
        v
 Processor Lambda
    |       |       |
    v       v       v
DynamoDB   Jev    OpenAI -> Discord REST
```

The small Fargate service exists because Discord events arrive over a persistent Gateway WebSocket. It only normalizes messages and places them on SQS. All decisions and external API calls happen in the Lambda processor.

See [Architecture](docs/ARCHITECTURE.md) for the processing lifecycle, idempotency rules, and failure behavior.

## Deploy to Discord

### Prerequisites

- [Node.js 22 or newer](https://nodejs.org/en/download)
- [TypeSafe / Jev access](https://typesafe.ai/)
- [Discord application and bot](https://discord.com/developers/applications)
- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) configured for the target account
- [Docker](https://docs.docker.com/get-started/get-docker/) with the daemon running
- An [OpenAI API key](https://platform.openai.com/docs/quickstart) only when you enable live replies

AWS CDK is installed as a project dependency. You do not need a global CDK installation.

### 1. Create the Discord bot

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Create an application and add a bot.
2. Enable **Message Content Intent** on the Bot page. Discord documents this privileged intent in its [Message Content Intent FAQ](https://support-dev.discord.com/hc/en-us/articles/4404772028055-Message-Content-Intent-FAQ-Redirecting).
3. Invite the bot to a test server with the `bot` scope.
4. Grant it **View Channels**, **Read Message History**, and **Send Messages** in the test channel.

Keep the bot token private.

### 2. Install and add local credentials

```bash
npm ci
npm test
npm run check
```

Copy `credentials.example.json` to `credentials.json` and replace the Discord and TypeSafe placeholders. Leave `OPENAI_API_KEY` as `replace-me` while using shadow mode.

```json
{
  "DISCORD_TOKEN": "YOUR_DISCORD_TOKEN",
  "TYPESAFE_API_KEY": "YOUR_TYPESAFE_KEY",
  "OPENAI_API_KEY": "replace-me"
}
```

Validate the deployment environment:

```bash
npm run doctor
```

The doctor checks Node, installed packages, AWS identity, Docker, CDK, and the required credential fields. It does not print credential values.

### 3. Bootstrap and deploy AWS

Bootstrap each AWS account and region once:

```bash
npx cdk bootstrap
```

Deploy the infrastructure:

```bash
npx cdk deploy
```

The first deployment keeps the Gateway stopped with `gatewayDesiredCount=0`. This prevents the bot from starting before its generated placeholder secret is replaced.

### 4. Upload credentials safely

```bash
npm run configure
```

This uploads `credentials.json` to `jev-discord-gate-v1/credentials` in AWS Secrets Manager. It avoids shell-specific JSON quoting and never prints the values.

To use another file or secret name:

```bash
npm run configure -- --file ./credentials.json --secret-id YOUR_SECRET_ID
```

### 5. Start in one shadow channel

Enable Developer Mode in Discord, then copy the server and channel IDs from their context menus.

```bash
npx cdk deploy \
  -c gatewayDesiredCount=1 \
  -c shadowMode=true \
  -c allowedGuildIds=YOUR_GUILD_ID \
  -c allowedChannelIds=YOUR_CHANNEL_ID
```

If both allowlists are empty, the bot processes messages everywhere it can see. Start with explicit IDs.

The Processor Lambda logs these CloudWatch events:

```text
jev_gate_decision
jev_context_selection
```

The durable decision records are stored in the DynamoDB table named by the `DecisionTableName` stack output.

### 6. Enable replies

Add a real OpenAI key to `credentials.json`, upload it, and disable shadow mode:

```bash
npm run configure
npx cdk deploy \
  -c gatewayDesiredCount=1 \
  -c shadowMode=false \
  -c allowedGuildIds=YOUR_GUILD_ID \
  -c allowedChannelIds=YOUR_CHANNEL_ID
```

Keep the allowlists in place until you have reviewed enough shadow decisions.

## Configuration

Pass settings to CDK with `-c key=value`.

| Setting | Default | Purpose |
|---|---:|---|
| `shadowMode` | `true` | Record decisions without generating or posting replies |
| `gatewayDesiredCount` | `0` | Number of Discord Gateway tasks |
| `allowedGuildIds` | empty | Comma-separated Discord server IDs |
| `allowedChannelIds` | empty | Comma-separated Discord channel IDs |
| `jevModel` | `jev-latest` | Jev model alias |
| `gateThreshold` | `0.58` | Minimum combined score to continue |
| `contextThreshold` | `0.55` | Minimum relevance probability for context |
| `explicitRequestThreshold` | `0.85` | Jev probability that counts as a direct assistant request |
| `organicMinValue` | `0.70` | Minimum usefulness for an unsolicited response |
| `organicMinNovelty` | `0.65` | Minimum probability that the response adds something new |
| `organicMinNeed` | `0.55` | Minimum question/response need for an unsolicited response |
| `organicMaxIntrusive` | `0.40` | Maximum tolerated interruption probability |
| `organicMaxResolved` | `0.50` | Maximum tolerated already-resolved probability |
| `organicCooldownSeconds` | `180` | Per-channel delay between organic responses |
| `agentRouteMinProbability` | `0.50` | Minimum selected-agent probability for organic traffic |
| `hotContextLimit` | `30` | Recent messages considered |
| `openAiModel` | `gpt-5.6-sol` | Generative model |
| `openAiMaxOutputTokens` | `700` | Generation output limit |
| `messageTtlDays` | `30` | Conversation-history retention |
| `decisionTtlDays` | `90` | Decision-record retention |
| `jevTimeoutMs` | `15000` | Jev request timeout |
| `openAiTimeoutMs` | `60000` | OpenAI request timeout |
| `discordTimeoutMs` | `10000` | Discord REST timeout |

## Privacy, security, and cost

- Discord message content is sent to Jev for gating and context selection.
- Only Jev-selected context is sent to OpenAI, and never in shadow mode.
- Message content, author/channel IDs, attachment metadata, and decision data are stored in DynamoDB until their configured TTLs expire.
- Attachments are recorded as metadata but their contents are not fetched.
- Credentials are stored in AWS Secrets Manager. Local `credentials.json` and `.env` files are gitignored.
- Fargate is the main fixed infrastructure cost. Lambda, SQS, DynamoDB, Jev, and OpenAI costs depend on usage.
- CI scans commits with Gitleaks, but automated scanning does not replace credential rotation after a confirmed leak.

Do not install the bot where participants have not agreed to this data flow.

## Reliability behavior

Each Discord source message can claim only one decision record. Response state advances through explicit processing, shadow, failure, and delivery states. The processor writes `REPLYING` before calling Discord and will not automatically post again after that point. If delivery becomes ambiguous, it prefers a missed reply over a duplicate reply.

See [Architecture](docs/ARCHITECTURE.md) for the full state machine.

## Project map

```text
bin/app.js                     CDK entry point
lib/jev-discord-stack.js       AWS infrastructure
scripts/demo.js                Local Jev gate/context demonstration
scripts/doctor.js              Deployment prerequisite checks
scripts/configure.js           Secrets Manager credential upload
src/gateway/index.js           Persistent Discord Gateway listener
src/processor/handler.js       SQS/Lambda orchestration
src/processor/core.js          Testable processing lifecycle
src/processor/repository.js    DynamoDB persistence and claims
src/shared/agents.js           Agent definitions and route policy
src/shared/jev.js              TypeSafe API and atomic questions
src/shared/decision.js         Gate scoring policy
src/shared/openai.js           Generative response call
src/shared/discord.js          Discord REST and response limits
docs/ARCHITECTURE.md           Detailed design notes
docs/EXAMPLES.md               Jev decision examples
docs/ROADMAP.md                Planned work
```

## Current limitations

- Gate weights and thresholds are hand-set and not calibrated from labeled data.
- Organic decisions are immediate; there is not yet a quiet-period debounce that waits for another human to answer.
- Agent definitions currently change instructions and output limits. They do not yet grant web, GitHub, or other tools.
- Context is the latest messages plus an older directly replied-to message when it remains in DynamoDB.
- There is no semantic retrieval or long-term topic memory.
- There are no admin/debug slash commands or replay/evaluation UI.
- A response is limited to one Discord message.
- The Gateway requires an always-on Fargate task.

The next useful phase is a JSONL decision exporter and replay/labeling harness. See the [Roadmap](docs/ROADMAP.md).

## License

[MIT](LICENSE)
