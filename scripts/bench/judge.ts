/**
 * Grade benchmark answers the way each benchmark's own evaluation does:
 *   LongMemEval  the type-specific yes/no checks of its evaluate_qa.py;
 *   LoCoMo       the generous CORRECT/WRONG judge used by Mem0 and later work, plus token F1.
 *   node --env-file=<keys> --experimental-transform-types scripts/bench/judge.ts <run-dir> [--judge <model>] [--pass 2 | --refine <locomo-refined.json>] [--concurrency 16]
 * The judge is DeepSeek flash by default. --judge names an OpenAI model instead, e.g. gpt-4.1-mini, or gpt-4o@2024-08-06
 * (the snapshot LongMemEval's own evaluation uses; replies from any other snapshot are discarded and asked again);
 * its grades go to grades-<model>.jsonl and record the model that answered, and its identity checks go to
 * judge-identity-<model>.jsonl. Absolute numbers differ between judges.
 * Grading resumes where it stopped. --pass 2 grades every answer again into grades-2.jsonl (grades-<model>-2.jsonl), to
 * measure how consistent the judge is with itself. --refine <locomo-refined.json> grades only the answers to questions
 * whose gold answer the label review corrected, against the corrected answer, into grades-refined.jsonl.
 */
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { deepseek } from './notes.ts'
import { checkIdentity, isOpenAIModel, modelSpec, openaiChat } from '../lib/openai.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { pass: { type: 'string', default: '1' }, concurrency: { type: 'string', default: '8' }, refine: { type: 'string' }, judge: { type: 'string' } } })
const judge = values.judge && isOpenAIModel(values.judge) ? values.judge : undefined
if (values.judge && !judge) throw new Error('--judge takes an OpenAI model; DeepSeek is the default')
const suffix = judge ? '-' + modelSpec(judge).label : ''
const dir = positionals[0], output = values.refine ? `grades${suffix}-refined.jsonl` : values.pass === '1' ? `grades${suffix}.jsonl` : `grades${suffix}-${values.pass}.jsonl`
const fixed = values.refine ? (JSON.parse(await readFile(values.refine, 'utf8')) as { fix: Record<string, { gold: string }> }).fix : undefined
if (!dir || !process.env[judge ? 'OPENAI_API_KEY' : 'DEEPSEEK_API_KEY']) throw new Error(`usage: judge.ts <run-dir> [--judge model] [--pass n] (${judge ? 'OPENAI_API_KEY' : 'DEEPSEEK_API_KEY'} required)`)
interface Row { arm: string; dataset: 'locomo' | 'longmemeval'; case: string; id: string; type: string; abstention: boolean; question: string; gold: string; answer: string }
const rows = (await readFile(join(dir, 'rows.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Row)
  .flatMap(row => !fixed ? [row] : fixed[row.id] ? [{ ...row, gold: fixed[row.id]!.gold }] : [])
const done = new Set((await readFile(join(dir, output), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => { const g = JSON.parse(line) as { arm: string; id: string }; return g.arm + '/' + g.id }))

const LME = {
  base: 'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.',
  temporal: ' In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model\'s response is still correct.',
  update: 'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.',
  preference: 'I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user\'s personal information correctly.',
  abstention: 'I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.',
}
function longmemevalPrompt(row: Row) {
  if (row.abstention) return `${LME.abstention}\n\nQuestion: ${row.question}\n\nExplanation: ${row.gold}\n\nModel Response: ${row.answer}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`
  if (row.type === 'single-session-preference') return `${LME.preference}\n\nQuestion: ${row.question}\n\nRubric: ${row.gold}\n\nModel Response: ${row.answer}\n\nIs the model response correct? Answer yes or no only.`
  const head = row.type === 'knowledge-update' ? LME.update : LME.base + (row.type === 'temporal-reasoning' ? LME.temporal : '')
  return `${head}\n\nQuestion: ${row.question}\n\nCorrect Answer: ${row.gold}\n\nModel Response: ${row.answer}\n\nIs the model response correct? Answer yes or no only.`
}
const locomoPrompt = (row: Row) => `Your task is to label an answer to a question as 'CORRECT' or 'WRONG'. You will be given (1) a question posed by one user to another user, (2) a 'gold' (ground truth) answer, and (3) a generated answer.

The point of the question is to ask about something one user should know about the other user from their earlier conversations. The gold answer is usually short. The generated answer may be much longer, but be generous: as long as it touches on the same topic as the gold answer, count it as CORRECT.

For time-related questions the gold answer is a specific date, month or year. The generated answer may be longer or use relative references ("last Tuesday", "next month"); be generous: as long as it refers to the same date or period as the gold answer, count it as CORRECT, whatever the format ("May 7th" vs "7 May").

Question: ${row.question}
Gold answer: ${row.gold}
Generated answer: ${row.answer}

Explain your reasoning in one short sentence, then give the label. Reply as JSON: {"reason": "...", "label": "CORRECT"} or {"reason": "...", "label": "WRONG"}.`

/** SQuAD-style token F1 after lower-casing and dropping punctuation and articles. */
function f1(prediction: string, gold: string) {
  const tokens = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(token => token && !['a', 'an', 'the', 'and'].includes(token))
  const p = tokens(prediction), g = tokens(gold)
  if (!p.length || !g.length) return Number(p.length === g.length)
  const counts = new Map<string, number>()
  for (const token of g) counts.set(token, (counts.get(token) ?? 0) + 1)
  let common = 0
  for (const token of p) { const n = counts.get(token) ?? 0; if (n > 0) { common++; counts.set(token, n - 1) } }
  if (!common) return 0
  const precision = common / p.length, recall = common / g.length
  return 2 * precision * recall / (precision + recall)
}

/** One judge call at temperature 0; the OpenAI judge also reports which model answered. */
async function ask(content: string, options: { maxTokens: number; json?: boolean }) {
  if (!judge) return { ...await deepseek([{ role: 'user', content }], options), served: undefined }
  return openaiChat([{ role: 'user', content }], { model: judge, temperature: 0, ...options })
}
/** What a judgment cost: the accepted reply's tokens, and how many replies from another snapshot were discarded before it. */
const spent = (reply: { usage: { miss: number; hit: number; output: number }; rejected?: string[] }) =>
  ({ usage: { miss: reply.usage.miss, hit: reply.usage.hit, output: reply.usage.output }, ...(reply.rejected?.length ? { discarded: reply.rejected.length } : {}) })
async function grade(row: Row) {
  if (row.dataset === 'longmemeval') {
    const reply = await ask(longmemevalPrompt(row), { maxTokens: 10 })
    return { correct: /^\s*yes/i.test(reply.text), raw: reply.text.trim().slice(0, 20), ...(reply.served ? { judge: reply.served } : {}), ...spent(reply) }
  }
  const reply = await ask(locomoPrompt(row), { maxTokens: 300, json: true }), text = reply.text
  let label = ''
  try { label = String((JSON.parse(text) as { label?: string }).label ?? '') } catch { label = /\bWRONG\b/.test(text) ? 'WRONG' : /\bCORRECT\b/.test(text) ? 'CORRECT' : '' }
  return { correct: label.toUpperCase() === 'CORRECT', raw: label, f1: f1(row.answer, row.gold), ...(reply.served ? { judge: reply.served } : {}), ...spent(reply) }
}

/** An OpenAI judge's identity is checked before grading and after every 100 grades (see checkIdentity); a failed check stops grading. */
async function verifyJudge() {
  if (!judge) return
  const check = await checkIdentity(judge)
  await appendFile(join(dir!, `judge-identity${suffix}.jsonl`), JSON.stringify(check) + '\n')
  if (check.ok === false) throw new Error(`Judge identity check failed for ${judge}: served ${check.served}, opening ${JSON.stringify(check.opening)}`)
}

const pending = rows.filter(row => !done.has(row.arm + '/' + row.id))
let next = 0, graded = 0, failures = 0
if (pending.length) await verifyJudge()
await Promise.all(Array.from({ length: Number(values.concurrency) }, async () => {
  while (next < pending.length) {
    const row = pending[next++]!
    try { await appendFile(join(dir, output), JSON.stringify({ arm: row.arm, id: row.id, case: row.case, type: row.type, abstention: row.abstention, ...await grade(row) }) + '\n'); graded++ }
    catch (error) { failures++; console.error('grade failed', row.arm, row.id, String(error).slice(0, 200)) }
    if ((graded + failures) % 100 === 0 && next < pending.length) await verifyJudge()
  }
}))
console.log('graded', graded, 'of', pending.length, failures ? `(${failures} failed)` : '')
