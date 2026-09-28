/**
 * Statistics for a benchmark run. Per arm: accuracy with a Wilson interval and a bootstrap interval that
 * resamples whole cases (a LoCoMo conversation's questions share one memory, so they are not independent),
 * token F1 and BLEU-1 against the gold answer, evidence in front of the model and accuracy by it, how often the
 * main model searched memory itself, tokens, cost (with the session notes' cost spread over the questions) and
 * latency. Per question type: accuracy with intervals. Between arms: the paired difference with a case bootstrap
 * interval and McNemar's exact test, Holm-adjusted over the comparisons. With grades-2.jsonl: how often the
 * judge agrees with itself (Cohen's kappa). And how the replica View and the main model's own search complement
 * each other. Offline; prices are DeepSeek's off-peak list prices (peak doubles them) and JEV's input price.
 *   node --experimental-transform-types scripts/bench/stats.ts <run-dir> [--notes <notes.jsonl>] [--data <dataset.json>] [--out stats.json] [--csv answers.csv]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { loadLocomo, loadLongMemEval } from './data.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { notes: { type: 'string' }, data: { type: 'string' }, out: { type: 'string' }, csv: { type: 'string' }, samples: { type: 'string', default: '10000' },
  refine: { type: 'string' } } })
const dir = positionals[0]
if (!dir) throw new Error('usage: stats.ts <run-dir> [--notes file] [--data file] [--out file]')
interface Usage { miss: number; hit: number; output: number; reasoning?: number }
interface Row { arm: string; dataset: 'locomo' | 'longmemeval'; case: string; id: string; type: string; abstention: boolean; answer: string; gold: string; elapsedMs: number
  main: Usage[]; replica?: { jev: number; recall: Usage[]; items: number; ms?: number }; evidence?: number }
interface Grade { arm: string; id: string; correct: boolean; f1?: number }
const lines = async <T>(file: string) => (await readFile(join(dir, file), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as T)
// With --refine (the reviewed LoCoMo labels): dropped questions leave, corrected ones are graded against the corrected answer.
const refine = values.refine ? JSON.parse(await readFile(values.refine, 'utf8')) as { version: string; fix: Record<string, { gold: string }>; drop: Record<string, unknown> } : undefined
// A question answered twice (a resumed run that repeated it) counts once: the first answer.
const rows = [...new Map((await lines<Row>('rows.jsonl')).reverse().map(row => [`${row.arm}/${row.id}`, row])).values()].reverse()
  .filter(row => !refine?.drop[row.id]).map(row => refine?.fix[row.id] ? { ...row, gold: refine.fix[row.id]!.gold } : row)
const regraded = new Map((refine ? await lines<Grade>('grades-refined.jsonl') : []).map(grade => [`${grade.arm}/${grade.id}`, grade]))
const grades = new Map((await lines<Grade>('grades.jsonl')).filter(grade => !refine?.fix[grade.id]).map(grade => [`${grade.arm}/${grade.id}`, grade] as [string, Grade]).concat([...regraded]))
const second = new Map((await lines<Grade>('grades-2.jsonl')).filter(grade => !refine?.fix[grade.id]).map(grade => [`${grade.arm}/${grade.id}`, grade]))
const dataset = rows[0]?.dataset ?? 'locomo'
const P = { miss: 0.15e-6, hit: 0.003e-6, output: 0.6e-6, jev: 0.042e-6 }
const priced = (u: Usage) => u.miss * P.miss + u.hit * P.hit + u.output * P.output

// Seeded PRNG so every interval can be reproduced.
let seed = 20260924
const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const B = Number(values.samples)
const sum = (list: number[]) => list.reduce((a, b) => a + b, 0), mean = (list: number[]) => list.length ? sum(list) / list.length : NaN
const quantile = (list: number[], q: number) => { const sorted = [...list].sort((a, b) => a - b); if (!sorted.length) return NaN; const at = (sorted.length - 1) * q, lo = Math.floor(at); return sorted[lo]! + (sorted[Math.min(lo + 1, sorted.length - 1)]! - sorted[lo]!) * (at - lo) }
function wilson(k: number, n: number, z = 1.959964) {
  if (!n) return [NaN, NaN] as const
  const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
  return [c - h, c + h] as const
}
/** Percentile interval of a statistic over cases resampled with replacement; `parts` maps each case to [numerator, denominator]. */
function caseBootstrap(parts: Array<[number, number]>) {
  if (!parts.length) return [NaN, NaN] as const
  const stats: number[] = []
  for (let b = 0; b < B; b++) { let num = 0, den = 0; for (let i = 0; i < parts.length; i++) { const [x, n] = parts[Math.floor(random() * parts.length)]!; num += x; den += n } stats.push(num / den) }
  return [quantile(stats, 0.025), quantile(stats, 0.975)] as const
}
const logFactorial: number[] = [0]
const lf = (n: number) => { for (let i = logFactorial.length; i <= n; i++) logFactorial.push(logFactorial[i - 1]! + Math.log(i)); return logFactorial[n]! }
/** McNemar's exact test: two-sided binomial on the discordant pairs. */
function mcnemar(b: number, c: number) {
  const n = b + c, k = Math.min(b, c)
  if (!n) return 1
  let tail = 0
  for (let i = 0; i <= k; i++) tail += Math.exp(lf(n) - lf(i) - lf(n - i) - n * Math.LN2)
  return Math.min(1, 2 * tail)
}
function holm(ps: number[]) {
  const order = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]), adjusted = new Array<number>(ps.length)
  let running = 0
  order.forEach(([p, i], rank) => { running = Math.max(running, Math.min(1, (ps.length - rank) * p)); adjusted[i] = running })
  return adjusted
}
const tokens = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(token => token && !['a', 'an', 'the', 'and'].includes(token))
/** BLEU-1: clipped unigram precision with the brevity penalty. */
function bleu1(prediction: string, gold: string) {
  const p = tokens(prediction), g = tokens(gold)
  if (!p.length) return 0
  const counts = new Map<string, number>()
  for (const token of g) counts.set(token, (counts.get(token) ?? 0) + 1)
  let clipped = 0
  for (const token of p) { const n = counts.get(token) ?? 0; if (n > 0) { clipped++; counts.set(token, n - 1) } }
  return (p.length > g.length ? 1 : Math.exp(1 - g.length / p.length)) * clipped / p.length
}

