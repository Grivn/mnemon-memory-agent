/** Optional synthetic data for serve-jev-replica; never run against a user's data. */
import { mkdir, readdir, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createAcceptanceRuntime } from './lib/jev-runtime.ts'
const { values } = parseArgs({ options: { root: { type: 'string' } } })
if (!values.root) throw new Error('Pass --root /absolute/new-experiment-directory')
await mkdir(resolve(values.root), { recursive: true })
const root = await realpath(resolve(values.root))
let existing: string[] = []
try { existing = await readdir(join(root, 'shared-plugin-data')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
if (existing.length) throw new Error('The experiment already contains plugin data; choose a fresh directory')
// Official profile Entries are nested under the include loader. RecordStore
// namespaces by the full Source instance key, in addition to dataDir/workspace.
const runtime = await createAcceptanceRuntime({ root, role: 'replica', capture: false, noReplica: true, entryPrefix: 'include:' })
try {
  await runtime.seed()
  await writeFile(join(root, 'synthetic-seed.json'), JSON.stringify({ format: 'jev-experiment-seed/v1', records: 13, entryPrefix: 'include:', workspace: runtime.workspacePath }) + '\n')
  console.log('Seeded 13 synthetic records in ' + root)
} finally { await runtime.dispose() }
