# Jev decision examples

These examples explain the two Jev stages. They are illustrative, not benchmark results. Exact probabilities vary by model version and input.

## The gate opens

```text
Maya: Production alerts stopped after the deploy.
Devin: Could be the SQS visibility timeout causing Lambda retries.
Maya: The timeout is three minutes. Messages are sitting in the queue without a receive count.
Maya: Could the Lambda event source mapping be disabled, and what should I check next?
```

Jev independently estimates whether the assistant was directly addressed, whether the latest message is a question, whether the assistant can add value, whether it has a novel contribution, whether a response would be intrusive, whether the issue is resolved, and whether silence would leave something unanswered. Application code combines those probabilities with hard organic-response rules.

The same request routes the response to one agent. If the organic policy passes and the route is suitable, Jev evaluates each earlier message for relevance. Only selected messages and the latest message are sent to the selected agent.

Run this example against the current Jev model:

```bash
npm run demo
```

## The gate stays closed

```text
Maya: The deployment is complete.
Devin: I verified the alerts. Everything is healthy now.
Maya: Perfect, thank you.
```

The resolved and intrusive probabilities should weigh against responding. When the score stays below the threshold, the pipeline stops before context selection and OpenAI is not called.

An explicit mention or reply to the bot still opens the gate. Organic traffic can also be suppressed by the cooldown, low novelty, low usefulness, or `no_suitable_agent` route.

## Shadow mode

Shadow mode runs the real gate and context selector, then records `SHADOW_SKIPPED` instead of generating or posting a reply. Use those stored decisions to find false interruptions and missed responses before enabling live replies.
