import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Judge, PlannedCall, PolicyState, StepObservation } from 'dsh-mnemon-agent-loop-jev'
import { hash, type Candidate } from 'dsh-mnemon-replica'
import { autoCompose, batchRequest, CHANGED_MARK, compactScanRequest, compose, excerpt, createNaturalPolicy, focused, LedgerStore, LexicalIndex, lexicalTokens, mixCues, NaturalConfig, recallText, scanRequest, type Complete, type LedgerItem, type Scored } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const item = (key: string, text: string): LedgerItem => ({ key, sourceInstanceKey: 's', sourceTypeId: 'notes', resourceId: key, revision: '1', text, seenAt: 1 })
const scored = (key: string, needed: number, superseded = 0, active = false, text = key): Scored => ({ item: item(key, text), needed, superseded, active })
const limits = { maxItems: 8, maxCharacters: 6000, enter: 0.5, stay: 0.35, withdraw: 0.6 }

it('composes with hysteresis and withdraws only confident, relevant supersessions', () => {
  const { selected, withdrawn } = compose([scored('new-low', 0.45), scored('kept', 0.4, 0, true), scored('dropped', 0.2, 0, true), scored('fresh', 0.9),
    scored('old-plan', 0.7, 0.9), scored('old-unrelated', 0.1, 0.9), scored('dup', 0.8, 0, false, 'fresh')], limits)
  expect(selected.map(value => value.key)).toEqual(['fresh', 'kept'])
  expect(withdrawn).toEqual([
    expect.objectContaining({ resourceId: 'old-plan', reason: 'superseded', text: 'old-plan' }),
    expect.objectContaining({ resourceId: 'dropped', reason: 'irrelevant' }),
  ])
  expect(compose([scored('a', 0.9, 0, false, 'x'.repeat(60)), scored('b', 0.8, 0, false, 'y'.repeat(60))], { ...limits, maxCharacters: 100 }).selected).toHaveLength(1)
})

it('fills the View past the entry line with the best-scored rest, spreading over origins first', () => {
  const at = (key: string, needed: number, group?: string, superseded = 0, active = false): Scored => ({ item: { ...item(key, key), ...(group ? { group } : {}) }, needed, superseded, active })
  const values = [at('entered', 0.7, 'a'), at('a2', 0.35, 'a'), at('a3', 0.3, 'a'), at('b1', 0.25, 'b'), at('old', 0.3, 'c', 0.9), at('faint', 0.05, 'd'), at('free', 0.2)]
  const fill = { fill: 5, fillFloor: 0.1, fillPerGroup: 2 }
  const composed = compose(values, { ...limits, ...fill })
  // Two per origin first (a3 waits while b1 and the ungrouped item get in), then score order; superseded and faint never.
  expect(composed.selected.map(value => value.key)).toEqual(['entered', 'a2', 'b1', 'free', 'a3'])
  expect(composed.filled.map(value => value.key)).toEqual(['a2', 'b1', 'free', 'a3'])
  expect(compose(values, limits).selected.map(value => value.key)).toEqual(['entered'])
  // Something already shown stays when the fill takes it, and is withdrawn when it does not.
  const shown = [at('x', 0.9), at('was', 0.2, undefined, 0, true)]
  expect(compose(shown, { ...limits, ...fill, fill: 2 })).toMatchObject({ selected: [{ key: 'x' }, { key: 'was' }], withdrawn: [] })
  expect(compose(shown, { ...limits, ...fill, fill: 1 }).withdrawn).toEqual([expect.objectContaining({ resourceId: 'was', reason: 'irrelevant' })])
})

it('shows JEV\'s yes, then each maybe while its chance of being the evidence still missing pays for showing it', () => {
  const worth = { ...limits, maxItems: 16, worth: 0.01 }
  // Sure: after a 0.9, a 0.2 still has a 0.2 × 0.1 = 2% chance of being the missing evidence; a 0.1 after it has 0.8%.
  const sure = [scored('yes', 0.9), scored('maybe', 0.2), scored('late', 0.1), scored('later', 0.05), scored('stale', 0.95, 0.9)]
  expect(compose(sure, worth)).toMatchObject({ selected: [{ key: 'yes' }, { key: 'maybe' }], filled: [{ key: 'maybe' }] })
  // Unsure: nothing reaches JEV's yes, the chance that the evidence is missing stays high, and the View takes more of the ranking.
  const unsure = [0.3, 0.2, 0.15, 0.1, 0.1, 0.08, 0.06, 0.05, 0.02].map((needed, i) => scored('u' + i, needed))
  expect(compose(unsure, worth).selected.map(value => value.key)).toEqual(['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'])
  expect(compose(unsure, { ...worth, maxItems: 3 }).selected).toHaveLength(3)
  // A need for every instance counts each item on its own; a plan that names no need shows only what JEV calls needed.
  expect(compose(sure, { ...worth, every: true }).selected.map(value => value.key)).toEqual(['yes', 'maybe', 'late', 'later'])
  expect(compose(sure, { ...worth, worth: 1 }).selected.map(value => value.key)).toEqual(['yes'])
})

it('shows JEV a long item\'s heading and the lines that share words with the searches, each with the line after it', () => {
  const lines = ['2023-05-15 · conversation 1', 'Conversation #15 on 15 May, 2023:', 'user: I love hiking in the Sierra.', 'assistant: Great! Any plans?',
    'user: I just started my solo camping trip to Yosemite today.', 'assistant: Enjoy the valley views!', 'user: Thanks, also any snack ideas?']
  const focus = focused([item('chunk', lines.join('\n')), item('short', 'title\nheading\nuser: Yosemite is great.')], ['How many days did I spend camping in Yosemite?'], 120)
  expect(focus.get('chunk')).toBe([lines[0], lines[1], '…', lines[4], lines[5]].join('\n'))
  expect(focus.has('short')).toBe(false) // short enough to be judged whole
  expect(focused([item('chunk', lines.join('\n'))], ['quantum chromodynamics'], 120).size).toBe(0) // nothing matches: judged whole
  // The best line longer than the budget: judged whole. A metadata line never comes along with the line before it.
  const long = ['title', 'heading', 'user: ' + 'Yosemite camping '.repeat(10) + 'trip.', '{"branch":"bench"}']
  expect(focused([item('long', long.join('\n'))], ['camping in Yosemite'], 120).size).toBe(0)
  expect(focused([item('meta', [...lines, '{"branch":"bench"}'].join('\n'))], ['snack ideas'], 120).get('meta')).toBe([lines[0], lines[1], '…', lines[6]].join('\n'))
})

it('references candidates by id label, never by array position', () => {
  const request = batchRequest([{ role: 'user', text: '饮料准备好了吗？' }], [{ id: 'x', source: 'notes', text: '只准备无酒精饮料' }], 'inline')
  expect((request.state as { candidates: Array<{ id: string }> }).candidates[0]!.id).toBe('c0')
  expect(request.questions.n0!.instructions).toContain('whose `id` is "c0"')
  expect(JSON.stringify(request.questions)).not.toMatch(/candidates\[\d+\]/)
  const scan = scanRequest([{ role: 'user', text: 'x' }], Array.from({ length: 3 }, (_, i) => ({ id: String(i), source: 's', text: 'y'.repeat(400) })))
  expect(Object.keys(scan.questions)).toEqual(['n0', 'n1', 'n2'])
  expect((scan.state as { candidates: Array<{ text: string }> }).candidates[0]!.text.length).toBeLessThanOrEqual(160)
})

it('ranks literal Chinese matches with bigrams', () => {
  expect(lexicalTokens('北岸书屋 G8642')).toEqual(expect.arrayContaining(['北岸', '书屋', 'g8642']))
  const index = new LexicalIndex([{ id: 'a', text: '北岸书屋这周六17:00关门' }, { id: 'b', text: '阳台种花的浇水日志' }])
  expect(index.search([{ text: '书屋几点关门', weight: 1 }], 2)[0]!.id).toBe('a')
})

