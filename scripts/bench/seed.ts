/**
 * Write one benchmark memory into public Sources, in the chosen memory mode:
 *   raw          every message of every session as imported conversation history (sessions Source), dated in its text;
 *   notes        each session's notes as dated journal records of at most ~600 characters (a whole memory stays enumerable);
 *   raw-records  each session's messages as they were said, in the same dated journal records: the notes' write path
 *                without extracting anything;
 *   hybrid       notes and raw history: notes to recall from, raw history to search for details.
 * Oldest first, so creation order follows the conversation. Records are written up to a thousand per call.
 */
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { MnemonRuntimeGraph } from '../../src/host/runtime.ts'
import type { Session } from './data.ts'

export type MemoryMode = 'raw' | 'notes' | 'raw-records' | 'hybrid'
export interface BenchMemory { mode: MemoryMode; sessions: Array<Session & { tag?: string }>; notes?: Record<string, string> }

/** Notes lines grouped into chunks of at most `limit` characters, each headed by the conversation it came from. */
export function noteChunks(heading: string, notes: string, limit = 600): string[] {
  const chunks: string[] = []
  let chunk: string[] = []
  for (const line of notes.split('\n').filter(value => value.trim())) {
    if (chunk.length && [...chunk, line].join('\n').length + heading.length > limit) { chunks.push(chunk.join('\n')); chunk = [] }
    chunk.push(line)
  }
  if (chunk.length) chunks.push(chunk.join('\n'))
  return chunks.map(text => `${heading}:\n${text}`)
}

/** A session's messages as `speaker: text` lines; a long message is cut at spaces into lines of at most `limit` characters. */
export function dialogueLines(session: Session, limit = 540): string {
  return session.turns.flatMap(turn => {
    let rest = `${turn.speaker}: ${turn.text.replace(/\s+/g, ' ').trim()}`
    const lines: string[] = []
    while (rest.length > limit) {
      const space = rest.lastIndexOf(' ', limit), cut = space > limit / 2 ? space : limit
      lines.push(rest.slice(0, cut)); rest = rest.slice(cut).trimStart()
    }
    return [...lines, rest]
  }).join('\n')
}

export async function seedBench(graph: MnemonRuntimeGraph, root: string, memory: BenchMemory) {
  const workspaceId = join(root, 'workspace'), scope = { storage: 'custom' as const, workspaceId }
  await promisify(execFile)('git', ['init', '-q', '-b', 'bench', workspaceId])
  await mkdir(join(root, 'imported-history'), { recursive: true })
  const sessions = memory.sessions.slice().sort((a, b) => a.iso.localeCompare(b.iso))
  let messages = 0
  if (memory.mode === 'raw' || memory.mode === 'hybrid') for (const [index, session] of sessions.entries()) {
    const lines = [JSON.stringify({ type: 'session_meta', payload: { cwd: workspaceId } }),
      ...session.turns.map((turn, i) => JSON.stringify({ type: 'message', role: turn.role, content: `[${session.tag ? session.tag + ' · ' : ''}${session.date}] ${turn.speaker}: ${turn.text}`, timestamp: new Date(Date.parse(session.iso) + i * 1000).toISOString() }))]
    await writeFile(join(root, 'imported-history', String(index).padStart(5, '0') + '.jsonl'), lines.join('\n') + '\n')
    messages += session.turns.length
  }
  const raw = memory.mode === 'raw-records'
  // Day-scoped journal entries keep their date, so a replica can page through a long memory by date.
  const records = memory.mode === 'raw' ? [] : sessions.flatMap(session => {
    const text = raw ? dialogueLines(session) : memory.notes?.[session.id]
    return !text ? [] : noteChunks(`Conversation ${session.tag ? session.tag + ' ' : ''}on ${session.date}`, text).map((content, i) =>
      ({ title: `${session.date} · ${raw ? 'conversation' : 'notes'} ${i + 1}`, content, kind: 'progress', scope: 'daily', date: session.iso.slice(0, 10) }))
  })
  for (let i = 0; i < records.length; i += 1000) await graph.source('journal', scope).mutate('batch-create', { records: records.slice(i, i + 1000) })
  return { sessions: sessions.length, messages, records: records.length, characters: records.reduce((n, record) => n + record.content.length, 0) }
}
