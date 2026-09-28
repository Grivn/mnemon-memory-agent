import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import { installMemory } from 'dsh-mnemon/extension-sdk'
import * as workspace from 'dsh-mnemon-strategy-workspace'
import { ReplicaStore, channelId, hash, type SelectedMemory } from '../src/store.ts'
import { renderSelection, replicaSource } from '../src/source.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'replica-store-')); cleanups.push(() => rm(root, { force: true, recursive: true }))
  const store = new ReplicaStore(root), input = { workspaceId: root, sessionId: 'main', messages: [{ id: 'user-1', role: 'user' as const, text: '今天想早一点回家。' }] }
  const progress = await store.progress(input), channel = channelId(root, 'main'), lease = (await store.claim(channel, 0, 60_000))!
  const item = (text: string): SelectedMemory => ({ sourceInstanceKey: 'source:journal', sourceTypeId: 'journal', resourceId: 'preference', revision: '1', text, digest: hash(['source:journal', 'preference', '1', text]) })
  return { root, store, input, progress, channel, lease, item }
}
it('rejects stale candidates and scope substitution while preserving the accepted snapshot', async () => {
  const f = await fixture(), candidate = await f.store.publish(f.channel, f.lease, f.progress.digest, [f.item('偏好安静的地方。')])
  await f.store.progress({ ...f.input, messages: [{ id: 'u2', role: 'user', text: '最近更想去热闹一点的地方。' }] })
  await expect(f.store.publish(f.channel, f.lease, f.progress.digest, [f.item('old')])).rejects.toThrow('Stale')
  expect((await f.store.read(f.channel))?.candidate).toEqual(candidate)
  expect(await f.store.read(channelId(f.root, 'other-main'))).toBeUndefined()
  await expect(f.store.read('../escape')).rejects.toThrow('channel')
})
it('deduplicates identical input and gives two workers only one active lease', async () => {
  const f = await fixture(), other = new ReplicaStore(f.root)
  expect((await other.progress(f.input)).revision).toBe(1)
  expect(await other.claim(f.channel, 0, 60_000)).toBeUndefined()
  await f.store.finish(f.channel, f.lease)
  expect(await other.claim(f.channel, 0, 60_000)).toBeUndefined()
  await f.store.progress({ ...f.input, messages: [{ id: 'u2', role: 'user', text: '周末天气看起来不错。' }] })
  const leases = await Promise.all([f.store.claim(f.channel, 0, 60_000), other.claim(f.channel, 0, 60_000)])
  expect(leases.filter(Boolean)).toHaveLength(1)
})
it('retains uncertain write intent across restart and never automatically repeats it', async () => {
  const f = await fixture()
  expect(await f.store.reserveWrite(f.channel, f.lease, 'message/source/action')).toBe(true)
  const restarted = new ReplicaStore(f.root)
  expect(await restarted.reserveWrite(f.channel, f.lease, 'message/source/action')).toBe(false)
  await restarted.settleWrite(f.channel, 'message/source/action', { completion: 'committed', id: 'actual-record' })
  expect(Object.values((await restarted.read(f.channel))!.writes)[0]).toMatchObject({ state: 'settled', outcome: { completion: 'committed' } })
})
it('rejects damaged evidence instead of silently injecting edited candidate content', async () => {
  const f = await fixture(); await f.store.publish(f.channel, f.lease, f.progress.digest, [f.item('original')])
  const state = (await f.store.read(f.channel))!; state.candidate!.items[0]!.text = 'replaced without updating version'
  await writeFile(join(f.root, f.channel + '.json'), JSON.stringify(state))
  await expect(f.store.read(f.channel)).rejects.toThrow('evidence')
})
it('creates a main-owned read grant and pins its content through later replica publication', async () => {
  const f = await fixture(); await f.store.publish(f.channel, f.lease, f.progress.digest, [f.item('original')])
  const runner = new MemoryCompositionRunner({ strategyTypeId: 'workspace' }); cleanups.push(() => runner.dispose())
  await runner.mount(workspace, { instanceId: 'workspace' })
  await runner.mount({ apply(ctx) { installMemory(ctx, { sources: [replicaSource(f.store, { waitMs: 0, maxRevisionLag: 0, maxAgeMs: 60_000 }, async () => {})] }) } }, { instanceId: 'main-only' })
  const scope = { storage: 'custom' as const, workspaceId: f.root, sessionId: 'main' }
  const turn = await runner.beginTurn({ scope })
  expect(turn.view.readGrants[0]?.schema).toBe('mnemon-replica-grant/v1')
  expect(JSON.stringify(turn.view)).not.toContain(f.lease.id)
  await f.store.publish(f.channel, f.lease, f.progress.digest, [f.item('new selection')])
  const evidence = await turn.executeRoute(turn.view.routes[0]!.id, {})
  expect(evidence.items[0]?.text).toBe('original')
  turn.release()
  const next = await runner.beginTurn({ scope })
  expect((await next.executeRoute(next.view.routes[0]!.id, {})).items[0]?.text).toBe('new selection')
  next.release()
})

