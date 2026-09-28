import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LexicalIndex } from 'dsh-mnemon/source-sdk'

/**
 * Consolidation (phase 3, 补充 25–27): the raw records stay the only evidence; after they are written, a model reads
 * each record once, in order, and writes an index over them — events on topic timelines, the history of values that
 * can change, and the instructions the user asked the assistant to keep — every item linked to the records it came
 * from. A question then lights up the topics and values its own evidence is linked to, JEV judges those and the nearest
 * few, and the View shows them coarse to fine: standing instructions, a one-line directory of every topic, the chosen
 * timelines and value histories, then the records themselves.
 */
export interface ConsolidationConfig {
  model: { provider: string; model: string }
  /** Ollama-compatible embedding service for the nearest topics and values; without it, word overlap ranks them. */
  embedUrl?: string; embedModel: string
  /** The Source whose records are consolidated; its search Route must list records oldest first after a creation time. */
  sourceTypeId: string
  /** Characters of readable text a batch holds, and of an assistant message that is read. */
  batchCharacters: number; assistantCharacters: number
  /** Batches one background job may fold: the rest waits for the next job. */
  maxBatches: number
  /** For very long memories: at most this many threads, keys and directives in a fold's prompt (all of them unless set). */
  indexLimit?: IndexLimit
}
export interface Thread { id: string; title: string }
export interface TimelineEvent { thread: string; date: string; text: string; records: string[] }
export interface StateValue { value: string; date: string; records: string[]; conflict: boolean }
export interface Directive { text: string; date: string; records: string[] }
export interface Consolidated { threads: Thread[]; events: TimelineEvent[]; facts: Record<string, StateValue[]>; directives: Directive[] }
export interface Pending { id: string; header: string; text: string }
export interface ConsolidationState {
  format: 'mnemon-consolidation/v1'
  /** The newest creation time read and the records read at it: the next job reads from there. */
  watermark?: { at: string; ids: string[] }
  pending: Pending[]; memory: Consolidated
  usage: { miss: number; hit: number; output: number }; calls: number; batches: number; failed: number
}
export const emptyState = (): ConsolidationState => ({ format: 'mnemon-consolidation/v1', pending: [], memory: { threads: [], events: [], facts: {}, directives: [] },
  usage: { miss: 0, hit: 0, output: 0 }, calls: 0, batches: 0, failed: 0 })

// ---------------------------------------------------------------------------------------------------------------- write

/**
 * What a consolidating model reads of a record, or nothing. A chat transcript is read for its user text whole and the
 * first characters of each assistant message; the rest of a long assistant message is not read. Other records are read
 * whole. The Route's text is the record's title, its content and its data line.
 */
export function readable(text: string, assistantCharacters: number): { header: string; body: string } | undefined {
  const lines = text.split('\n')
  if (lines.length > 1 && /^\s*\{.*\}\s*$/.test(lines.at(-1)!)) lines.pop()
  const title = lines.shift() ?? '', content = lines.join('\n')
  const session = /^Conversation #(\d+) on (\d{4}\/\d{2}\/\d{2})[^\n]*\n?/.exec(content)
  const body = session ? content.slice(session[0].length) : content
  if (!session) return body.trim() ? { header: title.slice(0, 40), body: body.slice(0, 2000) } : undefined
  // A chunk of a conversation: one holding user text is read whole, the start of an assistant message is read, and a
  // chunk that only continues an assistant message is not.
  const header = `${session[2]} (session ${session[1]})`
  if (body.startsWith('user: ') || body.includes('\nuser: ')) return { header, body }
  if (body.startsWith('assistant: ')) return { header, body: body.length > assistantCharacters ? body.slice(0, assistantCharacters) + ' …' : body }
  return undefined
}

/** The next batch: records until their text reaches the batch size; a short rest only when `flush`. */
export function nextBatch(pending: Pending[], characters: number, flush: boolean): Pending[] | undefined {
  let size = 0
  for (let i = 0; i < pending.length; i++) {
    size += pending[i]!.text.length
    if (size >= characters) return pending.slice(0, i + 1)
  }
  return flush && pending.length ? pending.slice() : undefined
}

