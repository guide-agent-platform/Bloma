import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject } from '../project/project-service'
import { leanBudget } from '../desktop/lean-budget'
import { redactSoftwareOutput } from './process-manager'
import { projectUsageLedgerPath } from '../platform/llm/request-ledger'
import { recordEvaluationEvent } from './harness-evaluation'

export type SoftwareRunStatus = 'running' | 'verifying' | 'repairing' | 'blocked' | 'waiting_user' | 'waiting_environment' | 'cancelled' | 'interrupted' | 'verified'
export interface SoftwareRunState { version: 1; projectId: string; operationId?: string; sessionId: string; runId: string; status: SoftwareRunStatus; at: string;
  source?: string; candidateId?: string; error?: string; check?: { path: string; sha256: string };
  budget: { file?: string; request_ledger?: string; requests?: number; output?: number; error?: string }; failure?: { signature: string; runId: string; repeats: number; total: number } }
function pathFor(id: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw Error('RUN_STATE_PROJECT_INVALID')
  return join(getPromaHome(), 'software-run-states', `${id}.json`)
}
export function readSoftwareRunState(projectId: string): SoftwareRunState | undefined {
  const file = pathFor(projectId); if (!existsSync(file)) return
  const value = JSON.parse(readFileSync(file, 'utf8')) as SoftwareRunState
  if (value.version !== 1 || value.projectId !== projectId || typeof value.sessionId !== 'string' || !value.budget
    || value.failure && (!Number.isSafeInteger(value.failure.repeats) || value.failure.repeats < 0 || !Number.isSafeInteger(value.failure.total) || value.failure.total < 0)) throw Error('RUN_STATE_UNREADABLE')
  return value
}
export function saveSoftwareRunState(input: { projectId: string; sessionId: string; runId: string; status: SoftwareRunStatus; source?: string; candidateId?: string; error?: string; check?: SoftwareRunState['check'] }) {
  const project = findProject(input.projectId), before = readSoftwareRunState(input.projectId)
  let budget: SoftwareRunState['budget']
  try { const state = leanBudget(input.projectId, 'desktop-implement').snapshot(); budget = { file: state.file, request_ledger: projectUsageLedgerPath(input.projectId), requests: state.requests, output: state.output } }
  catch (error) { budget = { error: redactSoftwareOutput(String(error)).slice(0, 500) } }
  const sameOperation = before?.operationId === project.lean_operation_id
  const state: SoftwareRunState = { version: 1, projectId: input.projectId, sessionId: input.sessionId, runId: input.runId, status: input.status,
    source: input.source ?? (sameOperation ? before?.source : undefined), check: input.check ?? (sameOperation ? before?.check : undefined), operationId: project.lean_operation_id, at: new Date().toISOString(), budget,
    candidateId: input.candidateId ?? (sameOperation ? before?.candidateId : undefined), failure: sameOperation ? before?.failure : undefined,
    error: input.error ? redactSoftwareOutput(input.error).slice(0, 2400) : input.status === 'verified' ? undefined : sameOperation ? before?.error : undefined }
  writeTextFileAtomic(pathFor(input.projectId), JSON.stringify(state))
  recordEvaluationEvent(input.projectId,'run_state',{status:state.status,run_id:state.runId,error:state.error,candidate_id:state.candidateId})
  return state
}
/** Repeated identical host observations without observable improvement stop a
 * single run; changed results get another attempt within the SAME budget. */
export function recordSoftwareRepair(input: { projectId: string; sessionId: string; runId: string; source?: string; candidateId?: string; error: string; observations?: unknown; category?:string }) {
  const previous = readSoftwareRunState(input.projectId), operation = findProject(input.projectId).lean_operation_id
  const normalized = redactSoftwareOutput(JSON.stringify({ error: input.error, observations: input.observations ?? null }))
    .split(input.candidateId ?? '[no-candidate]').join('[candidate]')
  const signature = createHash('sha256').update(normalized).digest('hex')
  const prior = previous && previous.operationId === operation ? previous.failure : undefined
  const repeats = prior?.runId === input.runId && prior.signature === signature ? prior.repeats + 1 : 1
  const state = saveSoftwareRunState({ ...input, status: 'repairing' })
  state.failure = { signature, runId: input.runId, repeats, total: (prior?.total ?? 0) + 1 }
  writeTextFileAtomic(pathFor(input.projectId), JSON.stringify(state))
  recordEvaluationEvent(input.projectId,'repair_started',{category:input.category??'unknown',candidate_id:input.candidateId})
  return { allowed: repeats < 3, repeats, total: state.failure.total }
}
export function softwareResumeContext(projectId: string) {
  const state = readSoftwareRunState(projectId)
  if (!state) return { available: false }
  const project = findProject(projectId)
  return { ...state, same_operation: state.operationId === project.lean_operation_id, project_status: project.status,
    instruction: '这是执行现场索引，不是当前版本通过凭据。沿sessionId的Pi原生会话与工具回执继续，不自动重放安装/写入/外部副作用；先核对已有文件和最新错误。旧进程不接管，已关闭的调试现场需重开。继续不会重置请求/输出/费用账本；旧测试仅在当前宿主重新绑定版本后有效。' }
}
