/** Host-owned tool facts shared by model history, orchestration and presentation. */
import { toolRecovery } from './tool-feedback-policy'
export interface ToolBudgetFact {
  resource: 'tool_calls' | 'script_runs' | 'install_calls' | 'model_requests' | 'money'
  scope: 'invocation' | 'session' | 'project' | 'experiment' | 'model_account'
  used: number
  limit: number
  remaining: number
  resets_on: 'new_invocation' | 'new_run' | 'none' | 'unknown'
}
export interface ToolFeedback {
  schema_version: 1
  execution: 'not_run' | 'running' | 'completed' | 'failed' | 'cancelled'
  verification: 'passed' | 'failed' | 'unverified' | 'not_applicable'
  scope?: string
  source?: 'host' | 'fixed_input' | 'physical_device' | 'unknown'
  category?: 'invalid_input' | 'permission' | 'environment' | 'product_assertion' | 'verification_harness' | 'budget' | 'transport' | 'unknown'
  reason?: string
  recovery?: 'correct_input' | 'prepare_environment' | 'repair_product' | 'repair_verifier' | 'wait_permission' | 'resume' | 'inspect' | 'none' | 'stop' | 'answer_question'
  budget?: ToolBudgetFact
  exit_code?: number
  reports?: string[]
  fingerprint?: string
  task_completion?: 'unverified' | 'incomplete'
  pending?: string[]
  evidence?: {
    key: string
    entry: string
    source_fingerprint: string
    environment_fingerprint: string
    freshness: 'current' | 'stale' | 'unknown'
    passed: number
    failed: number
    blocked: number
    /** Monotonic host execution count within this project/session, across budget resets. */
    attempt_seq?: number
  }
}

const EXECUTION = ['not_run', 'running', 'completed', 'failed', 'cancelled']
const VERIFICATION = ['passed', 'failed', 'unverified', 'not_applicable']
const CATEGORY = ['invalid_input', 'permission', 'environment', 'product_assertion', 'verification_harness', 'budget', 'transport', 'unknown']
const RECOVERY = ['correct_input', 'prepare_environment', 'repair_product', 'repair_verifier', 'wait_permission', 'resume', 'inspect', 'none', 'stop', 'answer_question']
/** Never forward arbitrary detail or credential-bearing nested objects. */
export function safeToolFeedback(raw: unknown): ToolFeedback | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (r.schema_version !== 1 || !EXECUTION.includes(String(r.execution)) || !VERIFICATION.includes(String(r.verification))) return undefined
  const result: ToolFeedback = { schema_version: 1, execution: r.execution as ToolFeedback['execution'], verification: r.verification as ToolFeedback['verification'] }
  for (const key of ['scope', 'reason', 'fingerprint'] as const) if (typeof r[key] === 'string') result[key] = r[key].slice(0, key === 'reason' ? 240 : 96)
  if (CATEGORY.includes(String(r.category))) result.category = r.category as ToolFeedback['category']
  if (RECOVERY.includes(String(r.recovery))) result.recovery = r.recovery as ToolFeedback['recovery']
  const b = r.budget as ToolBudgetFact | undefined
  if (b && typeof b === 'object' && ['tool_calls', 'script_runs', 'install_calls', 'model_requests', 'money'].includes(b.resource)
    && ['invocation', 'session', 'project', 'experiment', 'model_account'].includes(b.scope)
    && ['new_invocation', 'new_run', 'none', 'unknown'].includes(b.resets_on)
    && [b.used, b.limit, b.remaining].every(n => Number.isSafeInteger(n) && n >= 0)
    && b.remaining === Math.max(0, b.limit - b.used)) {
    result.budget = { resource: b.resource, scope: b.scope, used: b.used, limit: b.limit, remaining: b.remaining, resets_on: b.resets_on }
  }
  if (['host', 'fixed_input', 'physical_device', 'unknown'].includes(String(r.source))) result.source = r.source as ToolFeedback['source']
  if (typeof r.exit_code === 'number' && Number.isSafeInteger(r.exit_code)) result.exit_code = r.exit_code
  if (['unverified', 'incomplete'].includes(String(r.task_completion))) result.task_completion = r.task_completion as ToolFeedback['task_completion']
  if (Array.isArray(r.pending)) result.pending = r.pending.filter((s): s is string => typeof s === 'string').slice(0, 4).map(s => s.slice(0, 120))
  if (Array.isArray(r.reports)) result.reports = r.reports.filter((s): s is string => typeof s === 'string' && !s.includes('..') && !/^([a-z]:|[\\/]|https?:)/i.test(s)).slice(0, 4).map(s => s.slice(0, 160))
  const e = r.evidence as ToolFeedback['evidence']
  if (e && typeof e === 'object' && [e.key, e.source_fingerprint, e.environment_fingerprint].every(s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s))
    && typeof e.entry === 'string' && e.entry.length <= 160 && !e.entry.includes('..') && !/^([a-z]:|[\\/]|https?:)/i.test(e.entry)
    && ['current', 'stale', 'unknown'].includes(e.freshness) && [e.passed, e.failed, e.blocked].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 4096)
    && (e.attempt_seq === undefined || Number.isSafeInteger(e.attempt_seq) && e.attempt_seq > 0)) {
    result.evidence = { key: e.key, entry: e.entry, source_fingerprint: e.source_fingerprint, environment_fingerprint: e.environment_fingerprint,
      freshness: e.freshness, passed: e.passed, failed: e.failed, blocked: e.blocked }
    if (e.attempt_seq !== undefined) result.evidence.attempt_seq = e.attempt_seq
    if (e.freshness !== 'current') result.verification = 'unverified'
  } else if (r.evidence !== undefined) {
    result.verification = 'unverified'; result.category = 'verification_harness'; result.recovery = 'inspect'; result.reason = 'VERIFICATION_EVIDENCE_INVALID'
  }
  const recovery = toolRecovery(result)
  if (recovery !== undefined) result.recovery = recovery
  return result
}

export function formatToolFeedback(feedback: ToolFeedback, output: string): string {
  return `<tool-feedback>${JSON.stringify(feedback)}</tool-feedback>\n${output}`
}
export function readToolFeedback(content: string): ToolFeedback | undefined {
  const match = /^<tool-feedback>([^\n]{1,2400})<\/tool-feedback>/.exec(content)
  if (!match) return undefined
  try { return safeToolFeedback(JSON.parse(match[1]!)) } catch { return undefined }
}
export function toolFeedbackLabel(f: ToolFeedback): string {
  if (f.evidence?.freshness === 'stale') return '验证记录已过期'
  if (f.evidence?.freshness === 'unknown') return '验证版本待核对'
  if (f.scope === 'call_declared') return '调用已登记'
  if (f.category === 'budget') return '额度已用尽'
  if (f.category === 'permission') return f.execution === 'not_run' ? '未执行：权限限制' : '写入范围违规'
  if (f.execution === 'not_run') return '未执行'
  if (f.execution === 'running') return '进行中'
  if (f.execution === 'cancelled') return '已停止'
  if (f.task_completion === 'incomplete') return '任务未完成'
  if (f.verification === 'failed') return '检查未通过'
  if (f.execution === 'failed') return f.category === 'environment' ? '环境未就绪' : '执行失败'
  if (f.verification === 'passed') return f.scope === 'dependency_imports' ? '依赖已就绪' : '已报告检查通过'
  return f.verification === 'not_applicable' ? '操作完成' : '已执行，待验证'
}
