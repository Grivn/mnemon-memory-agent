import type { AgentEventDispatch, Inbox, InboxState, InboxTarget, TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

export const emptyInbox = (): InboxState => ({ 'next-turn': [], 'next-step': [] })
export function foldInbox(state: InboxState, event: SessionEvent): InboxState {
  if (event.type !== 'agent/inbox/spliced') return state
  const { target, start, removedCount = 0, inserted } = event.data
  const list = [...state[target]]; list.splice(start, removedCount, ...inserted)
  return { ...state, [target]: list }
}
export const emptyBoundary = (): TurnBoundaryProjection => ({ openTurnStartSeq: null, lastStepStartSeq: null, lastStepBoundary: null, lastTurn: 0 })
export function foldBoundary(state: TurnBoundaryProjection, event: SessionEvent): TurnBoundaryProjection {
  if (event.type === 'turn/start') return { ...state, openTurnStartSeq: event.seq, lastTurn: event.data.turn }
  if (event.type === 'turn/end') return { ...state, openTurnStartSeq: null }
  if (event.type === 'step/start') return { ...state, lastStepStartSeq: event.seq, lastStepBoundary: { kind: 'start', seq: event.seq } }
  if (event.type === 'step/end') return { ...state, lastStepBoundary: { kind: 'end', seq: event.seq } }
  return state
}

/** Durable queues, including edits made while the driver is idle. */
export class JevInbox implements Inbox {
  private state: InboxState
  constructor(private readonly session: Session, private readonly events: AgentEventDispatch) {
    this.state = session.snapshotEvents().reduce(foldInbox, emptyInbox())
  }
  get nextTurn() { return this.state['next-turn'] }
  get nextStep() { return this.state['next-step'] }
  private change(target: InboxTarget, start: number, count: number, inserted: UserMessage[], canceled = false) {
    if (![start, count].every(Number.isSafeInteger) || count < 0) throw new Error('Invalid inbox splice')
    const list = this.state[target]
    const offset = start < 0 ? Math.max(list.length + start, 0) : Math.min(start, list.length)
    const removed = list.slice(offset, offset + count)
    const event = this.session.append('agent/inbox/spliced', { target, start: offset, removedCount: removed.length, inserted, ...(canceled ? { outcome: 'canceled' as const } : {}) })
    this.state = foldInbox(this.state, event)
    if (canceled) for (const message of removed) this.events.emit('agent/inbox/discarded', { message })
    for (const message of inserted) this.events.emit('agent/inbox/inserted', { message })
    return removed
  }
  clear() { this.change('next-step', 0, this.nextStep.length, [], true); this.change('next-turn', 0, this.nextTurn.length, [], true) }
  append(target: InboxTarget, message: UserMessage) { this.change(target, this.state[target].length, 0, [message]) }
  prepend(target: InboxTarget, message: UserMessage) { this.change(target, 0, 0, [message]) }
  splice(target: InboxTarget, start: number, count: number, inserted: UserMessage[]) { return this.change(target, start, count, inserted, true) }
  replace(id: MessageId, message: UserMessage) {
    for (const target of ['next-step', 'next-turn'] as const) {
      const index = this.state[target].findIndex(value => value.id === id)
      if (index >= 0) { this.change(target, index, 1, [message], true); return true }
    }
    return false
  }
  remove(id: MessageId) {
    for (const target of ['next-step', 'next-turn'] as const) {
      const index = this.state[target].findIndex(value => value.id === id)
      if (index >= 0) { this.change(target, index, 1, [], true); return true }
    }
    return false
  }
  claim(first: boolean, turn: number) {
    const messages = [...this.change('next-step', 0, this.nextStep.length, []), ...first ? this.change('next-turn', 0, 1, []) : []]
    for (const message of messages) this.events.emit('agent/inbox/claimed', { message, turn })
    return messages
  }
}
