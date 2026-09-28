import { MemoryReadCoverage, memoryReadCursor, memoryReadOffset } from './reads.ts'
import { LexicalIndex, lexicalTokens } from './lexical.ts'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { COMPOSABLE_MEMORY_API_VERSION, type MemoryJsonValue, type MemoryOperationScope, type MemorySourceActionManifest, type MemorySourceDefinition, type MemorySourceManagementRequest, type MemorySourceRuntimeContext } from '../../core/contracts/index.ts'
import { createMemoryMutationReceipt, defineMemorySource, memoryInputInteger, memoryInputRecord, memoryInputText, truncateMemoryText } from '../index.ts'
import { digest, json, RecordStore, recordScope, reviseRecord, validateRecord, visibleRecord, type RecordCapacity, type RecordScope, type RecordSnapshot, type RecordValue } from './records.ts'
import { recordTransferTracks, exportRecordTrack, importRecordTrack } from './transfer.ts'
import { embedder, fuseRankings, VectorIndex, type Embed, type RecordEmbeddingConfig } from './vectors.ts'

/**
 * `embedding` (an Ollama-compatible endpoint) or `embed` lets the search route also rank records by meaning
 * (`match: 'hybrid'`); without either, the route offers only phrase and word matching.
 */
/**
 * `searchCalls`: calls of the search Route one View may make (default 16), for readers that page far through one Source.
 * `capacity`: records and bytes one collection may hold (10,000 and 32 MiB unless set). `searchCache`: keep each pinned
 * snapshot's word index and record digests between searches, and read the snapshot without copying it, so a collection
 * of tens of thousands of records is not indexed again for every search; results are the same (off unless set).
 */
export interface RecordSourceConfig { dataDir?: string; embedding?: RecordEmbeddingConfig; embed?: Embed; searchCalls?: number; capacity?: RecordCapacity; searchCache?: boolean }
export function sourceRecordDirectory(typeId: string, context: MemorySourceRuntimeContext, config: RecordSourceConfig = {}): string {
  if (!/^[a-z][a-z0-9-]*$/.test(typeId)) throw new Error('Invalid Source type')
  const root = config.dataDir ?? (typeof context.configuration?.dataDir === 'string' ? context.configuration.dataDir : undefined) ?? process.env.MNEMON_DATA_DIR ?? join(homedir(), '.mnemon')
  return join(root, 'sources', typeId, digest(context.sourceInstanceKey).slice(0, 20))
}
export interface RecordSourceOptions {
  typeId: string
  packageName?: string
  context?: import('../../core/contracts/index.ts').MemoryContextProfile
  role: string
  label: string
  description: string
  kinds: readonly string[]
  scopes: readonly RecordScope[]
  defaultScope: RecordScope
  /** Opt into portable human export/import. Session state is never transferred. */
  transfer?: boolean
  /** New versions stay pending; approval archives the exact reviewed original. */
  reviewedRevisions?: boolean
  scopeForKind?: Readonly<Record<string, RecordScope>>
  modelWrites?: 'proposal' | 'append'
  /** Memory-only operations handled by mutate. Existing records must belong to the pinned View. */
  modelActions?: readonly MemorySourceActionManifest[]
  validate(record: RecordValue): void
  prepare?(record: RecordValue, scope: MemoryOperationScope): Promise<void> | void
  /** Prepares the records of one `batch-create` together, e.g. one outside lookup for all; otherwise `prepare` runs per record. */
  prepareMany?(records: RecordValue[], scope: MemoryOperationScope): Promise<void> | void
  visible?(record: RecordValue, scope: MemoryOperationScope): Promise<boolean> | boolean
  project?(records: RecordValue[], scope: MemoryOperationScope): string
  search?(records: RecordValue[], input: { [key: string]: MemoryJsonValue }, scope: MemoryOperationScope): RecordValue[]
  read?(operation: string, input: { [key: string]: MemoryJsonValue }, context: { snapshot: RecordSnapshot; scope: MemoryOperationScope; signal?: AbortSignal }): Promise<MemoryJsonValue> | MemoryJsonValue
  mutate?(operation: string, input: { [key: string]: MemoryJsonValue }, context: { records: RecordValue[]; scope: MemoryOperationScope; signal?: AbortSignal }): Promise<void> | void
}

