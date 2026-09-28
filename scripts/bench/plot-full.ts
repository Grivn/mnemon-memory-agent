/**
 * Charts for a full benchmark run, drawn from the statistics of scripts/bench/stats.ts:
 *   accuracy.svg  every arm's accuracy with its 95% interval (conversations resampled), one panel per benchmark;
 *   types.svg     accuracy by question type as a heat table with every value printed;
 *   cost.svg      accuracy against what one answer costs (log scale), one panel per benchmark.
 *   node --experimental-transform-types scripts/bench/plot-full.ts --locomo <stats.json> --longmemeval <stats.json> --out <dir>
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { esc, svg } from '../natural/svg.ts'

const { values } = parseArgs({ options: { locomo: { type: 'string' }, longmemeval: { type: 'string' }, out: { type: 'string' } } })
if (!values.locomo || !values.longmemeval || !values.out) throw new Error('usage: plot-full.ts --locomo <stats.json> --longmemeval <stats.json> --out <dir>')
interface Arm { n: number; accuracy: number; caseBootstrap: [number, number]; cost: { mean: number; meanWithNotes: number } }
interface Stats { perArm: Record<string, Arm>; perType: Record<string, Record<string, Arm>> }
const load = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as Stats
const benches: Array<[string, Stats]> = [['LoCoMo（10 段对话，1540 题）', await load(values.locomo)], ['LongMemEval_S（500 题）', await load(values.longmemeval)]]
// Colour follows the configuration, as in the attribution chart; slot order is the validated reference palette.
const ARMS: Array<[string, string, string]> = [
  ['full-context', '整段放入上下文', '4'], ['main-only:notes', '仅主 DSH', 'c'], ['replica-lexical:notes', '副实例 · BM25', '2'],
  ['replica-scan:notes', 'JEV 全量方案', '5'], ['replica-v4:notes', 'JEV 缓存方案', '1'], ['replica-v4t:notes', 'v4t（参照）', '3'],
]
const fill = (slot: string) => slot === 'c' ? 'context' : `s${slot}`, stroke = (slot: string) => slot === 'c' ? 'lc' : `l${slot}`
const charted = (stats: Stats) => ARMS.flatMap(([arm]) => stats.perArm[arm] ? [stats.perArm[arm]!] : [])
const floorLow = Math.floor(Math.min(...benches.flatMap(([, s]) => charted(s).map(a => a.caseBootstrap[0]))) * 10) / 10
const TYPES: Record<string, string> = { 'single-hop': '单跳', 'multi-hop': '多跳', temporal: '时间', 'open-domain': '开放域', 'single-session-user': '单会话·用户', 'single-session-assistant': '单会话·助手',
  'single-session-preference': '单会话·偏好', 'multi-session': '跨会话', 'temporal-reasoning': '时间推理', 'knowledge-update': '知识更新', abstention: '拒答' }
const pct = (value: number, digits = 1) => `${(100 * value).toFixed(digits)}%`
await mkdir(values.out, { recursive: true })

// 1. Accuracy with intervals.
{
  const low = floorLow, width = 1000, column = 480, labelWidth = 170, row = 30
  let body = ''
  benches.forEach(([title, stats], b) => {
    const x0 = 24 + b * (column + 16), plotX = x0 + labelWidth, plotW = column - labelWidth - 110, top = 110
    const scale = (value: number) => plotX + (value - low) / (1 - low) * plotW
    body += `<text class="panel" x="${x0}" y="86">${esc(title)}</text>`
    const arms = ARMS.filter(([arm]) => stats.perArm[arm])
    const bottom = top + arms.length * row
    const every = (1 - low) > 0.5 ? 0.2 : 0.1
    for (let tick = 1; tick >= low - 1e-9; tick -= every) body += `<line class="grid" x1="${scale(tick)}" x2="${scale(tick)}" y1="${top - 12}" y2="${bottom - 8}"/><text class="tick" x="${scale(tick)}" y="${bottom + 8}" text-anchor="middle">${Math.round(tick * 100)}%</text>`
    arms.forEach(([arm, label, slot], i) => {
      const a = stats.perArm[arm]!, y = top + i * row
      const tip = `${label}: ${pct(a.accuracy)}，95% 区间 ${pct(a.caseBootstrap[0])}–${pct(a.caseBootstrap[1])}，${a.n} 题`
      body += `<text x="${plotX - 10}" y="${y + 4}" text-anchor="end" class="value">${esc(label)}</text>`
      body += `<line class="line ${stroke(slot)}" x1="${scale(a.caseBootstrap[0])}" x2="${scale(a.caseBootstrap[1])}" y1="${y}" y2="${y}"><title>${esc(tip)}</title></line>`
      body += `<circle class="dot ${fill(slot)}" cx="${scale(a.accuracy)}" cy="${y}" r="6"><title>${esc(tip)}</title></circle>`
      body += `<text class="value" x="${scale(a.caseBootstrap[1]) + 10}" y="${y + 4}">${pct(a.accuracy)}</text>`
    })
  })
  const height = 110 + ARMS.length * row + 30
  await writeFile(join(values.out, 'accuracy.svg'), svg(width, height, '全量基准的准确率', '点为准确率，横线为 95% 区间（按对话 / 题目重采样）；判分模型为 DeepSeek', body))
}

// 2. Accuracy by question type: a heat table, blue ramp light to dark (reversed in dark mode so high stays prominent).
{
  const ramp = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b']
  const heat = `<style>${ramp.map((hex, i) => `.h${i}{fill:${hex}}.t${i}{fill:${i >= 3 ? '#ffffff' : '#0b0b0b'}}`).join('')}
@media (prefers-color-scheme:dark){${ramp.slice().reverse().map((hex, i) => `.h${i}{fill:${hex}}.t${i}{fill:${i >= 3 ? '#0b0b0b' : '#ffffff'}}`).join('')}}</style>`
  const step = (value: number) => Math.max(0, Math.min(ramp.length - 1, Math.floor((value - 0.3) / 0.7 * ramp.length)))
  const cellW = 92, cellH = 30, labelWidth = 190
  let body = heat, y = 80, width = 0
  for (const [title, stats] of benches) {
    const types = Object.keys(TYPES).filter(type => stats.perType[type]), arms = ARMS.filter(([arm]) => stats.perArm[arm])
    body += `<text class="panel" x="24" y="${y + 12}">${esc(title)}</text>`
    y += 30
    types.forEach((type, j) => {
      const n = Object.values(stats.perType[type]!)[0]?.n ?? 0
      body += `<text class="tick" x="${24 + labelWidth + j * cellW + cellW / 2}" y="${y + 12}" text-anchor="middle">${esc(TYPES[type] ?? type)}</text><text class="tick" x="${24 + labelWidth + j * cellW + cellW / 2}" y="${y + 26}" text-anchor="middle">n=${n}</text>`
    })
    y += 34
    arms.forEach(([arm, label], i) => {
      body += `<text x="${24 + labelWidth - 10}" y="${y + i * cellH + cellH / 2 + 4}" text-anchor="end" class="value">${esc(label)}</text>`
      types.forEach((type, j) => {
        const a = stats.perType[type]![arm]
        if (!a) return
        const s = step(a.accuracy), x = 24 + labelWidth + j * cellW, cy = y + i * cellH
        body += `<rect class="h${s}" x="${x + 1}" y="${cy + 1}" width="${cellW - 2}" height="${cellH - 2}" rx="3"><title>${esc(`${label} · ${TYPES[type] ?? type}: ${pct(a.accuracy)}（${a.n} 题）`)}</title></rect>`
        body += `<text class="t${s}" x="${x + cellW / 2}" y="${cy + cellH / 2 + 4}" text-anchor="middle" font-size="12">${pct(a.accuracy, 0)}</text>`
      })
    })
    width = Math.max(width, 24 + labelWidth + types.length * cellW + 24)
    y += arms.length * cellH + 30
  }
  await writeFile(join(values.out, 'types.svg'), svg(Math.max(width, 720), y, '按题型的准确率', '颜色越深准确率越高；数值为 DeepSeek 判分的准确率', body))
}

// 3. Accuracy against the cost of one answer (marginal: answering and composing the View; notes excluded).
{
  const width = 1050, column = 500, height = 420, top = 90, plotH = 270
  const costs = benches.flatMap(([, s]) => charted(s).map(a => a.cost.mean)).filter(value => value > 0)
  const lx0 = Math.floor(Math.log10(Math.min(...costs))), lx1 = Math.ceil(Math.log10(Math.max(...costs)))
  const low = floorLow
  let body = ''
  benches.forEach(([title, stats], b) => {
    const x0 = 24 + b * (column + 16) + 44, plotW = column - 230
    const sx = (value: number) => x0 + (Math.log10(value) - lx0) / (lx1 - lx0) * plotW, sy = (value: number) => top + (1 - (value - low) / (1 - low)) * plotH
    body += `<text class="panel" x="${x0 - 44}" y="${top - 20}">${esc(title)}</text>`
    for (let e = lx0; e <= lx1; e++) body += `<line class="grid" x1="${sx(10 ** e)}" x2="${sx(10 ** e)}" y1="${top}" y2="${top + plotH}"/><text class="tick" x="${sx(10 ** e)}" y="${top + plotH + 16}" text-anchor="middle">$${(10 ** e).toString()}</text>`
    for (let tick = 1; tick >= low - 1e-9; tick -= (1 - low) > 0.5 ? 0.2 : 0.1) body += `<line class="grid" x1="${x0}" x2="${x0 + plotW}" y1="${sy(tick)}" y2="${sy(tick)}"/><text class="tick" x="${x0 - 8}" y="${sy(tick) + 4}" text-anchor="end">${Math.round(tick * 100)}%</text>`
    body += `<text class="tick" x="${x0 + plotW / 2}" y="${top + plotH + 34}" text-anchor="middle">每题费用（美元，对数刻度）</text>`
    const points = ARMS.flatMap(([arm, label, slot]) => { const a = stats.perArm[arm]; return a && a.cost.mean > 0 ? [{ a, label, slot, x: sx(a.cost.mean), y: sy(a.accuracy) }] : [] })
    // Labels sit in a column right of the plot, in the points' vertical order, at least 16px apart.
    const placed = points.slice().sort((p, q) => p.y - q.y).map(point => ({ ...point, ly: point.y }))
    for (let i = 1; i < placed.length; i++) placed[i]!.ly = Math.max(placed[i]!.ly, placed[i - 1]!.ly + 16)
    const labelX = x0 + plotW + 16
    for (const { a, label, slot, x, y, ly } of placed) {
      const tip = `${label}: ${pct(a.accuracy)}，每题 $${a.cost.mean.toFixed(5)}`
      body += `<line class="line ${stroke(slot)}" x1="${x}" x2="${x}" y1="${sy(a.caseBootstrap[0])}" y2="${sy(a.caseBootstrap[1])}"><title>${esc(tip)}</title></line>`
      body += `<polyline class="grid" fill="none" points="${x + 7},${y} ${labelX - 4},${ly}"/>`
      body += `<circle class="dot ${fill(slot)}" cx="${x}" cy="${y}" r="6"><title>${esc(tip)}</title></circle>`
      body += `<text class="value" x="${labelX}" y="${ly + 4}">${esc(label)} ${pct(a.accuracy)}</text>`
    }
  })
  await writeFile(join(values.out, 'cost.svg'), svg(width, height, '准确率与每题费用', '每题费用只算回答与组 View（DeepSeek 低峰价 + JEV），不含笔记生成；竖线为 95% 区间', body))
}
console.log('charts written to', values.out)