// Session notes are memory preparation: their cost is spread over every question that uses the notes.
let notesCost = 0, notesSessions = 0, notesInput = 0, notesOutput = 0
if (values.notes && values.data) {
  const cases = dataset === 'locomo' ? await loadLocomo(values.data) : await loadLongMemEval(values.data)
  const used = new Set(cases.filter(value => rows.some(row => row.case === value.id)).flatMap(value => value.sessions.map(session => session.id)))
  const seen = new Set<string>()
  for (const line of (await readFile(values.notes, 'utf8')).split('\n').filter(Boolean)) {
    const value = JSON.parse(line) as { key: string; usage: Usage }, parts = value.key.split(':'), id = parts.slice(1, -1).join(':')
    if (used.has(id) && !seen.has(id)) { seen.add(id); notesCost += priced(value.usage); notesSessions++; notesInput += value.usage.miss + value.usage.hit; notesOutput += value.usage.output }
  }
}
const questionsInRun = new Set(rows.map(row => row.id)).size
const tokensOf = (row: Row) => sum(row.main.map(u => u.miss + u.hit + u.output)) + (row.replica ? row.replica.jev + sum(row.replica.recall.map(u => u.miss + u.hit + u.output)) : 0)
const largest = (row: Row) => Math.max(0, ...row.main.map(u => u.miss + u.hit))
/** One answer's cost with the main model's price scaled, DeepSeek's prices scaled, the prompt cache on or off, and the side (recall, JEV) scaled. */
function costOf(row: Row, { main = 1, deepseek = 1, cache = true, side = 1 }: { main?: number; deepseek?: number; cache?: boolean; side?: number }) {
  const price = (u: Usage) => deepseek * (cache ? priced(u) : (u.miss + u.hit) * P.miss + u.output * P.output)
  return main * sum(row.main.map(price)) + side * (row.replica ? row.replica.jev * P.jev + sum(row.replica.recall.map(price)) : 0)
}

const arms = [...new Set(rows.map(row => row.arm))]
const graded = (arm: string) => rows.filter(row => row.arm === arm && grades.has(`${arm}/${row.id}`))
const correct = (row: Row) => grades.get(`${row.arm}/${row.id}`)!.correct
// The unit that shares a memory: a LoCoMo conversation (also when conversations were merged into one run), else the case.
const unit = (row: Row) => row.dataset === 'locomo' ? row.id.replace(/-q\d+$/, '') : row.case
function accuracy(list: Row[]) {
  const k = list.filter(correct).length, byCase = new Map<string, [number, number]>()
  for (const row of list) { const part = byCase.get(unit(row)) ?? [0, 0]; part[0] += Number(correct(row)); part[1]++; byCase.set(unit(row), part) }
  const [low, high] = wilson(k, list.length), [bootLow, bootHigh] = caseBootstrap([...byCase.values()])
  return { n: list.length, correct: k, accuracy: k / list.length, wilson: [low, high], caseBootstrap: [bootLow, bootHigh] }
}

