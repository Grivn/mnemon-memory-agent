import { expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Judge, PolicyState, StepObservation } from 'dsh-mnemon-agent-loop-jev'
import { Config, createContextPolicy, selectEvidence } from '../src/index.ts'

const raw = '我现在更喜欢热闹的地方。'
const user = { id: 'u1', role: 'user' as const, text: raw }
const entry = { id: 'route1', sourceInstanceKey: 'journal1', sourceTypeId: 'journal', operationId: 'search', description: 'User journal' }
const action = { ...entry, id: 'append1', operationId: 'append' }
function harness(options: Parameters<typeof Config>[0] = { reads: [{ sourceTypeId: 'journal', operationId: 'search', input: {} }] }) {
  const bridge = { job: vi.fn(() => ({ channel: 'c', lease: { id: 'l', revision: 1, until: Date.now() + 60000 }, progress: { workspaceId: '/test', sessionId: 's', messages: [user], revision: 1, digest: 'd', at: Date.now() } })),
    store: { reserveWrite: vi.fn(async () => true), settleWrite: vi.fn(async () => {}) } }
  const run = createContextPolicy(Config(options), bridge as never).create()
  const observations: StepObservation[] = []
  const judge: Judge = vi.fn(async request => ({ model: 'test', answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul' as const, noul: 1 }])), usage: { input_tokens: 0, output_tokens: 0 } }))
  const next = () => run.next({ agent: {} as Agent, turn: 1, step: observations.length + 1, messages: [], system: '', context: '', observations } satisfies PolicyState, judge, new AbortController().signal)
  const result = (value: unknown, isError = false) => observations.push({ call: { name: 'fixture', arguments: {} }, result: { value, content: [], isError } } as StepObservation)
  return { bridge, next, result, judge }
}
it('requires explicit recipes and rejects unsupported automatic write operations', () => {
  expect(() => Config({} as never)).toThrow()
  expect(() => harness({ reads: [], capture: { sourceTypeId: 'journal', operationId: 'delete', input: {} } })).toThrow('append-only')
})
it('retains the previous candidate when a selected read fails', async () => {
  const h = harness(); expect(await h.next()).toMatchObject({ call: { name: 'mnemon_view_inspect' } })
  h.result({ routes: [entry], actions: [] }); expect(await h.next()).toMatchObject({ call: { name: 'mnemon_view_route', arguments: { routeId: entry.id } } })
  h.result(undefined, true); await expect(h.next()).rejects.toThrow('retain the prior candidate')
})
it('writes the human original with an intent before execution, then settles its receipt before publication', async () => {
  const h = harness({ reads: [], capture: { sourceTypeId: 'journal', operationId: 'append', input: { kind: 'progress', content: 'must be overridden' } } })
  await h.next(); h.result({ routes: [], actions: [action] })
  const planned = await h.next()
  expect(h.bridge.store.reserveWrite).toHaveBeenCalledWith('c', expect.anything(), 'u1/journal1/append', expect.any(AbortSignal))
  expect(planned).toMatchObject({ call: { name: 'mnemon_view_action', arguments: { offerId: action.id, input: { title: raw, content: raw, kind: 'progress' } } } })
  h.result({ completion: 'committed', id: 'actual-record' })
  expect(await h.next()).toMatchObject({ call: { name: 'mnemon_replica_publish', arguments: { items: [] } } })
  expect(h.bridge.store.settleWrite).toHaveBeenCalledWith('c', 'u1/journal1/append', expect.objectContaining({ value: { completion: 'committed', id: 'actual-record' } }))
})
it.each(['ambiguous', 'approval'] as const)('does not dispatch a write to an %s destination', async condition => {
  const h = harness({ reads: [], capture: { sourceTypeId: 'journal', operationId: 'append', input: {} } })
  await h.next(); h.result({ routes: [], actions: condition === 'ambiguous' ? [action, { ...action, id: 'append2', sourceInstanceKey: 'journal2' }] : [{ ...action, requiresApproval: true }] })
  expect(await h.next()).toMatchObject({ call: { name: 'mnemon_replica_publish' } })
  expect(h.bridge.store.reserveWrite).not.toHaveBeenCalled()
})
it('bounds selected evidence while retaining exact source identity and version', async () => {
  const h = harness({ reads: [{ sourceTypeId: 'journal', operationId: 'search', input: { recent: true } }], maxItems: 1, maxCharacters: 100 })
  await h.next(); h.result({ routes: [entry], actions: [] }); await h.next()
  h.result({ items: [{ id: 'e1', text: 'a'.repeat(90), revision: 'r1' }, { id: 'e2', text: 'b'.repeat(90), revision: 'r2' }] })
  expect(await h.next()).toMatchObject({ call: { name: 'mnemon_replica_publish', arguments: { items: [{ resourceId: 'e1', sourceInstanceKey: 'journal1', revision: 'r1', text: 'a'.repeat(90) }] } } })
})
it('admits live lookup evidence without a backend revision and fingerprints changed content', async () => {
  const h = harness()
  await h.next(); h.result({ routes: [entry], actions: [] }); await h.next()
  h.result({ items: [{ id: 'same-file', text: '17:00关门' }] })
  const plan = await h.next()
  expect(plan).toMatchObject({ call: { name: 'mnemon_replica_publish', arguments: { items: [{ resourceId: 'same-file', text: '17:00关门', revision: expect.stringMatching(/^content-sha256:/) }] } } })
  const before = selectEvidence(entry, { items: [{ id: 'same-file', text: '17:00关门' }] })[0]!
  expect(before).not.toHaveProperty('operationId')
  expect(selectEvidence(entry, { items: [{ id: 'same-file', text: '17:00关门' }] })[0]).toEqual(before)
  expect(selectEvidence(entry, { items: [{ id: 'same-file', text: '20:30关门' }] })[0]?.revision).not.toBe(before.revision)
  expect(selectEvidence(entry, { revision: 'source-r2', items: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y', revision: 'item-r3' }] }).map(item => item.revision)).toEqual(['source-r2', 'item-r3'])
})
