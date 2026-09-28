# OptMem-inspired JEV experiment evidence

See the [Chinese implementation and test report](../../reports/jev-optmem-20260923.md) and [predeclared protocol](../../plans/jev-optmem-experiment.md).

The later requested [all-candidates and response-latency comparison](../../reports/jev-optmem-all-candidates-20260923.md) uses new contemporaneous runs, without changing the policy.

| Artifact | Meaning |
| --- | --- |
| [original.json](original.json) and root `trace-900-*.jsonl.gz` | Development v1 run, before terminal child hydration; retained, not included in final comparison |
| [final-original/evaluation.json](final-original/evaluation.json) | Final v2, original fixture placement, two real API arms |
| [scattered/evaluation.json](scattered/evaluation.json) | Final v2, fixed scattered placement and varied distractors |
| [all-original/evaluation.json](all-original/evaluation.json), [all-scattered/evaluation.json](all-scattered/evaluation.json) | Requested all-candidates versus OptMem-inspired comparisons, fresh shared corpora per layout |
| `latency.json` next to each final evaluation | Original durable main DSH inbox/turn/stream event evidence, per-input latency and distribution; excludes browser rendering |
| [all-cases.md](all-cases.md) | All 17 inputs, paired keyword checks and first-text latencies |
| [all-comparison.png](all-comparison.png), [all-latency.png](all-latency.png) and corresponding SVGs | New coverage/context comparison and response-time decomposition |
| [ablation-original.json](ablation-original.json), [ablation-scattered.json](ablation-scattered.json) | Exact post-answer observed pool, tree versus flat; all selector requests/results included |
| [analysis.json](analysis.json) | Recomputed integrity checks, metrics and API usage |
| [scale.json](scale.json) | 4,500-record offline mechanics probe; scripted scores, not semantic accuracy |
| [official-session-audit.json](official-session-audit.json) | Actual official Web profile and persisted main/replica events |
| [official-main.png](official-main.png), [official-replica.png](official-replica.png) | Actual browser captures of the separate three-Source smoke test |
| [comparison.png](comparison.png), [comparison.svg](comparison.svg) | Charts of archived final measurements, not UI screenshots |
| [regression.log](regression.log), [artifact-verification.log](artifact-verification.log), [typecheck.log](typecheck.log), [docs-verification.log](docs-verification.log) | Saved local verification outputs |
| [latency-test.log](latency-test.log) | Additional timing decoder and fresh-candidate invariant test |

Compressed JSONL files contain per-input actual main request text, exact answers, selected evidence, replica tool/decision audit, state and checkpoint. Candidates are synthetic. Local temp paths identify the original experiment environment; replay can seed fresh paths. Raw answers include failures and unsupported statements.

The final policy source commit is `59c73dde8a4ca0437e6bbb4b3607c6439bb711ab`; source SHA-256 is recorded in each final evaluation JSON. The ablation also records the input trace SHA-256. Run `node scripts/summarize-jev-optmem.mjs` from the repository root to verify archived totals and injection/budget invariants without API calls.

These are single-run synthetic diagnostics, not a real-user accuracy benchmark. The scattered layout is a window-miss stress condition; all initial bounded probes miss the required evidence. Do not pool v1 and v2 or interpret keyword matches as correctness.
