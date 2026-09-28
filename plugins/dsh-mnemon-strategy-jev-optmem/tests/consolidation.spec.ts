import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Judge, PlannedCall, PolicyState, StepObservation } from 'dsh-mnemon-agent-loop-jev'
import { hash } from 'dsh-mnemon-replica'
import { applyReply, composeLayer, consolidationPrompt, ConsolidationStore, createNaturalPolicy, lightUp, NaturalConfig, nextBatch, parseReply, readable, type Complete, type Consolidated } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const record = (title: string, content: string) => `${title}\n${content}\n{"branch":"bench"}`

it('reads user text whole, the start of an assistant message, not the rest of it, and other records whole', () => {
  const user = readable(record('2024/03/15 (Fri) 00:00 · conversation 1', 'Conversation #2 on 2024/03/15 (Fri) 00:00:\nuser: I moved the demo to Friday.'), 10)
  expect(user).toEqual({ header: '2024/03/15 (session 2)', body: 'user: I moved the demo to Friday.' })
  expect(readable(record('t', 'Conversation #2 on 2024/03/15 (Fri) 00:00:\nassistant: Sure, here is a long plan for Friday.'), 10))
    .toEqual({ header: '2024/03/15 (session 2)', body: 'assistant: …' })
  expect(readable(record('t', 'Conversation #2 on 2024/03/15 (Fri) 00:00:\nthe rest of an assistant message'), 10)).toBeUndefined()
  // The end of an assistant message followed by the user's next message is read whole.
  expect(readable(record('t', 'Conversation #2 on 2024/03/15 (Fri) 00:00:\nlong answer.\nuser: next question'), 10)?.body).toBe('long answer.\nuser: next question')
  expect(readable(record('Shopping', 'Buy oat milk on Friday.'), 10)).toEqual({ header: 'Shopping', body: 'Buy oat milk on Friday.' })
})

