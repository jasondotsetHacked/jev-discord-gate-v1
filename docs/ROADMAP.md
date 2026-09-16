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

## V1.1 - measure before tuning

- Persist every Jev decision to DynamoDB
- Record raw Jev answers, gate score, threshold, trigger result, and selected context IDs
- CLI to export decisions to JSONL
- Human labels for false positives and false negatives
- Offline replay of historical conversations

## V1.2 - social behavior

- Per-channel cooldown
- Avoid replying twice while humans are actively answering
- Stronger reply/mention handling
- Detect when a question is addressed to another named human
- Channel-specific personalities/policies
- Ignore configurable bot commands and noisy channels

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
