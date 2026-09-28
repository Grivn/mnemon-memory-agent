import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { lock } from 'proper-lockfile'
import { withMemoryStorageLock } from 'dsh-mnemon/extension-sdk'
import { hash } from 'dsh-mnemon-replica'
import { queryTerms } from './tree.ts'

/** An address to reread, never a persisted View id, grant, or continuation. */
export interface Address { source: string; type: string; operation: string; input: Record<string, unknown> }
export interface NavigationLeaf {
  key: string; source: string; type: string; resource: string; digest: string; text: string
  address: Address; at: number; summary: string; salience: number; organized?: string
}
export interface NavigationNode { id: string; count: number; preview: string; leaves?: string[]; children?: string[] }
export interface Navigation {
  format: 'jev-navigation/v1'; channel: string; generation: number; progress: number; cursor: number; at: number
  leaves: NavigationLeaf[]; nodes: Record<string, NavigationNode>; root?: string; trace: Record<string, unknown>
}
export const emptyNavigation = (channel: string): Navigation => ({ format: 'jev-navigation/v1', channel, generation: 0, progress: 0, cursor: 0, at: 0, leaves: [], nodes: {}, trace: {} })
export const leafKey = (source: string, resource: string) => hash([source, resource])
export function literalSpans(text: string): string[] {
  const parts = text.split(/(?<=[。！？!?\n])/u).map(value => value.trim()).filter(Boolean)
  const spans = parts.flatMap(value => value.length <= 240 ? [value] : [value.slice(0, 120), value.slice(-120)])
  return [...new Set(spans)].slice(0, 6)
}
/** Content-addressed summaries reuse unchanged subtrees; they are extractive, not evidence. */
export function materialize(index: Navigation) {
  const previous = index.nodes, nodes: Navigation['nodes'] = {}; let rebuilt = 0
  const build = (leaves: NavigationLeaf[]): string => {
    if (leaves.length <= 4) {
      const id = hash(leaves.map(leaf => [leaf.key, leaf.digest, leaf.summary, leaf.salience]))
      nodes[id] = previous[id] ?? { id, count: leaves.length, leaves: leaves.map(leaf => leaf.key), preview: leaves.map(leaf => leaf.summary).join('\n') }
      if (!previous[id]) rebuilt++
      return id
    }
    const middle = Math.ceil(leaves.length / 2), children = [build(leaves.slice(0, middle)), build(leaves.slice(middle))], id = hash(children)
    nodes[id] = previous[id] ?? { id, count: leaves.length, children, preview: leaves.slice().sort((a, b) => b.salience - a.salience).slice(0, 4).map(leaf => leaf.summary).join('\n') }
    if (!previous[id]) rebuilt++
    return id
  }
  const root = index.leaves.length ? build(index.leaves) : undefined
  return { nodes, ...(root ? { root } : {}), rebuilt }
}
/** Local activation uses literal text only. No cached body is sent to JEV or published. */
export function activate(index: Navigation, texts: string[], maximum = 16) {
  const terms = queryTerms(texts, 40).map(term => term.toLocaleLowerCase())
  const frequency = new Map(terms.map(term => [term, index.leaves.filter(leaf => leaf.text.toLocaleLowerCase().includes(term)).length]))
  const scores = new Map<string, number>()
  // Traverse the materialized tree's leaf addresses, retaining full leaf terms
  // so lossy parent summaries cannot make an otherwise literal match disappear.
  const visit = (id: string) => {
    const node = index.nodes[id]; if (!node) return
    for (const key of node.leaves ?? []) scores.set(key, 0)
    for (const child of node.children ?? []) visit(child)
  }
  if (index.root) visit(index.root)
  const values = index.leaves.filter(leaf => scores.has(leaf.key)).map(leaf => {
    const text = leaf.text.toLocaleLowerCase()
    const score = terms.reduce((sum, term) => sum + (text.includes(term) ? Math.log(1 + index.leaves.length / (1 + frequency.get(term)!)) : 0), 0)
    return { leaf, score: score * (1 + leaf.salience * .15) }
  })
  return values.filter(value => value.score > 0).sort((a, b) => b.score - a.score || b.leaf.at - a.leaf.at).slice(0, maximum)
}
export function prune(index: Navigation, sources: Set<string>, ttl: number, capacity: number, now = Date.now()) {
  index.leaves = index.leaves.filter(leaf => sources.has(leaf.source) && now - leaf.at <= ttl).slice(-capacity)
  const built = materialize(index); index.nodes = built.nodes
  if (built.root) index.root = built.root; else delete index.root
}
function validate(value: Navigation, channel: string) {
  if (!value || value.format !== 'jev-navigation/v1' || value.channel !== channel || !Number.isSafeInteger(value.generation) || value.generation < 0
    || !Number.isSafeInteger(value.progress) || !Number.isSafeInteger(value.cursor) || value.cursor < 0 || !Array.isArray(value.leaves) || value.leaves.length > 2000
    || !value.nodes || typeof value.nodes !== 'object' || Object.keys(value.nodes).length > 2000
    || value.leaves.some(leaf => !leaf || leaf.key !== leafKey(leaf.source, leaf.resource) || typeof leaf.text !== 'string' || leaf.text.length > 2400 || typeof leaf.summary !== 'string' || leaf.summary.length > 500
      || !Number.isFinite(leaf.salience) || leaf.salience < 0 || leaf.salience > 1 || !Number.isFinite(leaf.at) || !leaf.address || leaf.address.source !== leaf.source || leaf.address.type !== leaf.type
      || typeof leaf.address.operation !== 'string' || !leaf.address.input || typeof leaf.address.input !== 'object' || Array.isArray(leaf.address.input) || 'cursor' in leaf.address.input)) throw new Error('Invalid navigation checkpoint')
  // Recompute the structural tree. Disk data cannot introduce recursive graphs.
  const rebuilt = materialize({ ...value, nodes: {} })
  value.nodes = rebuilt.nodes
  if (rebuilt.root) value.root = rebuilt.root; else delete value.root
}
export class NavigationStore {
  constructor(readonly directory: string) { if (!isAbsolute(directory)) throw new Error('Use an absolute navigation directory') }
  private file(channel: string) { if (!/^[a-f0-9]{64}$/.test(channel)) throw new Error('Invalid navigation channel'); return join(this.directory, channel + '.navigation.json') }
  async read(channel: string): Promise<Navigation> {
    const file = this.file(channel)
    try {
      if ((await stat(file)).size > 8_000_000) throw new Error('Navigation checkpoint exceeds capacity')
      const value = JSON.parse(await readFile(file, 'utf8')) as Navigation; validate(value, channel); return value
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyNavigation(channel); throw error }
  }
  async save(value: Navigation, expected: number, signal: AbortSignal): Promise<boolean> {
    const file = this.file(value.channel)
    return withMemoryStorageLock(file, async () => {
      signal.throwIfAborted(); await mkdir(this.directory, { recursive: true, mode: 0o700 })
      let compromised: Error | undefined
      const release = await lock(file, { realpath: false, stale: 10000, update: 2000, retries: { retries: 20, minTimeout: 20, maxTimeout: 100 }, onCompromised: error => { compromised = error } })
      const tmp = file + '.' + randomUUID() + '.tmp'
      try {
        const old = await this.read(value.channel)
        if (old.generation !== expected || old.progress > value.progress) return false
        const next = { ...value, generation: expected + 1, at: Date.now() }; validate(next, value.channel)
        const body = JSON.stringify(next)
        if (Buffer.byteLength(body) > 8_000_000) throw new Error('Navigation checkpoint exceeds capacity')
        const handle = await open(tmp, 'wx', 0o600)
        try { await handle.writeFile(body); await handle.sync() } finally { await handle.close() }
        signal.throwIfAborted(); if (compromised) throw compromised
        await rename(tmp, file); return true
      } finally { await rm(tmp, { force: true }); await release() }
    })
  }
}
