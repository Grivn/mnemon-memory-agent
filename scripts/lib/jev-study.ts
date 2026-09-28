/** Bounded long-task fixtures and tools. Never installed by a production profile. */
import { mkdir, readFile, writeFile, readdir, lstat, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve, dirname, relative, isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { MnemonRuntimeGraph } from '../../src/host/runtime.ts'
import type { DecisionProvider } from '../../plugins/dsh-mnemon-agent-loop-jev/src/index.ts'
import { sourceTypes } from './jev-complex.ts'

const execute = promisify(execFile)
export type StudyId = 'memory' | 'project' | 'research'
interface RecordSpec { source: string; title: string; content: string; before?: number }
interface Scenario { title: string; brief: string; records: RecordSpec[]; updates: RecordSpec[]; turns: string[]; gold?: Record<string, string | number | boolean> }
const fixture = JSON.parse(await readFile(new URL('../../tests/fixtures/jev-replica/long-tasks.json', import.meta.url), 'utf8')) as { scenarios: Record<StudyId, Scenario> }
export const studyScenario = (id: StudyId) => fixture.scenarios[id]
const scope = (root: string) => ({ storage: 'custom' as const, workspaceId: join(root, 'workspace') })
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const normalize = (text: string) => text.toLowerCase().normalize('NFKC')
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const terms = (text: string) => [...new Set([...segmenter.segment(normalize(text))].filter(p => p.isWordLike && p.segment.length > 1).map(p => p.segment))]

/** Generic lexical ablation: no fixture IDs, expected answers or Source data files. */
export const lexicalProvider: DecisionProvider = { async decide(request) {
  const state = request.state as { phase?: string; conversation?: Array<{ role: string; text: string }>; candidates?: Array<{ id: string; value: unknown }> }
  const latest = state.conversation?.filter(m => m.role === 'user').slice(-2).map(m => m.text).join(' ') ?? ''
  const query = terms(latest), candidates = state.candidates ?? []
  const documents = candidates.map(c => normalize(typeof c.value === 'string' ? c.value : JSON.stringify(c.value)))
  const scored = candidates.map((candidate, index) => {
    const text = documents[index]!
    if (state.phase === 'terms') return { id: candidate.id, score: query.includes(text) ? 1 + text.length / 20 : normalize(latest).includes(text) ? text.length / 40 : 0 }
    const score = query.reduce((n, term) => n + (text.includes(term) ? Math.log(1 + documents.length / (1 + documents.filter(doc => doc.includes(term)).length)) : 0), 0)
    return { id: candidate.id, score: score / Math.sqrt(Math.max(1, text.length / 800)) }
  })
  const maximum = Math.max(...scored.map(c => c.score), .001)
  return { model: 'local-lexical-v1', usage: { input_tokens: 0, output_tokens: 0 }, answers: Object.fromEntries(scored.map(c => [c.id, { type: 'noul' as const, noul: c.score > 0 ? .46 + .5 * c.score / maximum : .05 }])) }
} }

export const researchSources = [
  { id: 'yjs-intro', title: 'Yjs Introduction', url: 'https://docs.yjs.dev/', text: 'Yjs 是用于协作应用的 CRDT，提供 Map、Array 等共享类型和编辑器绑定。它与具体网络传输无关，只要更新最终到达就能同步，更新顺序不影响这一点。可接入现有通信设施或独立网络 provider。该页面并未为本项目证明包体、72小时离线恢复或端到端加密已经达标。' },
  { id: 'yjs-indexeddb', title: 'y-indexeddb', url: 'https://docs.yjs.dev/ecosystem/database-provider/y-indexeddb', text: 'y-indexeddb 使用浏览器 IndexedDB 持久化 Yjs 共享数据，重新进入会话时加载本地变更，支持离线编辑。它是数据库 provider；网络传输需另行配置。set/get 存储的自定义元信息不与其他peer同步。持久化不替代应用资源离线加载方案。' },
  { id: 'yjs-undo', title: 'Y.UndoManager', url: 'https://docs.yjs.dev/api/undo-manager', text: 'Yjs 提供选择性的 Undo/Redo，可限制到共享类型以及 transaction origin。trackedOrigins 可控制追踪哪些来源，默认追踪没有origin的本地变更。captureTimeout影响连续编辑的分组，stopCapturing可切分分组。需要应用正确配置撤销范围，不能据此承诺任意产品撤销行为都已满足。' },
  { id: 'yjs-websocket', title: 'y-websocket', url: 'https://docs.yjs.dev/ecosystem/connection-provider/y-websocket', text: 'y-websocket 提供客户端/服务端 WebSocket 同步，服务端分发文档和awareness更新。可结合现有cookie/header认证，并配置持久化或扩展设施。它是可部署的网络组件，并不意味着完整权限策略或E2EE已自动实现。' },
  { id: 'automerge-intro', title: 'Welcome to Automerge', url: 'https://automerge.org/docs/hello/', text: 'Automerge 是协作数据结构库，设备可离线修改本地状态，连接后同步并合并；保留变更以支持历史、分支和合并。核心与网络无关，网络绑定由单独库承担，automerge-repo提供常用组件。JavaScript支持浏览器、Node和Electron，另有Rust/Wasm与类型定义。具体部署、存储、业务冲突显示仍需应用设计。' },
  { id: 'automerge-conflicts', title: 'Automerge Conflicts', url: 'https://automerge.org/docs/reference/documents/conflicts/', text: '不同对象或属性的并发修改通常可以合并。同一属性并发赋值时会确定性显示一个值，其余值仍可通过Automerge.getConflicts读取。默认胜出顺序基于操作ID的计数器及actorId，不是墙钟时间。应用可显示冲突并让用户作语义选择；一致状态不等于所有业务意图都无歧义。' },
  { id: 'sqlite-session', title: 'SQLite Session Extension', url: 'https://www.sqlite.org/sessionintro.html', text: 'SQLite Session Extension记录表变更为changeset/patchset，应用到相同schema且起始数据兼容的数据库。changeset可反转。需要声明PRIMARY KEY，不捕获virtual table变化，带NULL主键的行被忽略。应用changeset可发生数据或约束冲突，要通过配置处理省略、终止或应用；patchset冲突检测更有限。它没有在此文档中提供完整富文本CRDT、网络同步、权限或编辑器绑定。' },
] as const

async function addRecord(graph: MnemonRuntimeGraph, root: string, record: RecordSpec, serial: number) {
  const { source, title, content } = record, target = graph.source(source, scope(root))
  if (source === 'files') {
    const path = join(root, 'workspace', 'reference-data', `${String(serial).padStart(5, '0')}-${sha(title).slice(0, 8)}.md`)
    await writeFile(path, `# ${title}\n\n${content}\n`); return { source, path, title }
  }
  if (source === 'sessions') {
    const path = join(root, 'imported-history', String(serial).padStart(5, '0') + '.jsonl')
    await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { cwd: scope(root).workspaceId } }) + '\n' + JSON.stringify({ type: 'message', role: 'user', content: title + '\n' + content, timestamp: new Date(Date.UTC(2026, 8, 1) + serial * 1000).toISOString() }) + '\n')
    return { source, path, title }
  }
  if (source === 'documents') return target.mutate('mutate', { action: 'create', title, content })
  if (source === 'canvas') return target.mutate('add-note', { title, content, scope: 'project' })
  const kind = source === 'journal' ? 'progress' : source === 'tasks' ? 'project' : source === 'project-context' ? 'decision' : source === 'playbooks' ? 'prompt' : 'notification'
  return target.mutate('create', { title, content, kind, scope: source === 'notifications' ? 'global' : 'project', data: source === 'tasks' ? { status: 'pending' } : {} })
}
export async function seedStudy(graph: MnemonRuntimeGraph, root: string, id: StudyId, seed: number) {
  const scenario = studyScenario(id), workspace = join(root, 'workspace')
  await mkdir(join(workspace, 'reference-data'), { recursive: true }); await mkdir(join(workspace, 'outputs'), { recursive: true })
  await mkdir(join(workspace, 'sources'), { recursive: true }); await mkdir(join(root, 'imported-history'), { recursive: true })
  await execute('git', ['init', '-q', '-b', 'benchmark-main', workspace])
  await writeFile(join(workspace, 'brief.md'), scenario.brief)
  const manifest = [], topics = ['旧照片整理', '阳台植物', '旧活动器材', '过往读书笔记', '公交观察', '音乐练习', '旅行账本', '厨房收纳']
  let serial = 0
  for (const source of sourceTypes) {
    const rows: RecordSpec[] = Array.from({ length: 49 }, (_, i) => ({ source, title: `${topics[i % topics.length]} ${i + 1}`, content: `去年${topics[i % topics.length]}的独立记录：第${i + 1}次，编号${seed * 1000 + i * 17}。已经结束，与当前项目无关。` }))
    rows.push(...scenario.records.filter(record => record.source === source))
    rows.sort((a, b) => sha(seed + a.title).localeCompare(sha(seed + b.title)))
    for (const record of rows) { await addRecord(graph, root, record, serial++); manifest.push(record) }
  }
  if (id === 'research') for (const [i, source] of researchSources.entries()) {
    await writeFile(join(workspace, 'sources', source.id + '.md'), `# ${source.title}\n\nURL: ${source.url}\n核验日期: 2026-09-23\n说明：官方页面的人工摘要快照，不是全文或实时网页。\n\n${source.text}\n`)
    const record = { source: i % 2 ? 'documents' : 'files', title: '栖木笔记资料 ' + source.title, content: source.url + '\n' + source.text }
    await addRecord(graph, root, record, serial++); manifest.push(record)
  }
  return { records: manifest.length, seed, fixtureSha256: sha(JSON.stringify(scenario)), corpusSha256: sha(JSON.stringify(manifest)), sourceTypes, researchSources: id === 'research' ? researchSources : [] }
}
export async function applyStudyUpdates(graph: MnemonRuntimeGraph, root: string, id: StudyId, index: number) {
  const updates = studyScenario(id).updates.filter(record => record.before === index)
  for (const record of updates) await addRecord(graph, root, record, 10000 + index)
  return updates
}

