/**
 * Charts of the phase 1 study (raw records vs extracted notes under cue recall), from its data files:
 *   raw-vs-notes.svg  paired difference (raw - notes) with its interval, overall and per question type, against the
 *                     pre-registered non-inferiority margin;
 *   stages.svg        how much of the evidence survives each step of cue recall, per arm;
 *   tco.svg           cost per question, writing included, as the questions asked of one memory grow.
 *   node --experimental-transform-types scripts/bench/plot-phase1.ts <data-dir> <out-dir>
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { esc, lines, panel, svg, type Row, type Series } from '../natural/svg.ts'

const [dataDir, outDir] = process.argv.slice(2)
if (!dataDir || !outDir) throw new Error('usage: plot-phase1.ts <data-dir> <out-dir>')
interface Diff { n: number; diff: number; low: number; high: number; p: number }
interface Dataset { rawVsNotes: Diff; byTypeDiff: Record<string, Diff | null>; margin: number; notesWritePerMemory: number
  cost: Record<string, { query: number; write: number }>; accuracy: Record<string, { acc: number; n: number }> }
const stats = JSON.parse(await readFile(join(dataDir, 'p1-stats.json'), 'utf8')) as Record<'locomo' | 'longmemeval', Dataset>
const stages = JSON.parse(await readFile(join(dataDir, 'p1-mechanism.json'), 'utf8')) as Record<string, Record<string, { complete: Record<string, number> }>>
await mkdir(outDir, { recursive: true })
const NAMES: Record<string, string> = { locomo: 'LoCoMo', longmemeval: 'LongMemEval' }
const TYPES: Record<string, string> = {
  'single-hop': '单跳', 'multi-hop': '多跳', temporal: '时间', 'open-domain': '开放域',
  'single-session-user': '单会话·用户', 'single-session-assistant': '单会话·助手', 'single-session-preference': '单会话·偏好',
  'multi-session': '跨会话', 'temporal-reasoning': '时间推理', 'knowledge-update': '知识更新', abstention: '拒答',
}
const signed = (value: number) => (value > 0 ? '+' : value < 0 ? '−' : '') + Math.abs(value).toFixed(1)

// 1. Forest plot: one panel per dataset, a dashed line at its margin.
{
  const width = 960, labelWidth = 150, plotX = 24 + labelWidth, plotW = width - labelWidth - 250, min = -30, max = 15
  const sx = (value: number) => plotX + (Math.max(min, Math.min(max, value)) - min) / (max - min) * plotW
  let body = '', y = 70
  for (const key of ['locomo', 'longmemeval'] as const) {
    if (!stats[key]?.rawVsNotes) continue
    const data = stats[key], rows: Array<[string, Diff, boolean]> = [['全部题', data.rawVsNotes, true],
      ...Object.entries(data.byTypeDiff).filter((entry): entry is [string, Diff] => entry[1] !== null).map(([type, diff]) => [TYPES[type] ?? type, diff, false] as [string, Diff, boolean])]
    body += `<text class="panel" x="24" y="${y + 12}">${esc(`${NAMES[key]}：原话 − 笔记（百分点，同一批题，95% 区间）`)}</text>`
    const top = y + 34, step = 26, bottom = top + rows.length * step
    for (const tick of [-30, -20, -10, 0, 10]) body += `<line class="grid" x1="${sx(tick)}" x2="${sx(tick)}" y1="${top - 8}" y2="${bottom}"/><text class="tick" x="${sx(tick)}" y="${bottom + 14}" text-anchor="middle">${signed(tick)}</text>`
    body += `<line class="axis" x1="${sx(0)}" x2="${sx(0)}" y1="${top - 8}" y2="${bottom}"/>`
    body += `<line x1="${sx(-data.margin)}" x2="${sx(-data.margin)}" y1="${top - 8}" y2="${bottom}" style="stroke:var(--s2);stroke-width:1.5;stroke-dasharray:4 3"/>`
    body += `<text class="tick" x="${sx(-data.margin) - 4}" y="${top - 12}" text-anchor="end">非劣效下限 −${data.margin}</text>`
    rows.forEach(([label, diff, overall], i) => {
      const cy = top + i * step + 10, cls = overall ? 's1' : 'context'
      body += `<text x="${plotX - 10}" y="${cy + 4}" text-anchor="end"${overall ? ' class="value"' : ''}>${esc(`${label}（${diff.n}）`)}</text>`
      body += `<line x1="${sx(diff.low)}" x2="${sx(diff.high)}" y1="${cy}" y2="${cy}" style="stroke:var(--${overall ? 's1' : 'context'});stroke-width:2;stroke-linecap:round"/>`
      body += `<circle class="${cls} dot" cx="${sx(diff.diff)}" cy="${cy}" r="${overall ? 6 : 5}"><title>${esc(`${label}: ${signed(diff.diff)} [${signed(diff.low)}, ${signed(diff.high)}], p = ${diff.p.toPrecision(2)}`)}</title></circle>`
      body += `<text class="value" x="${plotX + plotW + 16}" y="${cy + 4}">${esc(`${signed(diff.diff)} [${signed(diff.low)}, ${signed(diff.high)}]`)}</text>`
    })
    y = bottom + 40
  }
  await writeFile(join(outDir, 'raw-vs-notes.svg'), svg(width, y, '写入不抽取：原话对笔记的准确率差', '线索召回（v2），同一批题配对；区间按共用一份记忆的单位重采样；越界的区间在图边截断，数值见右侧', body))
}

// 2. Evidence kept at each step, per dataset and arm.
{
  const STEPS: Array<[string, string]> = [['pooled', '进候选池（≤48）'], ['shortlisted', '进前 24 名'], ['admitted', 'JEV 判为需要'], ['selected', '展示给主模型']]
  let body = '', y = 70
  for (const key of ['locomo', 'longmemeval'] as const) {
    const arms = stages[key] ?? {}, raw = Object.entries(arms).find(([name]) => name.includes('raw-records'))?.[1], notes = Object.entries(arms).find(([name]) => name.includes('notes'))?.[1]
    if (!raw || !notes) continue
    const rows: Row[] = STEPS.flatMap(([step, label]) => [
      { label: `${label} · 原话`, value: raw.complete[step]! / 100, cls: 's1', emphasis: true },
      { label: `${label} · 笔记`, value: notes.complete[step]! / 100, cls: 'context' }])
    const drawn = panel(24, y, 900, `${NAMES[key]}：证据完整保留到这一步的题目占比`, rows, 1, value => `${(100 * value).toFixed(0)}%`, [0, 0.25, 0.5, 0.75, 1], 190)
    body += drawn.body; y += drawn.height + 24
  }
  await writeFile(join(outDir, 'stages.svg'), svg(960, y, '证据在线索召回各步的保留', '按会话级证据标签统计；"JEV 判为需要"指完整判断给出 needed ≥ 0.4（入选线）', body))
}

// 3. Cost per question with writing spread over the questions asked of one memory.
{
  const F = [1, 2, 5, 10, 20, 50, 100, 200], width = 960
  let body = '', y = 70
  for (const key of ['locomo', 'longmemeval'] as const) {
    const data = stats[key], raw = data?.cost['replica-cue:raw-records'], notes = data?.cost['replica-cue:notes']
    if (!raw?.query || !notes?.query) continue
    const series: Series[] = [
      { label: '原话（写入不调模型）', cls: 'l1', points: F.map((_, i) => [i, 1000 * raw.query] as [number, number]) },
      { label: '笔记（写入时抽取）', cls: 'lc', points: F.map((f, i) => [i, 1000 * (notes.query + data.notesWritePerMemory / f)] as [number, number]) },
    ]
    const top = Math.max(...series.flatMap(item => item.points.map(point => point[1])))
    const drawn = lines(24, y, width - 48, 260, `${NAMES[key]}：每题总成本（美元/千题，对数轴），按每份记忆被提问的次数`, series, F.length - 1, top * 1.3, F.map((_, i) => i), [0.3, 1, 3, 10, 30].filter(tick => tick <= top * 1.3),
      value => value >= 1 ? value.toFixed(0) : value.toFixed(1), '每份记忆被提问的次数', 190, 0.3, value => String(F[value]))
    body += drawn.body; y += drawn.height + 20
  }
  await writeFile(join(outDir, 'tco.svg'), svg(width, y, '写入加读取的总成本', 'DeepSeek 低峰价与 JEV 输入价；笔记的写入成本按每份记忆的实际会话数计，均摊到对它的提问上', body))
}
console.log('charts written to', outDir)
