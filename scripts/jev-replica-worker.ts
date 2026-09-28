import { parseArgs } from 'node:util'
import { SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { createAcceptanceRuntime, redact } from './lib/jev-runtime.ts'
import { channelId } from '../plugins/dsh-mnemon-replica/src/index.ts'
import { readFile } from 'node:fs/promises'
import { Checkpoints, LedgerStore, NavigationStore } from '../plugins/dsh-mnemon-strategy-jev-optmem/src/index.ts'
import type { DecisionProvider } from '../plugins/dsh-mnemon-agent-loop-jev/src/index.ts'
import type { Change } from './natural/corpus.ts'
import type { BenchMemory } from './bench/seed.ts'

const { values } = parseArgs({ options: { root: { type: 'string' }, role: { type: 'string' }, live: { type: 'boolean' }, complex: { type: 'boolean' }, wide: { type: 'boolean' }, optmem: { type: 'boolean' }, flat: { type: 'boolean' }, maintained: { type: 'boolean' }, 'no-nap': { type: 'boolean' }, 'bounded-cold': { type: 'boolean' }, 'local-nap': { type: 'boolean' }, background: { type: 'string' }, 'corpus-root': { type: 'string' }, 'no-replica': { type: 'boolean' }, 'no-capture': { type: 'boolean' }, 'full-context': { type: 'boolean' }, wait: { type: 'string' }, study: { type: 'string' }, lexical: { type: 'boolean' },
  natural: { type: 'string' }, delivery: { type: 'string' }, snapshots: { type: 'string' }, 'natural-corpus': { type: 'boolean' }, lag: { type: 'string' }, recall: { type: 'string' }, 'main-memory': { type: 'boolean' }, thinking: { type: 'boolean' }, gate: { type: 'string' }, 'terms-from': { type: 'string' }, bench: { type: 'string' }, fill: { type: 'string' }, intent: { type: 'boolean' }, focus: { type: 'string' }, materialize: { type: 'boolean' }, 'main-model': { type: 'string' }, 'recall-model': { type: 'string' }, searches: { type: 'string' }, 'brief-plan': { type: 'boolean' }, 'dates-first': { type: 'boolean' }, 'embed-url': { type: 'string' }, loop: { type: 'string' }, 'loop-fill': { type: 'string' }, worth: { type: 'string' }, 'unsure-fill': { type: 'string' }, feedback: { type: 'boolean' }, simple: { type: 'boolean' }, auto: { type: 'boolean' }, consolidate: { type: 'string' }, 'large-journal': { type: 'boolean' } } })
if (!values.root || !['main', 'replica'].includes(values.role ?? '')) throw new Error('Pass --root and --role main|replica')
const role = values.role as 'main' | 'replica'
process.env.DSH_HOME = join(values.root, role, 'dsh-home')
process.env.MNEMON_DATA_DIR = join(values.root, role, 'mnemon-home')
const fixture: DecisionProvider = { async decide(request) {
  return { model: 'deterministic-fixture', answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul', noul: 1 }])), usage: { input_tokens: 0, output_tokens: 0 } }
} }
const runtime = await createAcceptanceRuntime({ root: values.root, role, live: values.live === true, ...(values.live ? {} : { decisionProvider: fixture }),
  ...(values.study ? { study: values.study as 'memory' | 'project' | 'research' } : {}), lexical: values.lexical === true,
  complex: values.complex === true, wide: values.wide === true, optmem: values.optmem === true, flat: values.flat === true, maintained: values.maintained === true, skipMaintenance: values['no-nap'] === true, boundedCold: values['bounded-cold'] === true, localNap: values['local-nap'] === true, backgroundMs: Number(values.background ?? 0), ...(values['corpus-root'] ? { corpusRoot: values['corpus-root'] } : {}),
  noReplica: values['no-replica'] === true, capture: values['no-capture'] !== true, fullContext: values['full-context'] === true, waitMs: Number(values.wait ?? '15000'),
  ...(values.natural === 'jev' || values.natural === 'lexical' ? { natural: values.natural } : {}), ...(values.delivery === 'stable' ? { delivery: 'stable' as const } : {}),
  ...(values.snapshots === 'replace' || values.snapshots === 'delta' ? { snapshotDelivery: values.snapshots } : {}), naturalCorpus: values['natural-corpus'] === true, maxRevisionLag: Number(values.lag ?? '0'),
  ...(values.recall === 'llm' || values.recall === 'cue' ? { recall: values.recall } : {}), mainMemory: values['main-memory'] === true, thinking: values.thinking === true,
  ...(values['terms-from'] === 'jev' || values['terms-from'] === 'recall' ? { termsFrom: values['terms-from'] } : {}), ...(values.gate !== undefined ? { gate: Number(values.gate) } : {}),
  ...(values.fill !== undefined ? { fill: Number(values.fill) } : {}), ...(values.intent ? { intent: true } : {}), ...(values.focus !== undefined ? { focus: Number(values.focus) } : {}), ...(values.materialize ? { materialize: true } : {}),
  ...(values.bench === 'locomo' || values.bench === 'longmemeval' || values.bench === 'locomo-merged' || values.bench === 'beam' || values.bench === 'halumem' ? { bench: values.bench } : {}),
  ...(values['main-model'] ? { mainModel: values['main-model'] } : {}), ...(values['recall-model'] ? { recallModel: values['recall-model'] } : {}),
  ...(values.searches ? { searches: Number(values.searches) } : {}), ...(values['brief-plan'] ? { briefPlan: true } : {}),
  ...(values['dates-first'] ? { datesFirst: true } : {}), ...(values['embed-url'] ? { embedUrl: values['embed-url'] } : {}), ...(values.loop ? { loop: Number(values.loop) } : {}), ...(values['loop-fill'] ? { loopFill: Number(values['loop-fill']) } : {}), ...(values.worth ? { worth: Number(values.worth) } : {}), ...(values['unsure-fill'] ? { unsureFill: Number(values['unsure-fill']) } : {}), ...(values.feedback ? { feedback: true } : {}), ...(values.simple ? { simple: true } : {}), ...(values.auto ? { auto: true } : {}), ...(values.consolidate ? { consolidate: values.consolidate } : {}), ...(values['large-journal'] ? { largeJournal: true } : {}) })
let closing: Promise<void> | undefined
const close = () => closing ??= runtime.dispose()
process.on('SIGTERM', () => { void close().finally(() => process.exit(0)) })
process.on('disconnect', () => { void close().finally(() => process.exit(0)) })
process.on('message', (message: { id: string; method: string; args?: Record<string, unknown> }) => {
  void (async () => {
    const args = message.args ?? {}
    if (message.method === 'seed') return runtime.seed()
    if (message.method === 'seedComplex') return runtime.seedComplex(Number(args.perSource), args.layout === 'scattered' ? 'scattered' : 'original')
    if (message.method === 'probe') return runtime.complexProbe()
    if (message.method === 'seedNatural') return runtime.seedNatural(Number(args.perSource), args.layout === 'recent' ? 'recent' : 'scattered', Number(args.confusers ?? 0))
    if (message.method === 'mutateNatural') return runtime.mutateNatural(String(args.content))
    if (message.method === 'addNatural') return runtime.addNatural(args as unknown as Change)
    if (message.method === 'seedBench') return runtime.seedBench(args as unknown as BenchMemory)
    if (message.method === 'ledger') return new LedgerStore(join(values.root!, 'replica', 'natural')).read(runtime.workspacePath)
    if (message.method === 'naturalTraces') {
      try { return (await readFile(join(values.root!, 'replica', 'natural', 'traces', channelId(runtime.workspacePath, String(args.sessionId)) + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    }
    if (message.method === 'mutateComplex') return runtime.mutateComplex(args)
    if (message.method === 'chat') return runtime.chat(String(args.text), String(args.sessionId ?? 'main-chat'))
    if (message.method === 'seedStudy') return runtime.seedStudy(Number(args.seed ?? 1))
    if (message.method === 'studyUpdate') return runtime.studyUpdate(Number(args.index))
    if (message.method === 'studyGrade') return runtime.studyGrade()
    if (message.method === 'prime') {
      const id = String(args.sessionId), channel = channelId(runtime.workspacePath, id)
      if (!await runtime.ctx.mnemonReplica.store.read(channel)) await runtime.ctx.mnemonReplica.store.progress({ workspaceId: runtime.workspacePath, sessionId: id, messages: [{ id: 'prime-only', role: 'assistant', text: 'Background maintenance. No pending user request.' }] })
      else await runtime.ctx.mnemonReplica.requestRefresh(runtime.workspacePath)
      return { requested: true }
    }
    if (message.method === 'navigation') return new NavigationStore(join(values.root!, 'replica', 'optmem')).read(channelId(runtime.workspacePath, String(args.sessionId)))
    if (message.method === 'refresh') { await runtime.ctx.mnemonReplica.requestRefresh(runtime.workspacePath); return { requested: true } }
    if (message.method === 'checkpoint') return new Checkpoints(join(values.root!, 'replica', 'optmem')).read(channelId(runtime.workspacePath, String(args.sessionId)))
    if (message.method === 'state') return { channel: await runtime.ctx.mnemonReplica.store.read(channelId(runtime.workspacePath, String(args.sessionId ?? 'main-chat'))), errors: runtime.errors }
    if (message.method === 'snapshot') return runtime.graph.source(String(args.type ?? 'journal'), { storage: 'custom', workspaceId: runtime.workspacePath }).read('snapshot')
    if (message.method === 'traces' || message.method === 'audit') {
      const id = SessionId('replica-' + channelId(runtime.workspacePath, String(args.sessionId)).slice(0, 32))
      const handle = await runtime.ctx.sessionPersistence.open(id, 'read')
      try {
        const log = await handle.read()
        const notices = log.events.flatMap(event => {
          if (event.type !== 'user/message') return []
          const source = event.data.source
          if (source.kind !== 'plugin' || !('summary' in source) || typeof source.summary !== 'string' || !['JEV decision result', 'JEV tool observation'].includes(source.summary)) return []
          const summary = source.summary
          return event.data.content.flatMap(block => block.type === 'text' ? [{ seq: event.seq, summary, value: JSON.parse(block.text) }] : [])
        })
        if (message.method === 'audit') return notices.filter(notice => notice.seq > Number(args.afterSeq ?? 0)).map(({ seq, summary, value }) => ({ seq, summary, ...value }))
        return notices.filter(notice => notice.summary === 'JEV decision result').map(notice => notice.value)
      } finally { await handle.close() }
    }
    if (message.method === 'identity') return runtime.identity()
    if (message.method === 'close') { await close(); return { closed: true } }
    throw new Error('Unknown experiment command')
  })().then(value => process.send?.({ id: message.id, value }), error => process.send?.({ id: message.id, error: error instanceof Error ? redact(error.message) : 'Worker command failed' }))
})
process.send?.({ ready: true, role, pid: process.pid, dshHome: process.env.DSH_HOME })
