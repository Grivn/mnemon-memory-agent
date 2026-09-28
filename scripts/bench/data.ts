/**
 * LoCoMo and LongMemEval as one shape: a case is one memory (sessions with dates) and the questions asked
 * against it. LoCoMo: one case per conversation, many questions. LongMemEval: one case per question.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export interface Turn { role: 'user' | 'assistant'; speaker: string; text: string }
export interface Session { id: string; date: string; iso: string; turns: Turn[] }
export interface Question { id: string; type: string; question: string; answer: string; date?: string; abstention?: boolean; evidence?: string[]; rubric?: string[] }
export interface Case { id: string; dataset: 'locomo' | 'longmemeval' | 'beam' | 'halumem'; speakers: string[]; sessions: Session[]; questions: Question[] }

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
/** "1:56 pm on 8 May, 2023" (LoCoMo) or "2023/05/20 (Sat) 02:21" (LongMemEval) as an ISO timestamp. */
export function isoDate(value: string): string {
  const lme = /^(\d{4})\/(\d{2})\/(\d{2})(?: \(\w+\))?(?: (\d{2}):(\d{2}))?/.exec(value)
  if (lme) return new Date(Date.UTC(+lme[1]!, +lme[2]! - 1, +lme[3]!, +(lme[4] ?? 0), +(lme[5] ?? 0))).toISOString()
  const loc = /(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+(\w+),?\s+(\d{4})/i.exec(value)
  if (loc) {
    const hour = (+loc[1]! % 12) + (loc[3]!.toLowerCase() === 'pm' ? 12 : 0), month = MONTHS.indexOf(loc[5]!.toLowerCase())
    if (month >= 0) return new Date(Date.UTC(+loc[6]!, month, +loc[4]!, hour, +loc[2]!)).toISOString()
  }
  throw new Error('Unparsed date: ' + value)
}

// LoCoMo category numbers as used by its evaluation code and later work (Mem0 and others).
export const LOCOMO_CATEGORIES: Record<number, string> = { 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop', 5: 'adversarial' }

export async function loadLocomo(file: string, { adversarial = false } = {}): Promise<Case[]> {
  const data = JSON.parse(await readFile(file, 'utf8')) as Array<{ sample_id: string; conversation: Record<string, unknown>; qa: Array<{ question: string; answer?: unknown; adversarial_answer?: unknown; evidence?: string[]; category: number }> }>
  return data.map(sample => {
    const conversation = sample.conversation, speakers = [String(conversation.speaker_a), String(conversation.speaker_b)]
    const sessions: Session[] = []
    for (let n = 1; conversation[`session_${n}`] !== undefined; n++) {
      const date = String(conversation[`session_${n}_date_time`])
      const turns = (conversation[`session_${n}`] as Array<{ speaker: string; text: string; blip_caption?: string }>).map(turn => ({
        role: turn.speaker === speakers[0] ? 'user' as const : 'assistant' as const, speaker: turn.speaker,
        // Shared photos are known only through their captions, as in the dataset's own baselines.
        text: turn.text + (turn.blip_caption ? ` [shares a photo: ${turn.blip_caption}]` : ''),
      }))
      sessions.push({ id: `${sample.sample_id}-s${n}`, date, iso: isoDate(date), turns })
    }
    const questions = sample.qa.filter(qa => adversarial || qa.category !== 5).map((qa, i) => ({
      id: `${sample.sample_id}-q${i}`, type: LOCOMO_CATEGORIES[qa.category] ?? String(qa.category), question: qa.question,
      answer: String(qa.answer ?? qa.adversarial_answer ?? ''), ...(qa.evidence ? { evidence: qa.evidence } : {}), ...(qa.category === 5 ? { abstention: true } : {}),
    }))
    return { id: sample.sample_id, dataset: 'locomo' as const, speakers, sessions, questions }
  })
}

export async function loadLongMemEval(file: string): Promise<Case[]> {
  const data = JSON.parse(await readFile(file, 'utf8')) as Array<{ question_id: string; question_type: string; question: string; answer: unknown; question_date: string;
    haystack_session_ids: string[]; haystack_dates: string[]; haystack_sessions: Array<Array<{ role: string; content: string }>>; answer_session_ids: string[] }>
  return data.map(item => ({
    id: item.question_id, dataset: 'longmemeval' as const, speakers: ['user', 'assistant'],
    sessions: item.haystack_sessions.map((turns, i) => ({ id: item.haystack_session_ids[i]!, date: item.haystack_dates[i]!, iso: isoDate(item.haystack_dates[i]!),
      turns: turns.map(turn => ({ role: turn.role === 'assistant' ? 'assistant' as const : 'user' as const, speaker: turn.role, text: turn.content })) })),
    questions: [{ id: item.question_id, type: item.question_type, question: item.question, answer: String(item.answer), date: item.question_date,
      evidence: item.answer_session_ids, ...(item.question_id.endsWith('_abs') ? { abstention: true } : {}) }],
  }))
}

/**
 * Held-out benchmarks already converted to this shape (BEAM: one case per conversation, questions after it; HaluMem:
 * one case per session that carries questions, holding the user's sessions up to it, as its own protocol asks).
 */
export async function loadCases(file: string): Promise<Case[]> {
  return JSON.parse(await readFile(file, 'utf8')) as Case[]
}

/** A fixed, type-stratified subset: `perType` cases of every question type, chosen by a hash of the id. */
export function stratified(cases: Case[], perType: number): Case[] {
  const rank = (value: Case) => createHash('sha256').update(value.id).digest('hex')
  const byType = new Map<string, Case[]>()
  for (const value of cases) byType.set(value.questions[0]!.type, [...byType.get(value.questions[0]!.type) ?? [], value])
  return [...byType.values()].flatMap(list => list.slice().sort((a, b) => rank(a).localeCompare(rank(b))).slice(0, perType))
}

/** One session as plain text, each message stamped with the session date. */
export const transcript = (session: Session) => session.turns.map(turn => `${turn.speaker}: ${turn.text}`).join('\n')
