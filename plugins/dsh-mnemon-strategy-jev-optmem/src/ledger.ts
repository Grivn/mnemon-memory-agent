import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withMemoryStorageLock } from 'dsh-mnemon/extension-sdk'
import { hash } from 'dsh-mnemon-replica'

/** A public Route input, resolved against each new View by Source and operation. */
export interface RouteAddress { operationId: string; input: Record<string, unknown> }
/** What the strategy observed through public Routes. Sources stay the authority: an item is re-read before it is shown whenever it has an address. */
export interface LedgerItem {
  key: string; sourceInstanceKey: string; sourceTypeId: string; resourceId: string; revision: string; text: string; seenAt: number
  /** First observation; gives recall a stable order so a cached prompt prefix survives new observations. */
  firstSeen?: number
  /** A card or path whose body is still unread; `expand` opens it. */
  stub?: boolean; expand?: RouteAddress; reread?: RouteAddress
  /** Where the item comes from, as its Source says: a conversation, a file or a day. */
  group?: string
  /** Read-time notes written from this revision of the item (natural strategy, `materialize`). */
  facts?: { revision: string; text: string }
}
/**
 * `sweeps`: Sources last enumerated completely. `partial`: Sources a sweep could not finish within one View's
 * Route budget (read cursors are bound to their View, so a sweep cannot resume in the next job); those are
 * searched by term instead, and their items leave the ledger only when a re-read no longer finds them.
 */
export interface Ledger { format: 'natural-ledger/v1'; workspaceId: string; items: Record<string, LedgerItem>; sweeps: Record<string, number>; partial?: Record<string, number>
  /** Per partial Source with a date bound: the date to continue backwards from, `done`, or `stuck` (one date holds more than a View can read). */
  cursors?: Record<string, string> }

/** One ledger per workspace, shared by every session: identity memory in the OptMem sense. */
export class LedgerStore {
  constructor(readonly directory: string) {}
  private file(workspaceId: string) { return join(this.directory, 'ledger-' + hash(workspaceId).slice(0, 32) + '.json') }
  async read(workspaceId: string): Promise<Ledger> {
    try {
      const value = JSON.parse(await readFile(this.file(workspaceId), 'utf8')) as Ledger
      if (value.format === 'natural-ledger/v1' && value.workspaceId === workspaceId) return value
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return { format: 'natural-ledger/v1', workspaceId, items: {}, sweeps: {} }
  }
  /** Merge by observation time, so concurrent jobs never erase each other's reads. */
  async merge(workspaceId: string, items: LedgerItem[], sweeps: Record<string, number>, removed: Iterable<string>, partial: Record<string, number> = {}, cursors: Record<string, string> = {}) {
    const file = this.file(workspaceId)
    await withMemoryStorageLock(file, async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const ledger = await this.read(workspaceId), temporary = file + '.' + randomUUID() + '.tmp'
      for (const key of removed) delete ledger.items[key]
      for (const item of items) {
        const old = ledger.items[item.key], firstSeen = Math.min(old?.firstSeen ?? old?.seenAt ?? item.seenAt, item.firstSeen ?? item.seenAt)
        if ((old?.seenAt ?? 0) <= item.seenAt) ledger.items[item.key] = { ...item, firstSeen }
      }
      for (const [source, at] of Object.entries(sweeps)) ledger.sweeps[source] = Math.max(ledger.sweeps[source] ?? 0, at)
      for (const [source, at] of Object.entries(partial)) (ledger.partial ??= {})[source] = Math.max(ledger.partial[source] ?? 0, at)
      for (const [source, cursor] of Object.entries(cursors)) (ledger.cursors ??= {})[source] = cursor
      try { await writeFile(temporary, JSON.stringify(ledger), { mode: 0o600 }); await rename(temporary, file) } finally { await rm(temporary, { force: true }) }
    })
  }
}
