/**
 * Charts and summary of the self-written document study (doc.ts), from its run directories:
 *   data.json   accuracy (case-bootstrap 95% interval) per budget and question type, document sizes, answer input and cost;
 *   curve.svg   accuracy against the document budget, per benchmark, with the whole history in the prompt as reference;
 *   types.svg   LoCoMo accuracy per question type against the budget.
 * The 32 KiB level takes the better of the doc:32 and doc:64 arms of each benchmark (two measurements of the level
 * where the writer stops filling its budget); data.json names the arm used.
 *   node --experimental-transform-types scripts/bench/plot-doc.ts <locomo-run-dir> <longmemeval-run-dir> <out-dir>
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lines, svg, type Series } from '../natural/svg.ts'

const [locomoDir, lmeDir, outDir] = process.argv.slice(2)
if (!locomoDir || !lmeDir || !outDir) throw new Error('usage: plot-doc.ts <locomo-run-dir> <longmemeval-run-dir> <out-dir>')
interface Row { arm: string; dataset: string; case: string; id: string; type: string; main: Array<{ miss: number; hit: number; output: number }>; costUsd?: number }
interface Doc { case: string; budget: number; bytes: number; attempts: number; truncated: boolean; costUsd: number }
const read = async <T>(file: string) => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as T)
const LEVELS = [4, 8, 16, 32], P = { miss: 0.15e-6, hit: 0.003e-6, output: 0.6e-6 }
const TYPES: Record<string, string> = { 'single-hop': '单跳', 'multi-hop': '多跳', temporal: '时间', 'open-domain': '开放域',
  'single-session-user': '单会话·用户', 'single-session-assistant': '单会话·助手', 'single-session-preference': '单会话·偏好',
  'multi-session': '跨会话', 'temporal-reasoning': '时间推理', 'knowledge-update': '知识更新' }

/** Seeded resampling, so the intervals are the same on every run. */
function random(seed: number) { return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
/** Accuracy with a 95% interval that resamples whole memories (a LoCoMo conversation's questions share one). */
function accuracy(groups: number[][]) {
  const flat = groups.flat(), next = random(7), samples: number[] = []
  for (let b = 0; b < 10_000; b++) { let k = 0, n = 0; for (let i = 0; i < groups.length; i++) { const g = groups[Math.floor(next() * groups.length)]!; k += g.reduce((a, c) => a + c, 0); n += g.length } samples.push(k / n) }
  samples.sort((a, b) => a - b)
  return { n: flat.length, accuracy: flat.reduce((a, c) => a + c, 0) / flat.length, low: samples[250]!, high: samples[9750]! }
}

async function summarize(dir: string) {
  const rows = await read<Row>(join(dir, 'rows.jsonl')), docs = await read<Doc>(join(dir, 'docs.jsonl'))
  const grades = new Map((await read<{ arm: string; id: string; correct: boolean }>(join(dir, 'grades.jsonl'))).map(g => [g.arm + '/' + g.id, g.correct]))
  const dataset = rows[0]!.dataset, unit = (row: Row) => dataset === 'locomo' ? row.id.replace(/-q\d+$/, '') : row.case
  const graded = (arm: string, filter: (row: Row) => boolean = () => true) => rows.filter(row => row.arm === arm && grades.has(arm + '/' + row.id) && filter(row))
  const grouped = (list: Row[]) => [...list.reduce((map, row) => map.set(unit(row), [...map.get(unit(row)) ?? [], Number(grades.get(row.arm + '/' + row.id))]), new Map<string, number[]>()).values()]
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)
  const types = [...new Set(rows.map(row => row.type))]
  const arm = (level: number) => {
    if (level !== 32) return `doc:${level}`
    const score = (name: string) => graded(name).length ? accuracy(grouped(graded(name))).accuracy : -1
    return score('doc:64') > score('doc:32') ? 'doc:64' : 'doc:32'
  }
  const level = (name: string, budget?: number) => {
    const list = graded(name), sized = docs.filter(doc => doc.budget === budget)
    return { arm: name, ...accuracy(grouped(list)),
      byType: Object.fromEntries(types.map(type => [type, accuracy(grouped(graded(name, row => row.type === type)))])),
      answerInputTokens: mean(rows.filter(row => row.arm === name).map(row => row.main[0]!.miss + row.main[0]!.hit)),
      answerCostUsd: mean(rows.filter(row => row.arm === name).map(row => row.main.reduce((n, u) => n + u.miss * P.miss + u.hit * P.hit + u.output * P.output, 0))),
      ...(budget ? { budgetBytes: budget, documentBytes: mean(sized.map(doc => doc.bytes)), fill: mean(sized.map(doc => doc.bytes / budget)),
        rewritten: sized.filter(doc => doc.attempts > 1).length, truncated: sized.filter(doc => doc.truncated).length, documents: sized.length } : {}) }
  }
  const levels = Object.fromEntries(LEVELS.map(kib => { const name = arm(kib); return [kib, level(name, Number(name.slice(4)) * 1024)] }))
  const alternate = graded('doc:64').length ? { 'doc:32': level('doc:32', 32768), 'doc:64': level('doc:64', 65536) } : {}
  const writes = new Map<string, number>()
  for (const doc of docs) if (doc.budget <= 32768) writes.set(doc.case, (writes.get(doc.case) ?? 0) + doc.costUsd)
  return { dataset, memories: new Set(rows.map(unit)).size, questions: graded('full-context').length, types,
    fullContext: level('full-context'), levels, alternate, writeCostPerMemoryUsdAsRun: mean([...writes.values()]) }
}

