/**
 * LoCoMo / LongMemEval through the same two-process DSH setup as the natural study.
 * An arm is a system and a memory mode:
 *   full-context              no memory system: the whole history in the prompt (the long-context reference);
 *   main-only:<mode>          the main DSH mounts the Sources and reads memory itself with the Host's View tools;
 *   replica-<kind>:<mode>     a replica composes the View: v4 (JEV cache scheme), scan (JEV full scan), lexical (no JEV),
 *                             cue (cue searches: a bounded read whatever the memory size), cuefill (cue, and the View
 *                             filled past the entry line with the best-scored rest, up to 8 items), cueintent and
 *                             cuefillintent (the recall call also says what a request needs: suggestions or gathering),
 *                             cuefillfocus (cuefill, and JEV judges a long item by its lines that match the searches),
 *                             cuefillread (cuefill, with read-time notes for what reaches JEV's short list);
 *                             v4t: the v4 View, and the main DSH may still read memory itself with the Host's View tools.
 * Memory modes: raw (dated messages as imported history), notes (dated session notes), raw-records (the dated
 * messages themselves, written like the notes: nothing extracted), hybrid (notes and raw history).
 *   node --env-file=<keys> --experimental-transform-types scripts/bench/run.ts --dataset locomo --cases conv-26,conv-41 --arms full-context,replica-v4:hybrid --out <dir>
 * A run resumes: questions already answered in <dir>/rows.jsonl are skipped, so the same command fills in what an
 * interrupted run or a failed question left out. --prepare only writes the session notes. --pad k makes LongMemEval
 * histories k times longer (see below). --continuous asks all of a case's questions one after another in a single
 * session (the whole-history arm keeps every earlier question and answer in its prompt); a case that fails part-way
 * should be rerun into a fresh directory, since its session cannot be resumed. --merge n (LoCoMo) puts all ten
 * conversations into one memory and asks every question that does not name John (three conversations have a John)
 * against it, in n shards that each hold the whole merged memory.
 * --model sets the model of every general LLM call: the answers, the replica's recall planning and the full-context
 * arm. The default is DeepSeek flash (answers with thinking; --no-thinking answers without); an OpenAI model (e.g.
 * gpt-4.1-mini) answers without thinking, and every reply's model and the model's identity checks are recorded (rows,
 * identity.jsonl).
 * Cue recall options for every replica arm: --searches n (searches in the first plan, default 3), --brief-plan (the plan
 * asked for in one sentence); --dates-first makes the answer list the dated events first for date, duration and order
 * questions; --embed-url <Ollama-compatible endpoint> makes every cue search also rank by meaning (nomic-embed-text)
 * and fuse that with its word ranking; --loop n runs n rounds of the JEV loop after the first (what the reply needs, tabled
 * by JEV, read further only where still open), and --loop-fill n fills the View to n items when it needs every instance;
 * --worth p shows JEV's maybes while each still has at least a p chance of being the evidence the View misses, in place
 * of the entry line and the fills; --unsure-fill n fills the View by JEV's ranking to n items when JEV calls nothing needed;
 * --feedback searches without the recall model: the question, then the words its best hits share (pseudo-relevance feedback);
 * --simple lets budgets, JEV's yes and ranking, and what the last step observed decide the View and the loop (补充 10);
 * --auto, with --simple, lets JEV's answers decide how far the loop pages and how much the View shows, keeping what it
 * calls no longer current but needed, marked; the journal allows 32 search calls a View (补充 23);
 * --consolidate model has background jobs fold the journal into topic timelines, value histories and standing
 * instructions with that model, and every View show those its records light up or JEV calls needed, ahead of the records
 * (补充 25–29); give --warm enough background jobs to read the whole journal before the first question: warming stops
 * early once a job finds nothing new to read and nothing left to fold.
 * --incremental (HaluMem) writes each user's cases into one journal, in order, as a memory that met the sessions as
 * they came would hold them: every case still starts fresh workers, ledger and channels, writes only the sessions it
 * adds, and keeps the journal and the consolidation state of the case before it (补充 30).
 * --large-journal lets the journal hold a ten-million-token history (200,000 records, 1 GiB) and keep each snapshot's
 * word index between searches; --warm-question asks one question that is not recorded before a case's first, so that
 * index (and the records' vectors) is built before any recorded question, and sets aside the ledger it leaves (补充 32).
 * --workspaces <dir> keeps the cases' workspaces there instead of under --out, so runs can share them: --seed-only writes
 * each case's journal and asks nothing; --reuse-workspace then starts a case from that journal (and any consolidation
 * state written into it), moving the files of the run before to runs/<time> (补充 33).
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { startWorker } from '../lib/jev-worker.mjs'
import { isoDate, loadCases, loadLocomo, loadLongMemEval, stratified, transcript, type Case, type Question } from './data.ts'
import { NOTES_VERSION, deepseek, sessionNotes } from './notes.ts'
import { checkIdentity, isOpenAIModel, openaiChat, openaiSecrets } from '../lib/openai.ts'
import type { MemoryMode } from './seed.ts'

const { values } = parseArgs({ options: { dataset: { type: 'string' }, file: { type: 'string' }, cases: { type: 'string' }, 'per-type': { type: 'string' }, arms: { type: 'string' }, out: { type: 'string' },
  concurrency: { type: 'string' }, questions: { type: 'string' }, warm: { type: 'string' }, notes: { type: 'string' }, 'notes-concurrency': { type: 'string' }, prepare: { type: 'boolean' }, pad: { type: 'string' },
  continuous: { type: 'boolean' }, merge: { type: 'string' }, model: { type: 'string' }, searches: { type: 'string' }, 'brief-plan': { type: 'boolean' }, 'dates-first': { type: 'boolean' }, 'embed-url': { type: 'string' }, loop: { type: 'string' }, 'loop-fill': { type: 'string' }, worth: { type: 'string' }, 'unsure-fill': { type: 'string' }, feedback: { type: 'boolean' }, simple: { type: 'boolean' }, auto: { type: 'boolean' }, consolidate: { type: 'string' }, incremental: { type: 'boolean' }, 'large-journal': { type: 'boolean' }, 'warm-question': { type: 'boolean' }, workspaces: { type: 'string' }, 'seed-only': { type: 'boolean' }, 'reuse-workspace': { type: 'boolean' }, 'no-thinking': { type: 'boolean' } } })
const dataset = values.dataset === 'longmemeval' || values.dataset === 'beam' || values.dataset === 'halumem' ? values.dataset : 'locomo'
// BEAM and HaluMem (held-out, 补充 12) come converted to the case shape; name the file with --file.
const heldOut = dataset === 'beam' || dataset === 'halumem'
const out = resolve(values.out ?? `bench-${dataset}`), concurrency = Number(values.concurrency ?? 4), warm = Number(values.warm ?? 3)
const benchDir = resolve(values.file ? join(values.file, '..') : '../runs/benchmarks') // the practice workspace keeps data beside the worktree
const all = heldOut ? await loadCases(values.file!) : dataset === 'locomo' ? await loadLocomo(values.file ?? join(benchDir, 'locomo10.json')) : await loadLongMemEval(values.file ?? join(benchDir, 'longmemeval_s_cleaned.json'))
let cases = values.cases ? all.filter(value => values.cases!.split(',').includes(value.id)) : values['per-type'] ? stratified(all, Number(values['per-type'])) : all
if (values.questions) cases = cases.map(value => ({ ...value, questions: value.questions.slice(0, Number(values.questions)) }))
// --merge n (LoCoMo): one memory of all conversations; questions naming John are left out as ambiguous across them.
const merged = values.merge !== undefined && dataset === 'locomo'
if (merged) {
  const shards = Number(values.merge), sessions = cases.flatMap(value => value.sessions), speakers = [...new Set(cases.flatMap(value => value.speakers))]
  const questions = cases.flatMap(value => value.questions).filter(question => !/\bJohn\b/.test(question.question))
  cases = Array.from({ length: shards }, (_, i) => ({ id: `locomo-merged-${i + 1}`, dataset: 'locomo' as const, speakers, sessions, questions: questions.filter((_, j) => j % shards === i) }))
}
// --pad k (LongMemEval): every history k times as many sessions, the extra ones filler sessions of other questions,
// never any question's evidence and always dated before the question, chosen by hash so every arm and rerun sees the same.
if (values.pad && dataset === 'longmemeval') {
  const factor = Number(values.pad), evidence = new Set(all.flatMap(value => value.questions.flatMap(question => question.evidence ?? [])))
  const pool = [...new Map(all.flatMap(value => value.sessions).filter(session => !evidence.has(session.id)).map(session => [session.id, session])).values()]
  const rank = (caseId: string, id: string) => createHash('sha256').update(`${caseId}:${id}`).digest('hex')
  cases = cases.map(value => {
    const own = new Set(value.sessions.map(session => session.id)), before = isoDate(value.questions[0]!.date!)
    const filler = pool.filter(session => !own.has(session.id) && session.iso < before)
      .map(session => [rank(value.id, session.id), session] as const).sort((a, b) => a[0].localeCompare(b[0])).slice(0, Math.round((factor - 1) * value.sessions.length)).map(([, session]) => session)
    return { ...value, sessions: [...value.sessions, ...filler] }
  })
}
const arms = (values.arms ?? 'full-context').split(',')
// --incremental (HaluMem, 补充 30): a user's cases share one journal (incrementalUser).
const incremental = values.incremental === true && dataset === 'halumem'
if (incremental && arms.some(arm => !arm.startsWith('replica-'))) throw new Error('--incremental runs replica arms only')
const notesFile = resolve(values.notes ?? join(benchDir, `notes-${dataset}.jsonl`))
const model = values.model ?? 'deepseek-flash', openai = isOpenAIModel(model)
const recallOptions = { ...(values.searches ? { searches: Number(values.searches) } : {}), ...(values['brief-plan'] ? { briefPlan: true } : {}), ...(values['embed-url'] ? { embedUrl: values['embed-url'] } : {}), ...(values.loop ? { loop: Number(values.loop) } : {}), ...(values['loop-fill'] ? { loopFill: Number(values['loop-fill']) } : {}), ...(values.worth ? { worth: Number(values.worth) } : {}), ...(values['unsure-fill'] ? { unsureFill: Number(values['unsure-fill']) } : {}), ...(values.feedback ? { feedback: true } : {}), ...(values.simple ? { simple: true } : {}), ...(values.auto ? { auto: true } : {}),
  ...(values.consolidate ? { consolidate: values.consolidate } : {}), ...(values['large-journal'] ? { largeJournal: true } : {}) }
if (!process.env[openai ? 'OPENAI_API_KEY' : 'DEEPSEEK_API_KEY']) throw new Error((openai ? 'OPENAI_API_KEY' : 'DEEPSEEK_API_KEY') + ' required')
const redact = (text: string) => [process.env.TYPESAFE_API_KEY, process.env.DEEPSEEK_API_KEY, ...openaiSecrets()].filter((key): key is string => !!key).reduce((value, key) => value.replaceAll(key, '[credential]'), text)
await mkdir(out, { recursive: true })
const log = (line: string) => appendFile(join(out, 'progress.log'), `${new Date().toISOString()} ${redact(line)}\n`)
const answered = new Set((await readFile(join(out, 'rows.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => { const row = JSON.parse(line) as { arm: string; id: string }; return `${row.arm}/${row.id}` }))
const pending = (arm: string, value: Case) => value.questions.filter(question => !answered.has(`${arm}/${question.id}`))
/** A question that failed is logged and skipped; after three failures in a row the rest of the case waits for the next run. */
async function failed(arm: string, value: Case, question: Question | undefined, error: unknown) {
  await appendFile(join(out, 'failures.jsonl'), JSON.stringify({ at: new Date().toISOString(), arm, case: value.id, id: question?.id, error: redact(String(error)).slice(0, 500) }) + '\n')
  await log(`${arm} ${value.id} ${question?.id ?? ''} FAILED ${String(error).slice(0, 200)}`)
  // A refused key fails every later call too: stop starting questions rather than keep calling the API.
  if (!halted && /OpenAI request failed: 40[13]\b/.test(String(error))) { halted = true; await log('HALT: the OpenAI API refused the key; no further questions start') }
}
let halted = false

