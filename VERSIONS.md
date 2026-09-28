# Versions

Everything the paper's runs used, with where each version is recorded.

## Code

| Component | Version | Recorded in |
|---|---|---|
| This snapshot | research branch `codex/jev-replica-practice` of dsh-mnemon at `3bbf7835` (2026-09-28) | `PROVENANCE.json` |
| dsh-mnemon base | v0.5.13 (commit `84d469ff`, 2026-09-22) plus 216 research commits | `package.json` (`"version": "0.5.13"`) |
| DeepSeek Harness (DSH) | 0.1.5-rc.1 for the `@deepseek-ai/dsh-*` cohort; `dsh-session-projection`, versioned separately, is 0.1.0-rc.8 | `pnpm-lock.yaml`; the cohort is enumerated in `pnpm-workspace.yaml` |
| Cordis | `@deepseek-ai/cordis` 4.0.2 | `pnpm-lock.yaml` |
| JEV client | `@typesafe-ai/sdk` 0.6.0 | `pnpm-lock.yaml` |
| TypeScript / tsdown | 5.9.3 / 0.22.14 | `pnpm-lock.yaml` |
| Node.js | v25.1.0 (every run config records it) | `config-*.json` of each run |
| pnpm | 11.x (the snapshot was verified with 11.19.0) | — |

The code of each paper number ran at the commit listed for its run directory in `docs/run-commits.json`: 39 run
directories over 25 commits of the research branch, 7 of them from a working tree with uncommitted changes. The
snapshot is the branch at `3bbf7835`; it is not claimed to behave identically to every earlier commit for every
configuration.

The warm-index timings in `docs/paper/data/retrieval.json` were measured on one laptop (Apple M4, 24 GB, Node.js
v25.1.0), with every query embedded by a local llama-server running nomic-embed-text; the file records the machine.

## Models

| Role | Model | Notes |
|---|---|---|
| System 1 (JEV) | TypeSafe System One, requested as `jev-latest` | run configs record `jev-1.13.0` |
| Answering and recall planning, gpt-4.1-mini runs | `gpt-4.1-mini` (OpenAI API), temperature 0 | 47 run configs |
| Answering, DeepSeek runs | `deepseek-flash`, thinking enabled, reasoning effort high | 38 run configs |
| Recall planning, DeepSeek runs | `deepseek-flash`, thinking disabled | |
| Session notes (notes memory mode) | `deepseek-flash`, thinking disabled, temperature 0 | every run config |
| Consolidation | `deepseek-flash` without thinking | `recallOptions.consolidate` of the consolidated runs |
| Embeddings (hybrid search, consolidation) | `nomic-embed-text`, served locally | `recallOptions.embedUrl` (a local server) |
| Judges | `gpt-4.1-mini` and DeepSeek | `grades-gpt-4.1-mini.jsonl` and `grades.jsonl` in each run directory |

## Data

| Benchmark | File the scripts read | Packaged here |
|---|---|---|
| LoCoMo | `benchmarks/locomo10.json` | no: download it (see README) |
| LongMemEval-S (cleaned) | `benchmarks/longmemeval_s_cleaned.json` | no: download it (see README) |
| LoCoMo refined labels | `bench-full-20260924/locomo-refine/locomo-refined.json` | yes, in `runs/` |
| BEAM-100K, HaluMem | converted case files | no; the packaged run records carry what `collect.py` needs, except HaluMem's, which are not included (CC BY-NC-ND 4.0) |
