/**
 * The OpenAI chat-completions API for the benchmark harness: one request helper (retries, and a check of which model
 * answered), the DSH adapter built on it, and a temperature-0 fingerprint that tells models apart. The endpoint and key
 * come only from OPENAI_BASE_URL and OPENAI_API_KEY; `scrub` keeps both out of every error, log and record.
 */
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'

const endpoint = () => (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
/** The OpenAI key and endpoint as they may appear in text: the key, the base URL, and its host. */
export function openaiSecrets() {
  const url = process.env.OPENAI_BASE_URL
  let host = ''
  try { host = url ? new URL(url).host : '' } catch { /* not a URL: the raw value is still scrubbed */ }
  return [process.env.OPENAI_API_KEY, url, host].filter((value): value is string => !!value && value.length > 3)
}
export const scrub = (text: string) => openaiSecrets().reduce((value, secret) => value.replaceAll(secret, '[credential]'), text)
export const isOpenAIModel = (model: string) => /^(gpt-|o\d)/.test(model)

/**
 * `name@date` sends the alias and accepts only that dated snapshot (`gpt-4o@2024-08-06`: one alias can be answered by
 * several snapshots); a bare name accepts itself or any dated snapshot of it.
 */
export function modelSpec(spec: string) {
  const [name, date] = spec.split('@') as [string, string | undefined]
  return { name, label: date ? `${name}-${date}` : name, accepts: (served: string) => date ? served === `${name}-${date}` : served === name || served.startsWith(name + '-20') }
}

export interface ChatUsage { miss: number; hit: number; output: number; reasoning: number }
export interface ChatReply { text: string; usage: ChatUsage; served: string; finish: string; rejected: string[] }
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * One chat completion. Rate limits, server errors and dropped connections are retried. A reply from any model `model`
 * does not accept (see modelSpec) is discarded and asked again, up to `mismatches` times. The API rejects max_tokens
 * below 16.
 */
export async function openaiChat(messages: ChatMessage[], options: { model: string; maxTokens: number; temperature?: number; json?: boolean; timeoutMs?: number; retries?: number; mismatches?: number; backoffMs?: number; signal?: AbortSignal }): Promise<ChatReply> {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY required')
  const spec = modelSpec(options.model), rejected: string[] = [], retries = options.retries ?? 4
  const body = JSON.stringify({ model: spec.name, messages, max_tokens: Math.max(16, options.maxTokens), temperature: options.temperature ?? 0, ...(options.json ? { response_format: { type: 'json_object' } } : {}) })
  for (let attempt = 0; ;) {
    let response: Response
    try {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 300_000)
      response = await fetch(endpoint() + '/chat/completions', { method: 'POST', body, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.OPENAI_API_KEY } })
    } catch (error) {
      if (options.signal?.aborted || ++attempt > retries) throw new Error('OpenAI request failed: ' + scrub((error as Error).name))
      await sleep((options.backoffMs ?? 2000) * attempt)
      continue
    }
    const reply = await response.json().catch(() => ({})) as { model?: string; choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } } }
    if (response.ok && reply.choices?.[0]) {
      const served = String(reply.model ?? '')
      if (!spec.accepts(served)) {
        rejected.push(served)
        if (rejected.length > (options.mismatches ?? 16)) throw new Error(`OpenAI replies came from ${[...new Set(rejected)].join(', ')}, not ${spec.label}`)
        continue
      }
      const prompt = reply.usage?.prompt_tokens ?? 0, hit = reply.usage?.prompt_tokens_details?.cached_tokens ?? 0
      return { text: reply.choices[0].message?.content ?? '', served, finish: reply.choices[0].finish_reason ?? 'stop', rejected,
        usage: { miss: prompt - hit, hit, output: reply.usage?.completion_tokens ?? 0, reasoning: reply.usage?.completion_tokens_details?.reasoning_tokens ?? 0 } }
    }
    if (++attempt > retries || (!response.ok && response.status !== 429 && response.status < 500)) throw new Error('OpenAI request failed: ' + response.status + ' ' + scrub(JSON.stringify(reply)).slice(0, 200))
    await sleep((options.backoffMs ?? 2000) * attempt)
  }
}

