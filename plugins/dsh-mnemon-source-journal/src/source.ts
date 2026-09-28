import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { MemoryOperationScope } from 'dsh-mnemon/contracts'
import type { RecordSourceOptions, RecordValue } from 'dsh-mnemon/source-sdk'
const execute = promisify(execFile)
/** Tag records with the workspace's current branch, replacing any the writer supplied. */
async function tagBranch(records: RecordValue[], scope: MemoryOperationScope) {
  for (const record of records) delete record.data.branch
  if (scope.workspaceId) try {
    const branch = (await execute('git', ['-C', scope.workspaceId, 'branch', '--show-current'], { timeout: 1000, maxBuffer: 4096 })).stdout.trim()
    if (branch) for (const record of records) record.data.branch = branch
  } catch { /* Non-repository workspaces have no branch tag. */ }
}
export const sourceOptions: RecordSourceOptions = { context: {"mode":"routed","weight":1} satisfies import('dsh-mnemon/contracts').MemoryContextProfile,
  transfer: true,
  typeId: 'journal', role: 'activity-log', label: 'Activity journal', description: 'Project and daily activity with timestamps, feedback and branch provenance.',
  kinds: ['progress', 'feedback', 'result'], scopes: ['project', 'daily'], defaultScope: 'project', modelWrites: 'append',
  validate(record) {
    if (record.data.sentiment !== undefined && !['positive', 'neutral', 'negative'].includes(String(record.data.sentiment))) throw new Error('Unsupported feedback sentiment')
    if (record.data.category !== undefined && (typeof record.data.category !== 'string' || record.data.category.length > 100)) throw new Error('Category must be at most 100 characters')
  },
  async prepare(record, scope) { await tagBranch([record], scope) },
  // Records written in one batch share one lookup: the branch cannot change between them.
  async prepareMany(records, scope) { await tagBranch(records, scope) },
  project(records) { return `Activity journal: ${records.length} records. Query by date, keyword or kind to recover progress and feedback. Append only new outcomes; timestamps and branch provenance are recorded by the Source.` },
}
