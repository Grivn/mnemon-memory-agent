/**
 * Do the replica's View and the main model's own memory search fail on the same questions? Per arm: accuracy,
 * how often the main model looked memory up (more than one model call), and accuracy with and without a lookup.
 * Then every question by (replica View alone, main-only) correctness, with how the combined arm did in each cell.
 *   node --experimental-transform-types scripts/bench/complement.ts <run-dir> [--replica replica-v4:notes] [--main main-only:notes] [--both replica-v4t:notes] [--out file]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { replica: { type: 'string', default: 'replica-v4:notes' }, main: { type: 'string', default: 'main-only:notes' },
  both: { type: 'string', default: 'replica-v4t:notes' }, out: { type: 'string' } } })
const dir = positionals[0]
if (!dir) throw new Error('usage: complement.ts <run-dir> [--replica arm] [--main arm] [--both arm] [--out file]')
interface Row { arm: string; id: string; main: unknown[] }
interface Grade { arm: string; id: string; correct: boolean }
const lines = async <T>(file: string) => (await readFile(join(dir, file), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as T)
const rows = await lines<Row>('rows.jsonl'), correct = new Map((await lines<Grade>('grades.jsonl')).map(grade => [`${grade.arm}/${grade.id}`, grade.correct]))
const pct = (a: number, b: number) => b ? Math.round(1000 * a / b) / 10 : NaN

const arms: Record<string, Record<string, number>> = {}
for (const arm of [...new Set(rows.map(row => row.arm))]) {
  const graded = rows.filter(row => row.arm === arm && correct.has(`${arm}/${row.id}`))
  const looked = graded.filter(row => row.main.length > 1), direct = graded.filter(row => row.main.length <= 1)
  const right = (list: Row[]) => list.filter(row => correct.get(`${arm}/${row.id}`)).length
  arms[arm] = { questions: graded.length, accuracy: pct(right(graded), graded.length), looked: pct(looked.length, graded.length),
    accuracyLooked: pct(right(looked), looked.length), accuracyDirect: pct(right(direct), direct.length) }
  console.log(arm.padEnd(30), JSON.stringify(arms[arm]))
}
const ids = [...new Set(rows.filter(row => row.arm === values.replica).map(row => row.id))].filter(id => correct.has(`${values.replica}/${id}`) && correct.has(`${values.main}/${id}`))
const cells: Record<string, { questions: number; combinedCorrect: number }> = {}
for (const id of ids) {
  const cell = `${correct.get(`${values.replica}/${id}`) ? 'replica right' : 'replica wrong'}, ${correct.get(`${values.main}/${id}`) ? 'main-only right' : 'main-only wrong'}`
  const value = cells[cell] ??= { questions: 0, combinedCorrect: 0 }
  value.questions++; if (correct.get(`${values.both}/${id}`)) value.combinedCorrect++
}
const either = ids.filter(id => correct.get(`${values.replica}/${id}`) || correct.get(`${values.main}/${id}`)).length
for (const [cell, value] of Object.entries(cells)) console.log(`${cell}: ${value.questions}, ${values.both} right in ${value.combinedCorrect}`)
console.log(`either right: ${either}/${ids.length} (${pct(either, ids.length)}%)`)
if (values.out) await writeFile(values.out, JSON.stringify({ arms, pair: { replica: values.replica, main: values.main, both: values.both, questions: ids.length, either, cells } }, null, 1))
