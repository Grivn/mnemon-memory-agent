# JEV Agent loop (experimental)

A Cordis `AgentFactory` that replaces `@deepseek-ai/dsh-agent-loop` in a separate DSH instance. Tested against DSH **0.1.5-rc.1**. Install exactly one factory in that instance.

The driver owns Agent/session lifecycle, durable inboxes, step boundaries, bounded typed model calls and the public DSH tool pipeline. A separately installed policy constructs actions and arguments. There is no built-in memory routing, writing, summary, or fallback LLM policy.

Configure `policy` explicitly. Credentials are read from `TYPESAFE_API_KEY` (or `apiKeyEnv`); never put keys in profile files. `model` defaults to `jev-latest`. Limits bound steps, decision attempts, request state and turn time. The SDK's automatic retries are disabled. Tool cancellation is cooperative: the driver drains a tool before releasing its Agent.

Exported `JevPolicy`, `PolicyState`, `Judge` and `StepPlan` allow independent policy plugins. Register through `ctx.jevAgentLoop.registerPolicy(...)` inside `ctx.effect`. A policy returns a concrete tool call or stops; it can ask batched Noul/Choice/Score questions between operations. The actual DSH tool gates still apply. The current implementation executes tool calls serially.

JEV is not an LLM text adapter. Its requests, answers and observations are logged as attributed plugin notices. No assistant stream or LLM usage is fabricated. Resume reconstructs pending inboxes and repairs interrupted turns; it does not replay previously dispatched writes.

The replica profile must disable LLM-specific title, retry, compaction, token-meter and goal-round policies until explicitly adapted. Retain core Agent/session/tool/system-prompt services and the dependencies of installed plugins. See the [experiment design](../../docs/plans/jev-replica-agent-loop.md) for composition and compatibility boundaries.
