/**
 * A continuous-session run (run.ts --continuous): how each arm behaves as one session grows. Per arm and turn (the
 * question's position in its conversation's session): the main model's largest request, the share of its input served
 * from the prompt cache, latency and cost; accuracy by thirds of the session; and a chart of the main model's context
 * against the turn (mean over the conversations that reached that turn).
 *   node --experimental-transform-types scripts/bench/continuous.ts <run-dir> [--out continuous.json] [--chart continuous.svg]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { lines as lineChart, svg, type Series } from '../natural/svg.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, chart: { type: 'string' } } })
const dir = positionals[0]
if (!dir) throw new Error('usage: continuous.ts <run-dir> [--out file] [--chart file]')
interface Usage { miss: number; hit: number; output: number }
interface Row { arm: string; case: string; id: string; elapsedMs: number; main: Usage[]; replica?: { jev: number; recall: Usage[] } }
const read = async <T>(file: string) => (await readFile(join(dir, file), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as T)
const rows = [...new Map((await read<Row>('rows.jsonl')).reverse().map(row => [`${row.arm}/${row.id}`, row])).values()].reverse()
const correct = new Map((await read<{ arm: string; id: string; correct: boolean }>('grades.jsonl')).map(grade => [`${grade.arm}/${grade.id}`, grade.correct]))
const P = { miss: 0.15e-6, hit: 0.003e-6, output: 0.6e-6, jev: 0.042e-6 }
const priced = (u: Usage) => u.miss * P.miss + u.hit * P.hit + u.output * P.output
const sum = (list: number[]) => list.reduce((a, b) => a + b, 0), mean = (list: number[]) => list.length ? sum(list) / list.length : NaN
const turnOf = (row: Row) => Number(/-q(\d+)$/.exec(row.id)![1])
const largest = (row: Row) => Math.max(0, ...row.main.map(u => u.miss + u.hit))

const arms = [...new Set(rows.map(row => row.arm))], result: Record<string, unknown> = {}
const curves: Record<string, Array<[number, number]>> = {}
for (const arm of arms) {
  const mine = rows.filter(row => row.arm === arm), turns = new Map<number, Row[]>()
  for (const row of mine) turns.set(turnOf(row), [...turns.get(turnOf(row)) ?? [], row])
  curves[arm] = [...turns].sort((a, b) => a[0] - b[0]).filter(([, list]) => list.length >= 3).map(([turn, list]) => [turn, mean(list.map(largest))])
  // Thirds of each conversation's session, so long and short conversations weigh alike.
  const third = (row: Row) => { const size = Math.max(...mine.filter(other => other.case === row.case).map(turnOf)) + 1; return Math.min(2, Math.floor(3 * turnOf(row) / size)) }
  const byThird = [0, 1, 2].map(t => { const part = mine.filter(row => third(row) === t && correct.has(`${arm}/${row.id}`)); return { n: part.length, accuracy: part.filter(row => correct.get(`${arm}/${row.id}`)).length / Math.max(1, part.length),
    largest: mean(mine.filter(row => third(row) === t).map(largest)), cached: sum(mine.filter(row => third(row) === t).flatMap(row => row.main.map(u => u.hit))) / Math.max(1, sum(mine.filter(row => third(row) === t).flatMap(row => row.main.map(u => u.miss + u.hit)))),
    latency: mean(mine.filter(row => third(row) === t).map(row => row.elapsedMs)), cost: mean(mine.filter(row => third(row) === t).map(row => sum(row.main.map(priced)) + (row.replica ? row.replica.jev * P.jev + sum(row.replica.recall.map(priced)) : 0))) } })
  const last = mine.filter(row => turnOf(row) === Math.max(...mine.filter(other => other.case === row.case).map(turnOf)))
  result[arm] = { answered: mine.length, graded: mine.filter(row => correct.has(`${arm}/${row.id}`)).length, accuracy: mine.filter(row => correct.get(`${arm}/${row.id}`)).length / Math.max(1, mine.filter(row => correct.has(`${arm}/${row.id}`)).length),
    byThird, lastTurnLargest: mean(last.map(largest)), maxLargest: Math.max(...mine.map(largest)) }
  console.log(arm.padEnd(24), `acc ${(100 * (result[arm] as { accuracy: number }).accuracy).toFixed(1)}`, byThird.map((t, i) => `third ${i + 1}: acc ${(100 * t.accuracy).toFixed(1)} ctx ${Math.round(t.largest)} cached ${(100 * t.cached).toFixed(0)}% ${(t.latency / 1000).toFixed(1)}s $${t.cost.toFixed(5)}`).join(' | '),
    `| last turn ctx ${Math.round((result[arm] as { lastTurnLargest: number }).lastTurnLargest)} max ${(result[arm] as { maxLargest: number }).maxLargest}`)
}
if (values.out) await writeFile(values.out, JSON.stringify(result, null, 1))
if (values.chart) {
  const STYLE: Record<string, [string, Series['cls']]> = { 'full-context': ['整段放入上下文', 'l4'], 'main-only:notes': ['仅主 DSH', 'lc'], 'replica-lexical:notes': ['副实例 · BM25', 'l2'],
    'replica-scan:notes': ['JEV 全量方案', 'l5'], 'replica-v4:notes': ['JEV 缓存方案', 'l1'] }
  const series = arms.filter(arm => STYLE[arm]).map(arm => ({ label: STYLE[arm]![0], cls: STYLE[arm]![1], points: curves[arm]! }))
  const all = series.flatMap(item => item.points.map(([, v]) => v)).filter(v => v > 0), low = 10 ** Math.floor(Math.log10(Math.min(...all))), high = 10 ** Math.ceil(Math.log10(Math.max(...all)))
  const ticks: number[] = []; for (let v = low; v <= high; v *= 10) ticks.push(v)
  const xMax = Math.max(...series.flatMap(item => item.points.map(([t]) => t)))
  const chart = lineChart(24, 70, 960, 380, '主模型单次请求的上下文（token，对数）随会话轮次', series, xMax, high, [0, 25, 50, 75, 100, 125, 150].filter(t => t <= xMax), ticks,
    v => v >= 1e3 ? `${v / 1e3}k` : String(v), '会话中的第几题', 170, low)
  await writeFile(values.chart, svg(1000, 470, 'LoCoMo 持续会话：上下文怎么增长', '每段对话的全部问题在同一个会话里依次提问；曲线为各段对话在该轮的平均值（至少 3 段对话到达该轮）', chart.body))
}