const perArm: Record<string, unknown> = {}
for (const arm of arms) {
  const list = graded(arm), all = rows.filter(row => row.arm === arm)
  const cost = all.map(row => sum(row.main.map(priced)) + (row.replica ? row.replica.jev * P.jev + sum(row.replica.recall.map(priced)) : 0))
  const notes = arm.endsWith(':notes') || arm.endsWith(':hybrid') ? notesCost / Math.max(1, questionsInRun) : 0
  const withEvidence = list.filter(row => row.evidence !== undefined)
  const bucket = (test: (e: number) => boolean) => { const part = withEvidence.filter(row => test(row.evidence!)); return { n: part.length, accuracy: part.length ? part.filter(correct).length / part.length : NaN } }
  const pass2 = list.filter(row => second.has(`${arm}/${row.id}`))
  const agree = pass2.filter(row => second.get(`${arm}/${row.id}`)!.correct === correct(row)).length
  perArm[arm] = {
    answered: all.length, ...accuracy(list),
    ...(dataset === 'locomo' ? { f1: mean(list.map(row => grades.get(`${arm}/${row.id}`)!.f1 ?? 0)), bleu1: mean(list.map(row => bleu1(row.answer, row.gold))) } : {}),
    evidence: { mean: mean(withEvidence.map(row => row.evidence!)), full: bucket(e => e >= 1), partial: bucket(e => e > 0 && e < 1), none: bucket(e => e <= 0) },
    searched: mean(all.map(row => Number(row.main.length > 1))),
    tokens: { mainInput: mean(all.map(row => sum(row.main.map(u => u.miss + u.hit)))), mainCached: mean(all.map(row => sum(row.main.map(u => u.hit)))), mainOutput: mean(all.map(row => sum(row.main.map(u => u.output)))),
      reasoning: mean(all.map(row => sum(row.main.map(u => u.reasoning ?? 0)))), recallInput: mean(all.map(row => row.replica ? sum(row.replica.recall.map(u => u.miss + u.hit)) : 0)),
      recallCached: mean(all.map(row => row.replica ? sum(row.replica.recall.map(u => u.hit)) : 0)), recallOutput: mean(all.map(row => row.replica ? sum(row.replica.recall.map(u => u.output)) : 0)),
      jev: mean(all.map(row => row.replica?.jev ?? 0)), total: mean(all.map(tokensOf)) },
    // The main model's context: how many requests a question took, and the largest single request it read.
    context: { requests: mean(all.map(row => row.main.length)), largest: mean(all.map(largest)), largestP95: quantile(all.map(largest), 0.95), largestMax: Math.max(...all.map(largest)) },
    cost: { mean: mean(cost), median: quantile(cost, 0.5), p95: quantile(cost, 0.95), total: sum(cost), notesPerQuestion: notes, meanWithNotes: mean(cost) + notes,
      // The same tokens under other conditions: no prompt cache at all, DeepSeek's peak prices, and a main model 5x or 20x dearer.
      noCache: mean(all.map(row => costOf(row, { cache: false }))), peak: mean(all.map(row => costOf(row, { deepseek: 2 }))),
      main5x: mean(all.map(row => costOf(row, { main: 5 }))), main20x: mean(all.map(row => costOf(row, { main: 20 }))), mainShare: mean(all.map(row => costOf(row, { side: 0 }))) / Math.max(1e-12, mean(cost)) },
    latency: { mean: mean(all.map(row => row.elapsedMs)), p50: quantile(all.map(row => row.elapsedMs), 0.5), p95: quantile(all.map(row => row.elapsedMs), 0.95), replicaMs: mean(all.flatMap(row => row.replica?.ms === undefined ? [] : [row.replica.ms])) },
    ...(pass2.length ? { judge: { regraded: pass2.length, agreement: agree / pass2.length, accuracyPass2: pass2.filter(row => second.get(`${arm}/${row.id}`)!.correct).length / pass2.length } } : {}),
  }
}

// Question types: LoCoMo categories; LongMemEval types, with the abstention questions on their own.
const typeOf = (row: Row) => row.abstention ? 'abstention' : row.type
const types = [...new Set(rows.map(typeOf))].sort()
const perType: Record<string, Record<string, unknown>> = {}
for (const type of types) perType[type] = Object.fromEntries(arms.map(arm => [arm, accuracy(graded(arm).filter(row => typeOf(row) === type))]))

