import { TypeSafeClient, type Questions, type SystemOneRequest, type SystemOneResult } from '@typesafe-ai/sdk'

export type DecisionRequest = SystemOneRequest<Questions>
export type DecisionResult = SystemOneResult<Questions>
export interface DecisionProvider {
  decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult>
}
export interface DecisionTrace { request: DecisionRequest; result?: DecisionResult; elapsedMs: number; error?: string }
export type Judge = (request: DecisionRequest) => Promise<DecisionResult>

/** The SDK does not validate responses. Reject malformed/unknown decisions before any dispatch. */
export function validateDecision(request: DecisionRequest, value: DecisionResult): DecisionResult {
  const probability = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
  if (!value || typeof value.model !== 'string' || !value.answers || !value.usage
    || ![value.usage.input_tokens, value.usage.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid decision response envelope')
  for (const [key, question] of Object.entries(request.questions)) {
    const answer = value.answers[key]
    if (!answer || question.type !== answer.type) throw new Error('Decision response type mismatch: ' + key)
    if (answer.type === 'noul') {
      if (!probability(answer.noul)) throw new Error('Invalid Noul probability: ' + key)
    } else {
      const labels = question.type === 'choice' ? Object.keys(question.criteria) : question.type === 'score' ? question.criteria.map((_, i) => String(i)) : []
      if (!probability(answer.confidence) || !answer.probabilities || Object.keys(answer.probabilities).length !== labels.length
        || labels.some(label => !probability((answer.probabilities as Readonly<Record<string, number>>)[label]))
        || Math.abs(Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1) > 0.02
        || answer.type === 'choice' && !labels.includes(answer.choice)
        || answer.type === 'score' && (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > labels.length - 1)) throw new Error('Invalid finite decision: ' + key)
    }
  }
  if (Object.keys(value.answers).length !== Object.keys(request.questions).length) throw new Error('Unexpected decision answer')
  return value
}

/** Credentials stay in the process environment; neither config nor traces carry the key. */
export function createJevProvider(options: { apiKeyEnv?: string; model?: string; timeoutMs?: number } = {}): DecisionProvider {
  let client: TypeSafeClient | undefined
  return { async decide(request, signal) {
    signal.throwIfAborted()
    const key = process.env[options.apiKeyEnv ?? 'TYPESAFE_API_KEY']
    if (!key?.trim()) throw new Error('JEV API credential environment variable is missing')
    client ??= new TypeSafeClient({ apiKey: key, defaultModel: options.model ?? 'jev-latest', timeout: options.timeoutMs ?? 20_000,
      retry: { maxRetries: 0 }, logLevel: 'off' })
    // One decision call means one HTTP attempt. Recovery belongs to the configured policy.
    return validateDecision(request, await client.systemOne(request, { signal }))
  } }
}