const writeSchema = (options: RecordSourceOptions): MemoryJsonValue => ({ type: 'object', additionalProperties: false, required: ['title'], properties: {
  title: { type: 'string', maxLength: 300 }, content: { type: 'string', maxLength: 100000 }, kind: { type: 'string', enum: [...options.kinds], default: options.kinds[0]! },
  scope: { type: 'string', enum: [...options.scopes], default: options.defaultScope }, date: { type: 'string' }, data: { type: 'object' },
  supersedes: { type: 'object', additionalProperties: false, required: ['id', 'version'], properties: { id: { type: 'string' }, version: { type: 'integer', minimum: 1 } } },
} })
const readSchema = (options: RecordSourceOptions, hybrid = false): MemoryJsonValue => ({ type: 'object', additionalProperties: false, properties: {
  id: { type: 'string' }, ids: { type: 'array', items: { type: 'string' }, maxItems: 64 }, query: { type: 'string' }, match: { type: 'string', enum: hybrid ? ['phrase', 'words', 'hybrid'] : ['phrase', 'words'] }, expand: { type: 'boolean' }, kind: { type: 'string', enum: [...options.kinds] }, since: { type: 'string' }, until: { type: 'string' },
  date: { type: 'string' }, status: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 },
  cursor: { type: 'string', maxLength: 500 }, startCharacter: { type: 'integer', minimum: 0 },
  all: { type: 'boolean' }, recent: { type: 'boolean' }, archived: { type: 'boolean' },
} })

