import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, isAbsolute } from 'node:path'
import { lock } from 'proper-lockfile'
import { withMemoryStorageLock } from 'dsh-mnemon/extension-sdk'
export interface Checkpoint {
  format: 'jev-optmem/v1'; channel: string; serial: number; revision: number
  queries: string[]; hints: Array<{ source: string; text: string }>; trace: unknown
}
/** Hints only. Old evidence and view-bound cursors are never restored as readable data. */
export class Checkpoints {
  constructor(readonly directory: string) { if (!isAbsolute(directory)) throw new Error('Use an absolute policy state directory') }
  private file(channel: string) { if (!/^[a-f0-9]{64}$/.test(channel)) throw new Error('Invalid policy channel'); return join(this.directory, channel + '.json') }
  async read(channel: string): Promise<Checkpoint | undefined> {
    try {
      const path = this.file(channel)
      if ((await stat(path)).size > 512_000) throw new Error('Policy checkpoint exceeds capacity')
      const value = JSON.parse(await readFile(path, 'utf8')) as Checkpoint
      if (value.format !== 'jev-optmem/v1' || value.channel !== channel || !Number.isSafeInteger(value.serial) || !Array.isArray(value.queries) || value.queries.length > 8 || value.queries.some(q => typeof q !== 'string' || q.length > 80) || !Array.isArray(value.hints) || value.hints.length > 64 || value.hints.some(h => typeof h.source !== 'string' || typeof h.text !== 'string' || h.text.length > 400)) throw new Error('Invalid policy checkpoint')
      return value
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  }
  async save(value: Checkpoint, signal: AbortSignal) {
    const path = this.file(value.channel)
    await withMemoryStorageLock(path, async () => {
      signal.throwIfAborted()
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      let compromised: Error | undefined
      const release = await lock(path, { realpath: false, stale: 10000, update: 2000, retries: { retries: 20, minTimeout: 20, maxTimeout: 100 }, onCompromised: error => { compromised = error } })
      try {
        if (((await this.read(value.channel))?.serial ?? -1) >= value.serial) return
        const body = JSON.stringify(value)
        if (Buffer.byteLength(body) > 512_000) throw new Error('Policy checkpoint exceeds capacity')
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        const tmp = path + '.' + randomUUID() + '.tmp'
        try { await writeFile(tmp, body, { mode: 0o600, flag: 'wx' }); signal.throwIfAborted(); if (compromised) throw compromised; await rename(tmp, path) }
        finally { await rm(tmp, { force: true }) }
      } finally { await release() }
    })
  }
}
