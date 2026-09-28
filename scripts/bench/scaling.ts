/**
 * How each arm scales with the length of the history: the same LongMemEval questions at 1x (the full run) and with
 * histories padded to k times as many sessions (run.ts --pad k). Per scale and arm: questions answered and failed
 * (a request over the model's context counts as failed), accuracy over the answered questions and with failures
 * counted wrong, tokens (all, what the main model read, its largest single request, recall, JEV), cost with the
 * prompt cache as run and without it, and latency. Within each arm, every scale against 1x on the same questions:
 * the difference and McNemar's exact test. Offline.
 *   node --experimental-transform-types scripts/bench/scaling.ts --base <1x run> 2=<dir> 4=<dir> 8=<dir> [--out scaling.json] [--chart scaling.svg]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { lines as lineChart, svg, type Series } from '../natural/svg.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { base: { type: 'string' }, out: { type: 'string' }, chart: { type: 'string' } } })
if (!values.base || !positionals.length) throw new Error('usage: scaling.ts --base <1x run> k=<dir>... [--out file] [--chart file]')
interface Usage { miss: number; hit: number; output: number }
interface Row { arm: string; id: string; elapsedMs: number; main: Usage[]; replica?: { jev: number; recall: Usage[] } }
const P = { miss: 0.15e-6, hit: 0.003e-6, output: 0.6e-6, jev: 0.042e-6 }
const read = async <T>(dir: string, file: string) => (await readFile(join(dir, file), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as T)
const sum = (list: number[]) => list.reduce((a, b) => a + b, 0), mean = (list: number[]) => list.length ? sum(list) / list.length : NaN
const quantile = (list: number[], q: number) => { const sorted = [...list].sort((a, b) => a - b); if (!sorted.length) return NaN; const at = (sorted.length - 1) * q, lo = Math.floor(at); return sorted[lo]! + (sorted[Math.min(lo + 1, sorted.length - 1)]! - sorted[lo]!) * (at - lo) }
const lf: number[] = [0]
const logFactorial = (n: number) => { for (let i = lf.length; i <= n; i++) lf.push(lf[i - 1]! + Math.log(i)); return lf[n]! }
const mcnemar = (b: number, c: number) => { const n = b + c; if (!n) return 1; let tail = 0; for (let i = 0; i <= Math.min(b, c); i++) tail += Math.exp(logFactorial(n) - logFactorial(i) - logFactorial(n - i) - n * Math.LN2); return Math.min(1, 2 * tail) }
const priced = (u: Usage, cache = true) => (cache ? u.miss * P.miss + u.hit * P.hit : (u.miss + u.hit) * P.miss) + u.output * P.output
const cost = (row: Row, cache = true) => sum(row.main.map(u => priced(u, cache))) + (row.replica ? row.replica.jev * P.jev + sum(row.replica.recall.map(u => priced(u, cache))) : 0)

const scales = [{ k: 1, dir: values.base }, ...positionals.map(value => { const [k, dir] = value.split('='); return { k: Number(k), dir: dir! } })].sort((a, b) => a.k - b.k)
const loaded = await Promise.all(scales.map(async ({ k, dir }) => ({ k, rows: [...new Map((await read<Row>(dir, 'rows.jsonl')).reverse().map(row => [`${row.arm}/${row.id}`, row])).values()],
  correct: new Map((await read<{ arm: string; id: string; correct: boolean }>(dir, 'grades.jsonl')).map(grade => [`${grade.arm}/${grade.id}`, grade.correct])),
  failures: await read<{ arm: string; id?: string; error: string }>(dir, 'failures.jsonl') })))
// The questions every padded run asked (a stratified subset); the full 1x run is cut down to them.
const asked = loaded.filter(scale => scale.k > 1).map(scale => new Set([...scale.rows.map(row => row.id), ...scale.failures.flatMap(failure => failure.id ? [failure.id] : [])]))
const questions = new Set([...asked[0]!].filter(id => asked.every(set => set.has(id))))
const arms = [...new Set(loaded.filter(scale => scale.k > 1).flatMap(scale => scale.rows.map(row => row.arm)))]

const result: Record<string, Record<number, Record<string, number>>> = {}
for (const arm of arms) {
  result[arm] = {}
  const base = loaded[0]!
  for (const scale of loaded) {
    const rows = scale.rows.filter(row => row.arm === arm && questions.has(row.id)), answered = new Set(rows.map(row => row.id))
    const failed = new Set(scale.failures.filter(failure => failure.arm === arm && failure.id && questions.has(failure.id) && !answered.has(failure.id)).map(failure => failure.id!))
    const overflow = new Set(scale.failures.filter(failure => failure.arm === arm && failed.has(failure.id ?? '') && /context|length|too long|maximum|400/i.test(failure.error)).map(failure => failure.id!))
    const graded = rows.filter(row => scale.correct.has(`${arm}/${row.id}`)), right = graded.filter(row => scale.correct.get(`${arm}/${row.id}`))
    let onlyBase = 0, onlyHere = 0
    for (const row of graded) {
      const before = base.correct.get(`${arm}/${row.id}`)
      if (before === undefined) continue
      const now = scale.correct.get(`${arm}/${row.id}`)!
      if (before && !now) onlyBase++; if (!before && now) onlyHere++
    }
    result[arm]![scale.k] = { answered: rows.length, failed: failed.size, overflow: overflow.size, accuracy: right.length / Math.max(1, graded.length),
      accuracyFailuresWrong: right.length / Math.max(1, graded.length + failed.size), vsBase: (onlyHere - onlyBase) / Math.max(1, graded.length), lostVsBase: onlyBase, gainedVsBase: onlyHere, p: mcnemar(onlyBase, onlyHere),
      tokens: mean(rows.map(row => sum(row.main.map(u => u.miss + u.hit + u.output)) + (row.replica ? row.replica.jev + sum(row.replica.recall.map(u => u.miss + u.hit + u.output)) : 0))),
      mainRead: mean(rows.map(row => sum(row.main.map(u => u.miss + u.hit)))), largestRequest: mean(rows.map(row => Math.max(0, ...row.main.map(u => u.miss + u.hit)))),
      recallInput: mean(rows.map(row => row.replica ? sum(row.replica.recall.map(u => u.miss + u.hit)) : 0)), jev: mean(rows.map(row => row.replica?.jev ?? 0)),
      cost: mean(rows.map(row => cost(row))), costNoCache: mean(rows.map(row => cost(row, false))), p50: quantile(rows.map(row => row.elapsedMs), 0.5), p95: quantile(rows.map(row => row.elapsedMs), 0.95) }
  }
}
if (values.out) await writeFile(values.out, JSON.stringify({ questions: questions.size, scales: scales.map(scale => scale.k), prices: P, arms: result }, null, 1))
for (const [arm, byScale] of Object.entries(result)) for (const [k, v] of Object.entries(byScale))
  console.log(arm.padEnd(24), `${k}x`.padEnd(3), `answered ${v.answered} failed ${v.failed} (overflow ${v.overflow})`, `acc ${(100 * v.accuracy!).toFixed(1)} vs 1x ${(100 * v.vsBase!).toFixed(1)} p ${v.p!.toFixed(3)}`,
    `tokens ${Math.round(v.tokens!)} main ${Math.round(v.mainRead!)} largest ${Math.round(v.largestRequest!)} cost $${v.cost!.toFixed(5)} p50 ${(v.p50! / 1000).toFixed(1)}s`)

if (values.chart) {
  const ARMS: Array<[string, string, Series['cls']]> = [['full-context', '整段放入上下文', 'l4'], ['main-only:notes', '仅主 DSH', 'lc'], ['replica-lexical:notes', '副实例 · BM25', 'l2'],
    ['replica-scan:notes', '副实例 · JEV 全量扫描', 'l5'], ['replica-v4:notes', '副实例 · JEV（v4）', 'l1'], ['replica-v4t:notes', 'v4t', 'l3']]
  const series = (metric: string, floor = 0) => ARMS.filter(([arm]) => result[arm]).map(([arm, label, cls]) => ({ label, cls,
    points: scales.flatMap(({ k }) => { const v = result[arm]![k]?.[metric]; return v !== undefined && Number.isFinite(v) && v > floor ? [[Math.log2(k), v] as [number, number]] : [] }) }))
  const xTicks = scales.map(({ k }) => Math.log2(k)), formatX = (value: number) => `${2 ** value}×`, xMax = Math.max(...xTicks)
  const width = 1000, column = 480, height = 330
  const powers = (low: number, high: number) => { const ticks: number[] = []; for (let e = Math.floor(Math.log10(low)); e <= Math.ceil(Math.log10(high)); e++) ticks.push(10 ** e); return ticks }
  const range = (metric: string) => { const all = Object.values(result).flatMap(byScale => Object.values(byScale).map(v => v[metric]!)).filter(v => Number.isFinite(v) && v > 0); return [10 ** Math.floor(Math.log10(Math.min(...all))), 10 ** Math.ceil(Math.log10(Math.max(...all)))] as const }
  const [tLow, tHigh] = range('tokens'), [mLow, mHigh] = range('largestRequest'), [cLow, cHigh] = range('cost')
  const panels = [
    lineChart(24, 70, column, height, '准确率（答出的题）', series('accuracy'), xMax, 1, xTicks, [0.4, 0.6, 0.8, 1], v => `${Math.round(v * 100)}%`, '历史长度', 150, undefined, formatX),
    lineChart(24 + column + 16, 70, column, height, '每题 token（主 + 召回 + JEV，对数）', series('tokens'), xMax, tHigh, xTicks, powers(tLow, tHigh), v => v >= 1e6 ? `${v / 1e6}M` : v >= 1e3 ? `${v / 1e3}k` : String(v), '历史长度', 150, tLow, formatX),
    lineChart(24, 70 + height + 20, column, height, '主模型单次请求的上下文（token，对数）', series('largestRequest'), xMax, mHigh, xTicks, powers(mLow, mHigh), v => v >= 1e6 ? `${v / 1e6}M` : v >= 1e3 ? `${v / 1e3}k` : String(v), '历史长度', 150, mLow, formatX),
    lineChart(24 + column + 16, 70 + height + 20, column, height, '每题费用（美元，对数）', series('cost'), xMax, cHigh, xTicks, powers(cLow, cHigh), v => `$${v}`, '历史长度', 150, cLow, formatX),
  ]
  await writeFile(values.chart, svg(width, 70 + 2 * height + 40, '历史变长时各方案的表现', `LongMemEval 同一批 ${questions.size} 题，历史加长到 2、4、8 倍（加入其他题的填充会话）`, panels.map(panel => panel.body).join('')))
}
