import type { JevPolicy, Judge, PlannedCall, PolicyState } from 'dsh-mnemon-agent-loop-jev'

export type Observation = PolicyState['observations'][number]['result']
/** Live view of the current DSH step; `judge` always charges the step that is running. */
export interface PolicyScope { readonly state: PolicyState; readonly signal: AbortSignal; judge: Judge }
export type PolicyBody = AsyncGenerator<PlannedCall, string, Observation>

/** Write a policy as straight-line code: `yield` a tool call and receive its result. The DSH loop still executes every call. */
export function generatorPolicy(id: string, body: (scope: PolicyScope) => PolicyBody): JevPolicy {
  return { id, create() {
    let running: PolicyBody | undefined
    let current: { state: PolicyState; signal: AbortSignal; judge: Judge } | undefined
    const scope: PolicyScope = { get state() { return current!.state }, get signal() { return current!.signal }, judge: request => current!.judge(request) }
    return { async next(state, judge, signal) {
      current = { state, judge, signal }
      const step = running ? await running.next(state.observations.at(-1)!.result) : await (running = body(scope)).next()
      return step.done ? { kind: 'done', reason: step.value } : { kind: 'call', call: step.value }
    } }
  } }
}