/** A tiny Source world behind public Routes: an enumerable note set and card stubs with bodies. */
function world({ noise = 30, maxCalls = 8, dated = false, sameDay = false, schema = false, hybrid = false, noiseText = '阳台种花的浇水日志', expansion = undefined as string[] | undefined,
  laterText = '', split = Infinity } = {}) {
  // Noise notes from `split` on read `laterText` instead: a search then ranks what gives a need first, then what does not.
  const notes = new Map([
    ['mother', '妈妈膝盖不太好，要避开台阶。'], ['wine', '旧计划：给小聚买两瓶红酒。'], ['drinks', '新安排：小聚只准备无酒精饮料。'],
    ...Array.from({ length: noise }, (_, i) => ['noise-' + i, `${i < split ? noiseText : laterText} ${i}`] as [string, string]),
  ])
  const cards = new Map([['map', '青禾庄地图\n蓝线连接西门与温室。'], ['poster', '旧海报\n底色是淡紫色。']])
  const routes = [
    { id: 'notes-search', sourceInstanceKey: 'src:notes', sourceTypeId: 'notes', operationId: 'search', description: 'Notes', maxCalls,
      // Like the record Sources' schema: word matching and several ids per read are offered; with an embedder, meaning too.
      ...(schema ? { inputSchema: { type: 'object', properties: { query: { type: 'string' }, match: { type: 'string', enum: hybrid ? ['phrase', 'words', 'hybrid'] : ['phrase', 'words'] }, id: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer' }, ...(expansion ? { expand: { type: 'boolean' } } : {}) } } } : {}) },
    { id: 'cards-list', sourceInstanceKey: 'src:cards', sourceTypeId: 'cards', operationId: 'list', description: 'Cards', maxCalls: 6 },
    { id: 'cards-read', sourceInstanceKey: 'src:cards', sourceTypeId: 'cards', operationId: 'read', description: 'Card body', maxCalls: 6 },
  ]
  const handle = (call: PlannedCall): unknown => {
    if (call.name === 'mnemon_view_inspect') return { routes, projection: [] }
    if (call.name === 'mnemon_replica_publish') return { serial: 1 }
    const { routeId, input } = call.arguments as { routeId: string; input: Record<string, unknown> }
    if (routeId === 'notes-search') {
      // Dated notes are listed newest first by creation and honour an inclusive `until` — a day, or a creation time —
      // like the record Sources.
      const order = [...notes.keys()], created = (id: string) => new Date(Date.UTC(2023, 0, 1) + order.indexOf(id) * 60_000).toISOString()
      const date = (id: string) => !sameDay && id.startsWith('noise-') ? new Date(Date.UTC(2023, 0, 1 + Number(id.slice(6)))).toISOString().slice(0, 10) : '2023-06-01'
      // Word matching finds a note holding any space-separated part of the query; otherwise the query must appear whole.
      const parts = input.match === 'words' || input.match === 'hybrid' ? String(input.query ?? '').split(/\s+/).filter(Boolean) : []
      let all = [...notes].filter(([id, text]) => (!input.id || input.id === id) && (!input.ids || (input.ids as string[]).includes(id))
        && (parts.length ? parts.some(part => text.includes(part)) : text.includes(String(input.query ?? ''))))
      if (dated) all = all.filter(([id]) => !input.until || (String(input.until).includes('T') ? created(id) : date(id)) <= String(input.until)).sort((a, b) => created(b[0]).localeCompare(created(a[0])))
      const start = Number(input.cursor ?? 0), page = all.slice(start, start + 20)
      return { items: page.map(([id, text]) => ({ id, text, revision: hash(text), ...(dated ? { provenance: { date: date(id), createdAt: created(id) } } : {}) })), ...(start + 20 < all.length ? { continuation: { routeId: 'notes-search', input: { ...input, cursor: String(start + 20) } } } : {}),
        ...(input.expand && expansion && !input.cursor ? { metadata: { expansion } } : {}) }
    }
    if (routeId === 'cards-list') return { items: [...cards].filter(([, text]) => text.includes(String(input.query ?? ''))).map(([id, text]) => ({ id, text: text.split('\n')[0] + ' [card]' })) }
    if (routeId === 'cards-read') return { items: cards.has(String(input.id)) ? [{ id: input.id, text: cards.get(String(input.id)) }] : [] }
    throw new Error('unknown route ' + routeId)
  }
  return { notes, cards, handle }
}
let gateAnswer = 0.1
const seen: Array<Parameters<Judge>[0]> = [] // every request the policy put to JEV
const judge: Judge = async request => {
  const state = request.state as { rubric?: unknown; terms?: Array<{ term: string }>; candidates?: Array<{ text: string }>; shown?: unknown[]; needs?: Array<{ need: string }> }
  if (state.shown) return { model: 'fixture', answers: { more: { type: 'noul' as const, noul: gateAnswer } }, usage: { input_tokens: 5, output_tokens: 0 } } as Awaited<ReturnType<Judge>>
  // The JEV loop's table: an item gives a need when it holds the need's first two characters.
  if (state.needs) return { model: 'fixture', answers: Object.fromEntries(Object.keys(request.questions).map(key => {
    const [, i, k] = /^c(\d+)q(\d+)$/.exec(key)!
    return [key, { type: 'noul' as const, noul: state.candidates![Number(i)]!.text.includes(state.needs![Number(k)]!.need.slice(0, 2)) ? 0.9 : 0.05 }]
  })), usage: { input_tokens: 10, output_tokens: 0 } } as Awaited<ReturnType<Judge>>
  const needed = (text: string) => /膝盖|饮料|红酒|青禾庄/.test(text) ? 0.9 : 0.05
  const answers = Object.fromEntries(Object.keys(request.questions).map(key => {
    const i = Number(key.slice(1)), text = state.terms ? state.terms[i]!.term : state.candidates![i]!.text
    const value = state.terms ? (text === '青禾庄' ? 0.8 : 0.1) : key.startsWith('s') ? (text.includes('红酒') ? 0.9 : 0.1) : needed(text)
    return [key, { type: 'noul' as const, noul: value }]
  }))
  return { model: 'fixture', answers, usage: { input_tokens: 10, output_tokens: 0 } } as Awaited<ReturnType<Judge>>
}
async function run(root: string, trigger: 'input' | 'background', handle: (call: PlannedCall) => unknown, previous?: Candidate, complete?: Complete, extra: { gate?: number; until?: boolean; recall?: 'cue'; message?: string; fill?: number; fillFloor?: number; intent?: boolean; collectFill?: number; materialize?: boolean; searches?: number; briefPlan?: boolean; hybrid?: boolean; loop?: number; worth?: number; unsureFill?: number; feedback?: boolean; simple?: boolean; auto?: boolean } = {}) {
  const { until, recall, message = '周末陪妈妈去青禾庄，饮料准备好了吗？', ...options } = extra
  const config = NaturalConfig({ directory: root, sweepMs: 0, ...options, ...(complete || recall ? { recall: recall ?? 'llm', recallModel: { provider: 'fixture', model: 'fixture' } } : {}), adapters: [
    { sourceTypeId: 'notes', operationId: 'search', queryField: 'query', limitField: 'limit', exhaustive: true, reread: { operationId: 'search', bindings: { id: 'id' }, input: { limit: 1 } }, ...(until ? { until: 'until' } : {}) },
    { sourceTypeId: 'cards', operationId: 'list', queryField: 'query', limitField: 'limit', stubs: true, expand: { operationId: 'read', bindings: { id: 'id' } }, reread: { operationId: 'read', bindings: { id: 'id' } } },
  ] })
  const job = { channel: hash('channel'), trigger, lease: { id: 'lease', revision: 1, until: Date.now() + 60_000 },
    progress: { revision: 1, digest: 'd', workspaceId: '/workspace', sessionId: 's', at: 0, messages: [{ id: 'u', role: 'user', text: message }] } }
  const bridge = { job: () => job, store: { read: async () => previous ? { candidate: previous } : undefined } }
  const policy = createNaturalPolicy(config, bridge as never, complete).create(), observations: StepObservation[] = [], calls: PlannedCall[] = []
  let decisions = 0
  const counted: Judge = async request => { decisions++; seen.push(request); return judge(request) }
  for (let step = 1; step < 300; step++) {
    const plan = await policy.next({ agent: {}, turn: 1, step, observations: [...observations], messages: [], system: '', context: '' } as unknown as PolicyState, counted, new AbortController().signal)
    if (plan.kind === 'done') return { calls, decisions, reason: plan.reason, channel: job.channel }
    calls.push(plan.call)
    observations.push({ call: plan.call, result: { value: handle(plan.call), isError: false, content: [] } } as unknown as StepObservation)
  }
  throw new Error('policy did not finish')
}

it('sweeps, recalls with JEV, searches a chosen term, withdraws the superseded plan, and remembers per workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const w = world(), result = await run(root, 'input', w.handle)
  const reads = result.calls.filter(call => call.name === 'mnemon_view_route').map(call => call.arguments as { routeId: string; input: Record<string, unknown> })
  expect(reads.filter(read => read.routeId === 'notes-search' && !read.input.id)).toHaveLength(2) // one sweep: head + continuation
  expect(reads).toContainEqual({ routeId: 'cards-list', input: expect.objectContaining({ query: '青禾庄' }) }) // JEV-chosen literal term
  expect(reads).toContainEqual({ routeId: 'cards-read', input: { id: 'map' } }) // the card stub is opened before judging
  const publish = result.calls.at(-1)!.arguments as { items: Array<{ resourceId: string; text: string }>; withdrawn: Array<{ resourceId: string; reason: string }> }
  expect(publish.items.map(value => value.resourceId).sort()).toEqual(['drinks', 'map', 'mother'])
  expect(publish.items.find(value => value.resourceId === 'map')!.text).toContain('蓝线')
  expect(publish.withdrawn).toEqual([expect.objectContaining({ resourceId: 'wine', reason: 'superseded' })])
  const ledger = await new LedgerStore(root).read('/workspace')
  expect(Object.values(ledger.items).filter(value => value.sourceTypeId === 'notes')).toHaveLength(33)
  expect(ledger.sweeps['src:notes']).toBeGreaterThan(0)
  const trace = (await readFile(join(root, 'traces', result.channel + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(trace.at(-1)).toMatchObject({ trigger: 'input', selected: expect.any(Array), terms: [expect.objectContaining({ term: '青禾庄' })] })
})

it('maintains in the background without JEV: opens stubs and retires records a complete sweep no longer returns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const w = world()
  await run(root, 'background', w.handle)
  let ledger = await new LedgerStore(root).read('/workspace')
  expect(Object.values(ledger.items).find(value => value.resourceId === 'poster')).toMatchObject({ text: expect.stringContaining('淡紫色') })
  expect(Object.values(ledger.items).some(value => value.stub)).toBe(false)
  w.notes.delete('noise-3')
  const second = await run(root, 'background', w.handle)
  expect(second.decisions).toBe(0)
  expect(second.calls.some(call => call.name === 'mnemon_replica_publish')).toBe(false)
  ledger = await new LedgerStore(root).read('/workspace')
  expect(Object.values(ledger.items).some(value => value.resourceId === 'noise-3')).toBe(false)
})

it('stops sweeping a Source one View cannot enumerate: later jobs read its head and search it by term', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const w = world({ noise: 100, maxCalls: 3 }), store = new LedgerStore(root) // 103 notes, 20 per page, 3 pages per View
  w.notes.set('late-plan', '青禾庄的新安排写在最后一页。') // beyond what one View can page to
  const notes = async () => Object.values((await store.read('/workspace')).items).filter(value => value.sourceTypeId === 'notes')
  await run(root, 'background', w.handle)
  const ledger = await store.read('/workspace')
  expect(await notes()).toHaveLength(60)
  expect(ledger.sweeps['src:notes']).toBeUndefined()
  expect(ledger.partial?.['src:notes']).toBeGreaterThan(0)
  const input = await run(root, 'input', w.handle)
  const reads = input.calls.filter(call => call.name === 'mnemon_view_route').map(call => call.arguments as { routeId: string; input: Record<string, unknown> })
  expect(reads.filter(read => read.routeId === 'notes-search' && read.input.query === '' && !read.input.cursor)).toHaveLength(1) // head only, no sweep pages
  expect(reads).toContainEqual({ routeId: 'notes-search', input: expect.objectContaining({ query: '青禾庄' }) }) // searched by a JEV-chosen term
  expect((await notes()).map(value => value.resourceId)).toContain('late-plan')
  expect(await notes()).toHaveLength(61) // nothing retired without a complete enumeration
})

it('reads a partial Source backwards in time across jobs when its adapter names a time bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const w = world({ noise: 100, maxCalls: 3, dated: true }), store = new LedgerStore(root) // 103 dated notes, 60 per View
  const notes = async () => Object.values((await store.read('/workspace')).items).filter(value => value.sourceTypeId === 'notes')
  await run(root, 'background', w.handle, undefined, undefined, { until: true })
  expect(await notes()).toHaveLength(60)
  expect((await store.read('/workspace')).cursors?.['src:notes']).toBe('2023-01-01T00:43:00.000Z') // the oldest creation time the sweep reached
  const second = await run(root, 'background', w.handle, undefined, undefined, { until: true })
  expect(second.calls).toContainEqual({ name: 'mnemon_view_route', arguments: { routeId: 'notes-search', input: expect.objectContaining({ until: '2023-01-01T00:43:00.000Z' }) } })
  expect(await notes()).toHaveLength(103)
  expect((await store.read('/workspace')).cursors?.['src:notes']).toBe('done')
})

it('pages past a day that holds more records than one View may read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const w = world({ noise: 100, maxCalls: 3, dated: true, sameDay: true }), store = new LedgerStore(root) // 103 notes of one day, 60 per View
  const notes = async () => Object.values((await store.read('/workspace')).items).filter(value => value.sourceTypeId === 'notes')
  await run(root, 'background', w.handle, undefined, undefined, { until: true })
  expect(await notes()).toHaveLength(60)
  await run(root, 'background', w.handle, undefined, undefined, { until: true })
  expect(await notes()).toHaveLength(103) // a date cursor would stay on 2023-06-01 and re-read the same 60
  expect((await store.read('/workspace')).cursors?.['src:notes']).toBe('done')
})

it('re-reads what the main model currently sees, so an edited item is shown in its current form', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const w = world()
  await run(root, 'input', w.handle)
  w.cards.set('map', '青禾庄地图\n蓝线已改为连接东门。')
  const previous = { basedOn: 1, inputDigest: 'd', serial: 1, at: 0, digest: '', items: [{ sourceInstanceKey: 'src:cards', sourceTypeId: 'cards', resourceId: 'map', revision: '1', text: 'old', digest: '' }] }
  const result = await run(root, 'input', w.handle, previous)
  expect(result.calls).toContainEqual({ name: 'mnemon_view_route', arguments: { routeId: 'cards-read', input: { id: 'map' } } })
  const publish = result.calls.at(-1)!.arguments as { items: Array<{ resourceId: string; text: string }> }
  expect(publish.items.find(value => value.resourceId === 'map')!.text).toContain('东门')
})

it('encodes the recall scan compactly: cleaned excerpts, short dialogue, id-referenced instructions', () => {
  expect(recallText('做饭尝试\n{"branch":"natural-main"}')).toBe('做饭尝试')
  expect(recallText('面馆\n[material:24b6ba75-6c8c-4516-adee-86fa5e2e57c7]\n3月27日')).toBe('面馆 / 3月27日')
  const dialogue = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, text: 'x'.repeat(900) }))
  const items = [{ id: 'a', source: 'notes', text: '任务\n{"status":"pending","important":false}' }]
  const compact = compactScanRequest(dialogue, items), full = scanRequest(dialogue, items)
  expect((compact.state as { dialogue: unknown[] }).dialogue).toHaveLength(4)
  expect(compact.questions.n0!.instructions).toContain('whose `id` is "c0"')
  expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length / 2)
})

