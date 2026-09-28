import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { lock } from 'proper-lockfile'
import { withMemoryStorageLock } from 'dsh-mnemon/extension-sdk'

export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export interface ProgressMessage { id: string; role: 'user' | 'assistant'; text: string }
export interface ProgressInput { workspaceId: string; sessionId: string; messages: ProgressMessage[] }
export interface Progress extends ProgressInput { revision: number; digest: string; at: number }
export interface SelectedMemory { sourceInstanceKey: string; sourceTypeId: string; resourceId: string; revision: string; text: string; digest: string }
/** An item that left the View; only `superseded` withdrawals are shown to the main model. */
export interface Withdrawal { sourceInstanceKey: string; sourceTypeId: string; resourceId: string; reason: 'superseded' | 'irrelevant'; text?: string }
export interface Candidate { basedOn: number; inputDigest: string; serial: number; at: number; items: SelectedMemory[]; digest: string; withdrawn?: Withdrawal[] }
export interface Lease { id: string; revision: number; until: number }
export interface WriteRecord { state: 'reserved' | 'settled'; at: number; outcome?: unknown }
export interface ChannelState {
  format: 'mnemon-replica/v1'; channel: string; progress: Progress; candidate?: Candidate; lease?: Lease
  writes: Record<string, WriteRecord>; lastRun?: { revision: number; at: number; error?: string }
}
export const channelId = (workspaceId: string, sessionId: string) => hash([resolve(workspaceId), sessionId])
export function validateInput(input: ProgressInput): void {
  if (!input || !isAbsolute(input.workspaceId) || !input.sessionId || input.sessionId.length > 200 || !Array.isArray(input.messages) || input.messages.length > 100
    || input.messages.some(message => !message || !message.id || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string' || message.text.length > 50_000)
    || JSON.stringify(input).length > 200_000) throw new Error('Invalid replica progress')
}
export function validateItems(items: SelectedMemory[]): void {
  if (!Array.isArray(items) || items.length > 64 || JSON.stringify(items).length > 200_000) throw new Error('Replica candidate exceeds limits')
  const ids = new Set<string>()
  for (const item of items) {
    if (!item || ![item.sourceInstanceKey, item.sourceTypeId, item.resourceId, item.revision, item.text].every(value => typeof value === 'string' && value.length > 0)
      || item.digest !== hash([item.sourceInstanceKey, item.resourceId, item.revision, item.text])) throw new Error('Invalid replica evidence')
    const id = item.sourceInstanceKey + ':' + item.resourceId
    if (ids.has(id)) throw new Error('Duplicate replica evidence')
    ids.add(id)
  }
}
export function validateWithdrawals(withdrawn: Withdrawal[]): void {
  if (!Array.isArray(withdrawn) || withdrawn.length > 64 || JSON.stringify(withdrawn).length > 50_000) throw new Error('Replica withdrawals exceed limits')
  for (const item of withdrawn) if (!item || ![item.sourceInstanceKey, item.sourceTypeId, item.resourceId].every(value => typeof value === 'string' && value.length > 0)
    || !['superseded', 'irrelevant'].includes(item.reason) || item.text !== undefined && typeof item.text !== 'string') throw new Error('Invalid replica withdrawal')
}

/** One atomic file per main session. File locks cover both DSH processes. No plugin runtime handles cross this boundary. */
export class ReplicaStore {
  readonly directory: string
  constructor(directory: string) { if (!isAbsolute(directory)) throw new Error('Replica directory must be absolute'); this.directory = resolve(directory) }
  private file(channel: string) { if (!/^[a-f0-9]{64}$/.test(channel)) throw new Error('Invalid replica channel'); return join(this.directory, channel + '.json') }
  async list() { try { return (await readdir(this.directory)).filter(file => /^[a-f0-9]{64}\.json$/.test(file)).map(file => file.slice(0, -5)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error } }
  async read(channel: string): Promise<ChannelState | undefined> {
    let value: ChannelState
    try {
      const file = this.file(channel)
      if ((await stat(file)).size > 2_000_000) throw new Error('Replica channel exceeds capacity')
      value = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    if (value.format !== 'mnemon-replica/v1' || value.channel !== channel || !value.writes || typeof value.writes !== 'object') throw new Error('Invalid replica channel')
    validateInput(value.progress)
    const { workspaceId, sessionId, messages, revision, digest } = value.progress
    if (channelId(workspaceId, sessionId) !== channel || !Number.isSafeInteger(revision) || revision < 1 || digest !== hash({ workspaceId, sessionId, messages })) throw new Error('Replica progress identity mismatch')
    if (value.candidate) {
      validateItems(value.candidate.items)
      if (value.candidate.withdrawn) validateWithdrawals(value.candidate.withdrawn)
      if (!Number.isSafeInteger(value.candidate.basedOn) || value.candidate.basedOn > revision || value.candidate.digest !== hash(value.candidate.items)) throw new Error('Invalid replica candidate revision')
    }
    return value
  }
  private async change<T>(channel: string, mutate: (current: ChannelState | undefined) => { state: ChannelState; result: T }, signal?: AbortSignal): Promise<T> {
    return withMemoryStorageLock(this.file(channel), async () => {
      signal?.throwIfAborted(); await mkdir(this.directory, { recursive: true, mode: 0o700 })
      let compromised: Error | undefined
      // proper-lockfile tracks ownership by the target path, not lockfilePath.
      // Use the channel identity so concurrent sessions do not overwrite each
      // other's in-process lease. The first progress write has no file yet.
      const release = await lock(this.file(channel), { realpath: false, lockfilePath: join(this.directory, channel + '.lock'), stale: 10_000, update: 2000,
        retries: { retries: 30, minTimeout: 20, maxTimeout: 200 }, onCompromised: error => { compromised = error } })
      const temporary = this.file(channel) + '.' + randomUUID() + '.tmp'
      try {
        const current = await this.read(channel), before = JSON.stringify(current)
        const { state, result } = mutate(current)
        const body = JSON.stringify(state)
        if (body === before) return result
        if (body.length > 2_000_000) throw new Error('Replica channel capacity exceeded; archive this session channel')
        const handle = await open(temporary, 'wx', 0o600)
        try { await handle.writeFile(body); await handle.sync() } finally { await handle.close() }
        signal?.throwIfAborted(); if (compromised) throw compromised
        await rename(temporary, this.file(channel))
        return result
      } finally { await rm(temporary, { force: true }); await release() }
    })
  }
  async progress(input: ProgressInput, signal?: AbortSignal): Promise<Progress> {
    input = structuredClone(input); input.workspaceId = resolve(input.workspaceId); validateInput(input)
    const channel = channelId(input.workspaceId, input.sessionId), digest = hash(input)
    return this.change(channel, old => {
      if (old?.progress.digest === digest) return { state: old, result: old.progress }
      const progress: Progress = { ...input, revision: (old?.progress.revision ?? 0) + 1, digest, at: Date.now() }
      const state: ChannelState = { ...old, format: 'mnemon-replica/v1', channel, progress, writes: old?.writes ?? {} }
      return { state, result: progress }
    }, signal)
  }
  async claim(channel: string, backgroundMs: number, leaseMs: number): Promise<Lease | undefined> {
    return this.change(channel, state => {
      if (!state) throw new Error('Replica progress disappeared')
      const now = Date.now()
      if (state.lease && state.lease.until > now || state.lastRun?.revision === state.progress.revision && (state.lastRun.error ? now - state.lastRun.at < 10_000 : !backgroundMs || now - state.lastRun.at < backgroundMs)) return { state, result: undefined }
      const lease = { id: randomUUID(), revision: state.progress.revision, until: now + leaseMs }
      state.lease = lease
      return { state, result: lease }
    })
  }
  async publish(channel: string, lease: Lease, inputDigest: string, items: SelectedMemory[], signal?: AbortSignal, withdrawn?: Withdrawal[]): Promise<Candidate> {
    items = structuredClone(items); validateItems(items)
    if (withdrawn) { withdrawn = structuredClone(withdrawn); validateWithdrawals(withdrawn) }
    return this.change(channel, state => {
      if (!state || state.lease?.id !== lease.id || state.lease.until < Date.now() || state.progress.revision !== lease.revision || state.progress.digest !== inputDigest) throw new Error('Stale replica candidate rejected')
      const candidate: Candidate = { basedOn: lease.revision, inputDigest, serial: (state.candidate?.serial ?? 0) + 1, at: Date.now(), items, digest: hash(items), ...(withdrawn?.length ? { withdrawn } : {}) }
      state.candidate = candidate
      return { state, result: candidate }
    }, signal)
  }
  async finish(channel: string, lease: Lease, error?: string): Promise<void> {
    await this.change(channel, state => {
      if (!state) throw new Error('Replica progress disappeared')
      if (state.lease?.id === lease.id) { delete state.lease; state.lastRun = { revision: lease.revision, at: Date.now(), ...(error ? { error } : {}) } }
      return { state, result: undefined }
    })
  }
  /** Give up a lease without recording a run: the bridge preempted or superseded this job itself. */
  async release(channel: string, lease: Lease): Promise<void> {
    await this.change(channel, state => {
      if (!state) throw new Error('Replica progress disappeared')
      if (state.lease?.id === lease.id) delete state.lease
      return { state, result: undefined }
    })
  }
  async reserveWrite(channel: string, lease: Lease, key: string, signal?: AbortSignal): Promise<boolean> {
    return this.change(channel, state => {
      if (!state || state.lease?.id !== lease.id || state.progress.revision !== lease.revision || state.lease.until < Date.now()) throw new Error('Stale replica write intent rejected')
      const id = hash(key)
      if (state.writes[id]) return { state, result: false }
      state.writes[id] = { state: 'reserved', at: Date.now() }
      return { state, result: true }
    }, signal)
  }
  async settleWrite(channel: string, key: string, outcome: unknown): Promise<void> {
    await this.change(channel, state => {
      if (!state?.writes[hash(key)]) throw new Error('Replica write was not reserved')
      state.writes[hash(key)] = { state: 'settled', at: Date.now(), outcome }
      return { state, result: undefined }
    })
  }
}
