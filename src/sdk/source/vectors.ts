/**
 * Recall by meaning for Record Sources: a query and each record are compared by the cosine of their embeddings, so a
 * record that says the same thing in other words can be found. Embeddings come from an Ollama-compatible `/api/embed`
 * endpoint (or any `Embed` function) and are kept in memory per content digest: a record is embedded once per content.
 */
import { digest } from './records.ts'

export interface RecordEmbeddingConfig {
  /** Base URL of an Ollama-compatible server, e.g. `http://127.0.0.1:11434`. */
  url: string
  model: string
  /** Task prefixes some models expect, e.g. nomic-embed-text: `search_query: ` and `search_document: `. */
  queryPrefix?: string
  documentPrefix?: string
}
export type Embed = (texts: string[], kind: 'query' | 'document', signal?: AbortSignal) => Promise<number[][]>

export function embedder(config: RecordEmbeddingConfig): Embed {
  const url = config.url.replace(/\/+$/, '') + '/api/embed'
  return async (texts, kind, signal) => {
    const prefix = (kind === 'query' ? config.queryPrefix : config.documentPrefix) ?? ''
    const out: number[][] = []
    for (let start = 0; start < texts.length; start += 64) {
      const input = texts.slice(start, start + 64).map(text => prefix + text)
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: config.model, input, truncate: true }), ...(signal ? { signal } : {}) })
      if (!response.ok) throw new Error(`Embedding request failed: ${response.status}`)
      const reply = await response.json() as { embeddings?: number[][] }
      if (!Array.isArray(reply.embeddings) || reply.embeddings.length !== input.length) throw new Error('Embedding reply does not match its request')
      out.push(...reply.embeddings)
    }
    return out
  }
}

function unit(values: number[]): Float32Array {
  const vector = Float32Array.from(values)
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < vector.length; i++) vector[i]! /= norm
  return vector
}
function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!
  return sum
}

export class VectorIndex {
  private readonly documents = new Map<string, Float32Array>()
  private readonly queries = new Map<string, Float32Array>()
  /** With `memo`, each text's digest is kept, so a large collection is not hashed again on every search. */
  private readonly digests: Map<string, string> | undefined
  constructor(private readonly embed: Embed, memo = false) { this.digests = memo ? new Map() : undefined }
  private key(text: string): string {
    if (!this.digests) return digest(text)
    let key = this.digests.get(text)
    if (key === undefined) { key = digest(text); this.digests.set(text, key) }
    return key
  }
  /** Item ids by cosine similarity to the query, best first, at most `depth`. Items not embedded yet are embedded first. */
  async rank(query: string, items: Array<{ id: string; text: string }>, depth: number, signal?: AbortSignal): Promise<string[]> {
    const keys = items.map(item => this.key(item.text))
    const missing = [...new Map(items.map((item, i) => [keys[i]!, item.text])).entries()].filter(([key]) => !this.documents.has(key))
    // With `memo` (large collections) vectors are kept a chunk at a time, so a search cut short keeps what it embedded.
    const step = this.digests ? 2048 : Math.max(1, missing.length)
    for (let start = 0; start < missing.length; start += step) {
      const part = missing.slice(start, start + step)
      const vectors = await this.embed(part.map(([, text]) => text), 'document', signal)
      part.forEach(([key], i) => this.documents.set(key, unit(vectors[i]!)))
    }
    let target = this.queries.get(query)
    if (!target) {
      target = unit((await this.embed([query], 'query', signal))[0]!)
      this.queries.set(query, target)
      if (this.queries.size > 256) this.queries.delete(this.queries.keys().next().value!)
    }
    return items.map((item, i) => ({ id: item.id, score: dot(target!, this.documents.get(keys[i]!)!) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, depth).map(item => item.id)
  }
}

/** Reciprocal-rank fusion (k 60) of several rankings, each cut at `depth`: what ranks high in any of them ranks high. */
export function fuseRankings(rankings: string[][], depth = 200, k = 60): string[] {
  const score = new Map<string, number>()
  for (const ranking of rankings) ranking.slice(0, depth).forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (k + rank)))
  return [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)! || a.localeCompare(b))
}