it('defaults to LLM recall and falls back to the JEV scan when no recall model is configured', async () => {
  expect(NaturalConfig({ directory: '/x', adapters: [] }).recall).toBe('llm')
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const result = await run(root, 'input', world().handle) // default config, no recall model
  expect(result.decisions).toBeGreaterThan(2) // scan chunk(s) + terms + judge
})

it('keeps first observation time across merges so recall order is stable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const store = new LedgerStore(root)
  await store.merge('/w', [{ ...item('a', 'one'), seenAt: 10, firstSeen: 10 }], {}, [])
  await store.merge('/w', [{ ...item('a', 'one, edited'), seenAt: 20, firstSeen: 20 }], {}, [])
  expect((await store.read('/w')).items.a).toMatchObject({ text: 'one, edited', seenAt: 20, firstSeen: 10 })
})

it('recalls through one cached-prefix LLM listing plus BM25, keeps the prefix stable, and still lets JEV judge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const w = world(), prompts: string[][] = []
  await run(root, 'background', w.handle) // bodies opened first, so only the appended note changes the ledger below
  const complete: Complete = async (_system, messages) => {
    prompts.push(messages)
    const notes = messages[0]!.split('\n').slice(1), id = (needle: string) => notes.find(line => line.includes(needle))!.split('\t')[0]
    return { text: `${id('膝盖')} ${id('无酒精')} ${id('两瓶红酒')} ${id('青禾庄地图')}`, usage: { miss: 100, hit: 900, output: 12 } }
  }
  const first = await run(root, 'input', w.handle, undefined, complete)
  const publish = first.calls.at(-1)!.arguments as { items: Array<{ resourceId: string }>; withdrawn: Array<{ resourceId: string; reason: string }> }
  expect(publish.items.map(value => value.resourceId).sort()).toEqual(['drinks', 'map', 'mother'])
  expect(publish.withdrawn).toEqual([expect.objectContaining({ resourceId: 'wine', reason: 'superseded' })])
  const trace = (await readFile(join(root, 'traces', first.channel + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(trace.at(-1)).toMatchObject({ recallUsage: { miss: 100, hit: 900, output: 12 } })
  // The scan made no JEV call; the JEV calls left are terms and the judge.
  expect(first.decisions).toBe(2)
  w.notes.set('new-note', '新记下：周末可能下雨。')
  await run(root, 'input', w.handle, undefined, complete)
  const before = prompts[0]![0]!, after = prompts[1]![0]!
  expect(after.startsWith(before.split('\n').slice(0, -1).join('\n'))).toBe(true)
})

it('searches the terms the recall call suggests instead of asking JEV to choose them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const w = world()
  await run(root, 'background', w.handle)
  const complete: Complete = async (_system, messages) => {
    const notes = messages[0]!.split('\n').slice(1), id = (needle: string) => notes.find(line => line.includes(needle))!.split('\t')[0]
    return { text: `${id('膝盖')} ${id('无酒精')} ${id('两瓶红酒')}\nSEARCH: 青禾庄`, usage: { miss: 10, hit: 90, output: 8 } }
  }
  const result = await run(root, 'input', w.handle, undefined, complete)
  expect(result.decisions).toBe(1) // the judge only
  expect(result.calls).toContainEqual({ name: 'mnemon_view_route', arguments: { routeId: 'cards-list', input: expect.objectContaining({ query: '青禾庄' }) } })
  expect((result.calls.at(-1)!.arguments as { items: Array<{ resourceId: string }> }).items.map(value => value.resourceId).sort()).toEqual(['drinks', 'map', 'mother'])
})

it('keeps the View with one JEV question when nothing changed and it suffices, and never gates after a record changed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const w = world()
  const first = await run(root, 'input', w.handle)
  const published = first.calls.at(-1)!.arguments as { items: Candidate['items']; withdrawn: NonNullable<Candidate['withdrawn']> }
  const previous: Candidate = { basedOn: 1, inputDigest: 'd', serial: 1, at: 0, digest: '', items: published.items, withdrawn: published.withdrawn }
  gateAnswer = 0.1
  const kept = await run(root, 'input', w.handle, previous, undefined, { gate: 0.3 })
  expect(kept.decisions).toBe(1)
  expect(kept.calls.at(-1)).toEqual({ name: 'mnemon_replica_publish', arguments: { items: published.items, withdrawn: published.withdrawn } })
  gateAnswer = 0.8
  expect((await run(root, 'input', w.handle, previous, undefined, { gate: 0.3 })).decisions).toBeGreaterThan(2) // needs more: full pipeline
  gateAnswer = 0.1
  const older = [...w.notes]; w.notes.clear(); w.notes.set('new-plan', '新计划：周日改去玻璃温室。') // newest first, as record Sources list them
  for (const [id, text] of older) w.notes.set(id, text)
  const changed = await run(root, 'input', w.handle, previous, undefined, { gate: 0.3 })
  expect(changed.decisions).toBeGreaterThan(2) // a new record was observed: no gate question at all
})