export const CONSOLIDATION_SYSTEM = `You keep a structured memory of a long conversation between a user and an assistant. The conversation arrives in batches of records, in order; each record shows its id, the session date and the text (assistant messages are cut short). For each batch, write down, with the ids of the records each item comes from:

1. events: what happened, was decided, planned, changed, finished, reported or asked about in the user's projects and life. One event per distinct development, one sentence of at most 30 words, keeping exact names, numbers, amounts, versions and dates. Include what the assistant proposed only when the user relied on it or may ask about it later. Put each event in a thread: one specific sub-topic that later messages may return to (a feature, component, problem, decision, document, exam, event, relationship or goal). A conversation about one project is split into its parts; a thread that would hold the whole conversation is too broad. Reuse an existing thread id when the event continues that sub-topic; otherwise start a new thread ("new: <short title>").
2. facts: the value of something about the user's situation that can change later: a number, count, amount, date, time, deadline, place, choice, status, version, tool or name. Use a short key "thing · attribute". When an existing key changes, repeat that exact key with the new value. Set "conflict" to true when a value contradicts an earlier one and the user does not say it changed.
3. directives: instructions the user gives the assistant for how to answer from now on (format, style, what to always or never include), and lasting preferences the user states. Give their substance briefly, and do not repeat one already listed.

Use only what the records say. Dates are the session dates shown with the records. Reply with JSON only, in this form:
{"events":[{"thread":"T3","date":"YYYY/MM/DD","text":"...","records":["r12"]}],"facts":[{"key":"...","value":"...","date":"YYYY/MM/DD","records":["r15"],"conflict":false}],"directives":[{"text":"...","date":"YYYY/MM/DD","records":["r20"]}]}`

/** The user message of one batch: what is known so far, then the new records under batch-local ids. */
/**
 * With `limit`, a memory whose threads, keys or directives outnumber it shows a fold only that many of each: those whose
 * words the batch's records share most, and the most recently added, in their own order. A smaller memory shows all.
 */
export interface IndexLimit { threads: number; values: number; directives: number }
/** Which items to show: all when they fit; else half by the words they share with the batch, the rest the most recent. */
function shown<T>(items: T[], limit: number | undefined, text: (item: T) => string, recency: (item: T) => string | number, query: string): Set<T> {
  if (limit === undefined || items.length <= limit) return new Set(items)
  const index = new LexicalIndex(items.map((item, i) => ({ id: String(i), text: text(item) })))
  const keep = new Set<T>(index.search([{ text: query, weight: 1 }], Math.ceil(limit / 2)).map(hit => items[Number(hit.id)]!))
  for (const item of items.slice().sort((a, b) => recency(a) < recency(b) ? 1 : recency(a) > recency(b) ? -1 : 0)) { if (keep.size >= limit) break; keep.add(item) }
  return keep
}
export function consolidationPrompt(memory: Consolidated, batch: Pending[], limit?: IndexLimit): string {
  const count = new Map<string, { n: number; last: string }>()
  for (const e of memory.events) { const c = count.get(e.thread) ?? { n: 0, last: '' }; c.n++; c.last = e.date; count.set(e.thread, c) }
  const query = limit ? batch.map(record => record.text).join('\n') : ''
  // Threads are recent by their latest event, keys by the date of their latest value, directives by order; every list
  // keeps the memory's own order.
  const lastEvent = new Map<string, number>(); memory.events.forEach((e, i) => lastEvent.set(e.thread, i))
  const factList = Object.entries(memory.facts)
  const threadSet = shown(memory.threads, limit?.threads, t => t.title, t => lastEvent.get(t.id) ?? -1, query)
  const keySet = shown(factList, limit?.values, ([key, values]) => `${key} ${values.at(-1)!.value}`, ([, values]) => values.at(-1)!.date, query)
  const directiveSet = shown(memory.directives.map((d, i) => ({ d, i })), limit?.directives, ({ d }) => d.text, ({ i }) => i, query)
  const threads = memory.threads.filter(t => threadSet.has(t)).map(t => `${t.id} ${t.title} (${count.get(t.id)?.n ?? 0} events, last ${count.get(t.id)?.last ?? '-'})`)
  const facts = factList.filter(entry => keySet.has(entry)).map(([key, values]) => `- ${key}: ${values.at(-1)!.value}`)
  const directives = [...directiveSet].sort((a, b) => a.i - b.i).map(({ d }) => `- ${d.text}`)
  const of = (shown: number, total: number) => shown < total ? ` (the ${shown} of ${total} most related to these records or most recent; the rest keep their ids and keys)` : ''
  return `Threads so far${of(threads.length, memory.threads.length)}:\n${threads.join('\n') || '(none)'}\n\nState keys so far, with the latest value${of(facts.length, factList.length)}:\n${facts.join('\n') || '(none)'}\n\nDirectives so far${of(directives.length, memory.directives.length)}:\n${directives.join('\n') || '(none)'}`
    + `\n\nNew records:\n\n${batch.map((record, i) => `[r${i}] ${record.header}\n${record.text}`).join('\n\n')}`
}

