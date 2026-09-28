/** Read persisted main DSH streams; no model API calls. */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { measureTurn } from './lib/jev-latency.ts'

const source = resolve(process.argv[2]), output = resolve(process.argv[3] ?? join(dirname(source), 'latency.json'))
const bytes = await readFile(source), evaluation = JSON.parse(bytes)
if (!evaluation.completedAt || !evaluation.executionPassed) throw new Error('Use a completed successful experiment')
const mean = values => values.reduce((n, value) => n + value, 0) / values.length
const percentile = (values, p) => [...values].sort((a,b) => a-b)[Math.ceil(values.length * p) - 1]
const arms = []
for (const run of evaluation.runs) {
  const ctx = new Context()
  await ctx.plugin(SessionStore); await ctx.plugin(Persistence, { root: join(run.root, 'main', 'sessions'), compression: 'none' })
  const sessions = new Map(), records = []
  try {
    const raw = gunzipSync(await readFile(join(dirname(source), run.traceFile))).toString().trim().split('\n').map(JSON.parse)
    for (const row of run.results) {
      if (!sessions.has(row.caseId)) {
        const handle = await ctx.sessionPersistence.open(SessionId(row.caseId), 'read')
        try { sessions.set(row.caseId, (await handle.read()).events) } finally { await handle.close() }
      }
      const original = raw.find(value => value.caseId === row.caseId && value.turnId === row.turnId)
      const timing = measureTurn(sessions.get(row.caseId), row.chat.turn, row.text, original.chat.candidate?.at)
      records.push({ caseId: row.caseId, turnId: row.turnId, harnessElapsedMs: row.chat.elapsedMs, ...timing })
    }
    const fields = Object.keys(records[0].milliseconds)
    const statistics = Object.fromEntries(fields.map(field => {
      const values = records.map(record => record.milliseconds[field])
      return [field, { samples: values.length, mean: mean(values), median: percentile(values, .5), p95: percentile(values, .95), max: Math.max(...values) }]
    }))
    arms.push({ mode: run.mode, statistics, records })
  } finally { await ctx.fiber.dispose() }
}
const report = { kind: 'durable-main-dsh-response-latency', sourceReport: process.argv[2], sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  method: 'From durable main DSH inbox insertion to non-whitespace text delta, last text and turn/end. Uses official compact stream expansion. Before-model time includes replica preparation and Host overhead; candidateReady ends at actual fresh publication. Excludes browser transport/render and session creation before followup. Millisecond wall-clock timestamps; one controlled reply per turn.',
  capturedAt: new Date().toISOString(), arms }
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ output, arms: arms.map(({ mode, statistics }) => ({ mode, statistics })) }))
