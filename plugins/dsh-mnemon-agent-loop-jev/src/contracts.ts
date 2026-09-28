import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Judge } from './decisions.ts'

export interface PlannedCall { name: string; arguments: unknown }
export interface StepObservation { call: PlannedCall; result: ToolExecutionResult }
export interface PolicyState {
  readonly agent: Agent
  readonly turn: number
  readonly step: number
  readonly messages: readonly UserMessage[]
  readonly system: string
  readonly context: string
  readonly observations: readonly StepObservation[]
}
export type StepPlan = { kind: 'call'; call: PlannedCall } | { kind: 'done'; reason: string }
/** Policy code constructs arguments and candidate actions; JEV answers finite questions only. */
export interface JevPolicyRun { next(state: PolicyState, judge: Judge, signal: AbortSignal): Promise<StepPlan> }
export interface JevPolicy { id: string; create(): JevPolicyRun }
export interface LoopLimits { maxSteps: number; maxDecisionCalls: number; maxStateCharacters: number; turnTimeoutMs: number }