/** The JSON object in a reply, fenced or not. */
export function parseReply(text: string): { events?: unknown[]; facts?: unknown[]; directives?: unknown[] } | undefined {
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try { const value = JSON.parse(text.slice(start, end + 1)); return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined } catch { return undefined }
}

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
/** Most words of the shorter text appear in the other: the same directive in other words. */
const restates = (a: string, b: string) => { const x = words(a), y = words(b); return [...x].filter(w => y.has(w)).length / Math.max(1, Math.min(x.size, y.size)) >= 0.8 }

/** Add one batch's items; references outside the batch are dropped. Returns the items added. */
export function applyReply(memory: Consolidated, reply: NonNullable<ReturnType<typeof parseReply>>, batch: Pending[]): number {
  const refs = (value: unknown) => (Array.isArray(value) ? value : []).map(String).map(ref => Number(/^r?(\d+)$/.exec(ref.trim())?.[1] ?? NaN))
    .filter(i => Number.isInteger(i) && i >= 0 && i < batch.length).map(i => batch[i]!.id)
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
  let added = 0
  for (const raw of reply.events ?? []) {
    const e = raw as Record<string, unknown>, said = text(e.text)
    if (!said) continue
    const label = text(e.thread)
    let thread = memory.threads.find(t => t.id === label)
    if (!thread) {
      const title = label.replace(/^new:\s*/i, '').trim() || 'Other'
      thread = memory.threads.find(t => t.title.toLowerCase() === title.toLowerCase())
      if (!thread) { thread = { id: `T${memory.threads.length + 1}`, title }; memory.threads.push(thread) }
    }
    memory.events.push({ thread: thread.id, date: text(e.date), text: said, records: refs(e.records) }); added++
  }
  for (const raw of reply.facts ?? []) {
    const f = raw as Record<string, unknown>, key = text(f.key).toLowerCase(), value = text(f.value)
    if (!key || !value) continue
    ;(memory.facts[key] ??= []).push({ value, date: text(f.date), records: refs(f.records), conflict: f.conflict === true }); added++
  }
  for (const raw of reply.directives ?? []) {
    const d = raw as Record<string, unknown>, said = text(d.text)
    if (!said || memory.directives.some(existing => restates(existing.text, said))) continue
    memory.directives.push({ text: said, date: text(d.date), records: refs(d.records) }); added++
  }
  return added
}

/** Per-workspace consolidation state, written whole and renamed into place; one writer at a time in this process. */
export class ConsolidationStore {
  private readonly queue = new Map<string, Promise<unknown>>()
  constructor(private readonly directory: string) {}
  private file(workspaceId: string) { return join(this.directory, 'consolidation-' + createHash('sha256').update(workspaceId).digest('hex').slice(0, 32) + '.json') }
  async read(workspaceId: string): Promise<ConsolidationState> {
    try { const value = JSON.parse(await readFile(this.file(workspaceId), 'utf8')) as ConsolidationState; return value.format === 'mnemon-consolidation/v1' ? value : emptyState() }
    catch { return emptyState() }
  }
  async write(workspaceId: string, state: ConsolidationState): Promise<void> {
    const file = this.file(workspaceId), previous = this.queue.get(file) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
      await rename(temporary, file)
    })
    this.queue.set(file, next)
    try { await next } finally { if (this.queue.get(file) === next) this.queue.delete(file) }
  }
}

