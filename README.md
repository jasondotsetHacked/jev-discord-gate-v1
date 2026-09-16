# Jev Discord Gate V1

A small AWS CDK Discord bot starter where **TypeSafe Jev decides when the generative model should speak and which recent messages are relevant context**.

V1 is intentionally simple:

```text
Discord Gateway (ECS Fargate)
        |
        v
    SQS FIFO
        |
        v
 Processor Lambda
        |
        +--> DynamoDB conversation history
        |
        +--> Jev gate: should the bot speak?
        |
        +--> Jev context selector: which messages matter?
        |
        +--> OpenAI Responses API
        |
        +--> Discord REST API reply
```

The bot starts in **shadow mode**. Jev makes decisions and context selections, but OpenAI is not called and the bot does not reply. Use CloudWatch logs to tune it first.

## Why the tiny Fargate service?

Normal Discord `MESSAGE_CREATE` events arrive over Discord's persistent Gateway WebSocket. Lambda is a poor fit for holding that socket open. The Fargate process only listens to Discord and writes normalized messages to SQS. Everything else is event-driven.

## What is already implemented

- AWS CDK v2, JavaScript, Node.js 22
- Tiny `discord.js` Gateway listener on ECS Fargate
- SQS FIFO queue with one message group per Discord channel
- Lambda message processor
- DynamoDB hot conversation history with TTL
- Jev gate with five independent Noul questions
- Weighted gate score in ordinary JavaScript
- Jev fan-out context selection, one Noul per candidate message
- Reply-chain context is included deterministically
- OpenAI Responses API integration
- Discord REST reply
- CloudWatch decision logs
- Shadow mode enabled by default
- Optional guild/channel allowlists
- One Secrets Manager secret for all credentials

## Jev gate

For every incoming message, the processor asks Jev:

- Is this a direct or implicit question?
- Can the assistant materially add value?
- Would speaking be intrusive?
- Is the conversation already resolved?
- Would silence leave something useful unanswered?

The app then computes a score in `src/shared/decision.js`. This is deliberately code, not another model call, so you can tune the behavior without rewriting prompts.

If the gate passes, a second Jev call asks whether each recent message would be useful context for answering the latest message. Only selected messages are sent to OpenAI.

## Prerequisites

- Node.js 22+
- AWS CLI credentials for the target account
- AWS CDK bootstrapped in the target account/region
- A Discord application/bot
- Discord **Message Content Intent** enabled for the bot
- TypeSafe API key
- OpenAI API key when you are ready to leave shadow mode

## 1. Install

```bash
npm install
npm test
npm run check
```

## 2. Bootstrap CDK once

```bash
npx cdk bootstrap
```

## 3. Deploy infrastructure with the Gateway stopped

The default `gatewayDesiredCount` is `0`. This lets CloudFormation create the secret before the bot tries to log in with placeholder credentials.

```bash
npx cdk deploy
```

The stack creates this secret:

```text
jev-discord-gate-v1/credentials
```

## 4. Set credentials

Replace the values below. In shadow mode, `OPENAI_API_KEY` can remain `replace-me` until you enable replies.

```bash
aws secretsmanager put-secret-value \
  --secret-id jev-discord-gate-v1/credentials \
  --secret-string '{"DISCORD_TOKEN":"YOUR_DISCORD_TOKEN","TYPESAFE_API_KEY":"YOUR_TYPESAFE_KEY","OPENAI_API_KEY":"replace-me"}'
```

On PowerShell, it is usually easier to place the JSON in a file and use `file://credentials.json` with the AWS CLI if shell quoting becomes annoying.

## 5. Start the Discord Gateway in shadow mode

Optionally restrict the bot to one guild and one channel while testing:

```bash
npx cdk deploy \
  -c gatewayDesiredCount=1 \
  -c shadowMode=true \
  -c allowedGuildIds=YOUR_GUILD_ID \
  -c allowedChannelIds=YOUR_CHANNEL_ID
```

If the allowlists are empty, the bot processes messages in every guild/channel it can see.

## 6. Watch Jev decisions

Look at the Processor Lambda logs in CloudWatch. Important events are:

```text
jev_gate_decision
jev_context_selection
```

Example gate log shape:

```json
{
  "event": "jev_gate_decision",
  "gateScore": 0.73,
  "trigger": true,
  "directQuestion": 0.91,
  "canAddValue": 0.88,
  "intrusive": 0.08,
  "resolved": 0.11,
  "requiresResponse": 0.79
}
```

## 7. Turn on replies

First update the secret with a real OpenAI key:

```bash
aws secretsmanager put-secret-value \
  --secret-id jev-discord-gate-v1/credentials \
  --secret-string '{"DISCORD_TOKEN":"YOUR_DISCORD_TOKEN","TYPESAFE_API_KEY":"YOUR_TYPESAFE_KEY","OPENAI_API_KEY":"YOUR_OPENAI_KEY"}'
```

Then deploy with shadow mode off:

```bash
npx cdk deploy \
  -c gatewayDesiredCount=1 \
  -c shadowMode=false \
  -c allowedGuildIds=YOUR_GUILD_ID \
  -c allowedChannelIds=YOUR_CHANNEL_ID
```

The default generative model is `gpt-5.6-sol`. Change it with:

```bash
-c openAiModel=MODEL_ID
```

## Useful CDK context settings

```text
shadowMode          true
openAiModel         gpt-5.6-sol
jevModel            jev-latest
hotContextLimit     30
gateThreshold       0.58
contextThreshold    0.55
messageTtlDays      30
gatewayDesiredCount 0
allowedGuildIds     comma,separated,ids
allowedChannelIds   comma,separated,ids
```

Treat the thresholds and weights as starting values, not truth. The whole point of shadow mode is to collect examples and tune them against real chat.

## Discord bot permissions

For V1, the bot needs enough permission to:

- View the test channel
- Read message history
- Send messages when live mode is enabled

The application also needs the Message Content Intent enabled because the Gateway listener reads normal message content.

## Local project map

```text
bin/app.js                     CDK entry point
lib/jev-discord-stack.js       AWS infrastructure
src/gateway/index.js           Persistent Discord Gateway listener
src/processor/handler.js       Main SQS/Lambda orchestration
src/shared/jev.js              TypeSafe API + Jev questions
src/shared/decision.js         Gate scoring policy
src/shared/openai.js           Generative response call
docs/ARCHITECTURE.md           Design notes
docs/ROADMAP.md                Good next phases
AGENTS.md                      Context for Codex/other coding agents
```

## Current V1 limitations

- Context retrieval is only the last N messages from the same channel.
- No semantic/vector retrieval yet.
- No thread/topic memory beyond hot history and Discord reply references.
- Attachments are recorded as metadata but not fetched or interpreted.
- Generated Discord output is clipped near 2,000 characters rather than split across messages.
- The gate weights are hand-set starting values and are not calibrated yet.
- No admin/debug slash commands yet.
- No replay/evaluation UI yet.

## Good first Codex task

Ask Codex to add a **shadow decision recorder** that stores each gate result and selected context in DynamoDB, plus a small local CLI that exports the records to JSONL for review. That gives you the data needed to tune Jev instead of guessing.

## External API references used by this starter

- TypeSafe System One endpoint: `POST https://api.typesafe.ai/v1/systemone`
- TypeSafe default model alias: `jev-latest`
- OpenAI Responses API through the official `openai` Node package
- Discord Gateway for inbound messages and Discord REST API v10 for replies