// Paired comparisons over the questions both arms answered and had graded.
const PAIRS: Array<[string, string, string]> = [
  ['replica-v4t:notes', 'full-context', 'v4t vs whole history in context'], ['replica-v4t:notes', 'main-only:notes', 'v4t vs main-only'],
  ['replica-v4:notes', 'main-only:notes', 'JEV cached recall vs main-only'], ['replica-scan:notes', 'main-only:notes', 'JEV full scan vs main-only'],
  ['replica-lexical:notes', 'main-only:notes', 'architecture alone (BM25 replica) vs main-only'],
  ['replica-v4:notes', 'replica-lexical:notes', 'JEV vs BM25 inside the replica'], ['replica-scan:notes', 'replica-v4:notes', 'JEV full scan vs cached recall'],
  ['replica-v4t:notes', 'replica-v4:notes', 'adding the main model\'s own search'], ['full-context', 'main-only:notes', 'whole history vs main-only'],
  ['replica-cue:notes', 'main-only:notes', 'cue recall vs main-only'], ['replica-cue:notes', 'replica-scan:notes', 'cue recall vs JEV full scan'],
  ['replica-cue:notes', 'replica-v4:notes', 'cue recall vs JEV cached recall'], ['replica-cue:notes', 'full-context', 'cue recall vs whole history in context'],
  ['replica-cue:raw-records', 'replica-cue:notes', 'cue recall: raw messages vs extracted notes'], ['replica-cue:raw', 'replica-cue:notes', 'cue recall: imported history vs extracted notes'],
  ['replica-cue:raw-records', 'main-only:notes', 'cue recall on raw messages vs main-only on notes'], ['replica-cue:raw-records', 'full-context', 'cue recall on raw messages vs whole history in context'],
  ['replica-cuefill:raw-records', 'replica-cue:raw-records', 'filled View vs entry line only, raw messages'], ['replica-cuefill:notes', 'replica-cue:notes', 'filled View vs entry line only, notes'],
  ['replica-cuefill:raw-records', 'replica-cuefill:notes', 'filled View: raw messages vs extracted notes'],
]
const comparisons = PAIRS.filter(([a, b]) => arms.includes(a) && arms.includes(b)).map(([a, b, label]) => {
  const other = new Map(graded(b).map(row => [row.id, row])), both = graded(a).filter(row => other.has(row.id))
  let onlyA = 0, onlyB = 0
  const byCase = new Map<string, [number, number]>()
  for (const row of both) {
    const x = Number(correct(row)), y = Number(correct(other.get(row.id)!))
    if (x && !y) onlyA++; if (!x && y) onlyB++
    const part = byCase.get(unit(row)) ?? [0, 0]; part[0] += x - y; part[1]++; byCase.set(unit(row), part)
  }
  const [low, high] = caseBootstrap([...byCase.values()])
  return { a, b, label, n: both.length, difference: (onlyA - onlyB) / both.length, interval: [low, high], onlyA, onlyB, p: mcnemar(onlyA, onlyB) }
})
holm(comparisons.map(value => value.p)).forEach((p, i) => { (comparisons[i] as Record<string, unknown>).pHolm = p })

// Judge self-consistency over everything graded twice.
const twice = rows.filter(row => grades.has(`${row.arm}/${row.id}`) && second.has(`${row.arm}/${row.id}`))
let judge: Record<string, number> | undefined
if (twice.length) {
  const first = twice.map(row => grades.get(`${row.arm}/${row.id}`)!.correct), again = twice.map(row => second.get(`${row.arm}/${row.id}`)!.correct)
  const po = mean(first.map((value, i) => Number(value === again[i]))), p1 = mean(first.map(Number)), p2 = mean(again.map(Number)), pe = p1 * p2 + (1 - p1) * (1 - p2)
  judge = { graded: twice.length, agreement: po, kappa: (po - pe) / (1 - pe), flippedToCorrect: twice.filter((_, i) => !first[i] && again[i]).length, flippedToWrong: twice.filter((_, i) => first[i] && !again[i]).length }
}

