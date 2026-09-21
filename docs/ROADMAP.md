# Roadmap

## V1 - included

- Discord Gateway listener
- Ordered SQS ingestion
- DynamoDB hot history
- Jev response gate
- Jev hot-context selection
- Shadow mode
- Optional OpenAI response
- Discord reply

## V1.1 - hardening and measurement foundation (included)

- Persist every Jev decision to DynamoDB
- Record Jev answers, gate score, threshold, trigger result, and selected context IDs
- Source-message idempotency and response-state lifecycle
- FIFO dead-letter queue
- Direct retrieval of older Discord reply targets
- Bounded generation and external request timeouts

## V1.2 - routing and social behavior (included)

- Explicit mention and reply-to-bot requests reliably open the gate
- Inferred direct-assistant requests use a configurable probability threshold
- Stricter organic value, novelty, need, intrusion, and resolution policy
- Per-channel organic-response cooldown
- Shadow-mode assistant-activity records for cadence testing
- Jev Choice routing across specialist agent definitions
- Explicit fallback to a general helper
- Organic `no_suitable_agent` and low-probability suppression
- Agent-specific instructions and output limits

## V1.3 - evaluation tooling

- CLI to export decisions to JSONL
- Human labels for false positives and false negatives
- Offline replay of historical conversations

## V1.4 - remaining social behavior

- Quiet-period debounce that gives humans time to answer before organic evaluation
- Avoid responding while humans are actively answering
- Detect when a question is addressed to another named human
- Channel-specific personalities/policies
- Ignore configurable bot commands and noisy channels
- Add optional tools for agents, including sourced web verification and repository inspection

## V2 - dynamic context depth

Add a Jev judgment such as:

```text
Does the latest conversation depend on information older than the hot context provided?
```

If yes:

1. Create/search embeddings for older messages.
2. Retrieve candidate older messages or conversation chunks.
3. Ask Jev which candidates are relevant.
4. Merge them with hot context before generation.

This keeps expensive retrieval conditional rather than constant.

## V2.1 - conversation threads

- Topic/thread IDs independent of Discord threads
- Conversation summaries
- Entity memory
- Track unresolved questions
- Track who said what

## V3 - operations UI

Small web UI for:

- live gate decisions
- Jev probabilities
- context selected for each response
- thumbs-up/down on speak/silence decisions
- threshold sliders
- per-channel policies
- cost and latency metrics

## Experiments worth running

- Jev gate vs a cheap generative classifier
- Jev context selection vs last-N context
- Jev context selection vs embeddings only
- false interruption rate
- missed useful-response rate
- tokens saved before OpenAI
- response quality with selected vs full context
- latency distribution
