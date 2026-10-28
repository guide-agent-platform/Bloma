import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject } from '../project/project-service'

export interface IndependentDesignPolicy {
  version: 1; enabled: boolean; channel_id: string; model: string; monetary_policy_path: string; authorization_path: string
  timeout_ms: number; max_tokens: number
}
export type IndependentPolicy = IndependentDesignPolicy | { version: 1; enabled: false }
function directory(projectId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw Error('INDEPENDENT_PROJECT_INVALID')
  return join(getPromaHome(), 'software-independent-design', projectId)
}
export function validateIndependentPolicy(input: unknown): IndependentPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('INDEPENDENT_POLICY_INVALID')
  const value = input as IndependentDesignPolicy
  const keys = value.enabled ? ['version','enabled','channel_id','model','monetary_policy_path','authorization_path','timeout_ms','max_tokens'] : ['version','enabled']
  if (value.version !== 1 || typeof value.enabled !== 'boolean' || Object.keys(value).some(key => !keys.includes(key))) throw Error('INDEPENDENT_POLICY_INVALID')
  if (!value.enabled) return { version: 1, enabled: false }
  if (typeof value.channel_id !== 'string' || !value.channel_id.trim() || typeof value.model !== 'string' || !value.model.trim()
    || typeof value.monetary_policy_path !== 'string' || !isAbsolute(value.monetary_policy_path)
    || typeof value.authorization_path !== 'string' || !isAbsolute(value.authorization_path)
    || !Number.isSafeInteger(value.timeout_ms) || value.timeout_ms < 100 || value.timeout_ms > 60000
    || !Number.isSafeInteger(value.max_tokens) || value.max_tokens < 512 || value.max_tokens > 4096) throw Error('INDEPENDENT_POLICY_INVALID')
  return { version: 1, enabled: true, channel_id: value.channel_id, model: value.model,
    monetary_policy_path: value.monetary_policy_path, authorization_path: value.authorization_path,
    timeout_ms: value.timeout_ms, max_tokens: value.max_tokens }
}
/** Project selection takes precedence; malformed/stale selection never falls back. */
export function readIndependentPolicy(projectId?: string): IndependentPolicy | undefined {
  if (projectId) {
    const file = join(directory(projectId), 'policy.json')
    if (existsSync(file)) {
      const record = JSON.parse(readFileSync(file, 'utf8'))
      if (record.version !== 1 || record.project_id !== projectId
        || record.operation_id !== (findProject(projectId).lean_operation_id ?? 'initial')) throw Error('INDEPENDENT_POLICY_SCOPE_CHANGED')
      return validateIndependentPolicy(record.policy)
    }
    if (existsSync(join(directory(projectId), 'policies'))) throw Error('INDEPENDENT_POLICY_MISSING')
  }
  const file = join(getPromaHome(), 'software-independent-design', 'policy.json')
  if (!existsSync(file)) return
  // Preserve the old disabled-policy format, which may retain route fields.
  const value = JSON.parse(readFileSync(file, 'utf8'))
  if (value.version === 1 && value.enabled === false) return { version: 1, enabled: false }
  return validateIndependentPolicy(value)
}
export function independentPolicyDigest(projectId: string) {
  return createHash('sha256').update(JSON.stringify(readIndependentPolicy(projectId) ?? null)).digest('hex')
}
/** Host-only setup, before execution/binding. Does not create spending proof. */
export function assertIndependentPolicyMutable(projectId: string) {
  const project = findProject(projectId), operation = project.lean_operation_id ?? 'initial'
  if (project.workflow_version !== 'software-v1') throw Error('INDEPENDENT_SOFTWARE_PROJECT_REQUIRED')
  if (['archived','abandoned'].includes(project.status)) throw Error('INDEPENDENT_PROJECT_READ_ONLY')
  for (const file of [join(directory(projectId), 'current.json'), join(getPromaHome(), 'software-run-states', projectId + '.json')]) {
    if (!existsSync(file)) continue
    const record = JSON.parse(readFileSync(file, 'utf8'))
    if (record.version !== 1 || typeof (record.operation ?? record.operationId) !== 'string') throw Error('INDEPENDENT_POLICY_RUN_STATE_INVALID')
    if ((record.operation ?? record.operationId ?? 'initial') === operation) throw Error('INDEPENDENT_POLICY_RUN_ALREADY_STARTED')
  }
  if (['binding.json','pending.json'].some(name => existsSync(join(getPromaHome(), 'harness-evaluation', projectId, name)))) throw Error('INDEPENDENT_POLICY_RUN_ALREADY_BOUND')
  return project
}
export function configureIndependentPolicy(projectId: string, input: unknown) {
  const policy = validateIndependentPolicy(input), project = assertIndependentPolicyMutable(projectId), operation = project.lean_operation_id ?? 'initial'
  const record = { version: 1, project_id: projectId, operation_id: operation, policy }
  const digest = createHash('sha256').update(JSON.stringify(record)).digest('hex')
  writeTextFileAtomic(join(directory(projectId), 'policies', digest + '.json'), JSON.stringify(record))
  writeTextFileAtomic(join(directory(projectId), 'policy.json'), JSON.stringify(record))
  return { project_id: projectId, operation_id: operation, variant: policy.enabled ? 'independent' : 'single', policy_digest: independentPolicyDigest(projectId),
    admission: 'not_checked', note: '配置不授权付费；实际运行仍核对渠道、预算证明、完整请求预留和共享额度。' }
}