export async function safeStudyPath(workspace: string, value: string, write = false) {
  if (!value || isAbsolute(value)) throw new Error('Use a relative task file path')
  const path = resolve(workspace, value), rel = relative(workspace, path)
  if (rel.startsWith('..') || isAbsolute(rel) || !(rel === 'brief.md' || rel.startsWith('outputs/') || rel.startsWith('sources/'))) throw new Error('Path is outside task file scope')
  if (write && !rel.startsWith('outputs/')) throw new Error('Only outputs/ is writable')
  let parent = path
  while (parent !== workspace) {
    const stat = await lstat(parent).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (stat?.isSymbolicLink()) throw new Error('Symlinks are not allowed in task paths')
    parent = dirname(parent)
  }
  return path
}
export async function mountStudyTools(ctx: Context, graph: MnemonRuntimeGraph, workspace: string, id: StudyId) {
  const audit: Array<{ name: string; args: unknown; result?: unknown; error?: string; at: number }> = []
  const names: string[] = []
  const register = (name: string, description: string, properties: Record<string, unknown>, required: string[], action: (args: any) => Promise<unknown>) => {
    names.push(name)
    ctx.tools.register({ name, description, parameters: { type: 'object', properties, required, additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args) { const row = { name, args, at: Date.now() } as typeof audit[number]; audit.push(row)
        try { row.result = await action(args); return row.result } catch (error) { row.error = String(error); throw error } },
    })
  }
  register('task_files', 'Read brief.md or sources/, and list/read/write deliverables under outputs/. Write may include multiple files. Existing files are replaced with complete provided content.',
    { action: { type: 'string', enum: ['list', 'read', 'write'] }, path: { type: 'string' }, files: { type: 'array', maxItems: 8, items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', maxLength: 60000 } }, required: ['path', 'content'], additionalProperties: false } } }, ['action'], async args => {
      if (args.action === 'list') return { outputs: await readdir(join(workspace, 'outputs')), sources: await readdir(join(workspace, 'sources')) }
      if (args.action === 'read') return { path: args.path, content: (await readFile(await safeStudyPath(workspace, args.path), 'utf8')).slice(0, 40000) }
      if (!Array.isArray(args.files) || !args.files.length || args.files.length > 8) throw new Error('Provide 1..8 files')
      const paths = await Promise.all(args.files.map(async (file: { path: string; content: string }) => {
        if (typeof file.content !== 'string' || file.content.length > 60000) throw new Error('File content exceeds bound')
        return { ...file, absolute: await safeStudyPath(workspace, file.path, true) }
      }))
      for (const file of paths) { await mkdir(dirname(file.absolute), { recursive: true }); await writeFile(file.absolute, file.content) }
      return { written: paths.map(file => ({ path: file.path, characters: file.content.length, sha256: sha(file.content) })) }
    })
  register('task_memory', 'Search/read existing memory through Source public Routes. Query is literal text: use one entity phrase, not many space-separated keywords. Empty query lists a bounded window. Documents and record Sources already return body text in items[].text; their document relativePath is not a Files path. Canvas list returns cards; pass id to read a card body. Files search returns paths/snippets; pass path to read full text (including reference-data/). Sessions accepts sessionId to read neighboring conversation. Never guess missing contents from a title.',
    { source: { type: 'string', enum: sourceTypes }, query: { type: 'string', maxLength: 200 }, id: { type: 'string' }, path: { type: 'string' }, sessionId: { type: 'string' } }, ['source'], async args => {
      let operation = args.source === 'files' ? 'find' : args.source === 'sessions' ? 'history' : args.source === 'canvas' ? 'list' : 'search'
      let input: Record<string, unknown> = { query: args.query ?? '', limit: 10, ...(args.source === 'tasks' ? { all: true } : args.source === 'files' ? { mode: 'content', types: 'documents' } : args.source === 'sessions' ? { origin: 'imported', sort: 'relevance' } : {}) }
      if (args.source === 'canvas' && args.id) { operation = 'read-node'; input = { id: args.id } }
      if (args.source === 'files' && args.path) { operation = 'read-file'; input = { path: args.path, lines: 200 } }
      if (args.source === 'sessions' && args.sessionId) { operation = 'conversation'; input = { sessionId: args.sessionId, radius: 3 } }
      if (args.id && !['canvas','files','sessions','documents'].includes(args.source)) input = { id: args.id, limit: 1, ...(args.source === 'tasks' ? { all: true } : {}) }
      if (args.source === 'documents' && args.id && !args.query) throw new Error('Documents search already returns body text. Use query with its title; document IDs are not file paths.')
      const requestScope = { storage: 'custom' as const, workspaceId: workspace }, turnId = 'study-query-' + audit.length
      const turn = await graph.composableTurns.beginTurn(turnId, requestScope)
      try {
        const value = await graph.source(args.source, requestScope).forTurn(turn).route(operation, input)
        return { source: args.source, operation, evidence: value }
      } finally { graph.composableTurns.endTurn(turnId) }
    })
  register('task_note', 'Save an important current project decision or progress in the existing Journal plugin. Do not fabricate facts; mark superseded choices clearly.',
    { title: { type: 'string', maxLength: 200 }, content: { type: 'string', maxLength: 3000 } }, ['title', 'content'], async args => {
      const value = await graph.source('journal', { storage: 'custom', workspaceId: workspace }).mutate('create', { ...args, kind: 'progress', scope: 'project' })
      return { completion: 'committed', receipt: value }
    })
  register('task_research', 'Search or read the seven frozen official-document summaries. This is a dated primary-source packet, not live Internet search.',
    { query: { type: 'string' }, id: { type: 'string' } }, [], async args => {
      if (id !== 'research') return { sources: [], note: 'This task has no research packet' }
      if (args.id) { const source = researchSources.find(s => s.id === args.id); if (!source) throw new Error('Unknown source ID'); return source }
      const q = terms(args.query ?? '')
      return { sources: [...researchSources].map(s => ({ id: s.id, title: s.title, url: s.url, excerpt: s.text.slice(0, 80), score: q.filter(t => normalize(s.title + s.text).includes(t)).length })).sort((a, b) => b.score - a.score) }
    })
  register('task_verify', 'Run public basic checks against files already written. This checks syntax/schema and basic functions, not all final acceptance criteria.', {}, [], async () => publicVerify(workspace, id))
  return { names, audit }
}

async function projectCheck(workspace: string, full: boolean) {
  const result = await execute(process.execPath, ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../grade-study-project.mjs', import.meta.url)), workspace, ...(full ? ['--full'] : [])],
    { timeout: 10000, maxBuffer: 100000, env: { PATH: process.env.PATH ?? '', LANG: 'en_US.UTF-8', TZ: 'UTC' } })
  return JSON.parse(result.stdout)
}
async function publicVerify(workspace: string, id: StudyId) {
  if (id === 'project') return projectCheck(workspace, false)
  const file = id === 'memory' ? 'plan.json' : 'decision.json', value = JSON.parse(await readFile(join(workspace, 'outputs', file), 'utf8'))
  const required = id === 'memory' ? ['eventName','date','time','venue','room','attendees','budgetYuan','menu','allergy','transport','deadline','owner','backupPlan','privacy','deliveries']
    : ['recommended','teamSize','deadlineWeeks','offlineHours','bundleBudgetKB','serverLocation','requiresE2EE','richText','options','claims','openQuestions','stages']
  const missing = required.filter(key => value[key] === undefined)
  return { syntax: 'valid JSON', missing, passed: !missing.length, note: 'Schema only; content correctness is independently reviewed.' }
}
export async function gradeStudy(workspace: string, id: StudyId) {
  if (id === 'project') return projectCheck(workspace, true)
  const checks: Array<{ id: string; passed: boolean; actual?: unknown }> = []
  const add = (key: string, passed: unknown, actual?: unknown) => checks.push({ id: key, passed: !!passed, actual })
  let value: Record<string, any> = {}
  try { value = JSON.parse(await readFile(join(workspace, 'outputs', id === 'memory' ? 'plan.json' : 'decision.json'), 'utf8')); add('json-valid', true) } catch (error) { add('json-valid', false, String(error)) }
  for (const [key, expected] of Object.entries(studyScenario(id).gold ?? {})) add('constraint-' + key, typeof expected === 'string' ? JSON.stringify(value[key] ?? '').includes(expected) : value[key] === expected, value[key])
  const report = await readFile(join(workspace, 'outputs', id === 'memory' ? 'plan.md' : 'decision.md'), 'utf8').catch(() => '')
  add('readable-report', report.length >= 300, report.length)
  if (id === 'memory') {
    add('delivery-completed', /已|完成|签收/.test(JSON.stringify(value.deliveries ?? '')))
    add('phone-not-public', /不|仅|禁止|去除|排除/.test(JSON.stringify(value.privacy ?? '')))
  } else {
    const expected: Record<string, [boolean, string]> = { yjsNetworkAgnostic: [true, 'yjs-intro'], indexedDBPersistsBrowser: [true, 'yjs-indexeddb'], sqliteNeedsPrimaryKey: [true, 'sqlite-session'], sqliteCapturesVirtualTables: [false, 'sqlite-session'], sqliteConflictsNeedHandling: [true, 'sqlite-session'], automergeExposesConflicts: [true, 'automerge-conflicts'], yjsSelectiveUndo: [true, 'yjs-undo'] }
    for (const [key, [truth, source]] of Object.entries(expected)) {
      const claim = Array.isArray(value.claims) && value.claims.find((claim: any) => claim.key === key)
      add('grounded-' + key, claim && claim.value === truth && claim.sourceUrl?.replace(/\/$/, '') === researchSources.find(s => s.id === source)!.url.replace(/\/$/, ''), claim)
    }
    add('three-options', Array.isArray(value.options) && ['yjs','automerge','sqlite'].every(name => value.options.some((o: any) => normalize(String(o.name)).includes(name))))
    const urls = report.match(/https?:\/\/[^\s)\]<>"，。]+/g) ?? []
    add('report-cites-primary-sources', new Set(urls.filter(url => researchSources.some(s => s.url.replace(/\/$/, '') === url.replace(/\/$/, '')))).size >= 4)
    add('no-unlisted-citations', urls.every(url => researchSources.some(s => s.url.replace(/\/$/, '') === url.replace(/\/$/, ''))), urls)
    const migration = await readFile(join(workspace, 'outputs', 'migration-plan.md'), 'utf8').catch(() => '')
    add('migration-and-rollback', /迁移|导入/.test(migration) && /回退|回滚/.test(migration) && /备份/.test(migration))
    add('verification-plan', /离线/.test(migration) && /并发/.test(migration) && /乱序/.test(migration) && /180|gzip|包体/i.test(migration))
    add('unknowns-explicit', JSON.stringify(value.openQuestions ?? '').length > 20 && /待测|测量|验证|未知/.test(report))
  }
  return { checks, passed: checks.every(c => c.passed), hits: checks.filter(c => c.passed).length, total: checks.length }
}

export function measureStudyTurn(events: readonly SessionEvent[], turn: number, input: string) {
  const start = events.find(e => e.type === 'turn/start' && e.data.turn === turn)!, end = events.find(e => e.type === 'turn/end' && e.data.turn === turn)!
  if (!start || !end) throw new Error('Missing durable turn boundaries')
  const current = events.filter(e => e.seq >= start.seq && e.seq <= end.seq)
  const user = current.find(e => e.type === 'user/message' && e.data.source.kind === 'user' && e.data.content.some(b => b.type === 'text' && b.text === input))
  const inbox = events.findLast(e => e.seq <= start.seq && e.type === 'agent/inbox/spliced' && e.data.inserted?.some(m => m.id === (user?.type === 'user/message' ? user.data.id : undefined)))
  const answers = current.filter(e => e.type === 'assistant/message'), headers = current.filter(e => e.type === 'request/header')
  const visible = answers.flatMap(e => expandAssistantStream(e.data.stream).filter(r => r.chunk.type === 'text-delta' && r.chunk.text.trim()))
  const last = answers.at(-1), lastVisible = last ? expandAssistantStream(last.data.stream).filter(r => r.chunk.type === 'text-delta' && r.chunk.text.trim()) : []
  const queued = inbox?.time ?? start.time
  return { queued, turnStart: start.time, completedAt: end.time, firstTextMs: visible.length ? visible[0]!.time - queued : null,
    finalAnswerFirstTextMs: lastVisible.length ? lastVisible[0]!.time - queued : null, completedMs: end.time - queued,
    requestSeries: headers.length, assistantMessages: answers.length, requestSeriesTimes: headers.map(e => e.time),
    tokenUsages: answers.map(e => e.data.usage), reason: end.type === 'turn/end' ? end.data.reason : null }
}
