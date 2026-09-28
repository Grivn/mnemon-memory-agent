import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { hostSessions } from '../src/agent.ts'
import JevAgentLoop, { validateDecision, type JevPolicy, type DecisionProvider } from '../src/index.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const yes: DecisionProvider = { async decide(request) { return { model: 'fixture', answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul', noul: 1 }])), usage: { input_tokens: 1, output_tokens: 0 } } } }
async function fixture(policy: JevPolicy, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jev-agent-test-')), ctx = new Context()
  cleanup.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore)
  await ctx.plugin(Persistence, { root, compression: 'none' }); await ctx.plugin(Projections)
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(AgentRegistry)
  const loop = await ctx.plugin(JevAgentLoop, { policy: policy.id, ...options })
  ctx.jevAgentLoop.registerPolicy(policy); ctx.jevAgentLoop.setDecisionProvider(yes)
  return { ctx, root, loop }
}
const readPolicy: JevPolicy = { id: 'test', create: () => ({ async next(state, judge) {
  if (state.observations.length) return { kind: 'done', reason: 'Observed tool completion' }
  await judge({ state: { incoming: state.messages.flatMap(m => m.content.flatMap(block => block.type === 'text' ? [block.text] : [])) }, questions: { use: { type: 'noul', instructions: 'Use the configured test tool?' } } })
  return { kind: 'call', call: { name: 'test_write', arguments: { text: 'stored' } } }
} }) }
it('runs a real DSH tool pipeline, emits lifecycle hooks, and resumes its durable session without replaying writes', async () => {
  const { ctx, root } = await fixture(readPolicy), writes: string[] = [], events: string[] = []
  ctx.systemPrompt.section({ name: 'experiment-persona', order: 0, text: 'Provider {{provider}}, model {{model}}.' })
  ctx.tools.register({ name: 'test_write', description: 'Write a test record', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) { writes.push((args as { text: string }).text); return { completion: 'committed' } } })
  ctx.on('agent/pre-step', async (_payload, next) => { events.push('pre-step'); return next() })
  ctx.on('agent/turn-stopping', () => { events.push('stopping') })
  const handle = await ctx.agents.create({ sessionId: SessionId('agent'), meta: { cwd: root } })
  handle.agent.followup(message('随便聊聊，今天终于把周末空出来了。')); await handle.agent.whenIdle()
  const log = handle.agent.session.snapshotEvents()
  expect(log.findLast(e => e.type === 'turn/end')?.data).toMatchObject({ reason: { kind: 'completed' } })
  expect(writes).toEqual(['stored']); expect(events).toEqual(['pre-step', 'pre-step', 'stopping'])
  expect(log.some(e => e.type === 'assistant/message' || e.type === 'request/header')).toBe(false)
  expect(log.filter(e => e.type === 'tool/call')).toHaveLength(1)
  expect(log.some(e => e.type === 'user/message' && e.data.source.kind === 'plugin')).toBe(true)
  expect(JSON.stringify(log.find(e => e.type === 'system/message')?.data.message.content)).toContain('Provider typesafe-system-one, model jev-latest.')
  await handle.dispose()
  const resumed = await ctx.agents.resume({ resumeSessionId: SessionId('agent') })
  await resumed.agent.whenIdle(); expect(writes).toHaveLength(1)
  resumed.agent.followup(message('然后呢？')); await resumed.agent.whenIdle(); expect(writes).toHaveLength(2)
  await resumed.dispose()
})
it('preserves DSH pre-execution denial and returns the actual failed observation to the policy', async () => {
  const { ctx } = await fixture(readPolicy), execute = vi.fn(async () => ({}))
  ctx.tools.register({ name: 'test_write', description: '', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute })
  ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'Test policy refused this write' }))
  const handle = await ctx.agents.create({ sessionId: SessionId('denied') })
  handle.agent.followup(message('hello')); await handle.agent.whenIdle()
  expect(execute).not.toHaveBeenCalled()
  const result = handle.agent.session.snapshotEvents().find(e => e.type === 'tool/result')
  expect(JSON.stringify(result)).toContain('Test policy refused this write')
  await handle.dispose()
})
it('counts attempts before dispatch and enforces the decision budget', async () => {
  const { ctx } = await fixture({ id: 'budget', create: () => ({ async next(_state, judge) {
    const request = { state: 'input', questions: { x: { type: 'noul' as const } } }
    await judge(request); await judge(request)
    return { kind: 'done', reason: 'unreachable' }
  } }) }, { maxDecisionCalls: 1 })
  const decide = vi.fn(yes.decide); ctx.jevAgentLoop.setDecisionProvider({ decide })
  const handle = await ctx.agents.create({ sessionId: SessionId('budget') })
  handle.agent.followup(message('hi')); await handle.agent.whenIdle()
  expect(decide).toHaveBeenCalledOnce()
  expect(JSON.stringify(handle.agent.session.snapshotEvents().at(-1))).toContain('decision call budget exhausted')
  await handle.dispose()
})
it('aborts an in-flight JEV call on owner disposal and unregisters the Agent after quiescence', async () => {
  const { ctx } = await fixture(readPolicy), started = Promise.withResolvers<void>(), aborted = vi.fn()
  ctx.jevAgentLoop.setDecisionProvider({ decide: (_request, signal) => new Promise((_resolve, reject) => {
    started.resolve(); signal.addEventListener('abort', () => { aborted(); reject(new Error('aborted')) }, { once: true })
  }) })
  const handle = await ctx.agents.create({ sessionId: SessionId('cancel') })
  handle.agent.followup(message('hi')); await started.promise; await handle.dispose()
  expect(aborted).toHaveBeenCalledOnce(); expect(ctx.agents.get(SessionId('cancel'))).toBeUndefined()
  expect(hostSessions(ctx).get(SessionId('cancel'))).toBeUndefined()
})
it('rolls back unpublished setup, then allows the same identity to be created', async () => {
  const { ctx } = await fixture(readPolicy), announced = vi.fn(); ctx.on('agent/created', announced)
  await expect(ctx.agents.create({ sessionId: SessionId('setup'), setup() { throw new Error('bad setup') } })).rejects.toThrow('bad setup')
  expect(announced).not.toHaveBeenCalled(); expect(hostSessions(ctx).list()).toEqual([])
  const handle = await ctx.agents.create({ sessionId: SessionId('setup') }); await handle.dispose()
})
it('rejects invented labels and non-finite model probabilities', () => {
  const request = { state: null, questions: { x: { type: 'noul' as const } } }
  expect(() => validateDecision(request, { model: 'x', answers: { x: { type: 'noul', noul: NaN } }, usage: { input_tokens: 1, output_tokens: 0 } })).toThrow('probability')
  expect(() => validateDecision({ state: null, questions: { x: { type: 'choice', criteria: { a: null, b: null } } } },
    { model: 'x', answers: { x: { type: 'choice', choice: 'c', confidence: 1, probabilities: { a: 1, b: 0 } } }, usage: { input_tokens: 1, output_tokens: 0 } })).toThrow('finite decision')
})

