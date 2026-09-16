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

### Processor Lambda

The processor owns the control flow:

```text
persist -> retrieve -> gate -> select -> generate -> reply
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

A message explicitly replied to by the latest Discord message is retained deterministically.

### OpenAI

When live mode is enabled, only the selected context reaches the generative model.

The current default is `gpt-5.6-sol`, configurable through CDK context.

### Discord REST reply

The Lambda posts directly to Discord API v10 and records the bot response back into DynamoDB so later messages can use it as context.

## Shadow mode

Shadow mode is the default because the biggest unknown is not infrastructure. It is gate calibration.

When the gate triggers in shadow mode:

- context selection still runs
- selected message IDs are logged
- OpenAI is not called
- Discord receives no reply

This produces real decision traces without annoying a server.

## Why not vector search in V1?

Hot context is enough to validate the central hypothesis: can Jev decide **when to think** and **what recent information to think about**?

Long-term retrieval should be added only after this works. A later version can let Jev judge whether older context is required, then run a semantic retrieval pass only in those cases.