it('batches records until their text reaches the batch size, and the rest only when flushing', () => {
  const pending = ['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(30)].map((text, i) => ({ id: 'r' + i, header: 'h', text }))
  expect(nextBatch(pending, 100, false)?.map(value => value.id)).toEqual(['r0', 'r1'])
  expect(nextBatch(pending.slice(2), 100, false)).toBeUndefined()
  expect(nextBatch(pending.slice(2), 100, true)?.map(value => value.id)).toEqual(['r2'])
  expect(nextBatch([], 100, true)).toBeUndefined()
})

it('adds a batch\'s items: threads by id or title, values with their history, directives once, links inside the batch only', () => {
  const memory: Consolidated = { threads: [], events: [], facts: {}, directives: [] }
  const batch = [{ id: 'rec-a', header: 'h', text: 'x' }, { id: 'rec-b', header: 'h', text: 'y' }]
  const first = parseReply('```json\n{"events":[{"thread":"new: Demo","date":"2024/03/15","text":"Demo set for Thursday.","records":["r0"]}],'
    + '"facts":[{"key":"Demo · day","value":"Thursday","date":"2024/03/15","records":["r0","r9"],"conflict":false}],"directives":[{"text":"Always give times in 24-hour format.","date":"2024/03/15","records":["r1"]}]}\n```')!
  expect(applyReply(memory, first, batch)).toBe(3)
  const second = parseReply('{"events":[{"thread":"T1","date":"2024/03/16","text":"Demo moved to Friday.","records":["r1"]},{"thread":"new: demo","date":"2024/03/16","text":"Slides ready.","records":[]}],'
    + '"facts":[{"key":"demo · day","value":"Friday","date":"2024/03/16","records":["r1"],"conflict":true}],"directives":[{"text":"Always give times in the 24-hour format","date":"2024/03/16","records":["r1"]}]}')!
  applyReply(memory, second, batch)
  expect(memory.threads).toEqual([{ id: 'T1', title: 'Demo' }])
  expect(memory.events.map(e => [e.thread, e.text, e.records])).toEqual([['T1', 'Demo set for Thursday.', ['rec-a']], ['T1', 'Demo moved to Friday.', ['rec-b']], ['T1', 'Slides ready.', []]])
  expect(memory.facts['demo · day']).toEqual([{ value: 'Thursday', date: '2024/03/15', records: ['rec-a'], conflict: false }, { value: 'Friday', date: '2024/03/16', records: ['rec-b'], conflict: true }])
  expect(memory.directives).toHaveLength(1)
  expect(parseReply('no json here')).toBeUndefined()
})

it('shows a fold the whole index while it fits its limit, and past it the entries its records share words with and the newest', () => {
  const memory: Consolidated = { threads: [], events: [], facts: {}, directives: [] }
  for (let i = 1; i <= 12; i++) {
    memory.threads.push({ id: `T${i}`, title: i === 3 ? 'Kayak trip to the lake' : `Topic number ${i}` })
    memory.events.push({ thread: `T${i}`, date: `2024/01/${String(i).padStart(2, '0')}`, text: `event ${i}`, records: [] })
    memory.facts[`thing ${i} · status`] = [{ value: i === 5 ? 'kayak rented' : `value ${i}`, date: `2024/01/${String(i).padStart(2, '0')}`, records: [], conflict: false }]
  }
  memory.directives.push({ text: 'Answer briefly.', date: '2024/01/01', records: [] })
  const batch = [{ id: 'r', header: '2024/02/01 (session 9)', text: 'user: We booked the kayak for the lake next week.' }]
  // Within the limit the prompt is word for word the one without a limit.
  expect(consolidationPrompt(memory, batch, { threads: 12, values: 12, directives: 5 })).toBe(consolidationPrompt(memory, batch))
  const small = consolidationPrompt(memory, batch, { threads: 4, values: 4, directives: 5 })
  const threads = small.split('\n\n')[0]!.split('\n').slice(1), keys = small.split('\n\n')[1]!.split('\n').slice(1)
  expect(small).toContain('Threads so far (the 4 of 12 most related to these records or most recent')
  expect(threads).toHaveLength(4); expect(keys).toHaveLength(4)
  // The related entry and the newest are shown, in the memory's own order.
  expect(threads[0]).toMatch(/^T3 Kayak trip/); expect(threads.at(-1)).toMatch(/^T12 /)
  expect(keys.some(line => line.includes('kayak rented'))).toBe(true); expect(keys.at(-1)).toContain('thing 12')
  expect(small).toContain('Directives so far:\n- Answer briefly.')
})
it('lights up what the View\'s records are linked to, and composes coarse to fine within each budget', () => {
  const memory: Consolidated = { threads: [{ id: 'T1', title: 'Demo' }, { id: 'T2', title: 'Budget' }, { id: 'T3', title: 'Gym' }],
    events: [{ thread: 'T1', date: '2024/03/15', text: 'Demo set for Thursday.', records: ['a'] }, { thread: 'T1', date: '2024/03/16', text: 'Demo moved to Friday.', records: ['b'] },
      { thread: 'T2', date: '2024/03/17', text: 'Budget is $500.', records: ['c'] }, { thread: 'T3', date: '2024/03/18', text: 'Gym on Mondays.', records: ['d'] }],
    facts: { 'demo · day': [{ value: 'Thursday', date: '2024/03/15', records: ['a'], conflict: false }, { value: 'Friday', date: '2024/03/16', records: ['b'], conflict: true }] },
    directives: [{ text: 'Always give times in 24-hour format.', date: '2024/03/15', records: ['e'] }] }
  const lit = lightUp(memory, ['b', 'zzz'])
  expect([...lit.threads]).toEqual([['T1', 1]])
  expect([...lit.values]).toEqual(['demo · day'])
  const { blocks, linked, shown } = composeLayer(memory, { threads: ['T2', 'T1'], values: ['demo · day'] }, lit.events)
  expect(blocks.map(block => block.id)).toEqual(['1-instructions', '2-topics', '3-timelines', '4-values'])
  expect(blocks[1]!.text).toBe('Topics of the conversation (first and last date):\n- Demo (2024/03/15 to 2024/03/16)\n- Budget (2024/03/17)\n- Gym (2024/03/18)')
  expect(blocks[2]!.text.indexOf('Thread: Budget')).toBeLessThan(blocks[2]!.text.indexOf('Thread: Demo'))
  expect(blocks[3]!.text).toContain('demo · day: 2024/03/15 Thursday; 2024/03/16 Friday (contradicts the earlier value)')
  expect([...linked].sort()).toEqual(['a', 'b', 'c', 'e'])
  expect(shown).toMatchObject({ instructions: 1, topics: 3, threads: 2, events: 3, values: 1 })
  // A timeline too long for its room keeps the event linked to the View's records, then the latest.
  const long: Consolidated = { ...memory, events: Array.from({ length: 40 }, (_, i) => ({ thread: 'T1', date: `2024/04/${String(i % 28 + 1).padStart(2, '0')}`, text: `Step ${i} of the demo plan, written out at length.`, records: [i === 3 ? 'b' : 'x' + i] })) }
  const cut = composeLayer(long, { threads: ['T1'], values: [] }, lightUp(long, ['b']).events)
  const timeline = cut.blocks.find(block => block.id === '3-timelines')!.text
  expect(timeline.length).toBeLessThanOrEqual(1_600)
  expect(timeline).toContain('Step 3 of')
  expect(timeline).toContain('Step 39 of')
  expect(timeline).not.toContain('Step 10 of')
})

/** A journal behind a public Route that lists records oldest first after a creation time, like the record Sources. */
function journal(count: number) {
  const records = Array.from({ length: count }, (_, i) => ({ id: 'rec' + i, createdAt: new Date(Date.UTC(2024, 0, 1) + i * 1000).toISOString(),
    text: record(`2024/03/15 (Fri) 00:00 · conversation ${i}`, `Conversation #1 on 2024/03/15 (Fri) 00:00:\nuser: ${i === 5 ? 'The demo moved to Friday.' : 'Filler message number ' + i + '.'}`) }))
  const routes = [{ id: 'journal-search', sourceInstanceKey: 'src:journal', sourceTypeId: 'journal', operationId: 'search', description: 'Journal', maxCalls: 16,
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, since: { type: 'string' }, recent: { type: 'boolean' }, ids: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer' }, id: { type: 'string' } } } }]
  const handle = (call: PlannedCall): unknown => {
    if (call.name === 'mnemon_view_inspect') return { routes, projection: [] }
    if (call.name === 'mnemon_replica_publish') return { serial: 1 }
    const { input } = call.arguments as { routeId: string; input: Record<string, unknown> }
    let found = records.filter(value => (!input.since || value.createdAt >= String(input.since)) && (!input.ids || (input.ids as string[]).includes(value.id)) && (!input.id || input.id === value.id)
      && (!input.query || value.text.includes(String(input.query))))
    if (input.recent !== false) found = found.slice().reverse()
    const start = Number(input.cursor ?? 0), limit = Number(input.limit ?? 20), page = found.slice(start, start + limit)
    return { items: page.map(value => ({ id: value.id, text: value.text, revision: '1', provenance: { createdAt: value.createdAt } })),
      ...(start + limit < found.length ? { continuation: { routeId: 'journal-search', input: { ...input, cursor: String(start + limit) } } } : {}) }
  }
  return { records, handle }
}
const judge: Judge = async request => {
  const state = request.state as { candidates?: Array<{ text: string }>; shown?: unknown[] }
  if (state.shown) return { model: 'fixture', answers: { more: { type: 'noul' as const, noul: 0.9 } }, usage: { input_tokens: 5, output_tokens: 0 } } as Awaited<ReturnType<Judge>>
  const answers = Object.fromEntries(Object.keys(request.questions).map(key => {
    const text = state.candidates?.[Number(key.slice(1))]?.text ?? ''
    return [key, { type: 'noul' as const, noul: key.startsWith('s') ? 0.05 : /demo|Demo/.test(text) ? 0.9 : 0.1 }]
  }))
  return { model: 'fixture', answers, usage: { input_tokens: 10, output_tokens: 0 } } as Awaited<ReturnType<Judge>>
}
async function step(root: string, trigger: 'input' | 'background', handle: (call: PlannedCall) => unknown, consolidate: Complete, maxCharacters = 6000) {
  const config = NaturalConfig({ directory: root, sweepMs: 0, recall: 'jev', maxCharacters, adapters: [{ sourceTypeId: 'journal', operationId: 'search', queryField: 'query', limitField: 'limit' }],
    consolidation: { model: { provider: 'fixture', model: 'fixture' }, batchCharacters: 150 } })
  const job = { channel: hash('channel'), trigger, lease: { id: 'lease', revision: 1, until: Date.now() + 60_000 },
    progress: { revision: 1, digest: 'd', workspaceId: '/workspace', sessionId: 's', at: 0, messages: [{ id: 'u', role: 'user', text: 'When is the demo?' }] } }
  const policy = createNaturalPolicy(config, { job: () => job, store: { read: async () => undefined } } as never, undefined, consolidate).create()
  const observations: StepObservation[] = [], calls: PlannedCall[] = []
  for (let n = 1; n < 400; n++) {
    const plan = await policy.next({ agent: {}, turn: 1, step: n, observations: [...observations], messages: [], system: '', context: '' } as unknown as PolicyState, judge, new AbortController().signal)
    if (plan.kind === 'done') return { calls, channel: job.channel }
    calls.push(plan.call)
    observations.push({ call: plan.call, result: { value: handle(plan.call), isError: false, content: [] } } as unknown as StepObservation)
  }
  throw new Error('policy did not finish')
}

it('consolidates in the background from the watermark, folds the rest once idle, and puts the layer ahead of the records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'consolidation-')); roots.push(root)
  const world = journal(12), prompts: string[] = []
  // The consolidating model writes one event per record it is shown and names the demo's day.
  const consolidate: Complete = async (_system, [message]) => {
    prompts.push(message!)
    const ids = [...message!.matchAll(/\[r(\d+)\] [^\n]*\n([^\n]*)/g)]
    return { text: JSON.stringify({ events: ids.map(([, i, text]) => ({ thread: /demo/.test(text!) ? 'new: Demo' : 'new: Filler', date: '2024/03/15', text: text!.slice(6), records: ['r' + i] })),
      facts: ids.some(([, , text]) => /demo/.test(text!)) ? [{ key: 'demo · day', value: 'Friday', date: '2024/03/15', records: ['r0'], conflict: false }] : [], directives: [] }), usage: { miss: 10, hit: 0, output: 5 } }
  }
  await step(root, 'background', world.handle, consolidate)
  const store = new ConsolidationStore(root)
  let state = await store.read('/workspace')
  // Twelve records of about 30 readable characters in batches of 150: two full batches of five; two wait for more.
  expect(state.watermark?.at).toBe(world.records.at(-1)!.createdAt)
  expect(state.batches).toBe(2)
  expect(state.pending.map(value => value.id)).toEqual(['rec10', 'rec11'])
  expect(state.memory.events).toHaveLength(10)
  expect(state.memory.events.find(e => e.text.includes('demo'))?.records).toEqual(['rec5'])
  // Two more records, still short of a batch: they wait; the next job finds nothing new and folds the rest.
  world.records.push(...[12, 13].map(i => ({ id: 'rec' + i, createdAt: new Date(Date.UTC(2024, 0, 1) + i * 1000).toISOString(), text: record(`t ${i}`, `Conversation #1 on 2024/03/16 (Sat) 00:00:\nuser: Late note ${i}.`) })))
  await step(root, 'background', world.handle, consolidate)
  state = await store.read('/workspace')
  expect(state.pending.map(value => value.id)).toEqual(['rec10', 'rec11', 'rec12', 'rec13'])
  await step(root, 'background', world.handle, consolidate)
  state = await store.read('/workspace')
  expect(state.pending).toHaveLength(0)
  expect(state.memory.events).toHaveLength(14)
  expect(prompts.at(-1)).toContain('Late note 13')
  // A question: the layer comes first, then the records; the budget cuts records from the end.
  const input = await step(root, 'input', world.handle, consolidate, 700)
  const published = input.calls.at(-1)!.arguments as { items: Array<{ sourceTypeId: string; resourceId: string; text: string }> }
  expect(published.items[0]).toMatchObject({ sourceTypeId: 'consolidation', resourceId: '2-topics' })
  expect(published.items.map(item => item.resourceId)).toContain('3-timelines')
  expect(published.items.find(item => item.resourceId === '3-timelines')!.text).toContain('Thread: Demo')
  expect(published.items.find(item => item.resourceId === '4-values')!.text).toContain('demo · day: 2024/03/15 Friday')
  expect(published.items.reduce((n, item) => n + item.text.length, 0)).toBeLessThanOrEqual(700)
  const trace = (await readFile(join(root, 'traces', input.channel + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(trace.at(-1).layer).toMatchObject({ lexical: true, chosen: { topics: expect.any(Number) } })
  expect(trace.filter((value: { consolidation?: unknown }) => value.consolidation).length).toBe(3)
})
