# Mnemon memory agent: paper artifact

[中文](README.zh-CN.md)

This repository holds the system evaluated in the technical report *Read Raw, Judge Fast: Mnemon* (`docs/paper`),
the run records its numbers are computed from, and the tools that produced this snapshot.

Mnemon here is a two-system memory agent built on DeepSeek Harness (DSH). A dedicated memory DSH runs beside the
main DSH. It keeps raw conversation records, plans searches with an LLM, lets the JEV decision model judge what the
latest message needs (System 1), and consolidates each record once into an index that links back to it. The main
DSH receives the selection as a View.

**What this is not.** It is not the `mnemon` CLI ([mnemon-dev/mnemon](https://github.com/mnemon-dev/mnemon)), which
is a separate product, and not Mnemon Agency. The evaluated system does not use the `mnemon` binary. It is also not
a release of the `dsh-mnemon` package: it is a frozen research snapshot.

**Status.** Snapshot of the research branch at `e5c7954a` (2026-09-28). The paper is still being finalized, and the
snapshot will be refreshed with `tools/snapshot.py` when its numbers freeze.

## Contents

| Path | What |
|---|---|
| `docs/paper/` | The paper: LaTeX sources, bibliography, data, generated tables and figures, `main.pdf`, and its scripts |
| `docs/reports/` | The pre-registrations and study reports the paper cites |
| `docs/pr-assets/` | Only the report assets those reports link to |
| `docs/plans/` | The two design notes the reports link to |
| `runs/` | The run records `collect.py` reads, gzip-compressed, with `MANIFEST.json` |
| `docs/run-commits.json` | For each run directory, the code commit and models its runs recorded |
| `src/` | The dsh-mnemon kernel at the snapshot commit |
| `plugins/` | The 18 plugins the scripts and the kernel build need |
| `scripts/` | The evaluation harness (`scripts/bench`), the replica launcher and their libraries |
| `tools/` | How this snapshot is made and checked (see below) |
| `VERSIONS.md` | DSH, dsh-mnemon, model and dataset versions |
| `PROVENANCE.json` | Source commit, and each file's git blob id and SHA-256 |

## Reproduce the paper's numbers (no API keys)

Every number in the paper comes from `docs/paper/scripts/collect.py`, which reads the run records.

```sh
python3 tools/restore_runs.py                     # expands runs/ into runs-expanded/ and checks every file
# Put the two public datasets beside them:
#   runs-expanded/benchmarks/locomo10.json              LoCoMo, from github.com/snap-research/locomo
#   runs-expanded/benchmarks/longmemeval_s_cleaned.json LongMemEval-S (cleaned), from the LongMemEval release
MNEMON_RUNS=$PWD/runs-expanded python3 docs/paper/scripts/collect.py   # rewrites docs/paper/data/results.json
git diff --stat docs/paper/data/results.json      # only the HaluMem entries change: their records are not included
TECTONIC=tectonic PYTHON=python3 bash docs/paper/build.sh   # tables, figures (matplotlib) and main.pdf
```

`beam_evidence.py` additionally needs `pyarrow` and BEAM's `100K.parquet`.

## Run the system

Requirements: Node.js 25 (the runs used v25.1.0) and pnpm 11.

```sh
pnpm install --frozen-lockfile        # installs DSH 0.1.5-rc.1 exactly as the runs did
pnpm run build && pnpm run build:plugins
pnpm -r --filter 'dsh-mnemon-*' test --passWithNoTests
```

Live runs call external models. Provide the keys in the environment or in a local `.env` (git-ignored), never in
the repository:

| Variable | For |
|---|---|
| `TYPESAFE_API_KEY` | JEV (System 1) |
| `DEEPSEEK_API_KEY` | DeepSeek answering, planning, notes and consolidation |
| `OPENAI_API_KEY` | gpt-4.1-mini runs and judging |
| `OPENAI_BASE_URL` | optional; defaults to the OpenAI API |

A two-question smoke run of the final configuration's core (it answered both questions when this snapshot was made):

```sh
node --env-file=.env --experimental-transform-types scripts/bench/run.ts --dataset locomo \
  --file runs-expanded/benchmarks/locomo10.json --cases conv-26 --questions 2 \
  --arms replica-cuefill:raw-records --no-thinking --concurrency 1 --out out/smoke
```

The final version adds `--simple`, hybrid search with `--embed-url <local nomic-embed-text server>`, and
`--consolidate deepseek-flash`; the header of `scripts/bench/run.ts` documents every option.

## How the snapshot is made and checked

| Tool | Does |
|---|---|
| `tools/snapshot.py` | Copies the paper's part of the research branch byte for byte: the kernel, the plugins the scripts import (found by following imports), the scripts, the paper, the reports and what they link to; writes `PROVENANCE.json` |
| `tools/scrub.py` | Replaces machine-specific absolute paths with `<repo>`, `<tmp>` or `~` and records every rewritten file under `modified` in `PROVENANCE.json` |
| `tools/collect_runs.py` | Runs `collect.py` on the full records, keeps exactly the files it opens, and checks the recomputed `results.json` against the committed one |
| `tools/restore_runs.py` | Expands `runs/` and verifies each file against `runs/MANIFEST.json` |
| `tools/run_commits.py` | Writes `docs/run-commits.json` |
| `tools/audit.py` | Fails on credentials, local paths, non-loopback endpoints or files over 50 MB |

Checked for this snapshot: the recomputed `results.json` equals the committed one using only `runs/` and the two
datasets, except the HaluMem entries, whose run records are not included; the frozen-lockfile install, the kernel and plugin builds, and the plugins' 223 tests pass; the smoke run
above answered both questions; `tools/audit.py` is clean.

## Fidelity

- Files listed in `PROVENANCE.json` equal the source commit, except the ones under `modified` (path placeholders only).
- The paper's run directories ran at 25 different commits (`docs/run-commits.json`); the snapshot is the latest of
  the branch, not each of those commits.
- Three plugins (Memory Spaces, Runtime, three-tier) are here only because the kernel's client bundles their pages;
  they ship without their tests, which exercise product components outside this snapshot.
- Git history is not included.

## Licenses and data

The code is dsh-mnemon's, under the MIT license in `LICENSE`. The run records and report assets contain text derived
from LoCoMo, LongMemEval and BEAM; check each dataset's license before redistributing them. HaluMem's run records
are not included: its license (CC BY-NC-ND 4.0) does not allow sharing adapted material.
