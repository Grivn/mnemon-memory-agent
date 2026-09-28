/**
 * An independent check of the judge. `sample` draws a stratified random sample of graded answers (every arm alike;
 * on LoCoMo half of it from answers sharing few words with the gold, where a generous judge is most likely wrong),
 * shuffles it and writes it blind: no arm, no verdict. A second grader writes one strict verdict per item into
 * audit-verdicts.jsonl ({ "item": n, "correct": true|false, "note": "..." }). `score` compares that with the judge:
 * agreement, and how often the judge passed an answer the audit failed (lenient) or the reverse (strict), per arm,
 * with each arm's accuracy re-estimated from the audit (stratum weights undo the oversampling).
 *   node --experimental-transform-types scripts/bench/audit.ts sample <run-dir> [--per-arm 25] [--refine <locomo-refined.json>]
 *   node --experimental-transform-types scripts/bench/audit.ts score <run-dir>
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'per-arm': { type: 'string', default: '25' }, seed: { type: 'string', default: '20260924' }, refine: { type: 'string' } } })
const [mode, dir] = positionals
if ((mode !== 'sample' && mode !== 'score') || !dir) throw new Error('usage: audit.ts sample|score <run-dir> [--per-arm n]')
interface Row { arm: string; id: string; dataset: string; type: string; abstention: boolean; question: string; gold: string; answer: string; date?: string }
interface Grade { arm: string; id: string; correct: boolean; f1?: number }
const read = async <T>(file: string) => (await readFile(join(dir, file), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as T)
let seed = Number(values.seed)
const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const shuffle = <T>(list: T[]) => { const copy = [...list]; for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j]!, copy[i]!] } return copy }
const rows = new Map((await read<Row>('rows.jsonl')).map(row => [`${row.arm}/${row.id}`, row]))
// With --refine only questions whose label the review left alone are audited: the check is of the judge, not the labels.
const reviewed = values.refine ? JSON.parse(await readFile(values.refine, 'utf8')) as { fix: Record<string, unknown>; drop: Record<string, unknown> } : undefined
const grades = (await read<Grade>('grades.jsonl')).filter(grade => rows.has(`${grade.arm}/${grade.id}`) && !reviewed?.fix[grade.id] && !reviewed?.drop[grade.id])
const strata = (grade: Grade) => grade.f1 === undefined ? 'all' : grade.f1 < 0.3 ? 'low-overlap' : 'overlap'

if (mode === 'sample') {
  const perArm = Number(values['per-arm']), picked: Array<{ grade: Grade; stratum: string; weight: number }> = []
  for (const arm of [...new Set(grades.map(grade => grade.arm))]) {
    const mine = grades.filter(grade => grade.arm === arm), groups = new Map<string, Grade[]>()
    for (const grade of mine) groups.set(strata(grade), [...groups.get(strata(grade)) ?? [], grade])
    // LoCoMo: 60% of the sample from low-overlap answers; the weight of an item is its stratum's size over its sample count.
    const quota = groups.size > 1 ? { 'low-overlap': Math.round(perArm * 0.6), overlap: perArm - Math.round(perArm * 0.6) } : { all: perArm }
    for (const [stratum, list] of groups) {
      const take = shuffle(list).slice(0, (quota as Record<string, number>)[stratum] ?? 0)
      for (const grade of take) picked.push({ grade, stratum, weight: list.length / take.length })
    }
  }
  const order = shuffle(picked)
  await writeFile(join(dir, 'audit-sample.md'), order.map(({ grade }, item) => { const row = rows.get(`${grade.arm}/${grade.id}`)!
    return `### ${item}\n- type: ${row.abstention ? 'abstention' : row.type}${row.date ? ` · asked on ${row.date}` : ''}\n- question: ${row.question}\n- gold: ${row.gold}\n- answer: ${row.answer.replace(/\s+/g, ' ').trim()}\n` }).join('\n'))
  await writeFile(join(dir, 'audit-key.jsonl'), order.map(({ grade, stratum, weight }, item) => JSON.stringify({ item, arm: grade.arm, id: grade.id, judge: grade.correct, stratum, weight })).join('\n') + '\n')
  console.log(`${order.length} items written blind to audit-sample.md; the key is audit-key.jsonl`)
} else {
  const key = await read<{ item: number; arm: string; id: string; judge: boolean; stratum: string; weight: number }>('audit-key.jsonl')
  const verdicts = new Map((await read<{ item: number; correct: boolean }>('audit-verdicts.jsonl')).map(verdict => [verdict.item, verdict.correct]))
  const result: Record<string, Record<string, number>> = {}
  for (const arm of [...new Set(key.map(entry => entry.arm))]) {
    const mine = key.filter(entry => entry.arm === arm && verdicts.has(entry.item))
    const weight = mine.reduce((n, entry) => n + entry.weight, 0)
    result[arm] = { audited: mine.length, agreement: mine.filter(entry => entry.judge === verdicts.get(entry.item)).length / mine.length,
      judgePassedAuditFailed: mine.filter(entry => entry.judge && !verdicts.get(entry.item)).length, judgeFailedAuditPassed: mine.filter(entry => !entry.judge && verdicts.get(entry.item)).length,
      judgeAccuracy: mine.reduce((n, entry) => n + entry.weight * Number(entry.judge), 0) / weight, auditAccuracy: mine.reduce((n, entry) => n + entry.weight * Number(verdicts.get(entry.item)), 0) / weight }
  }
  const all = key.filter(entry => verdicts.has(entry.item))
  const summary = { audited: all.length, agreement: all.filter(entry => entry.judge === verdicts.get(entry.item)).length / all.length,
    lenient: all.filter(entry => entry.judge && !verdicts.get(entry.item)).length, strict: all.filter(entry => !entry.judge && verdicts.get(entry.item)).length }
  await writeFile(join(dir, 'audit-result.json'), JSON.stringify({ summary, perArm: result }, null, 1))
  console.log(JSON.stringify(summary))
  for (const [arm, value] of Object.entries(result)) console.log(arm.padEnd(26), JSON.stringify(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, Math.round(v * 1000) / 1000]))))
}
