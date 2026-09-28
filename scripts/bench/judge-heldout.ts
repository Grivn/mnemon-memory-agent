/**
 * Grade held-out benchmark answers (BEAM, HaluMem) with each benchmark's own judge prompt, read at run time from the
 * benchmark's repository at a pinned commit (the prompt texts are not copied here):
 *   BEAM     every rubric item ("nugget") scored 1, 0.5 or 0 by `unified_llm_judge_base_prompt`
 *            (src/prompts.py); a question's score is the mean over its items (the benchmark's llm_judge_score).
 *   HaluMem  `EVALUATION_PROMPT_FOR_QUESTION` (eval/eval_tools.py) labels an answer Correct, Hallucination or Omission
 *            against the reference answer and the key memory points behind it.
 *   node --env-file=<keys> --experimental-transform-types scripts/bench/judge-heldout.ts <run-dir> --cases <cases.json> [--judge <model>] [--concurrency 8]
 * The judge is DeepSeek flash by default (thinking off, temperature 0); --judge names an OpenAI model instead, e.g.
 * gpt-4.1-mini, whose identity is checked before grading and every 100 grades. Grades go to grades-heldout[-model].jsonl
 * and resume where they stopped.
 */
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { deepseek } from './notes.ts'
import type { Case } from './data.ts'
import { checkIdentity, isOpenAIModel, modelSpec, openaiChat } from '../lib/openai.ts'

const SOURCES = {
  beam: 'https://raw.githubusercontent.com/mohammadtavakoli78/BEAM/b2da22eac88bb0874c64665f13457eb99835774a/src/prompts.py',
  halumem: 'https://raw.githubusercontent.com/MemTensor/HaluMem/718f16ff0c83413b1c86fa83fc13cc1a639871f9/eval/eval_tools.py',
}
const { values, positionals } = parseArgs({ allowPositionals: true, options: { cases: { type: 'string' }, judge: { type: 'string' }, concurrency: { type: 'string', default: '8' } } })
const judge = values.judge && isOpenAIModel(values.judge) ? values.judge : undefined
if (values.judge && !judge) throw new Error('--judge takes an OpenAI model; DeepSeek is the default')
const dir = positionals[0]
if (!dir || !values.cases || !process.env[judge ? 'OPENAI_API_KEY' : 'DEEPSEEK_API_KEY']) throw new Error('usage: judge-heldout.ts <run-dir> --cases <cases.json> [--judge model]')
const output = `grades-heldout${judge ? '-' + modelSpec(judge).label : ''}.jsonl`

interface Row { arm: string; dataset: 'beam' | 'halumem'; case: string; id: string; type: string; question: string; gold: string; answer: string }
const rows = (await readFile(join(dir, 'rows.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Row)
const questions = new Map((JSON.parse(await readFile(values.cases, 'utf8')) as Case[]).flatMap(value => value.questions.map(question => [question.id, question] as const)))
const done = new Set((await readFile(join(dir, output), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => { const g = JSON.parse(line) as { arm: string; id: string }; return g.arm + '/' + g.id }))

/** A triple-quoted Python string assignment, `NAME = """..."""`, from a source file. */
function pythonString(source: string, name: string) {
  const match = new RegExp(`${name}\\s*=\\s*"""([\\s\\S]*?)"""`).exec(source)
  if (!match) throw new Error('prompt not found: ' + name)
  return match[1]!
}
const fetchText = async (url: string) => { const response = await fetch(url); if (!response.ok) throw new Error(`fetch ${url}: ${response.status}`); return response.text() }
const datasets = new Set(rows.map(row => row.dataset))
const BEAM = datasets.has('beam') ? pythonString(await fetchText(SOURCES.beam), 'unified_llm_judge_base_prompt') : ''
const HALUMEM = datasets.has('halumem') ? pythonString(await fetchText(SOURCES.halumem), 'EVALUATION_PROMPT_FOR_QUESTION') : ''
/** Python's str.format for the named fields, then its doubled braces. */
const pyFormat = (template: string, fields: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) => key in fields ? fields[key]! : whole).replaceAll('{{', '{').replaceAll('}}', '}')

async function ask(content: string) {
  if (!judge) return { ...await deepseek([{ role: 'user', content }], { maxTokens: 1200, thinking: false }), served: undefined }
  return openaiChat([{ role: 'user', content }], { model: judge, temperature: 0, maxTokens: 1200 })
}
/**
 * The JSON object in a reply, bare or in a ```json block. A backslash before a character JSON does not escape (a judge
 * quoting an answer's `\'` or `\$`) is read as a literal backslash rather than failing the grade; nothing else changes.
 */
function json(text: string): Record<string, unknown> {
  const block = /```json\s*(\{[\s\S]*?\})\s*```/.exec(text)?.[1] ?? /\{[\s\S]*\}/.exec(text)?.[0]
  if (!block) throw new Error('no JSON in judge reply: ' + text.slice(0, 120))
  try { return JSON.parse(block) as Record<string, unknown> } catch { return JSON.parse(block.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')) as Record<string, unknown> }
}
const usageOf = (reply: { usage: { miss: number; hit: number; output: number } }) => ({ miss: reply.usage.miss, hit: reply.usage.hit, output: reply.usage.output })
const add = (a: { miss: number; hit: number; output: number }, b: { miss: number; hit: number; output: number }) => ({ miss: a.miss + b.miss, hit: a.hit + b.hit, output: a.output + b.output })

async function grade(row: Row) {
  const question = questions.get(row.id)
  if (!question) throw new Error('question not in cases file: ' + row.id)
  if (row.dataset === 'beam') {
    const items: number[] = []
    let usage = { miss: 0, hit: 0, output: 0 }
    for (const item of question.rubric ?? []) {
      const reply = await ask(BEAM.replace('<rubric_item>', item).replace('<llm_response>', row.answer))
      usage = add(usage, usageOf(reply))
      items.push(Number(json(reply.text).score))
    }
    const score = items.length ? items.reduce((a, b) => a + b, 0) / items.length : 0
    return { score, items, usage }
  }
  const reply = await ask(pyFormat(HALUMEM, { question: row.question, reference_answer: row.gold, key_memory_points: (question.evidence ?? []).join('\n'), response: row.answer }))
  const label = String(json(reply.text).evaluation_result ?? '')
  return { label, correct: label === 'Correct', usage: usageOf(reply) }
}

async function verifyJudge() {
  if (!judge) return
  const check = await checkIdentity(judge)
  await appendFile(join(dir!, `judge-identity-heldout-${modelSpec(judge).label}.jsonl`), JSON.stringify(check) + '\n')
  if (check.ok === false) throw new Error(`Judge identity check failed for ${judge}: served ${check.served}`)
}

const pending = rows.filter(row => !done.has(row.arm + '/' + row.id))
let next = 0, graded = 0, failures = 0
if (pending.length) await verifyJudge()
await Promise.all(Array.from({ length: Number(values.concurrency) }, async () => {
  while (next < pending.length) {
    const row = pending[next++]!
    try { await appendFile(join(dir, output), JSON.stringify({ arm: row.arm, id: row.id, case: row.case, dataset: row.dataset, type: row.type, ...await grade(row) }) + '\n'); graded++ }
    catch (error) { failures++; console.error('grade failed', row.arm, row.id, String(error).slice(0, 200)) }
    if ((graded + failures) % 100 === 0 && next < pending.length) await verifyJudge()
  }
}))
console.log('graded', graded, 'of', pending.length, failures ? `(${failures} failed)` : '')