/** Sessions tagged #1..#n in date order: the tag names the conversation in every memory item and in the full-context prompt. */
const ordered = (value: Case) => value.sessions.slice().sort((a, b) => a.iso.localeCompare(b.iso)).map((session, i) => ({ ...session, tag: `#${i + 1}` }))
const questionText = (question: Question) => dataset === 'locomo' ? question.question : `Current date: ${question.date}\n${question.question}`
const PROMPTS = {
  longmemeval: 'You are a helpful assistant with long-term memory of your past conversations with the user. Answer from the conversation history. Use the current date stated with the question for any date arithmetic, and when a fact changed over time, answer with the latest version. When the user asks for suggestions, tailor them to what you know about the user. If the history does not contain what the question asks, say you do not know rather than guessing. Keep the answer short and direct.',
  locomo: 'You answer questions about the long-running conversation between two people, using the conversation history; every conversation carries its date. Answer with the specific fact asked for, as briefly as possible. For questions about when something happened, give the date, month or year, resolving relative times such as "last week" from the conversation date. If the history does not contain the answer, say it is not mentioned.',
  halumem: 'You are a helpful assistant with long-term memory of your past conversations with the user. Answer from the conversation history. Use the current date stated with the question for any date arithmetic, and when a fact changed over time, answer with the latest version. When the user asks for suggestions, tailor them to what you know about the user. If the history does not contain what the question asks, say you do not know rather than guessing. Keep the answer short and direct.',
  beam: 'You are a helpful assistant with long-term memory of your past conversations with the user. Answer from the conversation history. Use the current date stated with the question for any date arithmetic, and when a fact changed over time, answer with the latest version. When the user asks for suggestions, tailor them to what you know about the user. If the history does not contain what the question asks, say you do not know rather than guessing. Follow any instructions or preferences the user gave earlier in the conversations.',
  'locomo-merged': 'You answer questions about several long-running conversations, each between a different pair of people, using the conversation history; every conversation carries its date, and each question names the person it is about. Answer with the specific fact asked for, as briefly as possible. For questions about when something happened, give the date, month or year, resolving relative times such as "last week" from the conversation date. If the history does not contain the answer, say it is not mentioned.',
}
const prompt = merged ? PROMPTS['locomo-merged'] : PROMPTS[dataset]
const history = (value: Case) => ordered(value).map(session => `### Conversation ${session.tag} on ${session.date}\n${transcript(session)}`).join('\n\n')