it('runs unchanged progress again only when an explicit background interval expires', async () => {
  const f = await fixture(); await f.store.finish(f.channel, f.lease)
  expect(await f.store.claim(f.channel, 60000, 60000)).toBeUndefined()
  await new Promise(resolve => setTimeout(resolve, 10))
  const background = await f.store.claim(f.channel, 1, 60000)
  expect(background?.revision).toBe(1); expect(background?.id).not.toBe(f.lease.id)
})
it('applies configured lag and age bounds when a new input has no ready candidate', async () => {
  const f = await fixture(); await f.store.publish(f.channel, f.lease, f.progress.digest, [f.item('previous context')])
  await f.store.progress({ ...f.input, messages: [{ id: 'u2', role: 'user', text: '接着聊吧。' }] })
  await new Promise(resolve => setTimeout(resolve, 10))
  for (const [maxRevisionLag, maxAgeMs, expectedCount] of [[0, 60000, 0], [1, 60000, 1], [1, 1, 0]]) {
    const runner = new MemoryCompositionRunner({ strategyTypeId: 'workspace' }); cleanups.push(() => runner.dispose())
    await runner.mount(workspace, { instanceId: 'workspace' })
    await runner.mount({ apply(ctx) { installMemory(ctx, { sources: [replicaSource(f.store, { waitMs: 0, maxRevisionLag: maxRevisionLag!, maxAgeMs: maxAgeMs! }, async () => {})] }) } }, { instanceId: 'main' })
    const turn = await runner.beginTurn({ scope: { storage: 'custom', workspaceId: f.root, sessionId: 'main' } })
    expect((await turn.executeRoute(turn.view.routes[0]!.id, {})).items).toHaveLength(expectedCount!)
    turn.release()
  }
})
it('renders a stable View: no input counters, fixed order, superseded items named as withdrawn', async () => {
  const f = await fixture()
  const a = f.item('妈妈膝盖不太好。'), text = '只准备无酒精饮料。'
  const b: SelectedMemory = { sourceInstanceKey: 'source:context', sourceTypeId: 'context', resourceId: 'drinks', revision: '1', text, digest: hash(['source:context', 'drinks', '1', text]) }
  const old = { sourceInstanceKey: 'source:context', sourceTypeId: 'context', resourceId: 'wine', reason: 'superseded' as const, text: '两瓶红酒和一箱啤酒。' }
  const candidate = await f.store.publish(f.channel, f.lease, f.progress.digest, [a, b], undefined, [old, { ...old, resourceId: 'x', reason: 'irrelevant' }])
  const first = renderSelection(candidate, 3, 'stable'), reordered = renderSelection({ ...candidate, basedOn: 9, items: [b, a] }, 12, 'stable')
  expect(first).toBe(reordered)
  expect(first).not.toMatch(/revision/)
  expect(first.indexOf('[context/drinks]')).toBeLessThan(first.indexOf('[journal/preference]'))
  expect(first).toContain('No longer current'); expect(first).toContain('两瓶红酒'); expect(first).not.toContain('[context/x]')
  expect(renderSelection({ ...candidate, items: [], withdrawn: [] }, 1, 'stable')).toContain('nothing stored is needed')
  expect(renderSelection(candidate, 3, 'legacy')).toContain('input revision 1/3')
  await expect(f.store.publish(f.channel, f.lease, f.progress.digest, [a], undefined, [{ ...old, reason: 'stale' as never }])).rejects.toThrow('withdrawal')
  expect((await f.store.read(f.channel))?.candidate?.withdrawn).toHaveLength(2)
})
