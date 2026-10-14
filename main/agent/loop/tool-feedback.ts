import { safeToolFeedback, type ToolFeedback } from '../../../shared/tool-feedback'
import type { ToolOutcome } from './agent-loop'

const MIGRATED = new Set(['read_file', 'write_file', 'edit_file', 'list_files', 'grep', 'run_project_script', 'install_packages', 'run_project_driver', 'drive_project_app', 'delegate_agent', 'continue_delegation', 'wait_for_delegations', 'get_delegation_results', 'probe_desktop_env', 'inspect_project_resources'])
export function feedbackForTool(name: string, outcome: ToolOutcome): ToolFeedback | undefined {
  const explicit = safeToolFeedback(outcome.feedback)
  if (explicit) return explicit
  if (!MIGRATED.has(name)) return undefined
  const d = outcome.detail ?? {}
  const report = d.report && typeof d.report === 'object' ? d.report as Record<string, unknown> : d
  const f: ToolFeedback = { schema_version: 1, execution: outcome.budgetExhausted ? 'not_run' : outcome.isError ? 'failed' : 'completed', verification: 'not_applicable', source: 'host' }
  if (outcome.budgetExhausted) {
    f.category = 'budget'; f.recovery = 'inspect'; f.verification = 'unverified'
    return safeToolFeedback(f) // Refusal facts must not be overwritten by stale process detail.
  }
  else if (outcome.isError) { f.category = 'unknown'; f.recovery = 'inspect'; f.verification = 'unverified' }
  if (name === 'run_project_script' || name === 'run_project_driver') {
    f.scope = name === 'run_project_script' ? 'reported_scenarios' : 'contract_driver'
    const failedAssertion = Array.isArray(report.scenarios) && report.scenarios.some(s => s.outcome === 'fail')
    f.verification = d.verification_status === 'pass' || report.routing === 'pass' && Array.isArray(report.scenarios) && report.scenarios.some(s => s.outcome === 'pass') ? 'passed' : failedAssertion ? 'failed' : 'unverified'
    if (f.verification === 'failed') { f.category = 'product_assertion'; f.recovery = 'repair_product' }
    if (d.verification_status === 'blocked' || report.routing === 'blocked') { f.category = 'environment'; f.recovery = 'prepare_environment' }
    if (typeof d.code === 'number') f.exit_code = d.code
    else if (typeof report.exitCode === 'number') f.exit_code = report.exitCode
    if (f.exit_code !== undefined) f.execution = f.exit_code === 0 ? 'completed' : 'failed'
    if (f.exit_code !== undefined && f.exit_code !== 0 && f.verification === 'unverified' && f.category !== 'environment') {
      f.category = 'verification_harness'; f.recovery = 'inspect'; f.reason = 'PROCESS_EXIT_WITHOUT_FAILURE_ASSERTION'
    }
  }
  if (name === 'install_packages') {
    f.scope = 'dependency_imports'
    f.verification = d.imports_verified === true ? 'passed' : 'unverified'
    if (d.imports_verified === false) { f.category = 'environment'; f.recovery = 'prepare_environment' }
  }
  if (name === 'drive_project_app') { f.scope = 'gui_observation'; f.verification = 'unverified' }
  if (name.includes('delegation') || name === 'delegate_agent') {
    f.scope = 'delegation_lifecycle'; f.verification = 'unverified'; f.task_completion = 'unverified'
    const rows = Array.isArray(d.summaries) ? d.summaries : [d]
    if (rows.some(r => r && (r.task_handoff?.completion === 'incomplete' || ['turn_limit', 'budget_exhausted', 'cancelled', 'error'].includes(r.loop_status)))) { f.task_completion = 'incomplete'; f.recovery = 'inspect' }
    const budgets = rows.flatMap(r => Array.isArray(r?.task_handoff?.verification) ? r.task_handoff.verification : [])
      .map(safeToolFeedback).filter((b): b is ToolFeedback => b?.category === 'budget')
    if (budgets.length) {
      f.category = 'budget'
      if (rows.length === 1) f.budget = budgets.find(b => b.recovery === 'stop')?.budget ?? budgets[0].budget
    } else if (rows.some(r => r?.loop_status === 'turn_limit')) f.recovery = 'resume'
    if (rows.some(r => r?.status === 'running' && r.pending_question)) f.recovery = 'answer_question'
    f.pending = rows.flatMap(r => r?.task_handoff?.pending ?? []).filter(p => typeof p === 'string').slice(0, 4)
    if (rows.some(r => r?.status === 'running')) f.execution = 'running'
  }
  return safeToolFeedback(f)
}