type Worker = Awaited<ReturnType<typeof startWorker>>
interface Channel { progress: { revision: number }; lease?: unknown; lastRun?: { revision: number; at: number } }
async function settle(replica: Worker, sessionId: string, after = 0) {
  const started = Date.now()
  while (Date.now() - started < 180_000) {
    const { channel } = await replica.request('state', { sessionId }) as { channel?: Channel }
    if (channel && !channel.lease && channel.lastRun?.revision === channel.progress.revision && channel.lastRun.at >= after) return Date.now() - started
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Replica did not settle ' + sessionId)
}
/** Background jobs before the first question, at most --warm; with --consolidate, until one finds nothing new to read or fold. */
async function warmUp(replica: Worker) {
  let jobs = 0, consolidation: Record<string, unknown> | undefined
  while (jobs < warm) {
    const before = Date.now(); await replica.request('prime', { sessionId: 'warmup' }); await settle(replica, 'warmup', before); jobs++
    if (!values.consolidate) continue
    consolidation = (await replica.request('naturalTraces', { sessionId: 'warmup' }) as Array<Record<string, any>>).at(-1)?.consolidation
    if (consolidation?.read === 0 && consolidation.pending === 0) break
  }
  return { jobs, ...(consolidation ? { consolidation } : {}) }
}

/** Which conversations (by tag) a text shows: evidence recall of the View or the request. */
const tagsIn = (text: string) => new Set([...text.matchAll(/#(\d+)\b/g)].map(match => '#' + match[1]))
function evidenceTags(value: Case, question: Question): string[] {
  const sessions = ordered(value)
  if (heldOut) return [] // BEAM and HaluMem name no evidence sessions
  if (dataset === 'longmemeval') return sessions.filter(session => question.evidence?.includes(session.id)).map(session => session.tag)
  // LoCoMo evidence is dialogue ids like "D12:3": session 12 of the question's own conversation.
  const conversation = question.id.replace(/-q\d+$/, ''), numbers = new Set((question.evidence ?? []).map(id => /^D(\d+):/.exec(id)?.[1]).filter((n): n is string => !!n))
  return sessions.filter(session => [...numbers].some(n => session.id === `${conversation}-s${n}`)).map(session => session.tag)
}

async function fullContext(value: Case) {
  const prefix = history(value), earlier: Array<{ role: 'user' | 'assistant'; content: string }> = []
  let streak = 0
  if (openai) {
    const check = await checkIdentity(model)
    await appendFile(join(out, 'identity.jsonl'), JSON.stringify({ arm: 'full-context', case: value.id, use: 'main', model, identity: [check] }) + '\n')
    if (check.ok === false) return failed('full-context', value, undefined, new Error(`Model identity check failed for ${model}: served ${check.served}`))
  }
  for (const question of pending('full-context', value)) {
    if (halted) return
    try {
      const started = Date.now()
      const messages = dataset === 'locomo'
        ? [{ role: 'system' as const, content: prompt + '\n\nCONVERSATION HISTORY:\n' + prefix }, ...earlier, { role: 'user' as const, content: question.question }]
        : [{ role: 'system' as const, content: heldOut ? PROMPTS[dataset] : PROMPTS.longmemeval }, ...earlier, { role: 'user' as const, content: (earlier.length ? '' : 'Our past conversations:\n\n' + prefix + '\n\n') + questionText(question) }]
      // A whole long history is one expensive request: a long wait, and at most one retry.
      const { text, usage, served } = openai ? await openaiChat(messages, { model, maxTokens: 1024, timeoutMs: 900_000, retries: 2 })
        : { ...await deepseek(messages, { maxTokens: 8192, thinking: !values['no-thinking'], timeoutMs: 900_000, retries: 1 }), served: undefined }
      await record({ arm: 'full-context', mode: 'none', value, question, answer: text, elapsedMs: Date.now() - started, main: [{ miss: usage.miss, hit: usage.hit, output: usage.output, reasoning: usage.reasoning, ...(served ? { served } : {}) }], evidence: 1 })
      if (values.continuous) earlier.push({ role: 'user', content: dataset === 'locomo' ? question.question : (earlier.length ? '' : 'Our past conversations:\n\n' + prefix + '\n\n') + questionText(question) }, { role: 'assistant', content: text })
      streak = 0
    } catch (error) {
      await failed('full-context', value, question, error)
      if (++streak >= 3) return
    }
  }
}

/**
 * One case in fresh workers. With `shared` (--incremental) the case writes into its user's workspace only the sessions
 * it adds to the `written` ones before it, and its questions get sessions of their own. Returns whether its sessions
 * were written, so a user's later cases never build on a journal that misses them.
 */
async function withWorkers(arm: string, value: Case, shared?: { root: string; written: number }): Promise<boolean> {
  const [system, mode = 'hybrid'] = arm.split(':') as [string, MemoryMode]
  const root = shared?.root ?? join(values.workspaces ? resolve(values.workspaces) : out, arm.replace(':', '-'), value.id), corpusRoot = join(root, 'corpus'), logs: string[] = [], workers: Worker[] = []
  // --reuse-workspace: a case written by --seed-only keeps its journal and consolidation state; the workers', ledger's
  // and channels' files of the run before are moved to runs/<time>, so this run starts as fresh as a new case.
  const reuse = !shared && values['reuse-workspace'] === true && await stat(join(root, 'seeded.json')).then(() => true, () => false)
  // A resumed case starts from a fresh workspace; the earlier attempt is kept beside it.
  if (reuse) await archive(root, join('runs', String(Date.now())), true)
  else if (!shared) {
    if (await stat(root).then(() => true, () => false)) await rename(root, `${root}.attempt-${Date.now()}`)
    await mkdir(root, { recursive: true })
  }
  const onLog = (text: string) => { logs.push(redact(text)) }
  let ready = false
  try {
    const sessions = ordered(value).slice(shared?.written ?? 0)
    const notes = mode === 'raw' || mode === 'raw-records' ? undefined : Object.fromEntries([...await sessionNotes(sessions.map(session => ({ session, speakers: value.speakers })), notesFile)].map(([id, note]) => [id, note.notes]))
    // Tags go into the stored text so evidence can be traced and the answerer can tell conversations apart.
    const memory = { mode, notes, sessions }
    const replicaKind = system.startsWith('replica-') ? system.slice('replica-'.length) : undefined
    const replica = replicaKind ? await startWorker(root, 'replica', { live: true, corpusRoot, naturalCorpus: true, bench: merged ? 'locomo-merged' : dataset, onLog, waitMs: 30_000, ...(openai ? { recallModel: model } : {}), ...recallOptions,
      ...(replicaKind === 'lexical' ? { natural: 'lexical' } : replicaKind === 'scan' ? { natural: 'jev', recall: 'jev' } : replicaKind === 'cue' ? { natural: 'jev', recall: 'cue' } : replicaKind === 'cuefill' ? { natural: 'jev', recall: 'cue', fill: 8 }
        : replicaKind === 'cueintent' ? { natural: 'jev', recall: 'cue', intent: true } : replicaKind === 'cuefillintent' ? { natural: 'jev', recall: 'cue', fill: 8, intent: true }
        : replicaKind === 'cuefillfocus' ? { natural: 'jev', recall: 'cue', fill: 8, focus: 300 } : replicaKind === 'cuefillread' ? { natural: 'jev', recall: 'cue', fill: 8, materialize: true }
        : { natural: 'jev', recall: 'llm', termsFrom: 'recall' }) }) : undefined
    if (replica) workers.push(replica)
    const main = await startWorker(root, 'main', { live: true, corpusRoot, naturalCorpus: true, bench: merged ? 'locomo-merged' : dataset, onLog, waitMs: 30_000, ...(openai ? { mainModel: model } : { thinking: !values['no-thinking'] }), ...(values['dates-first'] ? { datesFirst: true } : {}), ...(values['large-journal'] ? { largeJournal: true } : {}),
      ...(replica ? { delivery: 'stable', snapshots: 'delta', ...(replicaKind === 'v4t' ? { mainMemory: true } : {}) } : { noReplica: true, mainMemory: true }) })
    workers.push(main)
    const seeded = reuse ? JSON.parse(await readFile(join(root, 'seeded.json'), 'utf8')) : await (replica ?? main).request('seedBench', memory as unknown as Record<string, unknown>, 600_000)
    // --seed-only writes the journal for later runs (--reuse-workspace) and asks nothing.
    if (values['seed-only']) { await writeFile(join(root, 'seeded.json'), JSON.stringify(seeded)); await log(`${arm} ${value.id} seeded only ${JSON.stringify(seeded)}`); ready = true; return ready }
    const warmed = replica ? await warmUp(replica) : undefined
    ready = true
    await log(`${arm} ${value.id} seeded ${JSON.stringify(seeded)}${warmed ? ' warmed ' + JSON.stringify(warmed) : ''}`)
    let streak = 0
    const seen = new Map<string, number>()
    // --warm-question: one question that is not recorded builds a long journal's word index (and the records' vectors)
    // before the first recorded one; the ledger it leaves is set aside, so that question starts as it otherwise would.
    if (replica && values['warm-question']) {
      const natural = join(root, 'replica', 'natural'), before = Date.now()
      // Asked again, at most four times, while its View takes over 30 seconds or does not finish: a long journal's
      // vectors come a chunk at a time, and one question can run out of time before all of them are in.
      let asked = 0
      for (let slow = true; slow && asked < 4; asked++) {
        const sessionId = `${value.id}-warm${asked ? '-' + asked : ''}`
        await main.request('chat', { text: 'What have we been talking about recently?', sessionId }, 600_000).catch(() => undefined)
        await settle(replica, sessionId).catch(() => undefined)
        const input = (await replica.request('naturalTraces', { sessionId }).catch(() => []) as Array<Record<string, any>>).filter(trace => trace.trigger === 'input').at(-1)
        slow = !input || Number(input.timing?.total ?? Infinity) > 30_000
      }
      for (const file of await readdir(natural).catch(() => [] as string[])) if (/^ledger-.*\.json$/.test(file)) {
        await mkdir(join(natural, 'set-aside'), { recursive: true }); await rename(join(natural, file), join(natural, 'set-aside', `warm-${file}`))
      }
      await log(`${arm} ${value.id} ${asked} warm question(s) took ${Math.round((Date.now() - before) / 1000)} s; their ledger set aside`)
    }
    // Errors of the background jobs before the first question (a warm-up job past its turn deadline) are logged, not
    // pinned on the first question: a question fails only on errors raised while it is answered (补充 30).
    let replicaErrors = 0
    if (replica) {
      const { errors = [] } = await replica.request('state', { sessionId: 'warmup' }) as { errors?: string[] }
      replicaErrors = errors.length
      if (errors.length) await log(`${arm} ${value.id} warm-up errors: ${errors.join(' | ').slice(0, 300)}`)
    }
    for (const [index, question] of value.questions.entries()) {
      if (answered.has(`${arm}/${question.id}`)) continue
      if (halted) break
      try {
        const sessionId = values.continuous ? 'continuous' : shared ? `${value.id}-q${index}` : `q${index}`, chat = await main.request('chat', { text: questionText(question), sessionId }, 600_000) as ChatResult
        // A failed model call ends the turn without an answer; record a failure (retried by the next run), not a wrong answer.
        if (chat.end?.reason && !['completed', 'max-tokens'].includes(chat.end.reason.kind)) throw new Error('main turn ended: ' + JSON.stringify(chat.end.reason).slice(0, 300))
        if (!chat.answer.trim()) throw new Error('empty answer')
        if (replica) await settle(replica, sessionId)
        // Likewise when the replica hit an error (e.g. a failed recall call) while composing this question's View.
        if (replica) {
          const { errors = [] } = await replica.request('state', { sessionId }) as { errors?: string[] }
          if (errors.length > replicaErrors) { const fresh = errors.slice(replicaErrors); replicaErrors = errors.length; throw new Error('replica error: ' + fresh.join(' | ').slice(0, 300)) }
        }
        const traces = replica ? await replica.request('naturalTraces', { sessionId }) as Array<Record<string, any>> : []
        const input = traces.slice(seen.get(sessionId) ?? 0).filter(trace => trace.trigger === 'input')
        seen.set(sessionId, traces.length)
        const view = chat.candidate ? chat.candidate.items.map(item => item.text).join('\n') : chat.request?.text ?? ''
        const wanted = evidenceTags(value, question), shown = tagsIn(view)
        // Cue recall: which evidence reached its candidate pool (the headings of what JEV screened), before any judgement.
        const pooled = input.flatMap(trace => (trace.cues?.candidates ?? []) as string[])
        await record({ arm, mode, value, question, answer: chat.answer, elapsedMs: chat.elapsedMs,
          main: (chat.calls ?? []).map(call => ({ miss: call.usage?.inputTokens ?? 0, hit: call.usage?.cacheReadTokens ?? 0, output: call.usage?.outputTokens ?? 0, reasoning: call.usage?.reasoningTokens ?? 0, ...(call.served ? { served: call.served } : {}) })),
          replica: { jev: input.reduce((n, trace) => n + Number(trace.decisionTokens ?? 0), 0), recall: input.map(trace => trace.recallUsage).filter(Boolean), items: chat.candidate?.items.length ?? 0,
            ms: input.reduce((n, trace) => n + Number(trace.timing?.total ?? 0), 0), reads: input.reduce((n, trace) => n + Number(trace.reads ?? 0), 0),
            ...(pooled.length ? { calls: input.reduce((n, trace) => n + Number(trace.decisions ?? 0), 0), rounds: Math.max(...input.map(trace => Number(trace.cues?.rounds ?? 0))),
              filled: input.reduce((n, trace) => n + (trace.filled?.length ?? 0), 0),
              ...(wanted.length ? { pool: wanted.filter(tag => tagsIn(pooled.join('\n')).has(tag)).length / wanted.length } : {}) } : {}) },
          evidence: wanted.length ? wanted.filter(tag => shown.has(tag)).length / wanted.length : undefined })
        // What the main model was given: the replica's View, and the whole final request when it could also search itself.
        await appendFile(join(out, 'contexts.jsonl'), JSON.stringify({ arm, id: question.id, ...(chat.candidate ? { view: chat.candidate.items.map(item => item.text) } : {}),
          ...(!replica || replicaKind === 'v4t' ? { request: chat.request?.text ?? '' } : {}) }) + '\n')
        streak = 0
      } catch (error) {
        await failed(arm, value, question, error)
        if (++streak >= 3) throw new Error('three failed questions in a row')
      }
    }
  } catch (error) {
    await failed(arm, value, undefined, error)
  } finally {
    // Which OpenAI models answered this case, what was discarded as another model's, and the identity checks.
    if (openai) for (const worker of workers) {
      const reports = await worker.request('identity').catch(() => undefined) as Array<Record<string, unknown>> | undefined
      for (const report of reports ?? []) await appendFile(join(out, 'identity.jsonl'), JSON.stringify({ arm, case: value.id, ...report }) + '\n')
    }
    await writeFile(join(root, shared ? `worker-${value.id}.log` : 'worker.log'), logs.join(''))
    for (const worker of workers.reverse()) await worker.close().catch(() => {})
  }
  return ready
}

/**
 * --incremental (HaluMem): a user's cases in order in one journal, each case holding the sessions of the one before it
 * and the ones it adds. Before a case starts, the workers', ledger's and channels' files of the case before it are moved
 * to cases/<id>, so it starts as fresh as a case of its own; the journal and the consolidation state stay.
 */
const userOf = (value: Case) => value.id.replace(/-s\d+$/, '')
async function incrementalUser(arm: string, list: Case[]) {
  const root = join(out, arm.replace(':', '-'), userOf(list[0]!))
  // A resumed user starts again from its first case (answered questions are not asked again); the attempt is kept.
  if (await stat(root).then(() => true, () => false)) await rename(root, `${root}.attempt-${Date.now()}`)
  await mkdir(root, { recursive: true })
  let before: Case | undefined
  for (const value of list) {
    const sessions = ordered(value), written = before ? ordered(before) : []
    if (written.some((session, i) => sessions[i]?.id !== session.id)) throw new Error(`${value.id} does not extend ${before!.id}`)
    if (before) await archive(root, before.id, true)
    if (!await withWorkers(arm, value, { root, written: written.length })) { await log(`${arm} ${userOf(value)} stopped at ${value.id}: its sessions were not written`); return }
    before = value
  }
  if (before) await archive(root, before.id, false)
}
async function archive(root: string, id: string, keepConsolidation: boolean) {
  const target = join(root, 'cases', id)
  await mkdir(target, { recursive: true })
  for (const name of ['main', 'replica', 'transport']) await rename(join(root, name), join(target, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
  if (!keepConsolidation) return
  const from = join(target, 'replica', 'natural'), to = join(root, 'replica', 'natural')
  await mkdir(to, { recursive: true })
  for (const file of await readdir(from).catch(() => [] as string[])) if (/^consolidation-[0-9a-f]+\.json$/.test(file)) await copyFile(join(from, file), join(to, file))
}

interface ChatResult { elapsedMs: number; answer: string; end?: { reason?: { kind: string } }; request?: { text: string }; candidate?: { items: Array<{ text: string }> }; calls?: Array<{ served?: string; usage?: { inputTokens?: number; cacheReadTokens?: number; outputTokens?: number; reasoningTokens?: number } }> }
async function record(row: { arm: string; mode: string; value: Case; question: Question; answer: string; elapsedMs: number; main: Array<Record<string, number | string>>; replica?: Record<string, unknown>; evidence?: number | undefined }) {
  const { value, question, ...rest } = row
  await appendFile(join(out, 'rows.jsonl'), JSON.stringify({ ...rest, model, dataset, case: value.id, id: question.id, type: question.type, abstention: question.abstention === true,
    question: question.question, gold: question.answer, date: question.date }) + '\n')
  await log(`${row.arm} ${value.id} ${question.id} ${Math.round(row.elapsedMs)} ms evidence ${row.evidence ?? '-'}`)
}

// Every invocation keeps its own record: code version, data checksum, models and prompts, and what was still to do.
const dataFile = values.file ?? join(benchDir, dataset === 'locomo' ? 'locomo10.json' : 'longmemeval_s_cleaned.json') // held-out sets always name --file
const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: new URL('../..', import.meta.url).pathname }).then(result => result.stdout.trim(), () => undefined)
await writeFile(join(out, `config-${arms.join('+').replaceAll(':', '-')}-${Date.now()}.json`), JSON.stringify({ startedAt: new Date().toISOString(), argv: process.argv.slice(2), node: process.version,
  git: { commit: await git('rev-parse', 'HEAD'), dirty: (await git('status', '--porcelain'))?.length !== 0 }, dataset, dataFile, dataSha256: createHash('sha256').update(await readFile(dataFile)).digest('hex'),
  cases: cases.map(value => value.id), questions: cases.reduce((n, value) => n + value.questions.length, 0), pending: arms.reduce((n, arm) => n + cases.reduce((m, value) => m + pending(arm, value).length, 0), 0),
  arms, warm, concurrency, recallOptions, datesFirst: values['dates-first'] === true, pad: values.pad ? Number(values.pad) : 1, continuous: values.continuous === true, incremental, merged: merged ? Number(values.merge) : undefined, sessions: cases.reduce((n, value) => n + value.sessions.length, 0), notesVersion: NOTES_VERSION, prompt,
  models: openai ? { main: `${model} (OpenAI API), temperature 0`, notes: 'deepseek-flash, thinking disabled, temperature 0', recall: `${model} (OpenAI API), temperature 0`, fullContext: `${model} (OpenAI API), temperature 0`, jev: 'jev-1.13.0' }
    : { main: values['no-thinking'] ? 'deepseek-flash, thinking disabled' : 'deepseek-flash, thinking enabled, reasoning effort high', notes: 'deepseek-flash, thinking disabled, temperature 0', recall: 'deepseek-flash, thinking disabled', jev: 'jev-1.13.0' } }, null, 2))
// Notes are written once, before any arm needs them.
if (values.prepare || arms.some(arm => arm.includes(':') && !arm.endsWith(':raw') && !arm.endsWith(':raw-records'))) {
  const all = cases.flatMap(value => ordered(value).map(session => ({ session, speakers: value.speakers })))
  let reported = 0
  await sessionNotes(all, notesFile, Number(values['notes-concurrency'] ?? 16), (done, total) => { if (done - reported >= 100 || done === total) { reported = done; void log(`notes ${done}/${total}`) } })
  if (values.prepare) { console.log('notes ready'); process.exit(0) }
}
const users = [...Map.groupBy(cases, userOf).values()].map(list => list.sort((a, b) => a.sessions.length - b.sessions.length))
const jobs = incremental
  ? arms.flatMap(arm => users.filter(list => list.some(value => pending(arm, value).length)).map(list => () => incrementalUser(arm, list).catch(error => failed(arm, list[0]!, undefined, error))))
  : arms.flatMap(arm => cases.filter(value => pending(arm, value).length).map(value => () => arm === 'full-context' ? fullContext(value) : withWorkers(arm, value)))
let next = 0
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => { while (next < jobs.length && !halted) await jobs[next++]!() }))
console.log(halted ? 'halted: the OpenAI API refused the key' : 'done', jobs.length, 'jobs')
