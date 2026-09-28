import { Context, Service } from '@deepseek-ai/cordis'
import z from 'schemastery'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-session-persistence'
import { defineMemoryPlugin, installMemory } from 'dsh-mnemon/extension-sdk'
import { channelId, ReplicaStore, type Lease, type Progress, type ProgressMessage, type SelectedMemory, type Withdrawal } from './store.ts'
import { replicaSource, renderSelection } from './source.ts'
export * from './store.ts'
export { replicaSource, renderSelection }
export const name = 'dsh-mnemon-replica'
export interface Config { role: 'main' | 'replica'; directory: string; pollMs: number; backgroundMs: number; leaseMs: number; waitMs: number; maxRevisionLag: number; maxAgeMs: number; maxMessages: number; maxConcurrentJobs: number; delivery: 'legacy' | 'stable' }
export type ConfigInput = Partial<Config> & Pick<Config, 'role' | 'directory'>
export interface ReplicaJob { channel: string; lease: Lease; progress: Progress; trigger?: 'input' | 'background'; invalidatedSources?: string[] }
declare module '@deepseek-ai/cordis' { interface Context { mnemonReplica: ReplicaBridge } }
export const memoryPlugin = defineMemoryPlugin({ packageName: name, label: { en: 'Replica context', 'zh-CN': '副本上下文' }, description: { en: 'Versioned evidence selected by an independent DSH instance.', 'zh-CN': '独立 DSH 实例选择的带版本证据。' }, roles: ['source'], provides: [{ id: 'source' }] })

