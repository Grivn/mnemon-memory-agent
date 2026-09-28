import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Judge, PolicyState, StepObservation } from 'dsh-mnemon-agent-loop-jev'
import { hash, type ReplicaJob, type SelectedMemory } from 'dsh-mnemon-replica'
import { Config, createOptmemPolicy, NavigationStore, emptyNavigation, materialize, leafKey, activate } from '../src/index.ts'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function harness(adaptive = false, semanticNap = true) {
  const directory = await mkdtemp(join(tmpdir(), 'maintained-optmem-')); roots.push(directory)
  const channel = hash('session-one'), store = new NavigationStore(directory)
  const config = Config({ directory, maintained: true, semanticNap, coldStart: adaptive ? 'adaptive' : 'bounded', adapters: [{ sourceTypeId: 'notes', operationId: 'search', exhaustive: true, queryField: 'query', limitField: 'limit', reread: { operationId: 'search', bindings: { id: 'id' }, input: { limit: 1 } } }], maxReads: 8, maintenanceReads: 4 })
  const rows = new Map([['a', '手杖在门后，密码5378。'], ['b', '旧海报为绿色。']])
  let exposed = true, serial = 0, current: ReplicaJob
  const bridge = { job: () => current, store: { read: async () => ({ progress: current.progress, lease: current.lease }) } }
  const policy = createOptmemPolicy(config, bridge as never)
  async function run(trigger: 'input' | 'background', text = '手杖在哪里？', customJudge?: Judge, otherChannel = channel) {
    current = { channel: otherChannel, trigger, lease: { id: 'lease-' + (serial + 1), revision: serial + 1, until: Date.now() + 10000 }, progress: { workspaceId: '/w', sessionId: 's', revision: serial + 1, digest: 'progress', at: Date.now(), messages: [{ id: 'user-' + serial, role: 'user', text }] } }
    const observations: StepObservation[] = [], calls: any[] = [], judgments: any[] = []; let selected: SelectedMemory[] | undefined
    const judge: Judge = async request => {
      judgments.push(request)
      return customJudge ? customJudge(request) : { model: 'fixture', usage: { input_tokens: 0, output_tokens: 0 }, answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: 'noul', noul: .9 }])) }
    }
    const run = policy.create(), signal = new AbortController().signal
    for (let step = 1; step < 50; step++) {
      const plan = await run.next({ agent: {}, turn: 1, step, observations, messages: [], system: '', context: '' } as unknown as PolicyState, judge, signal)
      if (plan.kind === 'done') { serial++; return { selected, calls, judgments, index: await store.read(otherChannel) } }
      calls.push(plan.call); const args = plan.call.arguments as any
      const value = plan.call.name === 'mnemon_view_inspect' ? { routes: exposed ? [{ id: 'view-route-' + serial, sourceInstanceKey: 'n', sourceTypeId: 'notes', operationId: 'search', description: 'notes', maxCalls: 8 }] : [], projection: [] }
        : plan.call.name === 'mnemon_replica_publish' ? (selected = args.items, { serial: serial + 1 })
          : { items: [...rows].filter(([id, text]) => args.input.id ? id === args.input.id : !args.input.query || text.includes(args.input.query)).map(([id, text]) => ({ id, text, revision: 'unchanged-Source-version' })), truncated: false }
      observations.push({ call: plan.call, result: { value, isError: false, content: [] } } as StepObservation)
    }
    throw new Error('Policy did not settle')
  }
  return { directory, channel, store, rows, run, revoke() { exposed = false } }
}
it('organizes changed text off the response path, persists across restarts, and does no JEV work for an unchanged nap', async () => {
  const h = await harness(), first = await h.run('input')
  expect(first.judgments).toHaveLength(2); expect(first.index.leaves.every(leaf => !leaf.organized)).toBe(true)
  const nap = await h.run('background')
  expect(nap.selected).toBeUndefined(); expect(nap.judgments.every(j => j.state.phase === 'nap')).toBe(true)
  expect(nap.index.trace.organized).toBe(2)
  const idle = await h.run('background')
  expect(idle.judgments).toHaveLength(0); expect(idle.index.trace.rebuilt).toBe(0)
  expect((await new NavigationStore(h.directory).read(h.channel)).root).toBe(nap.index.root)
  const warm = await h.run('input')
  expect(warm.judgments).toHaveLength(2)
  expect(warm.calls.some(call => call.arguments.input?.id === 'a')).toBe(true)
})
it('rereads edited live text despite an unchanged revision; new text reaches JEV and the candidate, old text does not', async () => {
  const h = await harness(); await h.run('background')
  h.rows.set('a', '手杖改放车尾箱，密码9941。'); h.rows.set('c', '手杖备用钥匙在白盒。')
  const result = await h.run('input')
  expect(JSON.stringify(result.selected)).toContain('9941'); expect(JSON.stringify(result.selected)).toContain('备用钥匙')
  expect(JSON.stringify(result.judgments)).not.toContain('5378')
  expect(result.index.leaves.find(leaf => leaf.resource === 'a')?.organized).toBeUndefined()
  const nap = await h.run('background')
  expect(nap.index.trace.organized).toBe(2); expect(nap.index.trace.rebuilt).toBeGreaterThan(0)
})
it('deletion and route revocation invalidate navigation and never pass cached bodies to the selector', async () => {
  const h = await harness(); await h.run('background'); h.rows.delete('a')
  const deleted = await h.run('input')
  expect(JSON.stringify(deleted.judgments)).not.toContain('5378')
  expect(deleted.index.leaves.some(leaf => leaf.resource === 'a')).toBe(false)
  h.revoke(); const denied = await h.run('input')
  expect(denied.selected).toEqual([]); expect(denied.judgments.every(j => j.state.phase === 'terms')).toBe(true); expect(denied.index.leaves).toEqual([])
})
it('isolates session indexes, prunes a completed scan, and never restores a View continuation', async () => {
  const h = await harness(); await h.run('background')
  expect((await h.store.read(hash('other-session'))).leaves).toEqual([])
  h.rows.delete('a'); const nap = await h.run('background')
  expect(nap.index.leaves.map(leaf => leaf.resource)).toEqual(['b'])
  expect(JSON.stringify(nap.index.leaves)).not.toContain('view-route')
  expect(nap.index.leaves.every(leaf => !('cursor' in leaf.address.input))).toBe(true)
})
it('CAS and cancellation prevent lost updates and partial index replacement', async () => {
  const h = await harness(), empty = emptyNavigation(h.channel)
  const saved = await Promise.all([h.store.save(empty, 0, new AbortController().signal), h.store.save(empty, 0, new AbortController().signal)])
  expect(saved.sort()).toEqual([false, true])
  const abort = new AbortController(); abort.abort()
  await expect(h.store.save({ ...empty, progress: 1 }, 1, abort.signal)).rejects.toThrow()
  expect((await h.store.read(h.channel)).generation).toBe(1)
  const path = join(h.directory, h.channel + '.navigation.json'), body = JSON.parse(await readFile(path, 'utf8'))
  body.generation = -1; await writeFile(path, JSON.stringify(body))
  await expect(h.store.read(h.channel)).rejects.toThrow('Invalid navigation')
})
it('materialized summaries keep literal recall lossless within observed leaves and reuse unchanged nodes', () => {
  const index = emptyNavigation(hash('index'))
  index.leaves = Array.from({ length: 64 }, (_, i) => ({ key: leafKey('n', String(i)), source: 'n', type: 'notes', resource: String(i), digest: String(i), text: i === 5 ? '隐藏词手杖' : '海报', summary: '海报', salience: .5, at: i, address: { source: 'n', type: 'notes', operation: 'search', input: { id: String(i) } } }))
  Object.assign(index, materialize(index))
  expect(activate(index, ['手杖在哪里'])[0]?.leaf.resource).toBe('5')
  expect(materialize(index).rebuilt).toBe(0)
  index.leaves[5]!.digest = 'changed'; index.leaves[5]!.summary = '手杖'
  const updated = materialize(index)
  expect(updated.rebuilt).toBe(5); expect(updated.rebuilt).toBeLessThan(Object.keys(updated.nodes).length)
})

it('uses the adaptive cold reader only before reusable navigation exists', async () => {
  const h = await harness(true)
  const first = await h.run('input')
  expect(first.judgments.length).toBeGreaterThan(1)
  expect(first.index.leaves.length).toBeGreaterThan(0)
  expect((first.index.trace.steps as any[])[0].kind).toBe('cold-start')
  const warm = await h.run('input')
  expect(warm.judgments).toHaveLength(2)
})

it('can isolate local pre-reading from JEV nap without changing foreground semantics', async () => {
  const h = await harness(false, false)
  const nap = await h.run('background')
  expect(nap.judgments).toHaveLength(0)
  expect(nap.index.leaves.every(leaf => leaf.organized === leaf.digest)).toBe(true)
  const read = await h.run('input')
  expect(read.judgments.map(j => j.state.phase)).toEqual(['terms', 'leaves'])
})