it('keeps every cue\'s best finds before the overall best when mixing cue results', () => {
  expect(mixCues([['a', 'b', 'c', 'd'], ['x', 'y', 'a']], 4)).toEqual(['a', 'b', 'x', 'y'])
  expect(mixCues([['a', 'b', 'c', 'd'], ['x', 'y', 'a']], 5)).toEqual(['a', 'b', 'x', 'y', 'c'])
})

it('plans cues in one sentence when asked, and keeps up to `searches` of them', async () => {
  const w = world({ schema: true, maxCalls: 16 }), prompts: string[][] = []
  const systems: string[] = []
  const complete: Complete = async (system, messages) => { systems.push(system); prompts.push(messages); return { text: '膝盖\n一号\n二号\n三号\n四号\n五号\nNOTE: 妈妈膝盖不好', usage: { miss: 1, hit: 0, output: 1 } } }
  const root = async () => { const value = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(value); return value }
  const cueReads = (result: { calls: PlannedCall[] }) => result.calls.filter(call => call.name === 'mnemon_view_route' && (call.arguments as { input: Record<string, unknown> }).input.match === 'words')
  const brief = await run(await root(), 'input', w.handle, undefined, complete, { recall: 'cue', briefPlan: true, searches: 5, message: '妈妈的膝盖怎么样了？' })
  const task = prompts[0]!.join('\n').split('\n\n').at(-1)!
  expect(task).toBe('Write up to 5 searches, one per line, each a few words, for everything the reply to the last message needs from past conversations; then a line starting with "NOTE:" holding a short invented note that would answer it.')
  expect(systems[0]).not.toMatch(/note/i) // the system prompt names no memory form
  expect(cueReads(brief)).toHaveLength(7) // the message, the invented note and five searches
  expect(cueReads(brief).map(call => (call.arguments as { input: { query: string } }).input.query)).toContain('妈妈膝盖不好')
  // The default plan is unchanged: three searches, asked for as before.
  prompts.length = 0
  const plain = await run(await root(), 'input', w.handle, undefined, complete, { recall: 'cue', message: '妈妈的膝盖怎么样了？' })
  expect(prompts[0]!.join('\n')).toContain('Write up to 3 searches that would find the stored notes')
  expect(cueReads(plain)).toHaveLength(5)
})

