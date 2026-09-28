# OptMem-inspired JEV exploration

An explicitly installed alternative policy for the replica DSH. Source plugins remain unchanged. Configure public read adapters, a separate absolute checkpoint directory, and the driver policy `jev-optmem`; no policy is installed by default.

The policy implements a bounded `wake → recall/zoom → cover → leaves → publish` program. It first reads the configured Sources, asks JEV to choose literal query terms and subsequent searches, follows current-View continuations, and opens children using declarative bindings to existing Routes. A final hydration pass can open children found in the last search round, within the same total read budget. JEV scores an extractive binary-tree cover of **observed** evidence, then scores raw leaves under a global View budget. The optional `flat` mode evaluates the same observed pool without the tree filter.

This independently implements ideas from [VictorTaelin/OptMem](https://github.com/VictorTaelin/OptMem): coarse representations, retained originals, and explicit expansion. It does not copy upstream code, run its CLI, train a model, or reproduce its append-only storage and generated summary tree. Extractive previews are lossy navigation aids, never replacement facts. The original Source remains responsible for its storage and write semantics.

Adapters name a Source type, public operation, optional query/limit fields, and optional child read bindings (e.g. `id` or `provenance.path`). They are configuration, not patches to data plugins. Every read is executed through the existing DSH tool pipeline and its current View permissions and budgets. A Source with no continuation or full-text Route still has that limitation; no management API or direct storage bypass is used.

The sidecar checkpoint holds previously chosen terms and diagnostic traces. Every published item comes from the current run's actual reads. Old bodies and View-bound cursors are never restored into a new View. Source failures preserve the prior candidate; all-model-low action scores stop exploration. Work, model calls, candidates and output characters remain bounded. This policy does not perform plugin writes, generate semantic summaries, or guarantee complete corpus coverage.

Example adapter: `{ sourceTypeId: 'canvas', operationId: 'list', queryField: 'query', limitField: 'limit', expand: { operationId: 'read-node', bindings: { id: 'id' } } }`.

Use the driver with at least `maxSteps: 36` and `maxDecisionCalls: 16` for the default 24-read policy. The driver may impose tighter limits; exceeding them fails the run rather than silently publishing incomplete execution. Checkpoints contain retrieved text; keep their directory in the replica's private storage.

The repository's `scripts/serve-jev-replica.mjs --optmem` mounts this policy in isolated official Web profiles. The [implementation and experiment report](../../docs/reports/jev-optmem-20260923.md) compares nine real Source types, original/scattered synthetic placement, and matched-pool tree/flat selection. Retrieval coverage improved with more work; the tree did not improve matched-pool evidence retention and only reduced tokens in the scattered condition. This is an opt-in experiment, not a default or a claim of universal quality gains.

## Optional maintained navigation

Set `maintained: true` to split foreground selection from background organization.
The replica bridge uses assistant-completed / idle jobs for `nap`; input jobs have
priority and cancel obsolete maintenance. `backgroundMs` on the bridge enables
periodic polling. Local committed memory operations also request a refresh of the
affected Source. Writes by a different DSH process or external file editor are
discovered by periodic reads or the next foreground read, not by a shared event bus.

`nap` rotates current authorized Source routes, follows only current-View cursors,
and retains at most `indexCapacity` navigation leaves (512 by default). Optional
adapter `maintainInput` supplies a query-independent browse recipe; `reread`
binds public resource fields to a fresh direct-read operation. Partial / truncated
Sources remain partial. The strategy does not access plugin databases, add Source
APIs, change original records, or generate natural-language summaries. JEV scores
literal spans only for changed content; unchanged spans and subtree hashes are
reused. The JSON checkpoint is session-scoped, locked, atomic, bounded and fenced
by generation and current replica lease. `indexTtlMs` bounds hint age.

Foreground uses one small JEV literal-term routing decision, reads a fresh head
and locally activated addresses through current grants, then scores at most one
48-item / 38k-character evidence batch. Candidates
still obey the configured global item and text budgets. Old index text is never
sent to the selector or main model without a fresh read. The index can miss unseen
resources or paraphrased queries; this is an experimental alternative, not a
completeness guarantee or a default policy. Changes after the pinned read obey
each Source's existing consistency contract. Main DSH history is not rewritten.

By default `coldStart: adaptive` retains the existing multi-step explorer when
this session has no navigation yet, then initializes its index from actual read
observations. Warm turns retain semantic term routing and one evidence batch. `coldStart: bounded` explicitly
opts into the faster but less capable cold reader, mainly for ablation. Only set
an adapter's `exhaustive: true` when its browse/continuation contract guarantees
complete enumeration; a bounded search window is not a complete inventory.

`semanticNap: false` retains the same background reads and index mechanics but
uses the first literal span with neutral salience; it permits a direct ablation
of JEV organization versus pre-reading alone. The foreground policy is unchanged.

Use `scripts/serve-jev-replica.mjs --maintained` for independent official Web
profiles. The [maintenance experiment report](../../docs/reports/jev-optmem-maintained-20260923.md)
includes cold/warm comparisons, the three-arm maintenance ablation, background
usage and limits; these measurements do not imply a default policy change.

## Natural policy (experimental)

`naturalPlugin` registers a second policy, `jev-natural`, written as straight-line
code over the same DSH loop (`generatorPolicy`: `yield` a tool call, receive its
result). Code proposes; JEV only answers finite questions:

1. **Observe** through public Routes: newest heads of every Source, complete sweeps
   of `exhaustive` adapters (which also retire deleted records), and a re-read of
   everything the main model currently sees. Observations go into one ledger per
   workspace, shared by all sessions. Background jobs only observe and open card or
   path `stubs` through `expand`; they make no JEV call. Read cursors are bound to
   their View, so a Source larger than one View's Route budget cannot be swept across
   jobs: the first sweep that runs out marks it `partial`, and from then on only its
   head is read and it is searched by term. When the adapter names a date bound
   (`until`), background jobs keep reading such a Source backwards in time from the
   oldest date reached, a cursor the ledger owns, until it is `done`.
2. **Gate** (`gate`, 0.3 by default; 0 turns it off): when no record was added, edited or removed and
   JEV's "could the reply need a note not shown?" is below `gate`, the same View is
   published again without recall.
3. **Recall** (default `recall: 'llm'`, the "JEV cache" scheme): one call to the replica's own DSH LLM
   (`recallModel`) lists the ids of possibly needed notes and suggests literal search
   terms for what the notes may lack; the whole ledger is a stable prompt prefix in
   first-seen order, so the provider's prompt cache serves most of it. BM25 adds
   literal matches; the call only nominates candidates. `recall: 'jev'` (the "JEV full-scan"
   scheme) instead asks one short, id-labelled
   "needed?" question per ledger item (cleaned excerpts, parallel requests); it is
   also the fallback when no recall model is configured. Both see `listing` characters
   of each item (120 by default; longer for memories stored as note chunks).
4. **Search** Sources that cannot be enumerated with those terms (`termsFrom: 'recall'`),
   or with literal terms taken from the dialogue and the best hits, JEV choosing among
   them (`termsFrom: 'jev'`, and always with the full scan).
5. **Judge** a short list (on screen + best recalled + new finds) with two questions
   per item — needed, and no longer current — with peers visible.
6. **Compose** with hysteresis (`enter`, `stay`) and withdraw confident supersessions
   (`withdraw`); items shown are re-read first when they have an address.

The candidate carries `withdrawn` entries; with the replica's `delivery: 'stable'`
the main View names superseded items instead of silently dropping them. How a changed
View reaches the main model is the host's `snapshotDelivery`: `replace` keeps one live
snapshot but rewrites earlier context, which invalidates the provider's prompt cache
from the retired snapshot on (in tool-heavy turns, the whole previous turn); `append`
and `delta` never rewrite, and `delta` appends only the blocks that changed.
**Consolidation** (optional, `consolidation: { model }`): background jobs also read the
Source's new records in creation order after a watermark (its search Route must offer
`since` and `recent`), within the Route budget of each job, and a model folds them a
batch at a time (`batchCharacters`, 10,000 by default; user text whole, the start of each
assistant message) into topic timelines, value histories and standing instructions,
each item linked to its records. A short rest is folded once a job finds nothing new, and
the texts Views rank by meaning are embedded then, so no reply waits for them.
The raw records stay the only evidence and are never changed. A View then lights up
the topics and values its own records are linked to, has JEV judge those and the
nearest few to the message (by `embedUrl` vectors, or shared words), and leads with
them coarse to fine: the instructions, a one-line directory of every topic, the chosen
timelines and value histories. The records follow in their order and give way from the
end within `maxCharacters`. The state lives in the policy's directory, one file per
workspace, written whole after every batch.

`judge: 'lexical'` runs the same pipeline with BM25 only, as a control. See the
[exploration report](../../docs/reports/jev-natural-exploration-20260923.md) and the
[second-round report](../../docs/reports/jev-v4-20260923.md) (complex scenarios, prompt-cache
monitoring, delivery modes, LoCoMo and LongMemEval).
