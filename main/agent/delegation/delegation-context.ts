import type { AgentEvent, PromaPermissionMode } from '../../../shared/types'
import type { DelegationRunRole } from '../../../shared/delegation-run-context'
import type { SDKQuery } from '../../orchestration/orchestrator'
import type { AgentLoopCompactionInfo, AgentLoopTool, AgentLoopTurnInfo } from '../loop/agent-loop'
import type { ChildToolsBuilder } from './agent-collaboration'

/** 父上下文随 session 隔离；保留统一缺省预算，允许宿主按工作角色指定预算。 */
export interface DelegationParentContext {
  maxConcurrentDelegations?: number
  allowChannelOverrides?: boolean
  delegationSummaryLimit?: number
  prepareDelegation?: (input: { parent: import('../loop/agent-loop').ToolContext; args: import('./agent-collaboration').DelegateAgentArgs; childSessionId: string; delegationId: string }) => { release: () => void; completionNote?: () => string }
  materials?: import('../../../shared/attachment-types').MaterialContext
  /** Domain may give a quality reviewer only its own candidate material. */
  childMaterialsBuilder?: (childSessionId: string) => import('../../../shared/attachment-types').MaterialContext | undefined
  query: SDKQuery
  env: Record<string, string>
  maxTokens: number
  maxTurns: number
  delegationMaxTurns: number
  delegationTurnLimits?: Partial<Record<DelegationRunRole, number>>
  /** Host-owned independent child ceilings; absent roles retain the legacy parent cap. */
  delegationTurnCaps?: Partial<Record<DelegationRunRole, number>>
  executionScope?: string
  runtime?: 'pi'
  runtimeScope?: string
  permissionMode: PromaPermissionMode
  temperature: number
  system: string
  /** Domain-owned context selection at start/continue; generic delegation owns no domain rules. */
  childSystemBuilder?: (role: DelegationRunRole, childSessionId: string) => string
  editFormat: 'diff' | 'whole'
  childToolsBuilder?: ChildToolsBuilder
  providerType?: string
  publish: (type: AgentEvent['type'], payload: Record<string, unknown>) => void
  autoAnswer?: string
  onChildTurn?: (info: AgentLoopTurnInfo, child: { sessionId: string; requestId: string; role: DelegationRunRole }) => void
  onChildCompaction?: (info: AgentLoopCompactionInfo, child: { sessionId: string; requestId: string; role: DelegationRunRole }) => void
  childExtraTools?: AgentLoopTool[]
  /** Optional host registration before the child can execute tools. */
  onChildCreated?: (child: { delegationId: string; childSessionId: string }) => void
}
export function resolveDelegationTurns(context: Pick<DelegationParentContext, 'maxTurns' | 'delegationMaxTurns' | 'delegationTurnLimits' | 'delegationTurnCaps'>, role: DelegationRunRole): number {
  const budget = context.delegationTurnLimits?.[role] ?? context.delegationMaxTurns
  return Math.max(1, Math.min(budget, context.delegationTurnCaps?.[role] ?? context.maxTurns))
}
