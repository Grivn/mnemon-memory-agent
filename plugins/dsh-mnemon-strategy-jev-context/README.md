# JEV context strategy (experimental opt-in policy)

An independently installable Cordis policy for `dsh-mnemon-agent-loop-jev` and `dsh-mnemon-replica`. Its `id` must match the driver's explicitly configured `policy`.

The program inspects the current Mnemon View, asks JEV which configured Sources could help ordinary conversation, calls their actual read routes, then asks which returned evidence to keep. A deterministic item/character budget shapes the candidate. Finally the bridge publishes it with the exact main-input revision. No special user phrase or explicit memory query is required.

`reads` is required: each recipe names `sourceTypeId`, `operationId`, optional exact `sourceInstanceKey`, and literal JSON `input`. Arguments come from code/configuration, not generated JEV text. Source authors with different read APIs can supply recipes or implement their own policy against the same driver.

Optional `capture` can target one append-only ActionOffer. JEV judges whether to retain the latest human statement; the program passes its **verbatim original text**. It does not synthesize facts, summaries or relationships, and it never approves pending proposals. Multiple matching write destinations without an exact instance selection disable that write. External-approval actions are excluded by this experiment; DSH still enforces all tool policies.

Selection thresholds and budgets belong to this policy, not the platform. Read failures keep the previous candidate. Mutation receipts and uncertain outcomes remain recorded separately from View publication. The recipe is a two-stage bounded selector, not a reproduction of Jev-Mem's graph expansion or an implementation of OptMem’s summary-tree protocol.

Some lookup Sources, including files and imported conversation history, return evidence without a backend revision. The policy preserves those observations with a `content-sha256:` fingerprint. This identifies the returned text snapshot; it is not a backend revision for writes and does not guarantee that the resource remains unchanged. Native item or evidence revisions take precedence when present.

The policy executes only the configured read recipes. It does not follow pagination, open Canvas cards after listing them, or fetch a document beyond its returned excerpt. Source selection, evidence selection, and main-side context delivery each have separate budgets; a selected item is not proof that its full content reached the main model.

See the [experiment design](../../docs/plans/jev-replica-agent-loop.md).
