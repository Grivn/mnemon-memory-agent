import { Context, Service } from '@deepseek-ai/cordis'
import z from 'schemastery'
import { z as schema } from 'zod'
import type { AgentFactory, AgentHandle, CreateAgentOptions, ResumeAgentOptions, InboxState, InboxWireState, TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import { Session, SessionLogOffset, interruptedTurnClosers, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import '@deepseek-ai/dsh-session-projection'
import '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-system-prompt'
import { JevAgent, hostSessions } from './agent.ts'
import { emptyBoundary, emptyInbox, foldBoundary, foldInbox } from './inbox.ts'
import { createJevProvider, type DecisionProvider } from './decisions.ts'
import type { JevPolicy, LoopLimits } from './contracts.ts'
export * from './contracts.ts'
export * from './decisions.ts'

export const name = 'dsh-mnemon-agent-loop-jev'
export interface Config extends LoopLimits { policy: string; apiKeyEnv: string; model: string; requestTimeoutMs: number }
export type ConfigInput = Partial<Config> & Pick<Config, 'policy'>
declare module '@deepseek-ai/cordis' { interface Context { jevAgentLoop: JevAgentLoop } }

/** Alternative public AgentFactory. Intentionally has no built-in memory policy. */
export class JevAgentLoop extends Service implements AgentFactory {
  static inject = ['agents', 'sessions', 'tools', 'systemPrompt', 'sessionProjections']
  static Config = z.object({
    policy: z.string().required(), apiKeyEnv: z.string().default('TYPESAFE_API_KEY'), model: z.string().default('jev-latest'),
    maxSteps: z.number().step(1).min(1).max(256).default(32), maxDecisionCalls: z.number().step(1).min(1).max(128).default(8),
    maxStateCharacters: z.number().step(1).min(1000).max(1_000_000).default(96_000),
    turnTimeoutMs: z.number().step(1).min(100).max(600_000).default(60_000), requestTimeoutMs: z.number().step(1).min(100).max(120_000).default(20_000),
  }) as z<ConfigInput, Config>
  private readonly runtime: { ctx: Context }
  private readonly closing = new AbortController()
  private readonly policies = new Map<string, JevPolicy>()
  private readonly handles = new Set<AgentHandle>()
  private readonly transactions = new Set<Promise<AgentHandle>>()
  private provider: DecisionProvider
  readonly config: Config
  constructor(ctx: Context, config: Config) {
    super(ctx, 'jevAgentLoop')
    if (!config.policy || ![config.maxSteps, config.maxDecisionCalls, config.maxStateCharacters, config.turnTimeoutMs, config.requestTimeoutMs].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid JEV driver configuration')
    this.config = { ...config }; this.runtime = { ctx }
    this.provider = createJevProvider({ apiKeyEnv: config.apiKeyEnv, model: config.model, timeoutMs: config.requestTimeoutMs })
    ctx.sessionProjections.register({ key: 'inbox', stateSchema: schema.custom<InboxState>(value => !!value && typeof value === 'object' && Array.isArray((value as InboxState)['next-turn']) && Array.isArray((value as InboxState)['next-step'])),
      init: emptyInbox, apply: foldInbox, wire: { viewSchema: schema.custom<InboxWireState>(), view: state => state as unknown as InboxWireState }, stateVersion: 1 })
    ctx.sessionProjections.register({ key: 'turnBoundary', stateSchema: schema.custom<TurnBoundaryProjection>(value => !!value && typeof value === 'object' && Number.isSafeInteger((value as TurnBoundaryProjection).lastTurn)),
      init: emptyBoundary, apply: foldBoundary, stateVersion: 1 })
    ctx.effect(() => ctx.agents.setFactory(this))
    ctx.effect(() => async () => {
      this.closing.abort(new Error('JEV driver unloaded'))
      for (const handle of this.handles) handle.agent.cancel({ kind: 'disposed' })
      await Promise.allSettled(this.transactions)
      const results = await Promise.allSettled([...this.handles].map(handle => handle.dispose()))
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'JEV agent disposal failed')
    })
    ctx.systemPrompt.variable('cwd', value => value.agent?.session.header.cwd)
    ctx.systemPrompt.variable('provider', value => value.agent?.options.provider)
    ctx.systemPrompt.variable('model', value => value.agent?.options.model)
  }
  /** Test/alternative typed provider seam. Existing Agents retain their chosen provider. */
  setDecisionProvider(provider: DecisionProvider) { this.provider = provider }
  registerPolicy(policy: JevPolicy): () => Promise<void> {
    if (this.policies.has(policy.id)) throw new Error('Duplicate JEV policy: ' + policy.id)
    this.policies.set(policy.id, policy)
    return async () => {
      if (this.policies.get(policy.id) !== policy) return
      this.policies.delete(policy.id)
      if (policy.id === this.config.policy) await Promise.all([...this.handles].map(handle => handle.dispose()))
    }
  }
  createAgent(owner: Context, options: CreateAgentOptions): Promise<AgentHandle> { return this.start(owner, options) }
  resume(owner: Context, options: ResumeAgentOptions): Promise<AgentHandle> { return this.start(owner, options) }
  private start(owner: Context, options: CreateAgentOptions | ResumeAgentOptions): Promise<AgentHandle> {
    const policy = this.policies.get(this.config.policy)
    if (!policy) return Promise.reject(new Error('Install the explicitly selected JEV policy before creating an Agent: ' + this.config.policy))
    owner.fiber.assertActive(); this.closing.signal.throwIfAborted(); options.signal?.throwIfAborted()
    const abort = new AbortController(), ctx = this.runtime.ctx
    const signal = AbortSignal.any([abort.signal, this.closing.signal, ...options.signal ? [options.signal] : []])
    let agent: JevAgent | undefined, stored: SessionHandle | undefined, detachAgent: (() => void) | undefined, detachSession: (() => void) | undefined
    let closed: Promise<void> | undefined, handle: AgentHandle | undefined, preparing = true
    const disposed = async () => {
      abort.abort(new Error('JEV Agent owner disposed'))
      agent?.cancel({ kind: 'disposed' })
      // An unpublished transaction owns its rollback; avoid self-await on setup failure.
      if (preparing) return
      return dispose()
    }
    const unfollow = owner.effect(() => disposed)
    const dispose = (): Promise<void> => closed ??= (async () => {
      abort.abort(new Error('JEV Agent disposed'))
      const failures: unknown[] = []
      try { agent?.cancel({ kind: 'disposed' }); await agent?.whenIdle(); await agent?.scope.dispose() } catch (error) { failures.push(error) }
      try { await stored?.close() } catch (error) { failures.push(error) }
      try { detachAgent?.(); detachSession?.() } finally { if (handle) this.handles.delete(handle) }
      if (failures.length) throw new AggregateError(failures, 'JEV Agent cleanup failed')
    })()
    const transaction = (async () => {
      try {
        const resume = 'resumeSessionId' in options
        const id: SessionId = resume ? options.resumeSessionId : options.sessionId
        let session: Session, storedCount = 0
        const persistence = ctx.get('sessionPersistence')
        if (resume) {
          if (!persistence) throw new Error('Resume requires a DSH session persistence plugin')
          stored = await persistence.open(id, 'write', { signal }); signal.throwIfAborted()
          const history = await stored.read(undefined, undefined, { signal }); signal.throwIfAborted()
          storedCount = history.events.length
          session = Session.create(id, [...history.events, ...interruptedTurnClosers(history.events)], stored.header, stored.inheritedEventCount)
        } else {
          session = hostSessions(ctx).prepare(id, { ...(options.meta ? { meta: options.meta } : {}), ...(options.seed ? { seed: options.seed } : {}), ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }) })
          if (persistence) stored = await persistence.create(session.header, { signal, inheritedEventCount: session.inheritedEventCount })
        }
        signal.throwIfAborted(); owner.fiber.assertActive()
        agent = new JevAgent(ctx, session, { ...options.agentOptions, provider: 'typesafe-system-one', model: this.config.model }, policy, this.provider, this.config)
        const commit = await options.setup?.(agent.ctx, agent)
        if (this.policies.get(this.config.policy) !== policy) throw new Error('JEV policy was unloaded during Agent setup')
        signal.throwIfAborted(); owner.fiber.assertActive(); commit?.commit()
        if (stored) { await stored.append(session.snapshotEvents(SessionLogOffset(storedCount))); signal.throwIfAborted() }
        detachSession = hostSessions(agent.ctx).enter(session)
        detachAgent = ctx.agents.enter(agent, options.parentAgent)
        hostSessions(agent.ctx).announce(session)
        signal.throwIfAborted()
        ctx.agents.announce(agent)
        agent.events.emit('agent/session-start', { source: resume ? 'resume' : 'startup' })
        signal.throwIfAborted()
        handle = { agent, dispose: async () => { await dispose(); await unfollow() } }
        this.handles.add(handle); preparing = false
        agent.activate(resume)
        return handle
      } catch (error) { preparing = false; await dispose().catch(() => {}); await unfollow(); throw error }
    })()
    this.transactions.add(transaction)
    void transaction.finally(() => this.transactions.delete(transaction)).catch(() => {})
    return transaction
  }
}
export default JevAgentLoop
