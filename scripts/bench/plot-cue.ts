/**
 * Charts for the cue-recall report, drawn from the summary the analysis writes:
 *   node --experimental-transform-types scripts/bench/plot-cue.ts <summary.json> <out-dir>
 *   cost.svg      model input tokens per question against the notes stored for it, per recall design
 *   accuracy.svg  accuracy on the full LoCoMo and LongMemEval, every arm on the same questions, with 95% intervals
 *   scaling.svg   accuracy as the stored memory grows, cue recall against the whole history in context
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lines, panel, svg, type Series } from '../natural/svg.ts'

interface Summary {
  cost: { series: Series[]; xMax: number; yMax: number; xTicks: number[]; yTicks: number[] }
  accuracy: Array<{ title: string; rows: Array<{ label: string; value: number; low: number; high: number; n: number; emphasis?: boolean }> }>
  scaling: Array<{ title: string; xLabel: string; xMax: number; xTicks: number[]; series: Series[] }>
}
const [file, out] = process.argv.slice(2)
if (!file || !out) throw new Error('usage: plot-cue.ts <summary.json> <out-dir>')
const summary = JSON.parse(await readFile(file, 'utf8')) as Summary
const pct = (value: number) => `${(100 * value).toFixed(1)}%`, thousands = (value: number) => value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value))
await mkdir(out, { recursive: true })

// 1. Cost against memory size: one line per recall design.
{
  const chart = lines(24, 70, 900, 380, '每题模型输入 token（JEV 与召回模型之和）', summary.cost.series, summary.cost.xMax, summary.cost.yMax,
    summary.cost.xTicks, summary.cost.yTicks, thousands, '该题记忆中的笔记条数', 150)
  await writeFile(join(out, 'cost.svg'), svg(948, 470, '召回开销随记忆增长', '全量扫描每题读全部笔记；缓存方案把全部笔记列给弱模型；线索召回只读有界候选池', chart.body))
}

// 2. Accuracy panels, the cue arm emphasised; the interval rides in the label (the axis runs to 110% so it fits).
{
  let body = '', y = 70
  const low = (value: number) => (100 * value).toFixed(1)
  for (const item of summary.accuracy) {
    const rows = item.rows.map(row => ({ label: row.label, value: row.value, emphasis: row.emphasis === true, display: `${pct(row.value)}（${low(row.low)}–${low(row.high)}，${row.n} 题）` }))
    const drawn = panel(24, y, 900, item.title, rows, 1.12, pct, [0, 0.25, 0.5, 0.75, 1], 170)
    body += drawn.body; y += drawn.height + 24
  }
  await writeFile(join(out, 'accuracy.svg'), svg(948, y + 10, '准确率（95% 区间）', '评审：DeepSeek，第 1 遍；区间按对话（LoCoMo）或按题（LongMemEval）重采样，与报告表格相同', body))
}

// 3. Accuracy as memory grows, on a 50-100% axis (the helper's axis starts at zero, so values are shifted into it).
{
  let body = '', y = 70
  const shift = (series: Series[]) => series.map(item => ({ ...item, points: item.points.map(([x, value]) => [x, (value - 0.5) / 0.5] as [number, number]) }))
  for (const item of summary.scaling) {
    const drawn = lines(24, y, 900, 300, item.title, shift(item.series), item.xMax, 1, item.xTicks, [0, 0.2, 0.4, 0.6, 0.8, 1], value => pct(0.5 + value / 2), item.xLabel, 150, undefined, value => String(value))
    body += drawn.body; y += 320
  }
  await writeFile(join(out, 'scaling.svg'), svg(948, y + 10, '记忆变大时的准确率', '线索召回每题只读有界候选池；整段放入每题读完整历史', body))
}