export class ReplicaBridge extends Service {
  static inject = ['agents', 'tools']
  static Config = z.object({ role: z.union(['main', 'replica']).required(), directory: z.string().required(), pollMs: z.number().step(1).min(25).max(60_000).default(250),
    backgroundMs: z.number().step(1).min(0).default(0), leaseMs: z.number().step(1).min(1000).default(90_000), waitMs: z.number().step(1).min(0).max(30_000).default(0),
    maxRevisionLag: z.number().step(1).min(0).default(0), maxAgeMs: z.number().step(1).min(1).default(300_000), maxMessages: z.number().step(1).min(1).max(100).default(12), maxConcurrentJobs: z.number().step(1).min(1).max(16).default(2),
    delivery: z.union(['legacy', 'stable']).default('legacy') }) as z<ConfigInput, Config>
  readonly store: ReplicaStore
  private readonly runtime: { ctx: Context }
  private readonly jobs = new WeakMap<Agent, ReplicaJob>()
  private readonly running = new Map<string, Running>()
  private pending: Promise<void> = Promise.resolve()
  private polling: Promise<void> | undefined
  private scanOffset = 0
  private closed = false
  private readonly refresh = new Map<string, Set<string>>()
  lastError: string | undefined
  readonly config: Config
  constructor(ctx: Context, config: Config) {
    super(ctx, 'mnemonReplica'); this.runtime = { ctx }; this.config = { ...config }; this.store = new ReplicaStore(config.directory)
    if (config.role === 'main') {
      ctx.inject(['mnemonMemory'], child => installMemory(child, { plugin: memoryPlugin, sources: [replicaSource(this.store, config, () => this.flush())] }, { instanceId: 'replica-main' }))
      ctx.on('agent/inbox/inserted', ({ agent, message }) => { if (message.source.kind === 'user') this.broadcast(agent, message) })
      ctx.on('session/event', (session, event) => {
        if (event.type !== 'user/message' && event.type !== 'assistant/message') return
        if (event.type === 'user/message' && event.data.source.kind !== 'user') return
        const agent = ctx.agents.get(session.id); if (agent) this.broadcast(agent)
      })
    } else {
      ctx.tools.register({ name: 'mnemon_replica_publish', description: 'Publish selected source evidence for this replica job. The bridge verifies job ownership and the current main-input revision.',
        parameters: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', additionalProperties: true } }, withdrawn: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['items'], additionalProperties: false },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async (args, exec) => {
          const job = this.job(exec.agent), { items, withdrawn } = args as { items: SelectedMemory[]; withdrawn?: Withdrawal[] }
          const candidate = await this.store.publish(job.channel, job.lease, job.progress.digest, items, exec.signal, withdrawn)
          return { completion: 'committed', serial: candidate.serial, basedOn: candidate.basedOn, digest: candidate.digest, selected: candidate.items.length }
        },
      })
      ctx.effect(() => { const timer = setInterval(() => { void this.pump() }, config.pollMs); timer.unref(); return () => clearInterval(timer) })
    }
    ctx.effect(() => async () => {
      this.closed = true
      for (const value of this.running.values()) value.handle?.agent.cancel({ kind: 'disposed' })
      await this.polling; await this.pending
      await Promise.allSettled([...this.running.values()].map(value => value.pending))
    })
  }
  job(agent: Agent | undefined): ReplicaJob {
    const job = agent && this.jobs.get(agent)
    if (!job || this.closed) throw new Error('This Agent does not own an active replica job')
    return structuredClone(job)
  }
  async flush() { await this.pending; if (this.lastError) throw new Error(this.lastError) }
  /** Optional policy wake-up; metadata invalidation never supplies evidence or grants. */
  async requestRefresh(workspaceId?: string, sourceInstanceKey?: string) {
    if (this.closed || this.config.role !== 'replica') return
    for (const channel of await this.store.list()) {
      const state = await this.store.read(channel)
      if (state && (!workspaceId || state.progress.workspaceId === workspaceId)) {
        const sources = this.refresh.get(channel) ?? new Set<string>()
        sources.add(sourceInstanceKey ?? '*'); this.refresh.set(channel, sources)
      }
    }
  }
  private broadcast(agent: Agent, inserted?: UserMessage) {
    if (!agent.session.header.cwd || this.closed) return
    const messages = visible(agent.session.snapshotEvents(), [...agent.inbox.nextStep, ...agent.inbox.nextTurn, ...inserted ? [inserted] : []]).slice(-this.config.maxMessages)
    const input = { workspaceId: agent.session.header.cwd, sessionId: String(agent.id), messages }
    this.pending = this.pending.then(async () => { await this.store.progress(input); this.lastError = undefined }).catch(() => { this.lastError = 'Replica progress could not be saved'; this.runtime.ctx.logger.warn(this.lastError) })
  }
  /** Polls only the local transport. Unchanged progress makes no model requests. */
  pump(): Promise<void> {
    if (this.closed || this.config.role !== 'replica') return Promise.resolve()
    if (this.polling) return this.polling
    const ctx = this.runtime.ctx
    this.polling = (async () => {
      // Inspect active jobs every pass, even when the directory scan rotates.
      for (const [channel, running] of this.running) {
        const current = await this.store.read(channel)
        if (current && current.progress.revision !== running.job.lease.revision) preempt(running, 'New main input superseded this replica job')
      }
      const channels = await this.store.list()
      const ordered = [...channels.slice(this.scanOffset), ...channels.slice(0, this.scanOffset)].slice(0, 256)
      // Advance within a scan window as well as between windows. Otherwise a
      // short background interval lets the same first jobs monopolize capacity.
      this.scanOffset = channels.length ? (this.scanOffset + ordered.length + 1) % channels.length : 0
      const scanned = await Promise.all(ordered.map(async channel => ({ channel, current: await this.store.read(channel) })))
      const urgent = (value: typeof scanned[number]) => value.current?.progress.messages.at(-1)?.role === 'user' && value.current.lastRun?.revision !== value.current.progress.revision && !this.running.has(value.channel)
      const demand = scanned.filter(urgent).length
      let release = Math.max(0, demand - (this.config.maxConcurrentJobs - this.running.size))
      for (const running of this.running.values()) if (release > 0 && running.job.trigger === 'background') {
        preempt(running, 'Foreground input takes priority over maintenance'); release--
      }
      scanned.sort((a, b) => Number(urgent(b)) - Number(urgent(a)))
      for (const { channel } of scanned) {
        if (this.closed) return
        const current = await this.store.read(channel), running = this.running.get(channel)
        if (!current) continue
        if (running) { if (running.job.lease.revision !== current.progress.revision) preempt(running, 'New main input superseded this replica job'); continue }
        if (this.running.size >= this.config.maxConcurrentJobs) continue
        const now = Date.now(), last = current.lastRun
        const refresh = this.refresh.has(channel)
        const backgroundMs = refresh ? 1 : this.config.backgroundMs
        if (current.lease && current.lease.until > now || last?.revision === current.progress.revision && (last.error ? now - last.at < 10_000 : !backgroundMs || now - last.at < backgroundMs)) continue
        const lease = await this.store.claim(channel, backgroundMs, this.config.leaseMs)
        if (!lease) continue
        const state = await this.store.read(channel)
        if (!state || state.progress.revision !== lease.revision) { await this.store.finish(channel, lease, 'Superseded before start'); continue }
        const job: ReplicaJob = { channel, lease, progress: state.progress,
          trigger: state.progress.messages.at(-1)?.role === 'assistant' || last?.revision === state.progress.revision ? 'background' : 'input' }
        const invalidated = this.refresh.get(channel), source = invalidated?.values().next().value
        if (source) { if (source !== '*') job.invalidatedSources = [source]; invalidated!.delete(source) }
        if (!invalidated?.size) this.refresh.delete(channel)
        const work: Running = { job, pending: Promise.resolve() }
        this.running.set(channel, work)
        work.pending = (async () => {
          let error: string | undefined
          try {
            const id = SessionId('replica-' + channel.slice(0, 32))
            // Every run owns a short Agent lifetime. Persistence preserves the session across runs/restarts.
            const persistence = ctx.get('sessionPersistence')
            const existing = persistence && await persistence.stat(id)
            const handle = existing ? await ctx.agents.resume({ resumeSessionId: id }) : await ctx.agents.create({ sessionId: id, meta: { cwd: job.progress.workspaceId } })
            work.handle = handle
            if (this.closed) return
            this.jobs.set(handle.agent, job)
            handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: JSON.stringify(job.progress) }], source: { kind: 'plugin', plugin: name, form: 'relay' } }))
            await handle.agent.whenIdle()
            const end = handle.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
            if (end?.type !== 'turn/end' || end.data.reason.kind !== 'completed') error = 'Replica turn did not complete'
          } catch { error = 'Replica job failed'; ctx.logger.warn(error) }
          finally {
            if (work.handle) { this.jobs.delete(work.handle.agent); await work.handle.dispose().catch(() => { error = 'Replica Agent cleanup failed' }) }
            // A job the bridge preempted did not fail; it leaves no run behind and may be claimed again.
            if (work.preempted) await this.store.release(channel, lease); else await this.store.finish(channel, lease, error)
            this.running.delete(channel)
          }
        })().catch(() => { this.lastError = 'Replica transport settlement failed'; this.running.delete(channel) })
      }
    })().catch(() => { this.lastError = 'Replica transport scan failed'; ctx.logger.warn(this.lastError) }).finally(() => { this.polling = undefined })
    return this.polling
  }
}

interface Running { job: ReplicaJob; handle?: AgentHandle; pending: Promise<void>; preempted?: boolean }
function preempt(running: Running, reason: string) { running.preempted = true; running.handle?.agent.cancel({ kind: 'hook', reason }) }

function visible(events: readonly SessionEvent[], pending: readonly UserMessage[]): ProgressMessage[] {
  const messages = new Map<string, ProgressMessage>()
  for (const event of events) {
    const message = event.type === 'assistant/message' ? event.data.message : event.type === 'user/message' && event.data.source.kind === 'user' ? event.data : undefined
    if (!message) continue
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (text.trim()) messages.set(String(message.id), { id: String(message.id), role: event.type === 'assistant/message' ? 'assistant' : 'user', text: text.slice(0, 50_000) })
  }
  for (const message of pending) if (message.source.kind === 'user') {
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (text.trim()) messages.set(String(message.id), { id: String(message.id), role: 'user', text: text.slice(0, 50_000) })
  }
  return [...messages.values()]
}
export default ReplicaBridge
