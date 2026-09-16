# Architecture

## Core idea

The generative model is a scarce, high-latency reasoning resource. Jev acts as an attention and routing layer in front of it.

This project separates four jobs:

1. **Ingest**: hear every eligible Discord message.
2. **Judge**: decide whether the assistant should speak.
3. **Select**: decide which recent messages matter.
4. **Generate**: create one natural Discord response.

## Components

### Discord Gateway - ECS Fargate

A single small always-on container maintains the Discord Gateway WebSocket through `discord.js`.

It does not call Jev or OpenAI. It normalizes `MESSAGE_CREATE` events and writes them to SQS FIFO.

Message group: Discord channel ID.

Deduplication ID: Discord message ID.

This preserves ordering per channel while allowing different channels to process independently.

### SQS FIFO

Buffers Discord traffic and isolates the persistent listener from model/API latency.

After five failed receives, messages move to a FIFO dead-letter queue with 14-day retention. A poison message blocks its channel group while it is being retried, but is eventually isolated so later channel messages can continue. Queue and DLQ URLs/ARNs are exposed as stack outputs.

### Processor Lambda

The processor owns the control flow:

```text
claim decision -> persist source -> retrieve -> gate -> select -> generate -> claim reply -> reply
```

It processes one SQS message per invocation batch in V1.

### DynamoDB

Partition key:

```text
CHANNEL#<discord-channel-id>
```

Sort key:

```text
MSG#<13-digit-timestamp>#<discord-message-id>
```

A TTL is set on each message. V1 defaults to 30 days.

An eventually consistent `MessageIdIndex` supports direct retrieval of reply targets outside hot history.

### Decision records and idempotency

A separate DynamoDB table uses `sourceMessageId` as its partition key. A conditional put creates both the durable decision record and the idempotency claim. The record contains the source snapshot, gate values and score, thresholds, candidate and selected context IDs, Jev model/request metadata, response state, Discord response ID, and structured failure information. Its default TTL is 90 days.

Retryable failures before delivery become `FAILED_RETRYABLE` and can be conditionally reacquired. `PROCESSING` has a lease so a Lambda timeout can eventually be retried. After generation but before the Discord request, a conditional update changes `PROCESSING` to `REPLYING`. Any duplicate that observes `REPLYING` or a later state stops without posting.

Discord REST does not provide an application idempotency key. A crash or network failure after Discord accepts a post but before the processor records the response is therefore ambiguous. Such work is not automatically retried; it remains `REPLYING` or is marked `DELIVERY_UNKNOWN` for manual reconciliation. This is an at-most-once response policy, not a guarantee that every intended response is delivered.

### Jev call 1: response gate

The state contains:

- assistant role
- channel identity
- latest message
- recent hot history

Questions are independent Noul judgments. The result is converted into a single gate score in normal JavaScript.

Current policy:

```text
+ 0.30 direct question
+ 0.30 can add value
+ 0.25 requires response
+ 0.15 explicit bot mention
- 0.25 intrusive
- 0.20 already resolved
```

The score is clamped to 0..1. Default threshold is 0.58.

These numbers are deliberately easy to change and should eventually be calibrated from shadow-mode data.

### Jev call 2: context selector

Only runs when the gate triggers.

For every prior candidate message in the hot history, the app creates one Noul question asking whether that message would help correctly answer the latest message.

Messages at or above `CONTEXT_THRESHOLD` are retained.

The latest message is always retained.

A message explicitly replied to by the latest Discord message is retained deterministically. If it is outside hot history, the processor queries `MessageIdIndex` and merges it without duplication. Because the index is eventually consistent, a reply to a just-written message can rarely miss until index propagation completes.

### OpenAI

When live mode is enabled, only the selected context reaches the generative model.

The current default is `gpt-5.6-sol`, configurable through CDK context.

Output is bounded by `OPENAI_MAX_OUTPUT_TOKENS` (700 by default). The latest source message appears once in the prompt. V1 sends at most one Discord response; overlong text is shortened at a whitespace/sentence boundary rather than blindly sliced.

### Discord REST reply

The Lambda posts directly to Discord API v10 and records the response ID in the decision record before treating the bot-history write as complete. Jev, OpenAI, and Discord calls have explicit timeouts. Retryable failures before `REPLYING` are delegated to SQS/Lambda; delivery-stage ambiguity is terminal pending reconciliation.

## Shadow mode

Shadow mode is the default because the biggest unknown is not infrastructure. It is gate calibration.

When the gate triggers in shadow mode:

- context selection still runs
- selected message IDs are logged
- OpenAI is not called
- Discord receives no reply

This produces durable decision traces without annoying a server. CloudWatch provides operational logs; the decision table is the analysis/replay source of record.

## Why not vector search in V1?

Hot context is enough to validate the central hypothesis: can Jev decide **when to think** and **what recent information to think about**?

Long-term retrieval should be added only after this works. A later version can let Jev judge whether older context is required, then run a semantic retrieval pass only in those cases.