it('recalls through a few cue searches without enumerating the memory, and JEV judges only what they found', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const w = world({ noise: 300 }), prompts: string[][] = []
  const complete: Complete = async (_system, messages) => { prompts.push(messages); return { text: '青禾庄\n膝盖\n小聚\nNOTE: 小聚只准备无酒精饮料', usage: { miss: 50, hit: 0, output: 20 } } }
  gateAnswer = 0.1
  const result = await run(root, 'input', w.handle, undefined, complete, { recall: 'cue' })
  const reads = result.calls.filter(call => call.name === 'mnemon_view_route').map(call => call.arguments as { routeId: string; input: Record<string, unknown> })
  expect(reads.filter(read => read.input.cursor)).toEqual([]) // no sweep: nothing is paged through
  expect(reads).toContainEqual({ routeId: 'notes-search', input: expect.objectContaining({ query: '膝盖', limit: 20 }) })
  expect(reads).toContainEqual({ routeId: 'cards-read', input: { id: 'map' } }) // a found card is opened before judging
  expect(prompts).toHaveLength(1)
  expect(prompts[0]!.join('\n')).not.toContain('浇水日志') // the recall model never sees the stored notes
  expect(result.decisions).toBe(2) // screening the small pool, then judging it: no scan of the memory, no term choice
  const publish = result.calls.at(-1)!.arguments as { items: Array<{ resourceId: string }>; withdrawn: Array<{ resourceId: string; reason: string }> }
  expect(publish.items.map(value => value.resourceId).sort()).toEqual(['drinks', 'map', 'mother'])
  expect(publish.withdrawn).toEqual([expect.objectContaining({ resourceId: 'wine', reason: 'superseded' })])
  const trace = (await readFile(join(root, 'traces', result.channel + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1)
  expect(trace).toMatchObject({ recallUsage: { miss: 50, output: 20 }, cues: { rounds: 1 } })
  expect(trace.judged.length).toBeLessThan(10) // what the cues found, not the 303 stored notes
  expect(Object.keys((await new LedgerStore(root).read('/workspace')).items).length).toBeLessThan(40)
})

it('searches again, differently, only when nothing the first cues found is worth showing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const w = world({ noise: 30 }), prompts: string[][] = []
  const complete: Complete = async (_system, messages) => {
    prompts.push(messages)
    return { text: prompts.length === 1 ? '阳台\nNOTE: 阳台种花' : '青禾庄', usage: { miss: 10, hit: 0, output: 5 } }
  }
  const result = await run(root, 'input', w.handle, undefined, complete, { recall: 'cue' })
  // The second plan sees what was tried and that nothing helped.
  expect(prompts[1]!.join('\n')).toMatch(/SEARCHES ALREADY RUN:\n- 周末陪妈妈去青禾庄，饮料准备好了吗？\n- 阳台种花\n- 阳台\n\nNOTES FOUND SO FAR:\n\(none that help\)/)
  expect(result.decisions).toBe(3) // screen and judge the first pool, then judge the new finds
  expect((result.calls.at(-1)!.arguments as { items: Array<{ resourceId: string }> }).items.map(value => value.resourceId)).toEqual(['map'])
  const trace = (await readFile(join(root, 'traces', result.channel + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1)
  expect(trace.cues).toMatchObject({ rounds: 2, added: 1, second: [{ kind: 'search', text: '青禾庄' }] })
  expect(trace.recallUsage).toMatchObject({ miss: 20, output: 10 })
  // A first round that finds something worth showing is the only round.
  const again = await run(await mkdtemp(join(tmpdir(), 'natural-')).then(value => (roots.push(value), value)), 'input', w.handle, undefined, async () => ({ text: '膝盖', usage: { miss: 1, hit: 0, output: 1 } }), { recall: 'cue' })
  expect(again.decisions).toBe(2)
  // Filling the View never stands in for that decision: it is taken on what passed the entry line.
  let plans = 0
  const filled = await run(await mkdtemp(join(tmpdir(), 'natural-')).then(value => (roots.push(value), value)), 'input', w.handle, undefined,
    async () => ({ text: ++plans === 1 ? '阳台\nNOTE: 阳台种花' : '青禾庄', usage: { miss: 10, hit: 0, output: 5 } }), { recall: 'cue', fill: 8, fillFloor: 0 })
  const shown = (filled.calls.at(-1)!.arguments as { items: Array<{ resourceId: string }> }).items.map(value => value.resourceId)
  expect(shown).toContain('map'); expect(shown.length).toBeGreaterThan(1)
  const last = (await readFile(join(roots.at(-1)!, 'traces', filled.channel + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1)
  expect(last.cues.rounds).toBe(2); expect(last.filled.length).toBe(shown.length - 1)
})

it('follows each Route\'s schema: word matching for cues where offered, several ids per re-read, no timestamp in the literal cue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const w = world({ dated: true, schema: true }) // the oldest notes are past the head, so what is shown must be re-read
  const complete: Complete = async () => ({ text: '青禾庄\n膝盖\n小聚\nNOTE: 小聚只准备无酒精饮料', usage: { miss: 1, hit: 0, output: 1 } })
  const reads = (result: { calls: PlannedCall[] }) => result.calls.filter(call => call.name === 'mnemon_view_route').map(call => call.arguments as { routeId: string; input: Record<string, unknown> })
  const first = await run(root, 'input', w.handle, undefined, complete, { recall: 'cue', message: 'Current date: 2023/05/30 (Tue) 23:40\n周末陪妈妈去青禾庄，饮料准备好了吗？' })
  expect(reads(first)).toContainEqual({ routeId: 'notes-search', input: expect.objectContaining({ query: '周末陪妈妈去青禾庄，饮料准备好了吗？', match: 'words' }) })
  expect(reads(first).filter(read => read.routeId === 'cards-list' && read.input.match !== undefined)).toEqual([])
  const trace = (await readFile(join(root, 'traces', first.channel + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1)
  expect(trace.cues.phraseOnly).toEqual(['cards']) // cue sentences reach the card listing as whole phrases only
  const shown = (first.calls.at(-1)!.arguments as { items: Candidate['items'] }).items
  expect(shown.map(value => value.resourceId).sort()).toEqual(['drinks', 'map', 'mother'])
  w.notes.delete('drinks')
  const second = await run(root, 'input', w.handle, { basedOn: 1, inputDigest: 'd', serial: 1, at: 0, digest: '', items: shown }, complete, { recall: 'cue' })
  const rereads = reads(second).filter(read => read.input.ids || read.routeId === 'cards-read')
  expect(rereads.slice(0, 2)).toEqual([ // both notes in one call, the card alone
    { routeId: 'notes-search', input: { limit: 2, ids: expect.arrayContaining(['drinks', 'mother']) } },
    { routeId: 'cards-read', input: { id: 'map' } }])
  expect((second.calls.at(-1)!.arguments as { items: Candidate['items'] }).items.map(value => value.resourceId).sort()).toEqual(['map', 'mother'])
})

it('JEV loop: reads further for a need of every instance while pages still add to it, and stops when nothing new is read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const prompts: string[] = []
  const complete: Complete = async (_system, messages) => {
    const prompt = messages.join('\n'); prompts.push(prompt)
    const text = prompt.includes('"NEED:"') ? 'NEED: 饮料的安排\nNEED: 青禾庄每一次采摘' : '青禾庄\n膝盖\nNOTE: 小聚只准备无酒精饮料'
    return { text, usage: { miss: 1, hit: 0, output: 1 } }
  }
  const result = await run(root, 'input', world({ schema: true, noiseText: '青禾庄采摘记录' }).handle, undefined, complete, { recall: 'cue', loop: 2 })
  const reads = result.calls.filter(call => call.name === 'mnemon_view_route').map(call => call.arguments as { routeId: string; input: Record<string, unknown> })
  // "青禾庄" matches 30 picking records: the first page held 20 that give the every-instance need, so the next page is read.
  expect(reads).toContainEqual({ routeId: 'notes-search', input: expect.objectContaining({ query: '青禾庄', cursor: '20' }) })
  expect(seen.some(request => (request.state as { needs?: unknown }).needs)).toBe(true)
  const trace = (await readFile(join(root, 'traces', result.channel + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1)
  // Worded as "every …", the second need asks for every instance although the model wrote NEED:.
  expect(trace.cues.loop.needs).toEqual([{ text: '饮料的安排', all: false }, { text: '青禾庄每一次采摘', all: true }])
  expect(trace.cues.loop.covered).toEqual([true, true])
  expect(trace.cues.loop.rounds[0]).toMatchObject({ round: 1, pages: 1, rewritten: [], fresh: 10 })
  expect(trace.cues.loop.stop).toBe('nothing new') // the last page had no continuation
  expect(prompts.some(prompt => prompt.includes('NOT FOUND YET'))).toBe(false) // the single need was given in the first round
})

it('JEV loop: asks once for differently worded searches for a single need no item gives, and stops once every need is given', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const complete: Complete = async (_system, messages) => {
    const prompt = messages.join('\n')
    const text = prompt.includes('"NEED:"') ? 'NEED: 膝盖的情况\nNEED: 红酒的旧计划' : prompt.includes('NOT FOUND YET') ? '旧计划' : '膝盖\nNOTE: 妈妈膝盖不太好'
    return { text, usage: { miss: 1, hit: 0, output: 1 } }
  }
  const result = await run(root, 'input', world({ schema: true }).handle, undefined, complete, { recall: 'cue', loop: 2 })
  const reads = result.calls.filter(call => call.name === 'mnemon_view_route').map(call => call.arguments as { routeId: string; input: Record<string, unknown> })
  expect(reads).toContainEqual({ routeId: 'notes-search', input: expect.objectContaining({ query: '旧计划', match: 'words' }) })
  const trace = (await readFile(join(root, 'traces', result.channel + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1)
  expect(trace.cues.loop.rounds[0]).toMatchObject({ round: 1, rewritten: ['旧计划'], fresh: 1 })
  expect(trace.cues.loop).toMatchObject({ covered: [true, true], stop: 'covered' })
  // The item that gives the need is judged, so the View can show it (as superseded here: the fixture calls 红酒 outdated).
  expect(trace.judged.map((value: { text: string }) => value.text)).toContainEqual(expect.stringContaining('红酒'))
})

it('JEV loop: a need no stored item gives stops after one fruitless try, well before the round cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const complete: Complete = async (_system, messages) => {
    const prompt = messages.join('\n')
    // Nothing stored is about a yacht; the reworded search finds only unrelated watering logs.
    const text = prompt.includes('"NEED:"') ? 'NEED: 膝盖的情况\nNEED: 游艇的型号' : prompt.includes('NOT FOUND YET') ? '阳台' : '膝盖\nNOTE: 妈妈膝盖不太好'
    return { text, usage: { miss: 1, hit: 0, output: 1 } }
  }
  const result = await run(root, 'input', world({ schema: true }).handle, undefined, complete, { recall: 'cue', loop: 3 })
  const trace = (await readFile(join(root, 'traces', result.channel + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1)
  expect(trace.cues.loop.rounds).toHaveLength(1)
  expect(trace.cues.loop.rounds[0]).toMatchObject({ rewritten: ['阳台'], progress: [false, false] })
  expect(trace.cues.loop).toMatchObject({ covered: [true, false], stop: 'no progress' })
})

it('JEV loop: one single need is judged by the screen alone, without a coverage table', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const complete: Complete = async (_system, messages) => {
    const text = messages.join('\n').includes('"NEED:"') ? 'NEED: 饮料的安排' : '膝盖\nNOTE: 小聚只准备无酒精饮料'
    return { text, usage: { miss: 1, hit: 0, output: 1 } }
  }
  const before = seen.length
  const result = await run(root, 'input', world({ schema: true }).handle, undefined, complete, { recall: 'cue', loop: 2 })
  expect(seen.slice(before).some(request => (request.state as { needs?: unknown }).needs)).toBe(false)
  const trace = (await readFile(join(root, 'traces', result.channel + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1)
  expect(trace.cues.loop).toMatchObject({ covered: [true], stop: 'covered', rounds: [] })
})

it('searches without the recall model: the question, then the words its best hits share, which the Source names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const prompts: string[] = []
  const complete: Complete = async (_system, messages) => { prompts.push(messages.join('\n')); return { text: 'NEED: 膝盖的情况', usage: { miss: 1, hit: 0, output: 1 } } }
  const message = '周末陪妈妈去青禾庄，饮料准备好了吗？'
  const result = await run(root, 'input', world({ schema: true, expansion: ['膝盖', '饮料'] }).handle, undefined, complete, { recall: 'cue', loop: 2, feedback: true, message })
  const reads = result.calls.filter(call => call.name === 'mnemon_view_route').map(call => call.arguments as { routeId: string; input: Record<string, unknown> })
  // The question asks the Source for its hits' shared words; then the question with them, and them alone.
  expect(reads).toContainEqual({ routeId: 'notes-search', input: expect.objectContaining({ query: message, expand: true }) })
  expect(reads).toContainEqual({ routeId: 'notes-search', input: expect.objectContaining({ query: message + ' 膝盖 饮料' }) })
  expect(reads).toContainEqual({ routeId: 'notes-search', input: expect.objectContaining({ query: '膝盖 饮料' }) })
  expect(prompts).toEqual([]) // the recall model is never asked, not even for what the reply needs
  const trace = (await readFile(join(root, 'traces', result.channel + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1)
  expect(trace.cues.expansion).toEqual(['膝盖', '饮料'])
  expect(trace.cues.loop.needs).toEqual([{ text: message, all: false }])
  expect((result.calls.at(-1)!.arguments as { items: Candidate['items'] }).items.map(value => value.resourceId)).toEqual(expect.arrayContaining(['mother', 'drinks']))
})

it('fills the View by JEV\'s ranking when JEV calls nothing needed, and only then', async () => {
  const view = async (plan: string, unsureFill: number) => {
    const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
    const complete: Complete = async () => ({ text: plan, usage: { miss: 1, hit: 0, output: 1 } })
    const result = await run(root, 'input', world({ schema: true }).handle, undefined, complete, { recall: 'cue', unsureFill })
    return (result.calls.at(-1)!.arguments as { items: Candidate['items'] }).items.map(value => value.resourceId)
  }
  // Only watering logs match: JEV calls none of them needed (0.05 each), and its ranking fills the View.
  expect(await view('阳台', 0)).toEqual([])
  expect(await view('阳台', 6)).toHaveLength(6)
  // The knee note is needed (0.9): the View is what it would have been.
  expect(await view('膝盖\n阳台', 6)).toEqual(await view('膝盖\n阳台', 0))
})

it('JEV loop with worth: reads the next page while its bottom half, seen again, pays for the items it reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const complete: Complete = async (_system, messages) => {
    const prompt = messages.join('\n')
    return { text: prompt.includes('"NEED:"') ? 'NEED: 饮料的安排\nNEED: 青禾庄每一次采摘' : '青禾庄\n膝盖\nNOTE: 小聚只准备无酒精饮料', usage: { miss: 1, hit: 0, output: 1 } }
  }
  const result = await run(root, 'input', world({ schema: true, noiseText: '青禾庄采摘记录' }).handle, undefined, complete, { recall: 'cue', loop: 3, worth: 0.01 })
  const reads = result.calls.filter(call => call.name === 'mnemon_view_route').map(call => call.arguments as { routeId: string; input: Record<string, unknown> })
  // The first page of "青禾庄" gives the every-instance need down to its last items, so its next page should too.
  expect(reads).toContainEqual({ routeId: 'notes-search', input: expect.objectContaining({ query: '青禾庄', cursor: '20' }) })
  const trace = (await readFile(join(root, 'traces', result.channel + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1)
  expect(trace.cues.loop.rounds).toHaveLength(1)
  expect(trace.cues.loop.rounds[0]).toMatchObject({ pages: 1, rewritten: [] })
  expect(trace.cues.loop.rounds[0].gains.pages[0]).toBeGreaterThan(0.2)
  expect(trace.cues.loop.stop).toBe('not worth it') // the last page had no continuation, and no need is missing
})

it('JEV loop with worth: a new search for a need nothing gives is tried while it pays, less so after each fruitless one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const complete: Complete = async (_system, messages) => {
    const prompt = messages.join('\n')
    const text = prompt.includes('"NEED:"') ? 'NEED: 膝盖的情况\nNEED: 游艇的型号' : prompt.includes('NOT FOUND YET') ? '阳台' : '膝盖\nNOTE: 妈妈膝盖不太好'
    return { text, usage: { miss: 1, hit: 0, output: 1 } }
  }
  const result = await run(root, 'input', world({ schema: true }).handle, undefined, complete, { recall: 'cue', loop: 3, worth: 0.3 })
  const trace = (await readFile(join(root, 'traces', result.channel + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1)
  // Three first-round searches found nothing about a yacht: a fourth should, about (0.1 + 1) / (3 + 2) of the time.
  expect(trace.cues.loop.rounds).toHaveLength(1)
  expect(trace.cues.loop.rounds[0]).toMatchObject({ rewritten: ['阳台'], pending: [false, true] })
  expect(trace.cues.loop.stop).toBe('not worth it')
})

it('JEV loop with worth: a plan that names no need shows only what JEV calls needed; a named need lets its maybes in', async () => {
  const view = async (plan: string) => {
    const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
    const complete: Complete = async (_system, messages) =>
      ({ text: messages.join('\n').includes('"NEED:"') ? plan : '膝盖\n阳台\nNOTE: 妈妈膝盖不太好', usage: { miss: 1, hit: 0, output: 1 } })
    const result = await run(root, 'input', world({ schema: true }).handle, undefined, complete, { recall: 'cue', loop: 1, worth: 0.001 })
    return (result.calls.at(-1)!.arguments as { items: Candidate['items'] }).items.map(value => value.resourceId)
  }
  // The watering logs score 0.05: after the knee note (0.9) each still has a 0.05 × 0.1 chance of being what is missing.
  expect(await view('Nothing from past conversations.')).toEqual(['mother'])
  expect(await view('NEED: 膝盖的情况')).toHaveLength(8)
})

it('simple mode: the View takes JEV\'s yes, then its order up to the View budget; no named need shows the yes alone', async () => {
  const view = async (plan: string, simple = true) => {
    const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
    const complete: Complete = async (_system, messages) =>
      ({ text: messages.join('\n').includes('"NEED:"') ? plan : '膝盖\n红酒\n阳台\nNOTE: 妈妈膝盖不太好', usage: { miss: 1, hit: 0, output: 1 } })
    const result = await run(root, 'input', world({ schema: true }).handle, undefined, complete, { recall: 'cue', loop: 1, simple })
    const trace = (await readFile(join(root, 'traces', result.channel + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1)
    return { shown: (result.calls.at(-1)!.arguments as { items: Candidate['items'] }).items.map(value => value.resourceId), judged: trace.judged.length }
  }
  // JEV judges the screen's best 8 (its budget here): the knee note and the old wine plan (both screened 0.9) and six
  // watering logs (0.05). The wine plan is no longer current (0.9) and stays out; the rest fill the View whatever
  // their scores.
  const named = await view('NEED: 膝盖的情况')
  expect(named.shown).toHaveLength(7)
  expect(named.shown).toContain('mother')
  expect(named.shown).not.toContain('wine')
  expect((await view('Nothing from past conversations.')).shown).toEqual(['mother'])
  // JEV judges only what could enter the View: its screen's yes and its best 8, not the usual short list of 24.
  expect(named.judged).toBe(8)
  expect((await view('NEED: 膝盖的情况', false)).judged).toBeGreaterThan(8)
})

it('simple mode: a single need JEV answers yes for is met without reading further', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const complete: Complete = async (_system, messages) =>
    ({ text: messages.join('\n').includes('"NEED:"') ? 'NEED: 膝盖的情况' : '膝盖\n阳台', usage: { miss: 1, hit: 0, output: 1 } })
  const result = await run(root, 'input', world({ schema: true }).handle, undefined, complete, { recall: 'cue', loop: 3, simple: true })
  const reads = result.calls.filter(call => call.name === 'mnemon_view_route').map(call => call.arguments as { routeId: string; input: Record<string, unknown> })
  expect(reads.some(read => read.input.cursor !== undefined)).toBe(false) // "阳台" has a next page, but nothing asks for it
  const trace = (await readFile(join(root, 'traces', result.channel + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1)
  expect(trace.cues.loop).toMatchObject({ stop: 'covered', rounds: [], state: ['met'], every: [false] })
})

it('simple mode: two records giving a need make it every-instance, read on while pages bring new yes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const complete: Complete = async (_system, messages) =>
    ({ text: messages.join('\n').includes('"NEED:"') ? 'NEED: 青禾庄每一次采摘' : '青禾庄', usage: { miss: 1, hit: 0, output: 1 } })
  const result = await run(root, 'input', world({ schema: true, noiseText: '青禾庄采摘记录' }).handle, undefined, complete, { recall: 'cue', loop: 3, simple: true })
  const reads = result.calls.filter(call => call.name === 'mnemon_view_route').map(call => call.arguments as { routeId: string; input: Record<string, unknown> })
  expect(reads).toContainEqual({ routeId: 'notes-search', input: expect.objectContaining({ query: '青禾庄', cursor: '20' }) })
  const trace = (await readFile(join(root, 'traces', result.channel + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1)
  // Only the plan's ALL is taken at its word ("每一次" alone no longer counts); the twenty picking records the screen
  // calls needed show it asks for every instance. The next page brings ten more; the one after that does not exist.
  expect(trace.cues.loop.needs).toEqual([{ text: '青禾庄每一次采摘', all: false }])
  expect(trace.cues.loop).toMatchObject({ every: [true], state: ['done'], stop: 'covered' })
  expect(trace.cues.loop.rounds).toHaveLength(1)
  expect(trace.cues.loop.rounds[0]).toMatchObject({ steps: ['page'], pages: 1, fresh: 10, improved: [true] })
})

it('simple mode: a need nothing gives reads its lead\'s next page, then a new search, and is given up when both fail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  const complete: Complete = async (_system, messages) => {
    const prompt = messages.join('\n')
    // Nothing stored is about a yacht; the watering logs are all the searches find, reworded or not.
    return { text: prompt.includes('"NEED:"') ? 'NEED: 游艇的型号' : '阳台', usage: { miss: 1, hit: 0, output: 1 } }
  }
  const result = await run(root, 'input', world({ schema: true }).handle, undefined, complete, { recall: 'cue', loop: 3, simple: true, message: '游艇是什么型号？' })
  const reads = result.calls.filter(call => call.name === 'mnemon_view_route').map(call => call.arguments as { routeId: string; input: Record<string, unknown> })
  expect(reads).toContainEqual({ routeId: 'notes-search', input: expect.objectContaining({ query: '阳台', cursor: '20' }) })
  const trace = (await readFile(join(root, 'traces', result.channel + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1)
  expect(trace.cues.loop.rounds).toHaveLength(2)
  expect(trace.cues.loop.rounds[0]).toMatchObject({ steps: ['page'], rewritten: [], fresh: 10, improved: [false] })
  expect(trace.cues.loop.rounds[1]).toMatchObject({ steps: ['search'], rewritten: ['阳台'], fresh: 0, improved: [false] })
  expect(trace.cues.loop).toMatchObject({ state: ['given up'], stop: 'given up', covered: [false] })
})

it('asks cue searches to rank by meaning too only when configured and offered by the Route', async () => {
  const complete: Complete = async () => ({ text: '青禾庄\n膝盖\nNOTE: 小聚只准备无酒精饮料', usage: { miss: 1, hit: 0, output: 1 } })
  const matches = async (hybrid: boolean, offered: boolean) => {
    const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
    const result = await run(root, 'input', world({ schema: true, hybrid: offered }).handle, undefined, complete, { recall: 'cue', hybrid })
    return new Set(result.calls.filter(call => call.name === 'mnemon_view_route').map(call => call.arguments as { routeId: string; input: Record<string, unknown> })
      .filter(read => read.routeId === 'notes-search' && read.input.query).map(read => read.input.match))
  }
  expect(await matches(true, true)).toEqual(new Set(['hybrid']))
  expect(await matches(true, false)).toEqual(new Set(['words'])) // a Source without embeddings still matches words
  expect(await matches(false, true)).toEqual(new Set(['words']))
})

it('lets the recall call say what a request needs: suggestions change the question JEV answers, gathering fills the View', async () => {
  const tailored = batchRequest([{ role: 'user', text: 'Any show for tonight?' }], [{ id: 'x', source: 'notes', text: 'Loves stand-up with storytelling' }], 'inline', 600, 'id', 'tailored')
  expect(tailored.questions.n0!.instructions).toContain('fit the user better')
  const w = world(), prompts: string[][] = []
  const plan = (kind: string): Complete => async (_system, messages) => { prompts.push(messages); return { text: `膝盖\n日志\nNOTE: 妈妈膝盖不好\nKIND: ${kind}`, usage: { miss: 1, hit: 0, output: 1 } } }
  const root = async () => { const value = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(value); return value }
  const last = async (result: { channel: string }) => (await readFile(join(roots.at(-1)!, 'traces', result.channel + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).at(-1)
  seen.length = 0
  const suggest = await run(await root(), 'input', w.handle, undefined, plan('suggest'), { recall: 'cue', intent: true })
  expect(prompts[0]!.join('\n')).toContain('KIND:')
  expect(seen.length).toBeGreaterThan(0)
  expect(seen.every(request => JSON.stringify(request.questions).includes('fit the user better') || JSON.stringify(request.state).includes('fit the user better'))).toBe(true)
  const trace = await last(suggest)
  expect(trace.cues.intent).toBe('suggest')
  expect(trace.cues.cues.map((cue: { text: string }) => cue.text)).toEqual(expect.not.arrayContaining([expect.stringMatching(/KIND/)]))
  // Gathering fills the View up to `collectFill`, whatever `fill` is.
  const collect = await run(await root(), 'input', w.handle, undefined, plan('collect'), { recall: 'cue', intent: true, fillFloor: 0, collectFill: 5 })
  expect((collect.calls.at(-1)!.arguments as { items: unknown[] }).items).toHaveLength(5)
  expect((await last(collect)).cues.intent).toBe('collect')
  // Without `intent` the recall prompt is the same as before and JEV is asked the usual question.
  prompts.length = 0; seen.length = 0
  await run(await root(), 'input', w.handle, undefined, plan('fact'), { recall: 'cue' })
  expect(prompts[0]!.join('\n')).not.toContain('KIND:')
  expect(seen.some(request => JSON.stringify(request).includes('fit the user better'))).toBe(false)
})

it('writes read-time notes for what JEV is about to judge, once per revision, and shows them above the excerpt', async () => {
  const w = world(), rewrites: string[] = []
  const complete: Complete = async (_system, messages) => {
    const text = messages.join('\n')
    if (text.startsWith('EXCERPTS:')) {
      rewrites.push(text) // labels in markdown and other bullets are read too
      return { text: [...text.matchAll(/^\[e(\d+)\]\n(.*)$/gm)].map(([, n, first]) => `**[e${n}]**\n• 整理：${first}`).join('\n'), usage: { miss: 5, hit: 0, output: 5 } }
    }
    return { text: '膝盖\n饮料\nNOTE: 小聚只准备无酒精饮料', usage: { miss: 1, hit: 0, output: 1 } }
  }
  const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
  seen.length = 0
  const first = await run(root, 'input', w.handle, undefined, complete, { recall: 'cue', materialize: true })
  expect(rewrites.length).toBeGreaterThan(0)
  expect(seen.some(request => JSON.stringify(request.state).includes('- 整理：'))).toBe(true) // JEV judged the notes
  const shown = (first.calls.at(-1)!.arguments as { items: Array<{ text: string }> }).items
  expect(shown.length).toBeGreaterThan(0)
  expect(shown.every(value => value.text.includes('Notes:\n- 整理：') && value.text.includes('Excerpt:'))).toBe(true)
  expect(Object.values((await new LedgerStore(root).read('/workspace')).items).filter(value => value.facts).length).toBeGreaterThan(0)
  // The next job reads the kept notes instead of rewriting the same items.
  const before = rewrites.length
  await run(root, 'input', w.handle, undefined, complete, { recall: 'cue', materialize: true })
  expect(rewrites.length).toBe(before)
})

it('auto mode composes what JEV calls for and what its table says gives a need, marks what changed, and fills only when unsure', () => {
  // a and b are needed, b no longer current; e only gives the need in JEV's table; c changed and was shown; d is a maybe.
  const sure = autoCompose([scored('a', 0.9), scored('b', 0.8, 0.9), scored('c', 0.1, 0.9, true), scored('d', 0.2), scored('e', 0.1)], new Map([['e', [0.9]]]), 1, limits)
  expect(sure.selected.map(item => item.key)).toEqual(['a', 'b', 'e'])
  expect([...sure.marked]).toEqual(['b'])
  expect(sure.unsure).toBe(false)
  expect(sure.withdrawn).toEqual([expect.objectContaining({ resourceId: 'c', reason: 'superseded' })])
  // Nothing called for: JEV's order fills the View, with current items only; a plan that names no need gets no fill.
  const unsure = autoCompose([scored('x', 0.3), scored('y', 0.2, 0.9), scored('z', 0.1)], new Map([['x', [0.1]]]), 1, limits)
  expect(unsure.selected.map(item => item.key)).toEqual(['x', 'z'])
  expect(unsure.unsure).toBe(true)
  expect(autoCompose([scored('x', 0.3), scored('z', 0.1)], undefined, 1, limits, false).selected).toEqual([])
  // A need nothing gives leaves JEV unsure even though another need is met.
  const open = autoCompose([scored('a', 0.9), scored('f', 0.3)], new Map([['a', [0.9, 0.1]], ['f', [0.1, 0.2]]]), 2, limits)
  expect(open.selected.map(item => item.key)).toEqual(['a', 'f'])
})

it('auto mode: shows what JEV calls needed but no longer current, marked, and fills nothing while JEV is sure', async () => {
  const view = async (auto: boolean) => {
    const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
    const complete: Complete = async (_system, messages) =>
      ({ text: messages.join('\n').includes('"NEED:"') ? 'NEED: 膝盖的情况' : '膝盖\n红酒\n阳台\nNOTE: 妈妈膝盖不太好', usage: { miss: 1, hit: 0, output: 1 } })
    const result = await run(root, 'input', world({ schema: true }).handle, undefined, complete, { recall: 'cue', loop: 1, simple: true, auto })
    return (result.calls.at(-1)!.arguments as { items: Array<{ resourceId: string; text: string }> }).items
  }
  // The fixture calls the old wine plan needed (0.9) and no longer current (0.9). Simple mode leaves it out and fills the
  // View with watering logs; auto mode shows it, marked, beside the knee note, and nothing else.
  const simple = await view(false)
  expect(simple.map(value => value.resourceId)).not.toContain('wine')
  expect(simple).toHaveLength(7)
  const auto = await view(true)
  expect(auto.map(value => value.resourceId).sort()).toEqual(['mother', 'wine'])
  expect(auto.find(value => value.resourceId === 'wine')!.text.startsWith(CHANGED_MARK)).toBe(true)
  expect(auto.find(value => value.resourceId === 'mother')!.text.startsWith(CHANGED_MARK)).toBe(false)
})

it('auto mode: reads on along a search while the bottom half of its latest page still gives the need, and stops once it does not', async () => {
  const pages = async (split: number, auto: boolean) => {
    const root = await mkdtemp(join(tmpdir(), 'natural-')); roots.push(root)
    const complete: Complete = async (_system, messages) =>
      ({ text: messages.join('\n').includes('"NEED:"') ? 'ALL: 采摘的每一次记录' : '青禾庄', usage: { miss: 1, hit: 0, output: 1 } })
    const w = world({ schema: true, noise: 60, noiseText: '青禾庄采摘记录', laterText: '青禾庄参观记录', split })
    const result = await run(root, 'input', w.handle, undefined, complete, { recall: 'cue', loop: 8, simple: true, auto })
    return result.calls.filter(call => call.name === 'mnemon_view_route').map(call => call.arguments as { routeId: string; input: Record<string, unknown> })
      .filter(read => read.input.query === '青禾庄' && read.input.cursor !== undefined).map(read => read.input.cursor)
  }
  // Picking records fill all three pages of "青禾庄": every page's bottom half gives the need, so both further pages are read.
  expect(await pages(Infinity, true)).toEqual(['20', '40'])
  // Picking records end in the first page's top half: its bottom half gives nothing, and auto mode stops there; simple
  // mode reads on along the search that found new yes.
  expect(await pages(8, true)).toEqual([])
  expect(await pages(8, false)).toEqual(['20'])
})

it('cuts long items between code points, never inside a surrogate pair, and otherwise as before', () => {
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
  // 298 characters keep from each end of a 600-character excerpt; an emoji straddles both cuts here.
  const text = 'a'.repeat(297) + '😀' + 'b'.repeat(400) + '😀' + 'c'.repeat(297)
  const cut = excerpt(text, 600)
  expect(lone.test(cut)).toBe(false)
  expect(cut.startsWith('a'.repeat(297) + ' … ')).toBe(true)
  expect(cut.endsWith(' … ' + 'c'.repeat(297))).toBe(true)
  const plain = 'x'.repeat(1000)
  expect(excerpt(plain, 600)).toBe(plain.slice(0, 298) + ' … ' + plain.slice(-298))
})