/** Adapts one Source's own schema to Core contracts; all domain policy stays with its author. */
export function createRecordSource(options: RecordSourceOptions, config: RecordSourceConfig = {}): MemorySourceDefinition {
  const packageName = options.packageName ?? 'dsh-mnemon-source-' + options.typeId
  const modelAction = options.modelWrites === 'append' ? 'append' : 'propose'
  const embed = config.embed ?? (config.embedding ? embedder(config.embedding) : undefined)
  return defineMemorySource({
    manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: options.typeId, packageName, role: options.role,
      capabilities: ['status', 'project', 'recall', 'write', 'export', 'import'], consistency: 'exact-snapshot',
      context: options.context ?? { mode: 'routed', weight: 1 },
      management: { label: options.label, description: options.description, operations: {
        reads: [{ id: 'snapshot', description: 'Browse records, versions and review states.', access: { kinds: ['browse', 'read'], result: 'records' } }],
        actions: [
          { id: 'approve', description: 'Adopt a pending proposal after reviewing its current version.', requiresApproval: true, operation: { effects: ['publish'], execution: 'immediate' } },
          { id: 'update', description: 'Edit a record with a current revision check.', requiresApproval: true, operation: { effects: ['update'], execution: 'immediate' } },
          { id: 'archive', description: 'Retain a record in history and remove it from active context.', requiresApproval: true, operation: { effects: ['remove'], execution: 'immediate' } },
          ...(options.transfer ? [{ id: 'transfer-import', description: 'Apply a reviewed snapshot to its matching scope.', requiresApproval: true, operation: { effects: ['transfer'], execution: 'immediate' } } satisfies import('../../core/contracts/index.ts').MemorySourceOperationInventory['actions'][number]] : []),
        ],
      } },
      // Sixteen calls per View: a recall that runs one search per cue (up to seven), a second round and the re-reads of
      // what is shown needs more than eight; each call is a local read of at most 20 records.
      routes: [{ id: 'search', access: { kinds: ['search', 'read'], result: 'records' }, description: `Search and read ${options.label}.`, capability: 'recall', inputSchema: readSchema(options, embed !== undefined), maxCalls: config.searchCalls ?? 16, maxResults: 20, maxCharacters: 12_000 }],
      actions: [{ id: modelAction, operation: { effects: [modelAction === 'append' ? 'append' : 'propose'], execution: 'immediate' }, description: modelAction === 'append' ? `Append a new ${options.label} record; existing records are preserved.` : `Propose a ${options.label} record for human approval; it stays inactive until approved.${options.reviewedRevisions ? ' To refine an existing record, read its full content first, then supply supersedes with its exact id and version. The original remains active until the revision is approved.' : ''}`, capability: 'write', inputSchema: writeSchema(options) }, ...options.modelActions ?? []],
    },
    create(context) {
      const store = new RecordStore(sourceRecordDirectory(options.typeId, context, config), config.capacity)
      const prepared = new WeakMap<object, RecordSnapshot>()
      const inspections = new Map<string, Map<string, number>>()
      const coverage = new MemoryReadCoverage()
      const vectors = embed ? new VectorIndex(embed, config.searchCache === true) : undefined
      // With `searchCache`, word indexes by snapshot and filters, dropped oldest first past 150,000 indexed records.
      const indexes = new Map<string, LexicalIndex>()
      const shared = config.searchCache === true && !options.search
      // Bounded opaque snapshots keep large collections out of Core's JSON grants.
      // Eviction fails closed; it never substitutes a newer collection for an old View.
      const snapshots = new Map<string, RecordValue[]>()
      let snapshotBytes = 0
      const pin = (records: RecordValue[]): string => {
        const key = digest(records)
        if (!snapshots.has(key)) {
          snapshots.set(key, records); snapshotBytes += Buffer.byteLength(JSON.stringify(records))
          while (snapshots.size > 16 || snapshotBytes > 64 * 1024 * 1024 && snapshots.size > 1) {
            const oldest = snapshots.keys().next().value!
            snapshotBytes -= Buffer.byteLength(JSON.stringify(snapshots.get(oldest)))
            snapshots.delete(oldest)
          }
        }
        return key
      }
      const pinned = (grant: MemoryJsonValue, copy = true): RecordValue[] => {
        const key = memoryInputText(memoryInputRecord(grant, 'record grant').snapshot, 'snapshot', 64)!
        const records = snapshots.get(key)
        if (!records) throw new Error('The pinned record snapshot expired; compose a new View')
        return copy ? structuredClone(records) : records
      }
      const active = async (snapshot: RecordSnapshot, scope: MemoryOperationScope, archives = false): Promise<RecordValue[]> => {
        const records = snapshot.records.filter(record => visibleRecord(record, scope) && (record.state === 'active' || archives && record.state === 'archived'))
        const included = await Promise.all(records.map(record => options.visible?.(record, scope) ?? true))
        return records.filter((_record, index) => included[index])
      }
      function create(input: { [key: string]: MemoryJsonValue }, scope: MemoryOperationScope, state: RecordValue['state']): RecordValue {
        const kind = memoryInputText(input.kind, 'kind', 64, false) ?? options.kinds[0]!
        const selectedScope = (options.scopeForKind?.[kind] ?? memoryInputText(input.scope, 'scope', 20, false) ?? options.defaultScope) as RecordScope
        if (!options.kinds.includes(kind)) throw new Error(`Unsupported record kind. Choose one of: ${options.kinds.join(', ')}`)
        if (!options.scopes.includes(selectedScope)) throw new Error(`Unsupported record scope. Choose one of: ${options.scopes.join(', ')}`)
        const data = input.data === undefined ? {} : memoryInputRecord(input.data, 'record data')
        if (Object.keys(data).some(key => ['mnemonTransfer', 'mnemonSupersedes', 'mnemonSupersededBy'].includes(key))) throw new Error('Transfer and revision identities are reserved for reviewed handoffs')
        const now = new Date().toISOString()
        return { id: randomUUID(), kind, title: memoryInputText(input.title, 'title', 300)!, content: memoryInputText(input.content, 'content', 100_000, false) ?? '',
          ...recordScope(selectedScope, scope, memoryInputText(input.date, 'date', 10, false)), state, data: structuredClone(data),
          signals: 1, createdAt: now, updatedAt: now, version: 1, history: [] }
      }
      async function change(operation: string, input: { [key: string]: MemoryJsonValue }, scope: MemoryOperationScope, revision?: string, signal?: AbortSignal, modelRecords?: RecordValue[], readRecords?: Map<string, number>): Promise<RecordSnapshot> {
        return store.change(revision, async records => {
          const attachRevision = (item: RecordValue) => {
            if (input.supersedes === undefined) return
            if (!options.reviewedRevisions || !['propose', 'receive-proposal'].includes(operation)) throw new Error('This Source does not accept reviewed revisions here')
            const reference = memoryInputRecord(input.supersedes, 'revision reference')
            const original = records.find(record => record.id === reference.id && record.state === 'active' && visibleRecord(record, scope))
            if (!original || original.version !== reference.version || original.scope !== item.scope || original.kind !== item.kind) throw new Error('The original record changed or is outside the proposal scope')
            if (modelRecords && (!modelRecords.some(record => record.id === original.id && record.version === original.version) || readRecords?.get(original.id) !== original.version)) throw new Error('Read the full original in this View before proposing a revision')
            item.data.mnemonSupersedes = { id: original.id, version: original.version }
          }
          const approveRevision = (record: RecordValue, version: MemoryJsonValue | undefined) => {
            if (!record.data.mnemonSupersedes) return
            const reference = memoryInputRecord(record.data.mnemonSupersedes, 'revision reference')
            const original = records.find(item => item.id === reference.id && item.state === 'active' && visibleRecord(item, scope) && item.scope === record.scope && item.kind === record.kind)
            if (!original || original.version !== reference.version || version !== original.version) throw new Error('Review the current original before adopting its revision')
            reviseRecord(original, 'superseded'); original.state = 'archived'; original.data.mnemonSupersededBy = record.id
          }
          if (['batch-approve', 'batch-reject', 'batch-archive'].includes(operation)) {
            const ids = input.recordIds, versions = memoryInputRecord(input.versions ?? {}, 'record versions'), replacements = memoryInputRecord(input.supersededVersions ?? {}, 'replacement versions')
            if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('Select between one and fifty unique records')
            const action = operation.slice(6)
            for (const id of ids as string[]) {
              const record = records.find(record => record.id === id && visibleRecord(record, scope))
              if (!record || versions[id] !== record.version) throw new Error('A selected record changed; refresh before reviewing')
              if (action === 'archive' ? !['active', 'pending'].includes(record.state) : record.state !== 'pending') throw new Error('A selected record is not eligible for this review action')
              if (action === 'approve') approveRevision(record, replacements[id])
              reviseRecord(record, action); record.state = action === 'approve' ? 'active' : action === 'reject' ? 'rejected' : 'archived'
              options.validate(record)
            }
            return
          }
          if (modelRecords && operation !== modelAction) {
            const before = modelRecords.find(record => record.id === input.id && record.state === 'active')
            const current = records.find(record => record.id === input.id && visibleRecord(record, scope))
            if (!before || !current || current.version !== before.version) throw new Error('Record is not active in this View or has changed; read it in a new View')
          }
          if (operation === 'receive-proposal') {
            const transferKey = memoryInputText(input.transferKey, 'transfer key', 500)!
            const item = create(input, scope, 'pending')
            await options.prepare?.(item, scope)
            options.validate(item)
            const previous = records.find(record => record.data.mnemonTransfer === transferKey)
            if (previous) {
              if (!visibleRecord(previous, scope) || previous.scope !== item.scope || previous.kind !== item.kind || previous.title !== item.title || previous.content !== item.content) throw new Error('The transfer already exists with different content or scope; inspect its destination')
              return
            }
            attachRevision(item)
            item.data.mnemonTransfer = transferKey
            records.push(item)
            return
          }
          if (['create', 'propose', 'append'].includes(operation)) {
            if (input.data && typeof input.data === 'object' && !Array.isArray(input.data) && Object.hasOwn(input.data, 'mnemonTransfer')) throw new Error('Transfer identity is reserved for confirmed handoffs')
            const item = create(input, scope, operation === 'propose' ? 'pending' : 'active')
            await options.prepare?.(item, scope)
            options.validate(item)
            attachRevision(item)
            const duplicate = records.find(record => record.state === item.state && visibleRecord(record, scope) && record.scope === item.scope && record.date === item.date
              && record.kind === item.kind && record.title.trim().toLowerCase() === item.title.trim().toLowerCase() && record.content.trim() === item.content.trim()
              && digest(record.data) === digest(item.data))
            if (operation === 'propose' && duplicate) { reviseRecord(duplicate, 'repeat-proposal'); duplicate.signals++; return }
            records.push(item)
            return
          }
          if (operation === 'batch-create') {
            // Many new records in one write (a single write rewrites the whole collection, so record-by-record appends
            // grow with the square of the count). Each is created and validated as `create` would; creation times step
            // by a millisecond so newest-first reads and creation-time paging keep the given order.
            if (!Array.isArray(input.records) || !input.records.length || input.records.length > 1000) throw new Error('Select between one and a thousand records')
            const start = Date.now(), items = input.records.map((value, index) => {
              const item = create(memoryInputRecord(value, 'record'), scope, 'active')
              item.createdAt = item.updatedAt = new Date(start + index).toISOString()
              return item
            })
            if (options.prepareMany) await options.prepareMany(items, scope)
            else for (const item of items) await options.prepare?.(item, scope)
            for (const item of items) { options.validate(item); records.push(item) }
            return
          }
          if (operation === 'import') {
            if (!Array.isArray(input.records) || input.records.length > 10_000) throw new Error('Import requires a bounded records array')
            if (input.conflicts !== undefined && !['skip', 'replace'].includes(String(input.conflicts))) throw new Error('Choose skip or replace for import conflicts')
            const imported = new Set<string>()
            for (const value of input.records) {
              const item: unknown = structuredClone(value)
              validateRecord(item)
              if (imported.has(item.id)) throw new Error('Duplicate imported record id')
              imported.add(item.id)
              if (!options.kinds.includes(item.kind) || !options.scopes.includes(item.scope) || !visibleRecord(item, scope)) throw new Error('Imported record is outside this Source or scope')
              options.validate(item)
              const index = records.findIndex(record => record.id === item.id)
              if (index < 0) { records.push(item); continue }
              const existing = records[index]!
              if (!visibleRecord(existing, scope)) throw new Error('Imported id belongs to another scope')
              if (digest(existing) === digest(item) || input.conflicts === 'skip') continue
              if (input.conflicts !== 'replace') throw new Error('Import conflict: ' + item.id)
              reviseRecord(existing, 'import')
              records[index] = { ...item, version: existing.version, updatedAt: existing.updatedAt, history: existing.history }
            }
            return
          }
          if (operation === 'transfer-import' && options.transfer) {
            importRecordTrack(records, input.snapshot, recordTransferTracks(options.scopes), scope, item => { if (!options.kinds.includes(item.kind)) throw new Error('Unsupported record kind'); options.validate(item) })
            return
          }
          if (['update', 'approve', 'archive', 'reject', 'restore', 'delete'].includes(operation)) {
            const id = memoryInputText(input.id, 'id', 100)!
            const record = records.find(value => value.id === id && visibleRecord(value, scope))
            if (!record) throw new Error('Record is not available in this scope')
            if (input.version !== undefined && input.version !== record.version) throw new Error('Record version changed; refresh before saving')
            if (operation === 'approve' && record.state !== 'pending') throw new Error('Only pending records can be approved')
            if (operation === 'reject' && record.state !== 'pending') throw new Error('Only pending records can be rejected')
            if (operation === 'restore' && !['archived', 'deleted', 'rejected'].includes(record.state)) throw new Error('Record is not archived or removed')
            if (operation === 'restore' && record.data.mnemonSupersededBy) throw new Error('Propose a reviewed revision of the current record to reuse this historical version')
            if (operation === 'approve') approveRevision(record, input.supersededVersion)
            reviseRecord(record, operation)
            if (operation === 'update' || operation === 'approve') {
              if (input.title !== undefined) record.title = memoryInputText(input.title, 'title', 300)!
              if (input.content !== undefined) record.content = memoryInputText(input.content, 'content', 100_000, false) ?? ''
              if (input.data !== undefined) {
                const next = memoryInputRecord(input.data, 'record data')
                for (const key of ['mnemonTransfer', 'mnemonSupersedes', 'mnemonSupersededBy']) if (JSON.stringify(next[key]) !== JSON.stringify(record.data[key])) throw new Error('Transfer and revision identities cannot be edited')
                record.data = structuredClone(next)
              }
            }
            if (operation !== 'update') record.state = operation === 'restore' && (record.data.mnemonSupersedes || record.data.mnemonSupersededBy) ? 'pending' : operation === 'approve' || operation === 'restore' ? 'active' : operation === 'archive' ? 'archived' : operation === 'reject' ? 'rejected' : 'deleted'
            options.validate(record)
            return
          }
          if (options.mutate) { await options.mutate(operation, input, { records, scope, ...(signal ? { signal } : {}) }); return }
          throw new Error('Unsupported management operation: ' + operation)
        }, signal)
      }
      const managed = (snapshot: RecordSnapshot, scope: MemoryOperationScope): RecordSnapshot => ({ revision: snapshot.revision, records: snapshot.records.filter(record => visibleRecord(record, scope)) })
      return {
        async facts(request, signal) {
          const snapshot = await store.read(signal)
          prepared.set(request.scope, snapshot)
          const scoped = managed(snapshot, request.scope).records
          return { sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: options.typeId, role: options.role, availability: 'ready', revision: snapshot.revision,
            capabilities: ['status', 'project', 'recall', 'write', 'export', 'import'], routeIds: ['search'], actionIds: [modelAction, ...options.modelActions?.map(action => action.id) ?? []],
            hints: { activeCount: scoped.filter(record => record.state === 'active').length, pendingCount: scoped.filter(record => record.state === 'pending').length } }
        },
        async project(request, signal) {
          const snapshot = prepared.get(request.scope) ?? await store.read(signal)
          prepared.delete(request.scope)
          if (snapshot.revision !== request.expectedRevision) throw new Error('Collection changed during View composition')
          const records = await active(snapshot, request.scope)
          const archived = await active(snapshot, request.scope, true)
          const text = options.project?.(records, request.scope) ?? `${options.label}: ${records.length} active records. Search this Source for details.`
          return { fragments: request.includeProjection ? [{ id: context.sourceInstanceKey + '/summary', sourceInstanceKey: context.sourceInstanceKey, mode: request.mode,
            text: truncateMemoryText(text, request.maxCharacters), revision: snapshot.revision }] : [],
            readGrant: { id: context.sourceInstanceKey + '/' + snapshot.revision, sourceInstanceKey: context.sourceInstanceKey, schema: 'mnemon-record-grant/v1',
              value: { snapshot: pin(archived) }, revision: snapshot.revision, consistency: 'exact-snapshot' },
            presentation: { visibleItems: records.length, totalItems: managed(snapshot, request.scope).records.length,
              items: records.slice(0, 20).map(record => ({ id: record.id, title: record.title, ...(record.content.trim() ? { excerpt: truncateMemoryText(record.content, 160) } : {}) })) },
          }
        },
        async query(request) {
          request.signal?.throwIfAborted()
          const input = memoryInputRecord(request.input, 'record query')
          const queryText = memoryInputText(input.query, 'query', 1000, false) ?? '', term = queryText.toLocaleLowerCase()
          // `match: 'words'` finds records sharing any word of the query, most relevant first (BM25); the default
          // `phrase` keeps records that contain the whole query. `match: 'hybrid'` also ranks every record by meaning
          // and fuses both rankings, so a record that says the same thing in other words is found too.
          const words = (input.match === 'words' || input.match === 'hybrid') && term !== ''
          const recordText = (record: RecordValue) => `${record.title}\n${record.content}\n${JSON.stringify(record.data)}`
          // `ids` re-reads several known records in one call, e.g. everything a View currently shows.
          const ids = Array.isArray(input.ids) ? new Set(input.ids.filter((value): value is string => typeof value === 'string')) : undefined
          let records = pinned(request.grant.value, !shared).filter(record =>
            (record.state === 'active' || input.archived === true && record.state === 'archived')
            && (input.id === undefined || record.id === input.id) && (ids === undefined || ids.has(record.id)) && (input.kind === undefined || record.kind === input.kind)
            && (input.date === undefined || record.date === input.date) && (input.status === undefined || record.data.status === input.status)
            // A date bound compares the record's day; a timestamp bound compares its creation time, so a reader can page
            // backwards through a day that holds more records than one read returns.
            && (input.since === undefined || (String(input.since).includes('T') ? record.createdAt : record.date ?? record.createdAt.slice(0, 10)) >= String(input.since))
            && (input.until === undefined || (String(input.until).includes('T') ? record.createdAt : record.date ?? record.createdAt.slice(0, 10)) <= String(input.until))
            && (!term || words || recordText(record).toLocaleLowerCase().includes(term)))
          // `expand` also names, on the first page, the words the ten best hits share and the rest of the Source rarely
          // uses (pseudo-relevance feedback), for a reader to search with next.
          let expansion: string[] | undefined
          if (words) {
            // The index depends only on the snapshot and the filters above, so with `searchCache` it is built once for them.
            const key = config.searchCache ? JSON.stringify([memoryInputRecord(request.grant.value, 'record grant').snapshot, input.archived === true, input.id, ids ? [...ids].sort() : null, input.kind, input.date, input.status, input.since, input.until]) : undefined
            let index = key === undefined ? undefined : indexes.get(key)
            if (!index) {
              index = new LexicalIndex(records.map(record => ({ id: record.id, text: recordText(record) })))
              if (key !== undefined) {
                indexes.set(key, index)
                while (indexes.size > 1 && [...indexes.values()].reduce((n, value) => n + value.size, 0) > 150_000) indexes.delete(indexes.keys().next().value!)
              }
            }
            const lexical = index.search([{ text: term, weight: 1 }], records.length).map(hit => hit.id)
            const order = input.match === 'hybrid' && vectors
              ? fuseRankings([lexical, await vectors.rank(queryText, records.map(record => ({ id: record.id, text: record.content || record.title })), 200, request.signal)])
              : lexical
            if (input.expand === true && input.cursor === undefined) expansion = index.feedback(order.slice(0, 10), new Set(lexicalTokens(term)))
            const rank = new Map(order.map((id, i) => [id, i]))
            records = records.filter(record => rank.has(record.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
          } else if (input.recent !== false) records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
          records = options.search?.(records, input, request.view.scope) ?? records
          const { cursor, startCharacter, ...query } = input
          const identity = { view: request.view.id, snapshot: request.grant.revision, scope: request.view.scope, query }
          const offset = memoryReadOffset(cursor, identity)
          if (offset > records.length) throw new Error('Read cursor exceeds this result set')
          const start = memoryInputInteger(startCharacter, 0, 0, 1_000_000)
          if (start > 0 && input.id === undefined) throw new Error('Select one record before continuing its content')
          const limit = Math.min(memoryInputInteger(input.limit, 10, 1, 100), request.route.maxResults ?? 20)
          let remaining = request.route.maxCharacters ?? 12_000
          let partialContent = false
          let contentContinuation: import('../../core/contracts/index.ts').MemoryReadContinuation | undefined
          const items = records.slice(offset, offset + limit).flatMap(record => {
            const body = recordText(record)
            if (remaining < 1) return []
            if (start > body.length) throw new Error('Read offset exceeds this resource version')
            const end = Math.min(body.length, start + remaining)
            partialContent ||= end < body.length
            const text = body.slice(start, end)
            const reference = { id: record.id, revision: String(record.version) }
            if (input.id !== undefined && end < body.length) contentContinuation = { routeId: request.route.sourceRouteId, input: { ...input, startCharacter: end } }
            if (options.reviewedRevisions && coverage.observe(request.view.id, reference, { start, end, total: body.length })) {
              const read = inspections.get(request.view.id) ?? new Map<string, number>(); read.set(record.id, record.version); inspections.set(request.view.id, read)
              while (inspections.size > 128) inspections.delete(inspections.keys().next().value!)
            }
            remaining -= text.length
            return [{ id: record.id, text, revision: String(record.version), reference, provenance: json({ range: { start, end, total: body.length }, kind: record.kind, scope: record.scope, date: record.date, createdAt: record.createdAt, state: record.state }) }]
          })
          return { id: randomUUID(), viewId: request.view.id, routeId: request.route.id, sourceInstanceKey: context.sourceInstanceKey,
            observedAt: new Date().toISOString(), items, truncated: offset + items.length < records.length || partialContent, ...(expansion ? { metadata: { expansion } } : {}),
            ...(contentContinuation ? { continuation: contentContinuation } : items.length > 0 && offset + items.length < records.length ? { continuation: { routeId: request.route.sourceRouteId, input: { ...query, cursor: memoryReadCursor(identity, offset + items.length) } } } : {}) }
        },
        async manage(request: MemorySourceManagementRequest) {
          const input = request.input === null ? {} : memoryInputRecord(request.input, 'record management')
          if (request.mode === 'read') {
            const snapshot = managed(await store.read(request.signal), request.scope)
            if (request.operation === 'snapshot' || request.operation === 'export') return { revision: snapshot.revision, value: json(snapshot) }
            if (options.transfer && request.operation === 'transfer-catalog') return { revision: snapshot.revision, value: json({ format: 'mnemon-source-transfer/v1', tracks: recordTransferTracks(options.scopes) }) }
            if (options.transfer && request.operation === 'transfer-export') {
              const track = memoryInputText(input.track, 'track', 100)!
              if (!recordTransferTracks(options.scopes).some(item => item.id === track)) throw new Error('Unsupported transfer track')
              if (track === 'project' && !request.scope.workspaceId) throw new Error('Select a workspace')
              return { revision: snapshot.revision, value: json(exportRecordTrack(snapshot.records, track, request.scope)) }
            }
            if (options.read) return { revision: snapshot.revision, value: await options.read(request.operation, input, { snapshot, scope: request.scope, ...(request.signal ? { signal: request.signal } : {}) }) }
            throw new Error('Unsupported management read: ' + request.operation)
          }
          if (!request.confirmed || request.expectedRevision === undefined) throw new Error('A confirmed, revision-fenced management request is required')
          const before = await store.read(request.signal)
          const snapshot = await change(request.operation, input, request.scope, request.expectedRevision, request.signal)
          if (request.operation === 'transfer-import' && options.transfer) return { revision: snapshot.revision, value: json(exportRecordTrack(snapshot.records, String(memoryInputRecord(input.snapshot!, 'transfer snapshot').track), request.scope)) }
          return { revision: snapshot.revision, value: json(managed(snapshot, request.scope)), records: recordChanges(before, snapshot, request.scope) }
        },
        async mutate(request) {
          const operation = request.offer.sourceActionId
          if (operation !== modelAction && !options.modelActions?.some(action => action.id === operation)) throw new Error('Unsupported record action')
          const input = memoryInputRecord(request.input, 'record write')
          if ((operation !== modelAction || input.supersedes !== undefined) && !request.grant) throw new Error('The action needs this Source\'s pinned read grant')
          const before = await store.read(request.signal)
          const snapshot = await change(operation, input, request.view.scope, undefined, request.signal, operation !== modelAction || input.supersedes !== undefined ? pinned(request.grant!.value) : undefined, inspections.get(request.view.id))
          const affected = snapshot.records.filter(record => visibleRecord(record, request.view.scope) && (input.id ? record.id === input.id : record.title === input.title)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          return createMemoryMutationReceipt(request.view.id, request.offer.id, context.sourceInstanceKey, snapshot.revision,
            { records: json(recordChanges(before, snapshot, request.view.scope)), message: operation === 'propose' ? 'Saved for approval; not active context.' : 'Record saved.', pending: operation === 'propose', recordId: affected[0]?.id ?? null, version: affected[0]?.version ?? null }, operation === 'propose' ? 'candidate' : 'committed')
        },
        dispose() { snapshots.clear(); inspections.clear(); snapshotBytes = 0 },
      }
    },
  })
}

/** Changed metadata is Source-owned; record bodies never enter feedback events. */
function recordChanges(before: RecordSnapshot, after: RecordSnapshot, scope: MemoryOperationScope) {
  const versions = new Map(before.records.map(record => [record.id, record.version]))
  return after.records.filter(record => visibleRecord(record, scope) && versions.get(record.id) !== record.version).map(record => ({ id: record.id, revision: String(record.version), state: record.state })).slice(0, 100)
}
