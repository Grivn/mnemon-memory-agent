import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { agentEvents, assembleContextFor, type Agent, type AgentCancelCause, type AgentOptions, type CancelOptions, type InboxTarget } from '@deepseek-ai/dsh-agent'
import { createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionStore, TurnEndReason } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import { renderPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { JevPolicy, LoopLimits, PolicyState, StepObservation } from './contracts.ts'
import { validateDecision, type DecisionProvider, type DecisionTrace } from './decisions.ts'
import { JevInbox } from './inbox.ts'

const plugin = 'dsh-mnemon-agent-loop-jev'
/** Callers can provide structurally valid class/proxy causes; durable events require plain JSON. */
function durableCancelCause(cause: AgentCancelCause | undefined): AgentCancelCause {
  if (!cause) return { kind: 'hook', reason: 'aborted' }
  return cause.kind === 'hook' ? { kind: 'hook', reason: String(cause.reason) } : { kind: cause.kind }
}
// DSH host and browser both augment Cordis.Context.sessions. Preserve the host
// service face when a consumer typechecks host and client in one TS program.
export const hostSessions = (ctx: Context) => ctx.get('sessions') as unknown as SessionStore
export class JevAgent implements Agent {
  readonly id
  readonly scope
  readonly ctx: Context
  readonly inbox: JevInbox
  readonly events
  status: 'idle' | 'running' = 'idle'
  private active: Promise<unknown> | undefined
  private controller: AbortController | undefined
  private cause: AgentCancelCause | undefined
  private disposed = false
  private published = false
  private wake = false
  private turn: number
  constructor(runtime: Context, readonly session: Session, readonly options: AgentOptions,
    private readonly policy: JevPolicy, private readonly provider: DecisionProvider, private readonly limits: LoopLimits) {
    this.id = session.id
    this.scope = createScope(runtime, this)
    this.ctx = this.scope.ctx
    this.events = agentEvents(this.ctx, this)
    this.inbox = new JevInbox(session, this.events)
    this.turn = session.snapshotEvents().reduce((n, event) => event.type === 'turn/start' ? Math.max(n, event.data.turn) : n, 0)
  }
  activate(resume = false) { this.published = true; if (resume && this.inbox.nextTurn.length) this.wake = true; this.schedule() }
  send(message: UserMessage, target: InboxTarget, wakeup: boolean) {
    if (this.disposed) throw new Error('JEV agent is disposed')
    this.inbox.append(target, message)
    if (wakeup) this.wake = true
    this.schedule()
  }
  followup(message: UserMessage) { this.send(message, 'next-turn', true) }
  steer(message: UserMessage) { this.send(message, 'next-step', true) }
  inject(message: UserMessage) { this.send(message, 'next-step', false) }
  cancel(cause: AgentCancelCause, options: CancelOptions = {}) {
    if (!options.keepInbox) this.inbox.clear()
    this.wake = false
    if (cause.kind === 'disposed') this.disposed = true
    if (this.controller && !this.controller.signal.aborted) { this.cause = cause; this.controller.abort(cause) }
  }
  async whenIdle(): Promise<void> { while (this.active) await this.active.catch(() => {}) }
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active || this.disposed) throw new Error('JEV agent is not available for maintenance')
    this.controller = new AbortController(); this.cause = undefined
    let result: Promise<T>
    try { result = task(this.controller.signal) } catch (error) { this.controller = undefined; throw error }
    const active = result.finally(() => { if (this.active === active) { this.active = undefined; this.controller = undefined; this.schedule() } })
    this.active = active
    return active
  }
  private statusTo(status: 'idle' | 'running') { if (this.status !== status) { this.status = status; this.events.emit('agent/status', { status }) } }
  private schedule() {
    if (!this.published || this.disposed || this.active || !this.wake) return
    this.controller = new AbortController(); this.cause = undefined
    this.statusTo('running')
    const active = Promise.resolve().then(() => this.ctx.agents.withInitiator(this, () => this.drive())).finally(() => {
      if (this.active === active) { this.active = undefined; this.controller = undefined; this.statusTo('idle'); this.schedule() }
    })
    this.active = active
    void active.catch(error => this.events.emit('agent/error', { turn: this.turn, step: 0, error }))
  }
  private audit(summary: string, value: unknown) {
    this.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: JSON.stringify(value) }],
      source: { kind: 'plugin', plugin, form: 'notice', summary } }), { surfaceOp: 'append' })
  }
  private async drive() {
    do {
      this.wake = false
      const reason = await this.driveTurn(this.controller!.signal)
      // Cancellation drains before a new waking input gets a new cancellation scope.
      if (this.controller!.signal.aborted || reason.kind !== 'completed') break
    } while (this.inbox.nextTurn.length || this.wake)
  }
  private async driveTurn(parent: AbortSignal) {
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new Error('JEV turn deadline exceeded')), this.limits.turnTimeoutMs)
    const signal = AbortSignal.any([parent, deadline.signal])
    const turn = ++this.turn, observations: StepObservation[] = [], messages: UserMessage[] = []
    let step = 0, calls = 0, reason: TurnEndReason = { kind: 'blocked' }
    this.session.append('turn/start', { turn })
    try {
      const run = this.policy.create()
      for (step = 1; step <= this.limits.maxSteps; step++) {
        signal.throwIfAborted()
        const assembly = await this.ctx.systemPrompt.assemble(assembleContextFor(this, signal))
        signal.throwIfAborted()
        const incoming = this.inbox.claim(step === 1, turn)
        const admission = await this.events.waterfall('agent/pre-step', { turn, step, messages: incoming, signal }, async () => ({ kind: 'enter', messages: incoming }))
        signal.throwIfAborted()
        if (admission.kind === 'reject') break
        this.session.append('step/start', { turn, step })
        try {
          const system = renderPrompt(assembly), context = renderContextSnapshot(assembly)
          // Typed requests have no LLM route/header/stream. Log their real inputs and outputs as plugin notices.
          if (step === 1 && system) this.session.append('system/message', { turn, step, message: createSystemMessage(system, plugin) }, { surfaceOp: 'append' })
          for (const message of admission.messages) this.session.append('user/message', message, { surfaceOp: 'append' })
          messages.push(...admission.messages)
          if (context) this.audit('DSH context assembled for JEV', { turn, step, context })
          const state: PolicyState = { agent: this, turn, step, messages: [...messages], system, context, observations: [...observations] }
          const plan = await run.next(state, async request => {
            signal.throwIfAborted()
            if (calls >= this.limits.maxDecisionCalls) throw new Error('JEV decision call budget exhausted')
            if (!Object.keys(request.questions).length || Object.keys(request.questions).length > 128 || JSON.stringify(request).length > this.limits.maxStateCharacters) throw new Error('JEV decision state exceeds configured limits')
            calls++
            const started = performance.now()
            this.audit('JEV decision request', { turn, step, call: calls, request })
            const trace: DecisionTrace = { request, elapsedMs: 0 }
            try { trace.result = validateDecision(request, await this.provider.decide(request, signal)); signal.throwIfAborted(); return trace.result }
            catch (error) { trace.error = signal.aborted ? 'aborted' : error instanceof Error ? error.name : 'DecisionError'; throw error }
            finally { trace.elapsedMs = performance.now() - started; this.audit('JEV decision result', { turn, step, call: calls, ...trace }) }
          }, signal)
          signal.throwIfAborted()
          if (plan.kind === 'done') {
            this.audit('JEV policy stopped', { turn, step, reason: plan.reason })
            await this.events.serial('agent/turn-stopping', { turn, signal })
            signal.throwIfAborted()
            if (this.inbox.nextStep.length) continue
            reason = { kind: 'completed' }; break
          }
          const { call } = plan
          if (!call.name || JSON.stringify(call).length > this.limits.maxStateCharacters) throw new Error('Invalid or oversized planned tool call')
          const callId = ToolCallId(randomUUID())
          this.session.append('tool/call', { turn, step, callId, name: call.name, arguments: JSON.stringify(call.arguments) })
          let result: ToolExecutionResult
          try { result = await this.ctx.tools.execute({ callId, name: call.name, arguments: call.arguments, agent: this, signal }) }
          catch { result = { isError: true, error: { message: 'Tool pipeline failed; outcome may be unknown', info: { name: 'ToolPipelineError', code: 'UNKNOWN' } }, content: [{ type: 'text', text: 'Tool pipeline failed; do not assume a write was rolled back.' }] } }
          this.session.append('tool/result', { turn, step, message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
            ...(result.error?.info ? { error: result.error.info } : {}), ...(result.meta === undefined ? {} : { meta: result.meta }) }, { surfaceOp: 'append' })
          // Canonical values are execution-local; the exact policy observation is separately logged for replay/debugging.
          this.audit('JEV tool observation', { turn, step, call, result })
          observations.push({ call, result })
          for (const message of result.additionalContexts ?? []) this.inject(message)
          signal.throwIfAborted()
          if (result.concludesTurn && !this.inbox.nextStep.length) { reason = { kind: 'completed' }; break }
        } finally { this.session.append('step/end', { turn, step }) }
      }
    } catch (error) {
      reason = parent.aborted ? { kind: 'aborted', reason: durableCancelCause(this.cause) }
        : { kind: 'error', error: { code: deadline.signal.aborted ? 'TIMEOUT' : 'JEV_LOOP_ERROR', message: error instanceof Error ? error.message : 'JEV loop failed' } }
      // A cancelled turn ends as `aborted`; only real failures are agent errors.
      if (!parent.aborted) this.events.emit('agent/error', { turn, step, error })
    } finally {
      clearTimeout(timer)
      this.session.append('turn/end', { turn, reason })
      await hostSessions(this.ctx).flush(this.session)
    }
    return reason
  }
}
