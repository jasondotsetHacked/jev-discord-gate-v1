# AGENTS.md

## Project goal

Build a Discord participant whose expensive generative model does **not** see every message and does **not** answer every message.

TypeSafe Jev is the fast judgment layer. It decides:

1. Whether a generative response is warranted now.
2. Which specialist agent should respond.
3. Which recent messages are relevant context for that response.

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
  -> conditionally claim/persist decision by source Discord message ID
  -> persist message
  -> load hot history
  -> load per-channel assistant activity
  -> Jev gate + agent Choice
  -> code policy: explicit override or strict organic checks/cooldown
  -> if triggered: Jev context selection
  -> persist selected agent and assistant activity
  -> if shadow: persist SHADOW_SKIPPED and stop
  -> OpenAI generation
  -> conditionally transition PROCESSING -> REPLYING
  -> Discord reply
  -> persist REPLIED/DELIVERY_UNKNOWN state
  -> persist bot reply
```

## Important files

- `src/shared/jev.js`: Jev API and atomic questions.
- `src/shared/agents.js`: specialist definitions and route policy.
- `src/shared/decision.js`: response gate policy.
- `src/processor/handler.js`: orchestration.
- `src/processor/core.js`: testable processing and response lifecycle.
- `src/processor/repository.js`: DynamoDB history, reply lookup, and decision claims.
- `src/gateway/index.js`: Discord ingest only.

## Near-term priorities

1. Add a JSONL decision exporter and replay/evaluation harness.
2. Add human labels: should-have-spoken, should-have-stayed-quiet, context-good/bad.
3. Calibrate gate weights and threshold from labeled data.
4. Add reconciliation tooling for `REPLYING` / `DELIVERY_UNKNOWN` records.
5. Add a quiet-period debounce before unsolicited responses.
6. Add optional tools for specialist agents.
7. Add semantic retrieval for older context only when Jev indicates hot context is insufficient.
8. Add `/jev debug` and `/jev status` commands.

## Reliability invariants

- A source Discord message has at most one decision item, keyed by `sourceMessageId`.
- Never automatically call Discord again after the decision reaches `REPLYING`.
- Retryable pre-delivery errors are retried by SQS/Lambda, not custom loops.
- Persist shadow outcomes as decision records; logs alone are not the experiment dataset.

## Safety / privacy expectations

- Do not silently expand collection beyond Discord locations where the bot was intentionally installed.
- Keep guild/channel allowlists easy to configure.
- Add retention controls before introducing long-term memory.
- Do not fetch attachment contents in V1 without an explicit design change.
