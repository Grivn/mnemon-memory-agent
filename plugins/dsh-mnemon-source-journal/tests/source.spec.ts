import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { RecordValue } from 'dsh-mnemon/source-sdk'
import { sourceOptions } from '../src/source.ts'
const value = (data: Record<string, any> = {}): RecordValue => ({ id: 'sample', kind: 'progress', title: 'Sample', content: 'Content', scope: 'project', workspaceId: '/project-a', state: 'active', data, signals: 1, version: 1, createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z', history: [] })
describe('journal', () => {
 it('uses append-only model writes and removes forged branch provenance', async () => {
   const record = value({ branch: 'forged' })
   await sourceOptions.prepare!(record, { storage: 'custom', workspaceId: '/nonexistent-project' })
   expect(record.data.branch).toBeUndefined()
   expect(sourceOptions.modelWrites).toBe('append')
 })
 it('tags every record of a batch with the branch from one lookup', async () => {
   const root = await mkdtemp(join(tmpdir(), 'mnemon-journal-'))
   try {
     await promisify(execFile)('git', ['init', '--initial-branch=main', root])
     const records = [value({ branch: 'forged' }), value()]
     await sourceOptions.prepareMany!(records, { storage: 'custom', workspaceId: root })
     expect(records.map(record => record.data.branch)).toEqual(['main', 'main'])
   } finally { await rm(root, { recursive: true, force: true }) }
 })
 it('checks feedback fields and keeps full entries out of the resident cover', () => {
   expect(() => sourceOptions.validate(value({ sentiment: 'unknown' }))).toThrow(/sentiment/)
   expect(sourceOptions.project!([value()], { storage: 'custom' })).not.toContain('Content')
 })
})
