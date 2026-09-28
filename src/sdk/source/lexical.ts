/** Deterministic lexical recall: CJK bigrams + literal codes, scored with BM25. Record Sources rank word searches with it. */
export function lexicalTokens(text: string): string[] {
  const out: string[] = []
  for (const match of text.toLowerCase().matchAll(/[a-z0-9]+(?:[-_:][a-z0-9]+)*/gu)) out.push(match[0])
  for (const match of text.matchAll(/\p{Script=Han}+/gu)) {
    const run = match[0]
    if (run.length === 1) out.push(run)
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2))
  }
  return out
}

export interface LexicalDocument { id: string; text: string }
export interface WeightedQuery { text: string; weight: number }

// English function words, left out of feedback terms (they say nothing about what a record is about).
const STOP_WORDS = new Set(`about above after again against all also and any are aren't because been before being below between both but can
could did didn't does doesn't doing don't down during each few for from further had has have having her here hers herself him himself his
how into isn't it's its itself just like more most myself not now off once only other our ours ourselves out over own same she should some
such than that that's the their theirs them themselves then there these they this those through too under until very was wasn't were
weren't what what's when where which while who whom why will with would you your yours yourself yourselves really`.split(/\s+/))

export class LexicalIndex {
  private readonly docs = new Map<string, { tf: Map<string, number>; length: number }>()
  private readonly df = new Map<string, number>()
  private totalLength = 0
  constructor(documents: Iterable<LexicalDocument> = []) { for (const doc of documents) this.add(doc) }
  get size() { return this.docs.size }
  has(id: string) { return this.docs.has(id) }
  add(doc: LexicalDocument) {
    if (this.docs.has(doc.id)) this.remove(doc.id)
    const tf = new Map<string, number>(), tokens = lexicalTokens(doc.text)
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
    for (const token of tf.keys()) this.df.set(token, (this.df.get(token) ?? 0) + 1)
    this.docs.set(doc.id, { tf, length: tokens.length }); this.totalLength += tokens.length
  }
  remove(id: string) {
    const doc = this.docs.get(id); if (!doc) return
    for (const token of doc.tf.keys()) { const n = (this.df.get(token) ?? 1) - 1; if (n > 0) this.df.set(token, n); else this.df.delete(token) }
    this.totalLength -= doc.length; this.docs.delete(id)
  }
  /** BM25 (k1 1.2, b 0.75); query terms from several messages are weighted and summed. */
  search(queries: WeightedQuery[], limit: number): Array<{ id: string; score: number }> {
    const weights = new Map<string, number>()
    for (const query of queries) for (const token of new Set(lexicalTokens(query.text))) weights.set(token, (weights.get(token) ?? 0) + query.weight)
    const n = this.docs.size, average = n ? this.totalLength / n : 1, scores: Array<{ id: string; score: number }> = []
    if (!n) return scores
    for (const [id, doc] of this.docs) {
      let score = 0
      for (const [token, weight] of weights) {
        const tf = doc.tf.get(token); if (!tf) continue
        const df = this.df.get(token) ?? 0, idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        score += weight * idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * doc.length / average))
      }
      if (score > 0) scores.push({ id, score })
    }
    return scores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit)
  }
  /**
   * Pseudo-relevance feedback: the words the given documents (a query's best hits) use most, each weighted by how rare
   * it is in the whole index; function words, numbers, Latin words under three letters and `exclude` (the query's own
   * words) are left out.
   */
  feedback(ids: string[], exclude: ReadonlySet<string>, limit = 10): string[] {
    const n = this.docs.size, score = new Map<string, number>()
    for (const id of ids) for (const [token, tf] of this.docs.get(id)?.tf ?? []) {
      if (exclude.has(token) || STOP_WORDS.has(token) || /^\d+$/.test(token) || !/\p{Script=Han}/u.test(token) && token.length < 3) continue
      score.set(token, (score.get(token) ?? 0) + tf * Math.log(1 + n / ((this.df.get(token) ?? 0) + 0.5)))
    }
    return [...score].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([token]) => token)
  }
}