// Complementarity: the replica View alone and the main model's own search, and what the combined arm did.
let complement: Record<string, unknown> | undefined
const [viewArm, searchArm, bothArm] = ['replica-v4:notes', 'main-only:notes', 'replica-v4t:notes']
if (arms.includes(viewArm) && arms.includes(searchArm)) {
  const search = new Map(graded(searchArm).map(row => [row.id, correct(row)])), combined = new Map(graded(bothArm).map(row => [row.id, correct(row)]))
  const cells: Record<string, { n: number; combinedCorrect: number }> = {}
  const pairs = graded(viewArm).filter(row => search.has(row.id))
  for (const row of pairs) {
    const cell = `${correct(row) ? 'view right' : 'view wrong'} / ${search.get(row.id) ? 'search right' : 'search wrong'}`
    const value = cells[cell] ??= { n: 0, combinedCorrect: 0 }
    value.n++; if (combined.get(row.id)) value.combinedCorrect++
  }
  complement = { questions: pairs.length, either: pairs.filter(row => correct(row) || search.get(row.id)).length / pairs.length, cells }
}

const result = { dataset, questions: questionsInRun, ...(refine ? { refine: { version: refine.version, fixed: Object.keys(refine.fix).length, dropped: Object.keys(refine.drop).length } } : {}), bootstrapSamples: B, prices: P, notes: { sessions: notesSessions, cost: notesCost, inputTokens: notesInput, outputTokens: notesOutput }, perArm, perType, comparisons, judge, complement,
  failures: (await lines<{ arm: string }>('failures.jsonl')).length }
if (values.out) await writeFile(values.out, JSON.stringify(result, null, 1))
// One line per answer: enough to recompute every table without the raw run.
if (values.csv) {
  const cell = (value: unknown) => typeof value === 'string' && /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value === undefined ? '' : String(value)
  const header = ['dataset', 'arm', 'case', 'id', 'type', 'abstention', 'correct', 'correct_pass2', 'f1', 'bleu1', 'evidence', 'searched', 'cost_usd', 'elapsed_ms', 'main_input', 'main_cached', 'main_output', 'recall_tokens', 'jev_tokens']
  const body = rows.map(row => [dataset, row.arm, row.case, row.id, row.type, row.abstention, grades.get(`${row.arm}/${row.id}`)?.correct, second.get(`${row.arm}/${row.id}`)?.correct,
    grades.get(`${row.arm}/${row.id}`)?.f1?.toFixed(4), dataset === 'locomo' ? bleu1(row.answer, row.gold).toFixed(4) : undefined, row.evidence?.toFixed(3), row.main.length > 1,
    (sum(row.main.map(priced)) + (row.replica ? row.replica.jev * P.jev + sum(row.replica.recall.map(priced)) : 0)).toFixed(6), Math.round(row.elapsedMs),
    sum(row.main.map(u => u.miss + u.hit)), sum(row.main.map(u => u.hit)), sum(row.main.map(u => u.output)), row.replica ? sum(row.replica.recall.map(u => u.miss + u.hit + u.output)) : 0, row.replica?.jev ?? 0].map(cell).join(','))
  await writeFile(values.csv, [header.join(','), ...body].join('\n') + '\n')
}
const pct = (value: number) => Number.isFinite(value) ? (100 * value).toFixed(1) : '-'
console.log(`${dataset}: ${questionsInRun} questions, notes for ${notesSessions} sessions cost $${notesCost.toFixed(2)}`)
for (const [arm, value] of Object.entries(perArm) as Array<[string, any]>)
  console.log(arm.padEnd(26), `acc ${pct(value.accuracy)} [${pct(value.wilson[0])}, ${pct(value.wilson[1])}] boot [${pct(value.caseBootstrap[0])}, ${pct(value.caseBootstrap[1])}] n ${value.n}/${value.answered}`,
    `cost $${value.cost.mean.toFixed(5)} (+notes $${value.cost.notesPerQuestion.toFixed(5)}) p50 ${(value.latency.p50 / 1000).toFixed(1)}s p95 ${(value.latency.p95 / 1000).toFixed(1)}s`,
    `tokens ${Math.round(value.tokens.total)} main-in ${Math.round(value.tokens.mainInput)} largest ${Math.round(value.context.largest)} req ${value.context.requests.toFixed(2)}`, value.judge ? `judge agree ${pct(value.judge.agreement)}` : '')
for (const value of comparisons) console.log(`${value.label.padEnd(48)} ${pct(value.difference)} pt [${pct(value.interval[0]!)}, ${pct(value.interval[1]!)}] ${value.onlyA}/${value.onlyB} p ${value.p.toExponential(2)} holm ${(value as any).pHolm.toExponential(2)}`)
if (judge) console.log('judge', JSON.stringify(judge))
if (complement) console.log('complement', JSON.stringify(complement))