it('unloads its factory while a request is active and closes all Agent ownership', async () => {
  const { ctx, loop } = await fixture(readPolicy), started = Promise.withResolvers<void>()
  ctx.jevAgentLoop.setDecisionProvider({ decide: (_request, signal) => new Promise((_resolve, reject) => {
    started.resolve(); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }) })
  const handle = await ctx.agents.create({ sessionId: SessionId('unload') })
  handle.agent.followup(message('hello')); await started.promise
  await loop.dispose()
  expect(ctx.agents.get(SessionId('unload'))).toBeUndefined()
  expect(hostSessions(ctx).get(SessionId('unload'))).toBeUndefined()
})
it('settles deadline expiry and a policy construction failure as actual failed turns', async () => {
  const { ctx } = await fixture(readPolicy, { turnTimeoutMs: 100 })
  ctx.jevAgentLoop.setDecisionProvider({ decide: (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) })
  const handle = await ctx.agents.create({ sessionId: SessionId('timeout') })
  handle.agent.followup(message('hi')); await handle.agent.whenIdle()
  expect(handle.agent.session.snapshotEvents().findLast(e => e.type === 'turn/end')?.data).toMatchObject({ reason: { kind: 'error', error: { code: 'TIMEOUT' } } })
  await handle.dispose()
  const other = await fixture({ id: 'throws', create() { throw new Error('policy construction failed') } })
  const broken = await other.ctx.agents.create({ sessionId: SessionId('broken') })
  broken.agent.followup(message('hello')); await broken.agent.whenIdle()
  expect(broken.agent.session.snapshotEvents().at(-1)?.data).toMatchObject({ reason: { kind: 'error', error: { message: 'policy construction failed' } } })
  await broken.dispose()
})
it('accepts a replacement input after cancelling an in-flight request without replaying the cancelled tool', async () => {
  const { ctx } = await fixture(readPolicy), started = Promise.withResolvers<void>(), writes = vi.fn(async () => ({}))
  let first = true
  ctx.jevAgentLoop.setDecisionProvider({ async decide(request, signal) {
    if (!first) return yes.decide(request, signal)
    first = false; started.resolve()
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  } })
  ctx.tools.register({ name: 'test_write', description: '', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute: writes })
  const handle = await ctx.agents.create({ sessionId: SessionId('replace') })
  handle.agent.followup(message('old')); await started.promise
  handle.agent.cancel({ kind: 'hook', reason: 'superseded' }); handle.agent.followup(message('new'))
  await handle.agent.whenIdle()
  expect(writes).toHaveBeenCalledOnce()
  expect(handle.agent.session.snapshotEvents().filter(e => e.type === 'turn/end').map(e => e.data.reason.kind)).toEqual(['aborted', 'completed'])
  await handle.dispose()
})
it('persists only the cancellation contract when a caller supplies a class with non-JSON state', async () => {
  const { ctx } = await fixture(readPolicy), started = Promise.withResolvers<void>()
  ctx.jevAgentLoop.setDecisionProvider({ decide: (_request, signal) => new Promise((_resolve, reject) => {
    started.resolve(); signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
  }) })
  const handle = await ctx.agents.create({ sessionId: SessionId('typed-cause') })
  handle.agent.followup(message('hi')); await started.promise
  class Cause { readonly kind = 'hook' as const; readonly reason = 'preempted'; dispose = () => {} }
  handle.agent.cancel(new Cause()); await handle.agent.whenIdle()
  expect(handle.agent.session.snapshotEvents().at(-1)?.data).toMatchObject({ reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'preempted' } } })
  await handle.dispose()
})
it('records a provider timeout as failure and can accept the next turn without replay', async () => {
  const { ctx } = await fixture({ id: 'failure-recovery', create: () => ({ async next(_state, judge) {
    await judge({ state: {}, questions: { use: { type: 'noul', instructions: 'A finite test decision.' } } })
    return { kind: 'done', reason: 'Decision succeeded' }
  } }) })
  let first = true
  ctx.jevAgentLoop.setDecisionProvider({ async decide(request, signal) {
    if (first) { first = false; const error = new Error('Request timed out after 20000ms.'); error.name = 'APITimeoutError'; throw error }
    return yes.decide(request, signal)
  } })
  const handle = await ctx.agents.create({ sessionId: SessionId('provider-recovery') })
  handle.agent.followup(message('first')); await handle.agent.whenIdle()
  expect(handle.agent.session.snapshotEvents().at(-1)?.data).toMatchObject({ reason: { kind: 'error', error: { code: 'JEV_LOOP_ERROR' } } })
  handle.agent.followup(message('next')); await handle.agent.whenIdle()
  expect(handle.agent.session.snapshotEvents().filter(e => e.type === 'turn/end').map(e => e.data.reason.kind)).toEqual(['error', 'completed'])
  await handle.dispose()
})
