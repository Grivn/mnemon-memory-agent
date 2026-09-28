/**
 * Charts of the phase 2 study (read-time changes that close the synthesis gap), from p2-final.json:
 *   steps.svg     each step's change on the dev set against the step it built on, raw records and notes, adopted or not;
 *   full.svg      the full-set confirmation: raw records minus notes, both with the filled View, overall and per type,
 *                 against the registered margin (held-out questions);
 *   accuracy.svg  held-out accuracy of phase 1's arms, the filled View's arms, main-only and the whole history.
 *   node --experimental-transform-types scripts/bench/plot-phase2.ts <p2-final.json> <out-dir>
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { esc, panel, svg, type Row } from '../natural/svg.ts'

const [input, outDir] = process.argv.slice(2)
if (!input || !outDir) throw new Error('usage: plot-phase2.ts <p2-final.json> <out-dir>')
interface Diff { n: number; diff: number; low: number; high: number; p: number }
interface Acc { acc: number; n: number }
interface Dataset { margin: number; heldOut: { accuracy: Record<string, Acc>; h1RawVsNotes: Diff }; byTypeDiff: Record<string, Diff | null> }
interface Pooled { pooled?: { diff: number; n: number } }
const data = JSON.parse(await readFile(input, 'utf8')) as Record<'locomo' | 'longmemeval', Dataset> & { devSteps: Record<string, { raw?: Pooled; notes?: Pooled; decision?: { adopt: boolean } | null }> }
await mkdir(outDir, { recursive: true })
const NAMES = { locomo: 'LoCoMo', longmemeval: 'LongMemEval' } as const
const TYPES: Record<string, string> = {
  'single-hop': '单跳', 'multi-hop': '多跳', temporal: '时间', 'open-domain': '开放域',
  'single-session-user': '单会话·用户', 'single-session-assistant': '单会话·助手', 'single-session-preference': '单会话·偏好',
  'multi-session': '跨会话', 'temporal-reasoning': '时间推理', 'knowledge-update': '知识更新', abstention: '拒答',
}
const signed = (value: number) => (value > 0 ? '+' : value < 0 ? '−' : '') + Math.abs(value).toFixed(1)

// 1. Dev steps: a diverging bar per step and memory kind.
{
  const STEPS: Array<[string, string, boolean]> = [['step1', '第 1 步 · 填满 View', true], ['step2', '第 2 步 · 按题意规划与判断', false],
    ['step3b', '第 3 步 · 聚焦判断（修正后）', false], ['step4', '第 4 步 · 读取时整理', false]]
  const width = 960, labelWidth = 250, plotX = 24 + labelWidth, plotW = width - labelWidth - 170, min = -8, max = 14
  const sx = (value: number) => plotX + (value - min) / (max - min) * plotW
  let body = '', y = 80
  const top = y
  for (const tick of [-5, 0, 5, 10]) body += `<line class="${tick ? 'grid' : 'axis'}" x1="${sx(tick)}" x2="${sx(tick)}" y1="${top - 8}" y2="${top + STEPS.length * 64}"/><text class="tick" x="${sx(tick)}" y="${top + STEPS.length * 64 + 16}" text-anchor="middle">${signed(tick)}</text>`
  STEPS.forEach(([key, label, adopted], i) => {
    const step = data.devSteps[key], cy = top + i * 64
    body += `<text x="${plotX - 10}" y="${cy + 18}" text-anchor="end" class="value">${esc(label)}</text><text x="${plotX - 10}" y="${cy + 36}" text-anchor="end" class="tick">${adopted ? '采纳' : '不采纳'}</text>`
    for (const [row, memory, cls, name] of [[0, 'raw', 's1', '原话'], [1, 'notes', 'context', '笔记']] as const) {
      const value = step?.[memory]?.pooled?.diff
      if (value === undefined) continue
      const by = cy + 4 + row * 22, x0 = sx(Math.min(0, value)), x1 = sx(Math.max(0, value))
      body += `<rect class="${cls}" x="${x0}" y="${by}" width="${Math.max(1, x1 - x0)}" height="16" rx="3"><title>${esc(`${label} · ${name}: ${signed(value)}`)}</title></rect>`
      body += `<text class="value" x="${value >= 0 ? x1 + 6 : x0 - 6}" y="${by + 12}" text-anchor="${value >= 0 ? 'start' : 'end'}">${esc(`${name} ${signed(value)}`)}</text>`
    }
  })
  y = top + STEPS.length * 64 + 40
  await writeFile(join(outDir, 'steps.svg'), svg(width, y, '阶段 2 各步在开发集上的变化', '开发集 210 题（LoCoMo 150 + LongMemEval 60），相对该步所叠加的基线（第 1 步对阶段 1，其余对第 1 步），百分点', body))
}

// 2. Full-set confirmation: raw - notes with the filled View, held-out questions.
{
  const width = 960, labelWidth = 150, plotX = 24 + labelWidth, plotW = width - labelWidth - 250, min = -30, max = 15
  const sx = (value: number) => plotX + (Math.max(min, Math.min(max, value)) - min) / (max - min) * plotW
  let body = '', y = 70
  for (const key of ['locomo', 'longmemeval'] as const) {
    const d = data[key], rows: Array<[string, Diff, boolean]> = [['全部', d.heldOut.h1RawVsNotes, true],
      ...Object.entries(d.byTypeDiff).filter((entry): entry is [string, Diff] => entry[1] !== null).map(([type, diff]) => [TYPES[type] ?? type, diff, false] as [string, Diff, boolean])]
    body += `<text class="panel" x="24" y="${y + 12}">${esc(`${NAMES[key]}：原话 − 笔记，两组都填满 View（百分点，去掉开发集的题，95% 区间）`)}</text>`
    const top = y + 34, step = 26, bottom = top + rows.length * step
    for (const tick of [-30, -20, -10, 0, 10]) body += `<line class="grid" x1="${sx(tick)}" x2="${sx(tick)}" y1="${top - 8}" y2="${bottom}"/><text class="tick" x="${sx(tick)}" y="${bottom + 14}" text-anchor="middle">${signed(tick)}</text>`
    body += `<line class="axis" x1="${sx(0)}" x2="${sx(0)}" y1="${top - 8}" y2="${bottom}"/>`
    body += `<line x1="${sx(-d.margin)}" x2="${sx(-d.margin)}" y1="${top - 8}" y2="${bottom}" style="stroke:var(--s2);stroke-width:1.5;stroke-dasharray:4 3"/>`
    body += `<text class="tick" x="${sx(-d.margin) - 4}" y="${top - 12}" text-anchor="end">非劣效下限 −${d.margin}</text>`
    rows.forEach(([label, diff, overall], i) => {
      const cy = top + i * step + 10, cls = overall ? 's1' : 'context'
      body += `<text x="${plotX - 10}" y="${cy + 4}" text-anchor="end"${overall ? ' class="value"' : ''}>${esc(`${label}（${diff.n}）`)}</text>`
      body += `<line x1="${sx(diff.low)}" x2="${sx(diff.high)}" y1="${cy}" y2="${cy}" style="stroke:var(--${overall ? 's1' : 'context'});stroke-width:2;stroke-linecap:round"/>`
      body += `<circle class="${cls} dot" cx="${sx(diff.diff)}" cy="${cy}" r="${overall ? 6 : 5}"><title>${esc(`${label}: ${signed(diff.diff)} [${signed(diff.low)}, ${signed(diff.high)}], p = ${diff.p.toPrecision(2)}`)}</title></circle>`
      body += `<text class="value" x="${plotX + plotW + 16}" y="${cy + 4}">${esc(`${signed(diff.diff)} [${signed(diff.low)}, ${signed(diff.high)}]`)}</text>`
    })
    y = bottom + 40
  }
  await writeFile(join(outDir, 'full.svg'), svg(width, y, '全集确认：填满 View 后，原话对笔记', '线索召回 + 填满 View（8 条），同一批题配对；区间按共用一份记忆的单位重采样；越界的区间在图边截断', body))
}

// 3. Held-out accuracy of every arm.
{
  const ARMS: Array<[string, string, string]> = [['cue:raw-records (phase 1)', '原话 · 阶段 1', 'context'], ['cue:notes (phase 1)', '笔记 · 阶段 1', 'context'],
    ['cuefill:raw-records', '原话 · 填满 View', 's1'], ['cuefill:notes', '笔记 · 填满 View', 's2'], ['main-only:notes', '仅主 DSH（笔记）', 'context'], ['full-context', '整段放入', 'context']]
  let body = '', y = 70
  for (const key of ['locomo', 'longmemeval'] as const) {
    const accuracy = data[key].heldOut.accuracy
    const rows: Row[] = ARMS.filter(([arm]) => accuracy[arm]).map(([arm, label, cls]) => ({ label, value: accuracy[arm]!.acc / 100, cls, emphasis: cls !== 'context', display: `${accuracy[arm]!.acc.toFixed(1)}%` }))
    const drawn = panel(24, y, 900, `${NAMES[key]}（去掉开发集的 ${accuracy['cuefill:raw-records']?.n ?? ''} 题）`, rows, 1, value => `${Math.round(100 * value)}%`, [0, 0.25, 0.5, 0.75, 1], 170)
    body += drawn.body; y += drawn.height + 24
  }
  await writeFile(join(outDir, 'accuracy.svg'), svg(960, y, '各方案准确率', '同一批题（去掉开发集）；阶段 1 为原先的组装规则，填满 View 为阶段 2 采纳的规则', body))
}
console.log('charts written to', outDir)
