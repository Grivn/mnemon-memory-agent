import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Judge, PolicyState, StepObservation } from 'dsh-mnemon-agent-loop-jev'
import { hash } from 'dsh-mnemon-replica'
import { Config, Checkpoints, cover, queryTerms, createOptmemPolicy, chooseLeaves } from '../src/index.ts'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const directory = async () => { const root = await mkdtemp(join(tmpdir(), 'optmem-policy-')); roots.push(root); return root }
const judgeFor = (fn: (phase: string, value: any) => number): Judge => async request => ({ model: 'fixture', usage: { input_tokens: 0, output_tokens: 0 },
  answers: Object.fromEntries((request.state as any).candidates.map((c: any) => [c.id, { type: 'noul', noul: fn((request.state as any).phase, c.value) }])) })
it('covers every observed leaf exactly once across binary zoom levels, including non-power-of-two sizes', () => {
  for (const count of [0, 1, 3, 7, 37, 500]) for (const budget of [1, 8, 24]) {
    const leaves = Array.from({ length: count }, (_, i) => ({ key: String(i), text: 'original-' + i, source: 'a' }))
    const nodes = cover(leaves, budget)
    expect(nodes.length).toBeLessThanOrEqual(budget)
    expect(nodes.flatMap(n => n.leaves).sort((a, b) => a - b)).toEqual(leaves.map((_, i) => i))
    for (const node of nodes) if (node.children) expect(node.children.flatMap(n => n.leaves)).toEqual(node.leaves)
  }
})
it('proposes literal multilingual terms without requiring a model to generate query text', () => {
  const values = queryTerms(['找《山音》和G8642的记录，蓝色便签放哪里了？'])
  expect(values).toContain('山音'); expect(values).toContain('G8642'); expect(values).toContain('蓝色'); expect(queryTerms(['北岸书屋几点关门？'])).toContain('书屋')
  expect(queryTerms(['今天先这样吧'])).not.toContain('今天')
})
it('preserves raw evidence and enforces one global item/character budget with no per-source quota', async () => {
  const items = ['a', 'a', 'b'].map((source, i) => ({ sourceTypeId: source, sourceInstanceKey: source, resourceId: String(i), text: String(i).repeat(50), revision: '1', digest: '' }))
  const result = await chooseLeaves(items, [], judgeFor(() => 1), { flat: true, coverNodes: 1, leafBudget: 2, threshold: .45, maxItems: 2, maxCharacters: 100 })
  expect(result.selected.map(i => i.sourceTypeId)).toEqual(['a', 'a'])
  expect(result.selected[0]!.text).toBe(items[0]!.text)
})
it('zooms into the selected tree group and scores its actual leaves', async () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ sourceTypeId: 'notes', sourceInstanceKey: 'n', resourceId: String(i), text: i === 10 ? '手杖放在蓝色盒子，口令 5378' : '无关的购物收据', revision: '1', digest: '' }))
  const judge = judgeFor((_phase, value) => JSON.stringify(value).includes('5378') ? 1 : 0)
  const result = await chooseLeaves(items, [{ role: 'user', text: '手杖在哪？' }], judge, { flat: false, coverNodes: 3, leafBudget: 4, threshold: .45, maxItems: 2, maxCharacters: 200 })
  expect(result.selected.map(i => i.resourceId)).toEqual(['10'])
  expect(result.inspectedLeaves.length).toBeLessThan(items.length)
})
async function harness(overrides: Partial<Parameters<typeof Config>[0]> = {}) {
  const root = await directory(), channel = hash('channel')
  const config = Config({ directory: root, adapters: [{ sourceTypeId: 'notes', operationId: 'search', queryField: 'query', limitField: 'limit', expand: { operationId: 'open', bindings: { id: 'id' } } }], maxReads: 4, rounds: 2, readsPerRound: 1, ...overrides })
  const bridge = { job: () => ({ channel, lease: { id: 'lease', revision: 1, until: Date.now() + 10000 }, progress: { revision: 1, digest: 'input', workspaceId: '/w', sessionId: 's', at: Date.now(), messages: [{ id: 'u', role: 'user', text: '手杖在哪里？' }] } }) }
  const run = createOptmemPolicy(config, bridge as never).create(), observations: StepObservation[] = [], signal = new AbortController()
  const judge = judgeFor((phase, value) => phase === 'terms' ? 0 : phase === 'explore' ? value.kind === 'zoom' || value.kind === 'continue' ? 1 : 0 : 1)
  const next = () => run.next({ agent: {}, turn: 1, step: observations.length + 1, observations, messages: [], system: '', context: '' } as unknown as PolicyState, judge, signal.signal)
  const result = (value: unknown, isError = false) => observations.push({ call: { name: 'fixture', arguments: {} }, result: { value, isError, content: [] } } as StepObservation)
  const base = { sourceTypeId: 'notes', sourceInstanceKey: 'n', description: 'Notes', maxCalls: 3 }
  const catalog = { routes: [{ ...base, id: 'search-v1', operationId: 'search' }, { ...base, id: 'open-v1', operationId: 'open' }], projection: [] }
  return { next, result, signal, catalog, root, channel }
}
it('executes returned child ids and current-View continuations, persists only after successful publication', async () => {
  const h = await harness(); await h.next(); h.result(h.catalog)
  expect(await h.next()).toMatchObject({ call: { name: 'mnemon_view_route', arguments: { routeId: 'search-v1', input: { query: '' } } } })
  h.result({ items: [{ id: 'box', text: '手杖便签', revision: '1' }], truncated: true, continuation: { routeId: 'search', input: { query: '', cursor: 'opaque-current-view' } } })
  expect(await h.next()).toMatchObject({ call: { arguments: { routeId: 'open-v1', input: { id: 'box' } } } })
  h.result({ items: [{ id: 'box', text: '手杖在门后，密码 5378', revision: '1' }] })
  expect(await h.next()).toMatchObject({ call: { arguments: { routeId: 'search-v1', input: { cursor: 'opaque-current-view' } } } })
  h.result({ items: [] })
  expect(await h.next()).toMatchObject({ call: { name: 'mnemon_replica_publish', arguments: { items: [{ resourceId: 'box', text: expect.stringContaining('手杖在门后，密码 5378') }] } } })
  const store = new Checkpoints(h.root); expect(await store.read(h.channel)).toBeUndefined()
  h.result({ serial: 1 }); expect(await h.next()).toMatchObject({ kind: 'done' })
  expect((await store.read(h.channel))?.serial).toBe(1)
})
it('fails before publication when a Source read fails or cancellation arrives', async () => {
  const h = await harness(); await h.next(); h.result(h.catalog); await h.next()
  h.result({}, true); await expect(h.next()).rejects.toThrow('read failed')
  expect(await new Checkpoints(h.root).read(h.channel)).toBeUndefined()
  const cancelled = await harness(); cancelled.signal.abort(new Error('superseded')); await expect(cancelled.next()).rejects.toThrow('superseded')
})
it('does not overwrite a newer checkpoint with a delayed prior publication', async () => {
  const store = new Checkpoints(await directory()), channel = hash('state')
  const base = { format: 'jev-optmem/v1' as const, channel, revision: 1, queries: [], hints: [], trace: {} }
  await store.save({ ...base, serial: 2 }, new AbortController().signal)
  await store.save({ ...base, serial: 1 }, new AbortController().signal)
  expect((await store.read(channel))?.serial).toBe(2)
  await expect(store.read('../outside')).rejects.toThrow('Invalid policy channel')
})

it('opens a newly discovered child after the final search round within the same total read budget', async () => {
  const h = await harness({ rounds: 1 }); await h.next(); h.result(h.catalog); await h.next()
  h.result({ items: [], continuation: { routeId: 'search', input: { cursor: 'last-page' } } })
  expect(await h.next()).toMatchObject({ call: { arguments: { input: { cursor: 'last-page' } } } })
  h.result({ items: [{ id: 'late-child', text: '手杖记录', revision: '1' }] })
  expect(await h.next()).toMatchObject({ call: { arguments: { routeId: 'open-v1', input: { id: 'late-child' } } } })
  h.result({ items: [{ id: 'late-child', text: '手杖在门后', revision: '1' }] })
  expect(await h.next()).toMatchObject({ call: { name: 'mnemon_replica_publish', arguments: { items: [{ text: expect.stringContaining('手杖在门后') }] } } })
})
