#!/usr/bin/env node
/** Install and boot two real DSH web profiles. No changes to the user's DSH_HOME. */
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import YAML from 'yaml'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: { root: { type: 'string' }, mnemon: { type: 'string' }, 'main-port': { type: 'string', default: '0' }, 'replica-port': { type: 'string', default: '0' }, reuse: { type: 'boolean' }, optmem: { type: 'boolean' }, maintained: { type: 'boolean' } } })
if (values.maintained) values.optmem = true
if (!values.root || !values.mnemon) throw new Error('Required: --root /absolute/experiment-directory --mnemon /absolute/binary')
await mkdir(resolve(values.root), { recursive: true })
const state = await realpath(resolve(values.root)), native = await realpath(resolve(values.mnemon)), workspace = join(state, 'workspace'), shared = join(state, 'shared-plugin-data')
if (state === root || root.startsWith(state + '/')) throw new Error('Keep state outside the source checkout')
await access(native); await mkdir(workspace, { recursive: true })
for (const key of ['main-port', 'replica-port']) if (!/^\d{1,5}$/.test(values[key]) || Number(values[key]) > 65535) throw new Error('Invalid TCP port')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const packages = [...new Set([...Object.keys(manifest.dependencies).filter(name => name.startsWith('dsh-mnemon-')), 'dsh-mnemon-replica', 'dsh-mnemon-agent-loop-jev', 'dsh-mnemon-strategy-jev-context', ...values.optmem ? ['dsh-mnemon-strategy-jev-optmem'] : []])]
const dsh = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), children = [], streams = []
let stopping = false
async function stop() {
  if (stopping) return; stopping = true
  await Promise.all(children.map(child => new Promise(done => {
    if (child.exitCode !== null || child.signalCode) return done()
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000); timer.unref()
    child.once('exit', () => { clearTimeout(timer); done() }); child.kill('SIGTERM')
  })))
  for (const stream of streams) stream.end()
}
process.on('SIGINT', () => { void stop() }); process.on('SIGTERM', () => { void stop() })
try {
  for (const role of ['replica', 'main']) {
    const home = join(state, role, 'dsh-home'), env = { ...process.env, DSH_HOME: home, DSH_TOOLS_MODE: 'native', DSH_TELEMETRY_MODE: 'DISABLED',
      MNEMON_DATA_DIR: join(state, role, 'mnemon'), MNEMON_CLI_PATH: native, ...(role === 'main' ? { TYPESAFE_API_KEY: '' } : { DEEPSEEK_API_KEY: '' }) }
    await mkdir(home, { recursive: true })
    const patchFile = join(home, 'profiles/web/cordis.patch.yml')
    if (values.reuse) { await access(patchFile); if (role === 'replica' && values.optmem && !(await readFile(patchFile, 'utf8')).includes('dsh-mnemon-strategy-jev-optmem')) throw new Error('The reused profile does not enable the OptMem policy') }
    else {
      await new Promise((done, reject) => {
        const child = spawn(process.execPath, [dsh, 'plugin', '--profile', 'web', 'add', `link:${root}`, ...packages.map(name => `link:${join(root, 'plugins', name)}`)], { cwd: workspace, env, stdio: 'inherit' })
        child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error('DSH plugin installation failed: ' + role)))
      })
      const disable = ['mnemon-strategy-default-three-tier', 'mnemon-source-runtime', 'mnemon-source-documents', 'mnemon-source-memory-spaces', 'session-title-llm', 'directory-picker']
      if (role === 'replica') disable.push('agent-loop', 'llm-retry', 'llm-deepseek', 'llm-pi-ai', 'token-meter', 'goal-round-driver', 'agent-presets')
      const patch = [
        ...disable.map(id => ({ id, disabled: true })),
        { id: 'tools', config: { mode: 'native' } },
        { id: 'mnemon', config: { storageScope: 'custom', dataDir: join(state, role, 'mnemon'), cliPath: native, recallMode: 'guided', writebackMode: 'guided', idleReviewMs: 600000,
          writeEnabled: true, lifecycleEnabled: true, displayMode: 'sidebar', timeoutMs: 30000, memoryTopology: { strategyId: 'workspace', viewBudget: { maxRoutes: 32, maxActions: 32, maxProjectionCharacters: 24000 } } } },
        { id: 'mnemon-strategy-workspace', disabled: false },
        { id: 'llm-deepseek', ...(role === 'replica' ? { disabled: true } : {}), config: { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY', thinking: 'disabled', reasoningEffort: 'off', maxTokens: 1024 } },
        { insert: [
          { id: 'experiment-directory-picker', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
          { id: 'experiment-directory-picker-ui', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
          { id: 'experiment-journal', name: 'dsh-mnemon-source-journal', config: { dataDir: shared, captureFeedback: false } },
          ...role === 'replica' ? [
            { id: 'experiment-tasks', name: 'dsh-mnemon-source-tasks', config: { dataDir: shared } },
            { id: 'experiment-documents', name: 'dsh-mnemon-source-documents', config: { dataDir: shared } },
            { id: 'jev-agent-loop', name: 'dsh-mnemon-agent-loop-jev', config: { policy: values.optmem ? 'jev-optmem' : 'jev-context', turnTimeoutMs: values.optmem ? 90000 : 60000, maxSteps: values.optmem ? 36 : 24, maxDecisionCalls: values.optmem ? 16 : 8 } },
          ] : [],
          { id: 'replica-bridge', name: 'dsh-mnemon-replica', config: { role, directory: join(state, 'transport'), pollMs: 250, waitMs: values.optmem ? 30000 : 15000, maxRevisionLag: 0, backgroundMs: values.maintained ? 1000 : 0, maxConcurrentJobs: 2 } },
          ...role === 'replica' && values.optmem ? [{ id: 'jev-optmem-policy', name: 'dsh-mnemon-strategy-jev-optmem', config: { id: 'jev-optmem', maintained: values.maintained === true, directory: join(state, role, 'optmem'), adapters: [
            { sourceTypeId: 'journal', operationId: 'search', queryField: 'query', limitField: 'limit', exhaustive: true, reread: { operationId: 'search', bindings: { id: 'id' }, input: { limit: 1 } } },
            { sourceTypeId: 'tasks', operationId: 'search', queryField: 'query', limitField: 'limit', input: { all: true }, exhaustive: true, reread: { operationId: 'search', bindings: { id: 'id' }, input: { limit: 1 } } },
            { sourceTypeId: 'documents', operationId: 'search', queryField: 'query', limitField: 'limit', reread: { operationId: 'search', bindings: { query: 'provenance.title' }, input: { limit: 7 } } },
          ] } }] : role === 'replica' ? [{ id: 'jev-context-policy', name: 'dsh-mnemon-strategy-jev-context', config: { id: 'jev-context', reads: [
            { sourceTypeId: 'journal', operationId: 'search', input: { recent: true, limit: 20 } },
            { sourceTypeId: 'tasks', operationId: 'search', input: { all: true, limit: 20 } },
            { sourceTypeId: 'documents', operationId: 'search', input: { query: '', limit: 20 } },
          ], capture: { sourceTypeId: 'journal', operationId: 'append', input: { kind: 'progress', scope: 'project' } } } }] : [],
        ] },
      ]
      await writeFile(patchFile, YAML.stringify(patch), { mode: 0o600 })
    }
    const log = createWriteStream(join(state, role, 'dsh-web.log'), { flags: 'a', mode: 0o600 }); streams.push(log)
    const child = spawn(process.execPath, ['--max-http-header-size=32768', dsh, 'web', '--no-open', '--host', '127.0.0.1', '--port', values[role + '-port']], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
    child.stdout.on('data', data => process.stdout.write(`[${role}] ${data}`)); child.stderr.on('data', data => process.stderr.write(`[${role}] ${data}`))
    child.once('error', error => { console.error(error.message); process.exitCode = 1; void stop() })
    child.once('exit', code => { if (!stopping) { process.exitCode = code || 1; void stop() } })
    console.log(`${role}: PID ${child.pid}; DSH_HOME ${home}`)
  }
  await writeFile(join(state, 'profiles.json'), JSON.stringify({ source: root, workspace, shared, native, pids: children.map(child => child.pid) }, null, 2) + '\n')
} catch (error) { console.error(error.message); process.exitCode = 1; await stop() }
