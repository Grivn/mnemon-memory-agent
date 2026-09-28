/**
 * LoCoMo label review, blind to every system's answers. `flag` shows a model each question with its gold answer and
 * the dialogue turns the dataset cites as evidence (with the session date and two turns either side), and asks
 * whether the gold answer is supported, wrong (with a corrected answer), partial, ambiguous, or not answerable from
 * the evidence. It writes refine-flags.jsonl and, for a human (or second) reviewer, refine-review.md with every
 * flagged question plus a random sample of unflagged ones. The reviewer writes refine-decisions.jsonl
 * ({ "id", "action": "keep" | "fix" | "drop", "gold"?, "reason" }); `build` turns it into the refined label set used by
 * judge.ts --refine and stats.ts --refine.
 *   node --env-file=<keys> --experimental-transform-types scripts/bench/refine.ts flag <locomo10.json> <out-dir>
 *   node --experimental-transform-types scripts/bench/refine.ts build <out-dir>
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deepseek } from './notes.ts'

const [mode, first, second] = process.argv.slice(2)
interface Turn { speaker: string; dia_id: string; text: string; blip_caption?: string }
interface QA { question: string; answer?: unknown; evidence?: string[]; category: number }
const CATEGORIES: Record<number, string> = { 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop' }

if (mode === 'flag') {
  const [file, out] = [first!, second!]
  const data = JSON.parse(await readFile(file, 'utf8')) as Array<{ sample_id: string; conversation: Record<string, unknown>; qa: QA[] }>
  const done = new Set((await readFile(join(out, 'refine-flags.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => (JSON.parse(line) as { id: string }).id))
  const items: Array<{ id: string; category: string; question: string; gold: string; evidence: string }> = []
  for (const sample of data) {
    const turns = new Map<string, { turn: Turn; session: number; index: number }>(), sessions = new Map<number, { date: string; turns: Turn[] }>()
    for (let n = 1; sample.conversation[`session_${n}`] !== undefined; n++) {
      const list = sample.conversation[`session_${n}`] as Turn[]
      sessions.set(n, { date: String(sample.conversation[`session_${n}_date_time`]), turns: list })
      list.forEach((turn, index) => turns.set(turn.dia_id, { turn, session: n, index }))
    }
    const line = (turn: Turn) => `${turn.speaker}: ${turn.text}${turn.blip_caption ? ` [shares a photo: ${turn.blip_caption}]` : ''}`
    // Question ids number the non-adversarial questions only, as data.ts does.
    sample.qa.filter(qa => qa.category !== 5).forEach((qa, i) => {
      // The cited turns with two turns either side, grouped by session with its date.
      const blocks = new Map<number, Set<number>>()
      for (const id of qa.evidence ?? []) { const at = turns.get(id.trim()); if (!at) continue; const set = blocks.get(at.session) ?? new Set(); for (let k = at.index - 2; k <= at.index + 2; k++) set.add(k); blocks.set(at.session, set) }
      const evidence = [...blocks].sort((a, b) => a[0] - b[0]).map(([n, set]) => { const session = sessions.get(n)!
        return `[Session ${n}, ${session.date}]\n` + [...set].sort((a, b) => a - b).filter(k => k >= 0 && k < session.turns.length).map(k => line(session.turns[k]!)).join('\n') }).join('\n\n')
      items.push({ id: `${sample.sample_id}-q${i}`, category: CATEGORIES[qa.category] ?? String(qa.category), question: qa.question, gold: String(qa.answer ?? ''), evidence: evidence || '(no evidence turns found)' })
    })
  }
  const pending = items.filter(item => !done.has(item.id))
  let next = 0
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (next < pending.length) {
      const item = pending[next++]!
      const prompt = `You check the gold answers of a question-answering benchmark about long conversations. You see a question, its gold answer, and the conversation turns the benchmark cites as evidence (with the session date; relative times such as "last week" are relative to that date).

Decide whether the gold answer is right, using only the evidence shown:
- "supported": the evidence supports the gold answer (paraphrases, date formats and reasonable date arithmetic are fine);
- "wrong": the evidence clearly supports a different answer; give it as "corrected";
- "partial": the gold answer misses part of what the evidence says the answer is, or adds something the evidence does not say; give the full answer as "corrected";
- "ambiguous": the question has several reasonable answers from the evidence, or needs speculation beyond it;
- "unanswerable": the evidence shown does not contain the answer.

Category: ${item.category}
Question: ${item.question}
Gold answer: ${item.gold}

Evidence:
${item.evidence}

Reply as JSON: {"verdict": "supported|wrong|partial|ambiguous|unanswerable", "corrected": "...", "reason": "one sentence"}.`
      try {
        const { text } = await deepseek([{ role: 'user', content: prompt }], { maxTokens: 400, json: true, timeoutMs: 120_000 })
        const value = JSON.parse(text) as { verdict?: string; corrected?: string; reason?: string }
        await appendFile(join(out, 'refine-flags.jsonl'), JSON.stringify({ ...item, verdict: value.verdict ?? 'unparsed', corrected: value.corrected ?? '', reason: value.reason ?? '' }) + '\n')
      } catch (error) { console.error('flag failed', item.id, String(error).slice(0, 160)) }
    }
  }))
  // Everything flagged, and 60 unflagged questions at random (seeded), go to the reviewer in one blind file.
  const flags = (await readFile(join(out, 'refine-flags.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as typeof items[number] & { verdict: string; corrected: string; reason: string })
  let seed = 20260924
  const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const flagged = flags.filter(flag => flag.verdict !== 'supported'), clean = flags.filter(flag => flag.verdict === 'supported')
  const control = clean.map(flag => [random(), flag] as const).sort((a, b) => a[0] - b[0]).slice(0, 60).map(([, flag]) => flag)
  const review = [...flagged, ...control].map(flag => [random(), flag] as const).sort((a, b) => a[0] - b[0]).map(([, flag]) => flag)
  await writeFile(join(out, 'refine-review.md'), review.map(flag => `### ${flag.id} (${flag.category})\n- question: ${flag.question}\n- gold: ${flag.gold}\n- first pass: ${flag.verdict}${flag.corrected ? ` → ${flag.corrected}` : ''} — ${flag.reason}\n\n\`\`\`\n${flag.evidence}\n\`\`\`\n`).join('\n'))
  console.log(`${flags.length} checked: ${flagged.length} flagged (${[...new Set(flagged.map(flag => flag.verdict))].map(v => `${v} ${flagged.filter(flag => flag.verdict === v).length}`).join(', ')}); review file has ${review.length} questions`)
} else if (mode === 'build') {
  const out = first!
  const decisions = (await readFile(join(out, 'refine-decisions.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { id: string; action: 'keep' | 'fix' | 'drop'; gold?: string; reason: string })
  const bad = decisions.filter(value => value.action === 'fix' && !value.gold)
  if (bad.length) throw new Error('a fix needs a gold answer: ' + bad.map(value => value.id).join(', '))
  const refined = { version: 'locomo-refined-20260924', note: 'Label decisions made from the question, the gold answer and the cited evidence only, without any system answer.',
    fix: Object.fromEntries(decisions.filter(value => value.action === 'fix').map(value => [value.id, { gold: value.gold, reason: value.reason }])),
    drop: Object.fromEntries(decisions.filter(value => value.action === 'drop').map(value => [value.id, { reason: value.reason }])) }
  await writeFile(join(out, 'locomo-refined.json'), JSON.stringify(refined, null, 1))
  console.log(`refined labels: ${Object.keys(refined.fix).length} fixed, ${Object.keys(refined.drop).length} dropped, ${decisions.filter(value => value.action === 'keep').length} reviewed and kept`)
} else throw new Error('usage: refine.ts flag <locomo10.json> <out-dir> | build <out-dir>')
