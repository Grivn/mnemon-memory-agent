import assert from 'node:assert/strict'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const text = (blocks: readonly ContentBlock[]) => blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')

/** Derive timing from DSH's durable inbox/turn/request/stream timestamps. */
export function measureTurn(events: readonly SessionEvent[], turn: number, input: string, candidateAt?: number) {
  const start = events.find(event => event.type === 'turn/start' && event.data.turn === turn)
  const end = events.find(event => event.type === 'turn/end' && event.data.turn === turn)
  assert(start && end, 'Completed turn timing is required')
  const current = events.filter(event => event.seq >= start.seq && event.seq <= end.seq)
  const user = current.find(event => event.type === 'user/message' && event.data.source.kind === 'user' && text(event.data.content) === input)
  assert(user?.type === 'user/message', 'Original human message must match the evaluated input')
  const messageId = user.data.id
  const inbox = events.findLast(event => event.seq <= user.seq && event.type === 'agent/inbox/spliced' &&
    event.data.inserted?.some(message => message.id === messageId))
  const header = current.find(event => event.type === 'request/header')
  const answers = current.filter(event => event.type === 'assistant/message')
  assert(inbox && header && answers.length === 1, 'Expected one main-model reply per controlled turn')
  const answer = answers[0]!
  const chunks = expandAssistantStream(answer.data.stream)
  const visible = chunks.filter(record => record.chunk.type === 'text-delta' && record.chunk.text.trim())
  assert(visible.length, 'A visible text response is required')
  assert.equal(chunks.flatMap(record => record.chunk.type === 'text-delta' ? [record.chunk.text] : []).join(''), text(answer.data.message.content))
  const queued = inbox.time, first = visible[0]!.time, last = visible.at(-1)!.time
  assert(queued <= start.time && start.time <= header.time && header.time <= first && first <= last && last <= end.time)
  if (candidateAt !== undefined) assert(candidateAt >= queued && candidateAt <= header.time, 'Candidate must be freshly published before the main request')
  return {
    milliseconds: {
      firstText: first - queued, lastText: last - queued, completed: end.time - queued,
      beforeModel: header.time - queued, modelFirstText: first - header.time, generation: last - first,
      ...(candidateAt !== undefined ? { candidateReady: candidateAt - queued, afterCandidateBeforeModel: header.time - candidateAt } : {}),
    },
    timestamps: { queued, turnStart: start.time, request: header.time, firstText: first, lastText: last, turnEnd: end.time, candidateAt },
    evidence: { inbox, turnStart: start, user, request: { type: header.type, seq: header.seq, time: header.time }, answer, turnEnd: end },
  }
}