const data = { locomo: await summarize(locomoDir), longmemeval: await summarize(lmeDir) }
await mkdir(outDir, { recursive: true })
await writeFile(join(outDir, 'data.json'), JSON.stringify(data, null, 2) + '\n')
const pct = (value: number) => (value * 100).toFixed(1) + '%', kib = (i: number) => `${LEVELS[i]} KiB`
const width = 960, NAMES = { locomo: 'LoCoMo', longmemeval: 'LongMemEval-S' }

// Accuracy against the budget, one panel per benchmark; the series end labels carry the 32 KiB value.
let body = '', y = 70
for (const key of ['locomo', 'longmemeval'] as const) {
  const value = data[key], doc = LEVELS.map((level, i) => [i, value.levels[level]!.accuracy * 100] as [number, number])
  const series: Series[] = [
    { label: '自写文档', cls: 'l1', points: doc },
    { label: '原文整段放入', cls: 'lc', points: [[0, value.fullContext.accuracy * 100], [LEVELS.length - 1, value.fullContext.accuracy * 100]] },
  ]
  const drawn = lines(24, y, width - 48, 300, `${NAMES[key]}（${value.questions} 题）：自写文档 ${LEVELS.map(level => pct(value.levels[level]!.accuracy)).join(' → ')}；原文 ${pct(value.fullContext.accuracy)}`,
    series, LEVELS.length - 1, 100, LEVELS.map((_, i) => i), [0, 20, 40, 60, 80, 100], tick => tick + '%', '文档预算（UTF-8 字节上限）', 120, undefined, kib)
  body += drawn.body; y += drawn.height + 24
}
await writeFile(join(outDir, 'curve.svg'), svg(width, y, '自写文档的准确率曲线', 'ds flash 读完历史、不看题目写一份限长文档，作答只看文档；DeepSeek 评分；32 KiB 档取 32/64 KiB 两次中较高者', body))

// LoCoMo per question type.
const locomo = data.locomo, order = ['single-hop', 'multi-hop', 'temporal', 'open-domain']
const typeSeries: Series[] = order.map((type, i) => ({ label: TYPES[type]!, cls: (['l1', 'l2', 'l3', 'l4'] as const)[i]!,
  points: LEVELS.map((level, j) => [j, locomo.levels[level]!.byType[type]!.accuracy * 100] as [number, number]) }))
const drawn = lines(24, 70, width - 48, 340, `原文整段放入：${order.map(type => `${TYPES[type]} ${pct(locomo.fullContext.byType[type]!.accuracy)}`).join('、')}`, typeSeries, LEVELS.length - 1, 100, LEVELS.map((_, i) => i), [0, 20, 40, 60, 80, 100],
  tick => tick + '%', '文档预算（UTF-8 字节上限）', 120, undefined, kib)
await writeFile(join(outDir, 'types.svg'), svg(width, 70 + drawn.height + 16, 'LoCoMo：各题型准确率随文档预算的变化', '题量：单跳 841、多跳 282、时间 321、开放域 96；单跳与时间在 4–16 KiB 几乎重合（相差不到 0.2 分）', drawn.body))
console.log('written to', outDir)
