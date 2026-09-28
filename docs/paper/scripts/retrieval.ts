/**
 * Warm-index retrieval micro-benchmark (data/retrieval.json): the journal Source's own search Route, built as in the
 * runs (the kernel's `createRecordSource` with the journal plugin's options, `searchCache` on), over the final runs'
 * journals: the largest memory of each benchmark (ten histories for LongMemEval-S, whose memories are one question each).
 *
 * Warm means that every record is embedded and the word index is built before timing. Reads are timed one at a time,
 * with the cues the replica searched in that memory:
 *   hybrid  BM25 and nomic-embed-text cosine, fused by RRF (the runs' setting), with every cue's embedding computed
 *           fresh by a local embedding server, so that it counts in the time
 *   words   BM25 alone
 *   head    the newest 20 records, as the replica's observation reads them
 *   ids     20 known records by id
 * Queries go to an OpenAI-compatible embeddings endpoint (MNEMON_QUERY_EMBED_URL); the records' vectors, needed only to
 * warm the index, to an Ollama-compatible one (MNEMON_EMBED_URL). The run records and their journals live outside the
 * repository; point MNEMON_RUNS at them:
 *
 *   node --experimental-transform-types docs/paper/scripts/retrieval.ts
 */
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { arch, cpus, platform, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { createRecordSource } from '../../../src/sdk/source/source.ts'
import { sourceOptions } from '../../../plugins/dsh-mnemon-source-journal/src/source.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const RUNS = process.env.MNEMON_RUNS ?? join(HERE, '../../../../runs')
const QUERY_URL = process.env.MNEMON_QUERY_EMBED_URL ?? 'http://127.0.0.1:8091/v1/embeddings'
const DOCUMENT_URL = (process.env.MNEMON_EMBED_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '') + '/api/embed'
const P3 = join(RUNS, 'phase03-20260925')
// The journal's directory for the runs' Source instance ('source:experiment-journal').
const RECORDS = 'corpus/shared-plugin-data/sources/journal/90cb1d8c784bd7ff0e38/records.json'
const MEMORIES = [
  { key: 'locomo', root: 'steps/mini-simple-consolidated/locomo/replica-cuefill-raw-records', memories: 1 },
  { key: 'lme', root: 'steps/lme-final-workspaces/replica-cuefill-raw-records', memories: 10 },
  { key: 'halumem', root: 'heldout/halumem-consolidated/replica-cuefill-raw-records', memories: 1 },
  { key: 'beam100k', root: 'heldout/beam128k-consolidated/replica-cuefill-raw-records', memories: 1 },
  { key: 'beam10m', root: 'heldout/beam10m-workspaces/replica-cuefill-raw-records', memories: 1 },
]
const QUERIES = 60

let queryMs = 0
async function embed(texts: string[], kind: 'query' | 'document'): Promise<number[][]> {
  if (kind === 'query') {
    // A kept-alive connection the server closed during a long warm-up fails once: retry, timing the attempt that answers.
    for (let attempt = 0; ; attempt++) {
      const started = performance.now()
      try {
        const response = await fetch(QUERY_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'nomic-embed-text', input: texts.map(text => 'search_query: ' + text) }) })
        const reply = await response.json() as { data: Array<{ index: number; embedding: number[] }> }
        queryMs += performance.now() - started
        return reply.data.sort((a, b) => a.index - b.index).map(value => value.embedding)
      } catch (error) { if (attempt >= 2) throw error }
    }
  }
  const out: number[][] = []
  for (let start = 0; start < texts.length; start += 1024) {
    const response = await fetch(DOCUMENT_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', input: texts.slice(start, start + 1024).map(text => 'search_document: ' + text) }) })
    if (!response.ok) throw new Error('Document embedding failed: ' + response.status)
    out.push(...(await response.json() as { embeddings: number[][] }).embeddings)
  }
  return out
}

async function largest(root: string, count: number): Promise<string[]> {
  const found: Array<{ path: string; size: number }> = []
  for (const name of await readdir(root)) {
    if (name.includes('.attempt-')) continue
    try { found.push({ path: join(root, name), size: (await stat(join(root, name, RECORDS))).size }) } catch { /* not a memory */ }
  }
  return found.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path)).slice(0, count).map(value => value.path)
}
/** The cues the replica searched in one memory, in trace order. A resumed memory keeps traces in `<name>.attempt-<n>`; HaluMem keeps one per question under cases/. */
async function cuesOf(memory: string): Promise<string[]> {
  const parent = join(memory, '..'), base = memory.split('/').pop()!
  const dirs = [memory, ...(await readdir(parent)).filter(name => name.startsWith(base + '.attempt-')).map(name => join(parent, name))]
  const traces: string[] = []
  for (const dir of dirs) {
    traces.push(join(dir, 'replica/natural/traces'))
    for (const name of (await readdir(join(dir, 'cases')).catch(() => [] as string[])).sort()) traces.push(join(dir, 'cases', name, 'replica/natural/traces'))
  }
  const seen = new Set<string>()
  for (const dir of traces) for (const file of (await readdir(dir).catch(() => [] as string[])).sort()) for (const line of (await readFile(join(dir, file), 'utf8')).split('\n')) {
    if (!line.trim()) continue
    const entry = JSON.parse(line)
    if (entry.trigger !== 'input') continue
    for (const cue of entry.cues?.cues ?? []) if (cue.text) seen.add(cue.text)
    for (const round of entry.cues?.loop?.rounds ?? []) for (const text of round.rewritten ?? []) seen.add(text)
  }
  return [...seen]
}
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), at = (p: number) => sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))]!
  return { n: values.length, p50: +at(0.5).toFixed(2), p90: +at(0.9).toFixed(2), mean: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2) }
}