/**
 * A fixed open-ended prompt: at temperature 0 each model opens its answer its own way, whatever the reply's model field
 * says, so a changed model is noticed even when the field does not show it.
 */
export const FINGERPRINT_PROMPT = 'Write one sentence describing a quiet harbor at dawn.'
// Only the opening words: past them one model's temperature-0 continuation can still vary ("…lay still and serene" or
// "…lay still and shimmering"), while other models already open differently ("As the first light…", "The tranquil harbor…").
export const FINGERPRINTS: Record<string, string> = { 'gpt-4.1-mini': 'The quiet harbor at dawn lay still', 'gpt-4.1': 'Soft morning light glimmers' }
export interface IdentityCheck { at: string; model: string; served: string; opening: string; ok?: boolean }
/** Two tries, since temperature 0 is not fully deterministic. `ok` is absent for a model (or pinned snapshot) with no recorded opening. */
export async function checkIdentity(model: string): Promise<IdentityCheck> {
  const expected = FINGERPRINTS[modelSpec(model).label]
  let check: IdentityCheck | undefined
  for (let i = 0; i < 2 && check?.ok !== true; i++) {
    const reply = await openaiChat([{ role: 'user', content: FINGERPRINT_PROMPT }], { model, maxTokens: 60, temperature: 0 })
    check = { at: new Date().toISOString(), model, served: reply.served, opening: reply.text.slice(0, 80), ...(expected ? { ok: reply.text.startsWith(expected) } : {}) }
    if (check.ok === undefined) break
  }
  return check!
}

/**
 * DSH adapter over openaiChat for the benchmark's text-only calls (answers and recall planning): no tools, no images.
 * It checks the model's fingerprint on its first call and every `every` calls after, and fails the call when a check
 * fails. `report` counts the models that answered and the replies it discarded.
 */
export class OpenAIAdapter extends LlmAdapter {
  readonly report = { calls: 0, served: {} as Record<string, number>, rejected: {} as Record<string, number>, identity: [] as IdentityCheck[] }
  lastServed: string | undefined
  constructor(private readonly defaults: { maxTokens: number; every?: number }) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: model.startsWith('gpt-4.1') ? 1_047_576 : 128_000 }, defaultMaxTokens: this.defaults.maxTokens })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.tools?.length) throw new Error('The benchmark OpenAI adapter sends no tools')
    if (this.report.calls++ % (this.defaults.every ?? 50) === 0) {
      const check = await checkIdentity(options.model)
      this.report.identity.push(check)
      if (check.ok === false) throw new Error(`Model identity check failed for ${options.model}: served ${check.served}, opening ${JSON.stringify(check.opening)}`)
    }
    const messages: ChatMessage[] = [...options.system ? [{ role: 'system' as const, content: options.system }] : [], ...options.messages.map(message => ({ role: message.role,
      content: message.content.flatMap(block => {
        if (block.type === 'text') return [block.text]
        if (block.type === 'reasoning') return []
        throw new Error(`The benchmark OpenAI adapter cannot send ${block.type} blocks`)
      }).join('\n') }))]
    const reply = await openaiChat(messages, { model: options.model, maxTokens: options.maxTokens ?? this.defaults.maxTokens, temperature: options.temperature ?? 0, ...options.signal ? { signal: options.signal } : {} })
    this.lastServed = reply.served
    this.report.served[reply.served] = (this.report.served[reply.served] ?? 0) + 1
    for (const served of reply.rejected) this.report.rejected[served] = (this.report.rejected[served] ?? 0) + 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply.text } }
    yield { type: 'usage', usage: { inputTokens: reply.usage.miss, outputTokens: reply.usage.output, cacheReadTokens: reply.usage.hit, reasoningTokens: reply.usage.reasoning, totalTokens: reply.usage.miss + reply.usage.hit + reply.usage.output } }
    yield { type: 'finish', reason: { kind: reply.finish === 'length' ? 'max-tokens' : 'stop' } }
  }
}
