# AGENTS.md

## Project goal

Build a Discord participant whose expensive generative model does **not** see every message and does **not** answer every message.

TypeSafe Jev is the fast judgment layer. It decides:

1. Whether a generative response is warranted now.
2. Which recent messages are relevant context for that response.

OpenAI is the generation layer after the gate.

## Architectural rules

- Keep Jev questions atomic.
- Keep composition, thresholds, weighting, cooldowns, and deterministic rules in code.
- Do not turn Jev into a text generator.
- Do not send all channel history to OpenAI by default.
- Preserve shadow mode as a first-class operating mode.
- Prefer observable decisions over hidden heuristics.
- Keep the Discord Gateway process tiny. It should ingest and enqueue, not reason.
- Treat each Discord channel as an ordered stream. The FIFO queue groups by channel ID.
- Avoid storing API keys in source, CDK context, or CloudFormation outputs.

## Current flow

```text
Discord MESSAGE_CREATE
  -> Fargate Gateway
  -> SQS FIFO
  -> Lambda
  -> persist message
  -> load hot history
  -> Jev gate
  -> code score
  -> if triggered: Jev context selection
  -> if shadow: log and stop
  -> OpenAI generation
  -> Discord reply
  -> persist bot reply
```

## Important files

- `src/shared/jev.js`: Jev API and atomic questions.
- `src/shared/decision.js`: response gate policy.
- `src/processor/handler.js`: orchestration.
- `src/gateway/index.js`: Discord ingest only.

## Near-term priorities

1. Persist shadow-mode decision records.
2. Add a replay/evaluation harness for historical messages.
3. Add human labels: should-have-spoken, should-have-stayed-quiet, context-good/bad.
4. Calibrate gate weights and threshold from labeled data.
5. Add cooldown / anti-dogpile behavior.
6. Add semantic retrieval for older context only when Jev indicates hot context is insufficient.
7. Add `/jev debug` and `/jev status` commands.

## Safety / privacy expectations

- Do not silently expand collection beyond Discord locations where the bot was intentionally installed.
- Keep guild/channel allowlists easy to configure.
- Add retention controls before introducing long-term memory.
- Do not fetch attachment contents in V1 without an explicit design change.
