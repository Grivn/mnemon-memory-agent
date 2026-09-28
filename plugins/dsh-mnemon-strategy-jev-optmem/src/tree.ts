/** Independent extractive index; it never generates facts or replaces Source storage. */
export interface Leaf { key: string; text: string; source: string }
export interface Node { id: string; leaves: number[]; preview: string; children?: [Node, Node] }
export function tree(leaves: Leaf[], indexes = leaves.map((_, i) => i)): Node {
  const preview = indexes.map(i => `${leaves[i]!.source}: ${excerpt(leaves[i]!.text, 150)}`).join('\n')
  const node: Node = { id: indexes.map(i => leaves[i]!.key).join('|'), leaves: indexes, preview }
  if (indexes.length > 1) {
    const middle = Math.ceil(indexes.length / 2)
    node.children = [tree(leaves, indexes.slice(0, middle)), tree(leaves, indexes.slice(middle))]
  }
  return node
}
/** A disjoint cover of observed leaves, not a claim to cover an unread corpus. */
export function cover(leaves: Leaf[], budget: number): Node[] {
  if (!leaves.length) return []
  const nodes = [tree(leaves)]
  while (nodes.length < Math.max(1, budget)) {
    const largest = nodes.reduce((best, node, i) => node.children && (best < 0 || node.leaves.length > nodes[best]!.leaves.length) ? i : best, -1)
    if (largest < 0) break
    nodes.splice(largest, 1, ...nodes[largest]!.children!)
  }
  return nodes
}
export function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text
  const half = Math.floor((limit - 5) / 2)
  return text.slice(0, half) + '\n[…]\n' + text.slice(-half)
}
const stop = new Set('我们 你们 他们 那个 这个 什么 怎么 怎样 多少 哪个 哪些 一下 一起 已经 今天 明天 现在 最近 之前 后来 还是 就是 可以 应该 好像 真的 这次 那就 时候 帮我 需要 想要 知道 记得 事情 安排 帮忙 按照 来着 以及 the this that with from have what how'.split(' '))
/** Finite literal proposals from conversation; JEV chooses, it does not generate text. */
export function queryTerms(texts: string[], maximum = 32): string[] {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
  const terms: string[] = []
  for (const text of texts.slice().reverse()) {
    const parts = [...segmenter.segment(text)]
    const words = parts.filter(part => part.isWordLike && part.segment.length >= 2 && part.segment.length <= 40 && !stop.has(part.segment.toLowerCase()))
    for (const word of words) if (!terms.includes(word.segment)) terms.push(word.segment)
    // ICU may split a name such as 书屋 into two single-character words.
    // Offer adjacent literal joins; JEV still decides whether any is useful.
    for (let i = 0; i < parts.length - 1; i++) {
      const a = parts[i]!, b = parts[i + 1]!
      if (!a.isWordLike || !b.isWordLike || a.segment.length > 1 && b.segment.length > 1) continue
      if (a.index + a.segment.length !== b.index || /^[的了这那我你他她它是在吗呢吧和也又就都把到上下]$/u.test(a.segment) || /^[的了这那我你他她它是在吗呢吧和也又就都把到上下]$/u.test(b.segment)) continue
      const joined = a.segment + b.segment
      if (joined.length <= 12 && !terms.includes(joined) && !stop.has(joined)) terms.push(joined)
    }
    // Quoted names and codes remain intact even if the language segmenter splits them.
    for (const match of text.matchAll(/[《「“"]([^》」”"]{2,40})[》」”"]|\b[A-Z]+[-\d][A-Z\d-]+\b/gu)) {
      const term = match[1] ?? match[0]; if (!terms.includes(term)) terms.unshift(term)
    }
  }
  return terms.slice(0, maximum)
}