// ---------------------------------------------------------------------------------------------------------------- read

export const LAYER = { instructions: 1_500, directory: 1_500, timelines: 3_500, thread: 1_500, values: 1_500, nearThreads: 12, nearValues: 16 }
export const threadsOf = (memory: Consolidated) => {
  const by = new Map<string, TimelineEvent[]>()
  for (const e of memory.events) (by.get(e.thread) ?? by.set(e.thread, []).get(e.thread)!).push(e)
  return by
}
/** What JEV and the embedder see of a topic: its title, span and latest events. */
export function threadText(title: string, events: TimelineEvent[]): string {
  return `${title}: ${events.length} events, ${events[0]!.date} to ${events.at(-1)!.date}. Latest: ${events.slice(-3).map(e => `${e.date} ${e.text}`).join(' / ')}`
}
export const valueText = (key: string, values: StateValue[]) => `${key}: ${values.map(v => `${v.date} ${v.value}${v.conflict ? ' (contradicts the earlier value)' : ''}`).join('; ')}`
/** The texts a View ranks by meaning: every topic that has events, and every value's history. */
export function layerTexts(memory: Consolidated) {
  const by = threadsOf(memory), threadIds = memory.threads.filter(t => by.has(t.id)).map(t => t.id), keys = Object.keys(memory.facts)
  const titles = new Map(memory.threads.map(t => [t.id, t.title]))
  return { by, threadIds, threadTexts: threadIds.map(id => threadText(titles.get(id)!, by.get(id)!)), keys, valueTexts: keys.map(key => valueText(key, memory.facts[key]!)) }
}

/** Topics and values linked to the records a question's own searches put in its View (bottom-up). */
export function lightUp(memory: Consolidated, anchors: string[]) {
  const anchor = new Set(anchors), threads = new Map<string, number>(), events = new Set<TimelineEvent>(), values = new Set<string>()
  for (const e of memory.events) {
    const n = e.records.filter(r => anchor.has(r)).length
    if (n) { threads.set(e.thread, (threads.get(e.thread) ?? 0) + n); events.add(e) }
  }
  for (const [key, list] of Object.entries(memory.facts)) if (list.some(v => v.records.some(r => anchor.has(r)))) values.add(key)
  return { threads, events, values }
}

export interface LayerBlocks { id: string; text: string }
/**
 * The consolidated part of a View, coarse to fine: standing instructions, the directory of topics, the timelines of
 * `threads` (in that order: JEV's yes first, then those lit from below), the histories of `values`. Every block keeps
 * to its budget; a timeline cut for room keeps the events linked to the question's records, then the latest.
 */
