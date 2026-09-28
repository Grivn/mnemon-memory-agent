/**
 * Accuracy by arm and question type, with the cost of every answer (off-peak DeepSeek prices; JEV input priced,
 * output free), latency, and how often the evidence conversations were in front of the answering model.
 *   node --experimental-transform-types scripts/bench/summarize.ts <run-dir>
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) throw new Error('usage: summarize.ts <run-dir>')
const P = { miss: 0.15e-6, hit: 0.003e-6, output: 0.6e-6, jev: 0.042e-6 }
interface Row { arm: string; case: string; id: string; type: string; abstention: boolean; elapsedMs: number; main: Array<{ miss: number; hit: number; output: number }>; replica?: { jev: number; recall: Array<{ miss: number; hit: number; output: number }> }; evidence?: number }
interface Grade { arm: string; id: string; correct: boolean; f1?: number }
const lines = async <T>(file: string) => (await readFile(join(dir, file), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as T)
const rows = await lines<Row>('rows.jsonl'), grades = new Map((await lines<Grade>('grades.jsonl')).map(grade => [grade.arm + '/' + grade.id, grade]))
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN
const quantile = (values: number[], q: number) => { const sorted = values.slice().sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : NaN }
const cost = (row: Row) => row.main.reduce((n, u) => n + u.miss * P.miss + u.hit * P.hit + u.output * P.output, 0)
  + (row.replica ? row.replica.jev * P.jev + row.replica.recall.reduce((n, u) => n + u.miss * P.miss + u.hit * P.hit + u.output * P.output, 0) : 0)
const tokens = (row: Row) => row.main.reduce((n, u) => n + u.miss + u.hit + u.output, 0) + (row.replica ? row.replica.jev + row.replica.recall.reduce((n, u) => n + u.miss + u.hit + u.output, 0) : 0)
function metrics(list: Row[]) {
  const graded = list.map(row => grades.get(row.arm + '/' + row.id)).filter((grade): grade is Grade => !!grade)
  const evidence = list.flatMap(row => row.evidence === undefined ? [] : [row.evidence])
  return { questions: list.length, graded: graded.length, accuracy: mean(graded.map(grade => Number(grade.correct))), f1: mean(graded.flatMap(grade => grade.f1 === undefined ? [] : [grade.f1])),
    evidence: mean(evidence), cost: mean(list.map(cost)), tokens: mean(list.map(tokens)), mainTokens: mean(list.map(row => row.main.reduce((n, u) => n + u.miss + u.hit + u.output, 0))),
    msP50: quantile(list.map(row => row.elapsedMs), 0.5), msP95: quantile(list.map(row => row.elapsedMs), 0.95) }
}
const arms = [...new Set(rows.map(row => row.arm))], types = [...new Set(rows.map(row => row.type))].sort()
const summary = Object.fromEntries(arms.map(arm => { const list = rows.filter(row => row.arm === arm)
  return [arm, { all: metrics(list), byType: Object.fromEntries(types.map(type => [type, metrics(list.filter(row => row.type === type))])), abstention: metrics(list.filter(row => row.abstention)) }] }))
await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
const pct = (value: number) => Number.isFinite(value) ? (value * 100).toFixed(1) + '%' : '-'
console.log('arm'.padEnd(26), 'n'.padEnd(5), 'acc'.padEnd(7), 'f1'.padEnd(7), 'evid'.padEnd(7), 'cost/q'.padEnd(10), 'tokens/q'.padEnd(9), 'p50/p95 s', '|', types.join(' | '))
for (const [arm, value] of Object.entries(summary)) console.log(arm.padEnd(26), String(value.all.questions).padEnd(5), pct(value.all.accuracy).padEnd(7), pct(value.all.f1).padEnd(7), pct(value.all.evidence).padEnd(7),
  ('$' + value.all.cost.toFixed(5)).padEnd(10), (Math.round(value.all.tokens / 100) / 10 + 'k').padEnd(9), `${(value.all.msP50 / 1000).toFixed(1)}/${(value.all.msP95 / 1000).toFixed(1)}`.padEnd(9), '|',
  types.map(type => `${pct(value.byType[type]!.accuracy)} (${value.byType[type]!.graded})`).join(' | '))
