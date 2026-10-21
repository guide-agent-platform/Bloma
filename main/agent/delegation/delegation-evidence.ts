import { createToolState, type AgentLoopTool, type ToolContext } from '../loop/agent-loop'
import { buildTaskHandoff, handoffRecovery, type TaskHandoff } from './task-handoff'
import type { DelegationRecord } from './agent-collaboration'
import type { ToolFeedback, ToolBudgetFact } from '../../../shared/tool-feedback'

/** Re-project host receipts against current files before the parent consumes them. */
export function refreshHandoffEvidence(record: DelegationRecord, tools: AgentLoopTool[]): TaskHandoff {
  const prior = record.taskHandoff!
  const collectors = tools.filter(tool => tool.collectFeedback)
  if (!collectors.length) return prior
  const ctx: ToolContext = { projectId: record.projectId, sessionId: record.childSessionId, requestId: 'handoff-read', signal: record.abort.signal, state: createToolState() }
  const facts = collectors.flatMap(tool => {
    try { return tool.collectFeedback!(ctx) } catch { return [{ schema_version: 1 as const, execution: 'not_run' as const,
      verification: 'unverified' as const, category: 'verification_harness' as const, recovery: 'inspect' as const, reason: 'EVIDENCE_COLLECTION_FAILED' }] }
  })
  const previous = prior.verification.filter(f => f.scope !== 'execution_resources')
    .map(f => f.evidence ? { ...f, verification: 'unverified' as const, evidence: { ...f.evidence, freshness: 'unknown' as const } } : f)
  const handoff = buildTaskHandoff({ status: record.loopStatus ?? 'completed', turns: 0, finalText: '', toolCalls: [],
    files_changed: prior.changed_files, tool_feedback: [...previous, ...facts] })
  handoff.stop_reason = prior.stop_reason
  if (prior.omitted_changed_files) handoff.omitted_changed_files = prior.omitted_changed_files
  return handoff
}

export class DelegationBudgetError extends Error {
  readonly feedback: ToolFeedback
  constructor(budget: ToolBudgetFact) {
    super('DELEGATION_BUDGET_REQUIRES_NEW_RUN: 累计执行额度已用尽，续接不会清零；未启动模型请求。')
    this.feedback = { schema_version: 1, execution: 'not_run', verification: 'unverified', source: 'host', scope: 'delegation_lifecycle',
      category: 'budget', recovery: 'stop', budget }
  }
}

export function assertDelegationRecovery(record: DelegationRecord): void {
  const exhausted = record.taskHandoff?.resources?.find(b => b.resource === 'script_runs' && b.remaining === 0 && ['new_run', 'none'].includes(b.resets_on))
  if (exhausted) throw new DelegationBudgetError(exhausted)
  const recovery = record.taskHandoff ? handoffRecovery(record.taskHandoff) : 'inspect'
  if ((record.loopStatus === 'budget_exhausted' || record.taskHandoff?.verification.some(f => f.category === 'budget')) && recovery !== 'resume') {
    throw new Error(recovery === 'stop' ? 'DELEGATION_BUDGET_REQUIRES_NEW_RUN: 累计额度不会因续接恢复，未启动模型请求。'
      : 'DELEGATION_BUDGET_RECOVERY_UNKNOWN: 预算重置条件未明确，先检查宿主额度，未启动模型请求。')
  }
}