export function composeLayer(memory: Consolidated, order: { threads: string[]; values: string[] }, anchorEvents: Set<TimelineEvent>) {
  const by = threadsOf(memory), blocks: LayerBlocks[] = [], linked = new Set<string>(), shown = { instructions: 0, topics: 0, threads: 0, events: 0, cut: 0, values: 0 }
  let instructions = 'Standing instructions and preferences the user stated:'
  for (const d of memory.directives) {
    const line = `\n- (${d.date}) ${d.text}`
    if (instructions.length + line.length > LAYER.instructions) break
    instructions += line; shown.instructions++; d.records.forEach(r => linked.add(r))
  }
  if (shown.instructions) blocks.push({ id: '1-instructions', text: instructions })
  const spans = memory.threads.filter(t => by.has(t.id)).map(t => ({ t, first: by.get(t.id)![0]!.date, last: by.get(t.id)!.at(-1)!.date, n: by.get(t.id)!.length }))
  const line = (s: typeof spans[number]) => `\n- ${s.t.title} (${s.first === s.last ? s.first : `${s.first} to ${s.last}`})`
  // The chosen topics first, then the largest, within the budget; listed in the order they began.
  const head = 'Topics of the conversation (first and last date):', keep = new Set<string>()
  let size = head.length
  for (const id of [...order.threads, ...spans.slice().sort((a, b) => b.n - a.n).map(s => s.t.id)]) {
    const s = spans.find(x => x.t.id === id)
    if (!s || keep.has(id) || size + line(s).length > LAYER.directory) continue
    keep.add(id); size += line(s).length
  }
  if (keep.size) { blocks.push({ id: '2-topics', text: head + spans.filter(s => keep.has(s.t.id)).map(line).join('') }); shown.topics = keep.size }
  const eventLine = (e: TimelineEvent) => `\n- ${e.date}: ${e.text}`
  let timelines = ''
  for (const id of order.threads) {
    const room = Math.min(LAYER.thread, LAYER.timelines - timelines.length)
    if (room < 300) break
    const title = `Thread: ${memory.threads.find(t => t.id === id)?.title ?? id}`, events = by.get(id) ?? []
    let chosen = events
    if (title.length + events.reduce((n, e) => n + eventLine(e).length, 0) > room) {
      const pick = new Set<TimelineEvent>(); let used = title.length
      for (const e of [...events.filter(e => anchorEvents.has(e)), ...events.slice().reverse().filter(e => !anchorEvents.has(e))]) {
        if (used + eventLine(e).length <= room) { pick.add(e); used += eventLine(e).length }
      }
      chosen = events.filter(e => pick.has(e)); shown.cut += events.length - chosen.length
    }
    if (!chosen.length) continue
    timelines += (timelines ? '\n\n' : '') + title + chosen.map(eventLine).join('')
    shown.threads++; shown.events += chosen.length; chosen.forEach(e => e.records.forEach(r => linked.add(r)))
  }
  if (timelines) blocks.push({ id: '3-timelines', text: 'Timelines of the topics this concerns:\n' + timelines })
  let values = ''
  for (const key of order.values) {
    const list = memory.facts[key]
    if (!list) continue
    const text = `\n- ${valueText(key, list)}`
    if (values.length + text.length > LAYER.values) continue
    values += text; shown.values++; list.forEach(v => v.records.forEach(r => linked.add(r)))
  }
  if (values) blocks.push({ id: '4-values', text: 'History of values:' + values })
  return { blocks, linked, shown }
}

/** The nearest texts to a query: by meaning when an embedder is configured, otherwise by shared words. */
export function nearest(query: string, texts: string[], limit: number, vectors?: { query: Float32Array; texts: Float32Array[] }): number[] {
  if (vectors) {
    const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s }
    return texts.map((_, i) => [i, dot(vectors.query, vectors.texts[i]!)] as const).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([i]) => i)
  }
  const index = new LexicalIndex(texts.map((text, i) => ({ id: String(i), text })))
  return index.search([{ text: query, weight: 1 }], limit).map((hit: { id: string }) => Number(hit.id))
}

/** An Ollama-compatible embedder with an in-process cache; unit vectors, `search_query` / `search_document` prefixes. */
export function embedder(url: string, model: string) {
  const cache = new Map<string, Float32Array>()
  return async (texts: string[], kind: 'query' | 'document', signal?: AbortSignal): Promise<Float32Array[]> => {
    const prefix = kind === 'query' ? 'search_query: ' : 'search_document: ', keys = texts.map(text => prefix + text.slice(0, 1500))
    const missing = [...new Set(keys.filter(key => !cache.has(key)))]
    for (let i = 0; i < missing.length; i += 64) {
      const input = missing.slice(i, i + 64)
      const response = await fetch(url.replace(/\/+$/, '') + '/api/embed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input }), ...(signal ? { signal } : {}) })
      if (!response.ok) throw new Error('Embedding service answered ' + response.status)
      const body = await response.json() as { embeddings: number[][] }
      body.embeddings.forEach((vector, j) => { const a = Float32Array.from(vector); let n = 0; for (const x of a) n += x * x; n = Math.sqrt(n) || 1; cache.set(input[j]!, a.map(x => x / n)) })
    }
    while (cache.size > 50_000) cache.delete(cache.keys().next().value!)
    return keys.map(key => cache.get(key)!)
  }
}
