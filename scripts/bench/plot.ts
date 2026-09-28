/**
 * Benchmark figure: accuracy of every arm overall and by question type, next to cost per question and p95 latency.
 *   node --experimental-transform-types scripts/bench/plot.ts <run-dir> --out <dir> --title <text> [--prefix name] arm=label ...
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { panel, svg } from '../natural/svg.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, title: { type: 'string' }, subtitle: { type: 'string' }, prefix: { type: 'string' } } })
const [dir, ...labels] = positionals
if (!dir || !labels.length) throw new Error('usage: plot.ts <run-dir> --out <dir> arm=label ...')
const summary = JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')) as Record<string, { all: Record<string, number>; byType: Record<string, Record<string, number>> }>
const arms = labels.map(value => value.split('=') as [string, string]).filter(([arm]) => summary[arm])
const pct = (value: number) => Number.isFinite(value) ? Math.round(value * 100) + '%' : '-'
const emphasis = (arm: string) => arm.startsWith('replica-v4')
const types = Object.keys(summary[arms[0]![0]]!.byType).filter(type => arms.some(([arm]) => (summary[arm]!.byType[type]?.graded ?? 0) > 0))
const width = 440, labelWidth = 170
let body = '', y = 70, height = 0
const overall = panel(24, y, width, '准确率（全部）', arms.map(([arm, label]) => ({ label, value: summary[arm]!.all.accuracy!, emphasis: emphasis(arm) })), 1, pct, [0, 0.5, 1], labelWidth)
const cost = panel(24 + width + 16, y, width, '每题费用（美元）', arms.map(([arm, label]) => ({ label, value: summary[arm]!.all.cost!, emphasis: emphasis(arm), display: '$' + summary[arm]!.all.cost!.toFixed(4) })),
  Math.max(...arms.map(([arm]) => summary[arm]!.all.cost!)) * 1.15, value => '$' + value.toFixed(3), [0], labelWidth)
body += overall.body + cost.body
y += Math.max(overall.height, cost.height) + 20
types.forEach((type, i) => {
  const chart = panel(24 + (i % 2) * (width + 16), y, width, `准确率 · ${type}`, arms.map(([arm, label]) => ({ label, value: summary[arm]!.byType[type]?.accuracy ?? NaN, emphasis: emphasis(arm),
    display: `${pct(summary[arm]!.byType[type]?.accuracy ?? NaN)}（${summary[arm]!.byType[type]?.graded ?? 0}）` })), 1, pct, [0, 0.5, 1], labelWidth)
  body += chart.body
  if (i % 2 === 1 || i === types.length - 1) { y += chart.height + 16 }
  height = y
})
await mkdir(values.out ?? dir, { recursive: true })
const file = join(values.out ?? dir, `${values.prefix ?? 'bench'}-accuracy.svg`)
await writeFile(file, svg(24 * 2 + width * 2 + 16, height + 8, values.title ?? '基准准确率', values.subtitle ?? 'DeepSeek 按基准自己的评分规则判定', body))
console.log('wrote', file)