const scratch = await mkdtemp(join(tmpdir(), 'mnemon-retrieval-'))
const results: Record<string, unknown> = {}
for (const { key, root, memories } of MEMORIES) {
  const hybrid: number[] = [], queryEmbedding: number[] = [], words: number[] = [], head: number[] = [], ids: number[] = []
  const used: Array<{ memory: string; records: number; cues: number; warmUpMs: number }> = []
  const chosen = await largest(join(P3, root), memories)
  for (const memory of chosen) {
    // A private data directory whose records.json links to the run's: nothing is written next to the runs.
    const dataDir = join(scratch, key)
    await rm(dataDir, { recursive: true, force: true })
    await mkdir(join(dataDir, 'sources/journal/90cb1d8c784bd7ff0e38'), { recursive: true })
    await symlink(join(memory, RECORDS), join(dataDir, 'sources/journal/90cb1d8c784bd7ff0e38/records.json'))
    const records = (JSON.parse(await readFile(join(memory, RECORDS), 'utf8')) as { records: Array<{ id: string; workspaceId?: string }> }).records
    const scope = { workspaceId: records.find(record => record.workspaceId)?.workspaceId ?? '/' } as never
    const source = await createRecordSource(sourceOptions, { dataDir, embed, searchCache: true, capacity: { records: 200_000, bytes: 1024 ** 3 } })
      .create({ sourceInstanceKey: 'source:experiment-journal', configuration: {} } as never)
    const facts = await source.facts!({ scope } as never)
    const { readGrant } = await source.project!({ scope, expectedRevision: facts.revision, includeProjection: false, mode: 'routed', maxCharacters: 1000 } as never)
    const route = { id: 'search', sourceRouteId: 'search', maxResults: 20, maxCharacters: 12_000 }
    let views = 0
    const read = (input: Record<string, unknown>) => source.query!({ input, grant: readGrant, route, view: { id: 'view-' + views++, scope } } as never)
    // Warm-up with a query no cue repeats: every record is embedded and the word index built; not timed as a search.
    const warmStart = performance.now()
    await read({ query: 'warm up the index', match: 'hybrid', limit: 20 })
    const warmUpMs = performance.now() - warmStart
    await read({ query: 'warm up the index', match: 'words', limit: 20 })
    await read({ query: '', limit: 20 })
    const cues = (await cuesOf(memory)).slice(0, Math.ceil(QUERIES / chosen.length))
    for (const cue of cues) {
      queryMs = 0
      let started = performance.now()
      await read({ query: cue, match: 'hybrid', limit: 20 })
      hybrid.push(performance.now() - started); queryEmbedding.push(queryMs)
      started = performance.now()
      await read({ query: cue, match: 'words', limit: 20 })
      words.push(performance.now() - started)
    }
    for (let i = 0; i < 20; i++) {
      let started = performance.now()
      await read({ query: '', limit: 20 })
      head.push(performance.now() - started)
      const pick = Array.from({ length: 20 }, (_, j) => records[(i * 7919 + j * 104729) % records.length]!.id)
      started = performance.now()
      await read({ ids: pick, limit: 20 })
      ids.push(performance.now() - started)
    }
    used.push({ memory: memory.slice(P3.length + 1), records: records.length, cues: cues.length, warmUpMs: Math.round(warmUpMs) })
  }
  results[key] = { memories: used, records: Math.max(...used.map(value => value.records)), hybrid: summary(hybrid), queryEmbedding: summary(queryEmbedding),
    words: summary(words), head: summary(head), ids: summary(ids) }
  console.log(key, JSON.stringify({ records: results[key] && Math.max(...used.map(value => value.records)), hybrid: summary(hybrid).p50, words: summary(words).p50 }))
}
await rm(scratch, { recursive: true, force: true })
const machine = { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, cores: cpus().length, memoryGiB: Math.round(totalmem() / 1024 ** 3), node: process.version }
await writeFile(join(HERE, '../data/retrieval.json'), JSON.stringify({ measuredAt: new Date().toISOString().slice(0, 10), machine, results }, null, 1) + '\n')
