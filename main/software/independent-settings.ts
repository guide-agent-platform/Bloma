import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SoftwareModelSettings, SoftwareModelSettingsSave } from '../../shared/types'
import { isAgentProtocolProvider } from '../../shared/types'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { listChannels, getChannelByIdRaw } from '../platform/llm/channel-manager'
import { readMonetaryBudget } from '../platform/llm/monetary-budget'
import { findProject } from '../project/project-service'
import { assertIndependentPolicyMutable, configureIndependentPolicy, independentPolicyDigest, readIndependentPolicy } from './independent-policy'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function softwareModelSettings(projectId: string): SoftwareModelSettings {
  const project = findProject(projectId), policy = readIndependentPolicy(projectId)
  let lock_reason: string | undefined
  try { assertIndependentPolicyMutable(projectId) } catch (error) { lock_reason = String(error) }
  const channels = listChannels().filter(channel => channel.enabled && isAgentProtocolProvider(channel.provider_type)).map(channel => ({ id: channel.id, name: channel.name,
    models: channel.models.filter(model => model.enabled).map(model => model.name) }))
  const result: SoftwareModelSettings = { project_id: projectId, variant: policy?.enabled ? 'independent' : 'single',
    revision: digest([project.lean_operation_id, independentPolicyDigest(projectId), lock_reason, channels]),
    locked: Boolean(lock_reason), lock_reason, channels, design_status: 'not_prepared', admission: 'not_checked' }
  const file = join(getPromaHome(), 'software-independent-design', projectId, 'current.json')
  if (existsSync(file)) result.design_status = JSON.parse(readFileSync(file, 'utf8')).status
  if (policy?.enabled) {
    result.channel_id = policy.channel_id; result.model = policy.model
    try {
      const channel = getChannelByIdRaw(policy.channel_id)
      const budget = readMonetaryBudget(policy.monetary_policy_path).find(row => row.model === policy.model && row.host === new URL(channel?.base_url ?? '').host)
      if (!budget) throw Error('missing budget')
      result.budget = { cap_rmb: budget.cap_rmb, accounted_upper_rmb: budget.accounted_upper_rmb, remaining_rmb: budget.remaining_rmb }
      const rate = JSON.parse(readFileSync(policy.monetary_policy_path, 'utf8')).models.find((row: {host:string;model:string}) => row.model === policy.model && row.host === new URL(channel!.base_url).host)
      result.pricing = { context_tokens: rate.context_tokens, input_rmb_per_million: rate.input_rmb_per_million, output_rmb_per_million: rate.output_rmb_per_million }
    } catch { result.budget_error = '预算记录暂不可读，请核对原记录；未将未知用量当作零。' }
  }
  return result
}
/** A GUI save records explicit budget consent; it never probes a provider. Each
 * consent has new immutable files; prior policy/state/receipts are retained. */
export function saveSoftwareModelSettings(input: SoftwareModelSettingsSave): SoftwareModelSettings {
  const project = assertIndependentPolicyMutable(input.project_id), before = softwareModelSettings(input.project_id)
  if (input.revision !== before.revision) throw Error('配置已变化，请刷新后再保存。')
  if (input.variant === 'single') {
    configureIndependentPolicy(input.project_id, { version: 1, enabled: false })
    return softwareModelSettings(input.project_id)
  }
  if (input.variant !== 'independent' || input.authorize_budget !== true) throw Error('请明确确认本项目 B 模型的预算授权。')
  const channel = typeof input.channel_id === 'string' && getChannelByIdRaw(input.channel_id)
  if (!channel || !channel.enabled || !isAgentProtocolProvider(channel.provider_type) || !channel.models.some(model => model.enabled && model.name === input.model)) throw Error('请选择已启用且支持当前协议的渠道和模型。')
  const rate = input.budget
  if (!rate || !Number.isFinite(rate.cap_rmb) || rate.cap_rmb <= 0 || rate.cap_rmb > 10000
    || !Number.isSafeInteger(rate.context_tokens) || rate.context_tokens < 1 || rate.context_tokens > 2_000_000
    || ![rate.input_rmb_per_million, rate.output_rmb_per_million].every(value => Number.isFinite(value) && value >= 0 && value <= 100000)) throw Error('请填写有效预算、上下文上限及输入／输出单价。')
  const max_tokens = 4096
  if (Math.floor(rate.cap_rmb * 1e6) < Math.ceil(rate.context_tokens * rate.input_rmb_per_million) + Math.ceil(max_tokens * rate.output_rmb_per_million)) throw Error('预算不足以覆盖一次完整输入和响应的保守预留。')
  const previous = readIndependentPolicy(input.project_id)
  if (previous?.enabled && existsSync(join(getPromaHome(), 'software-independent-design', input.project_id, 'policy.json'))
    && (before.budget_error || !before.budget || before.budget.accounted_upper_rmb > 0)) throw Error('已有预算包含用量或未知责任，不能替换；请保留原账本并核对。')
  const directory = join(getPromaHome(), 'software-independent-design', input.project_id, 'funding', randomUUID())
  const money = join(directory, 'policy.json'), authorization = join(directory, 'authorization.json')
  const host = new URL(channel.base_url).host
  const policy = { version: 1, models: [{ host, model: input.model, cap_rmb: rate.cap_rmb, context_tokens: rate.context_tokens,
    input_rmb_per_million: rate.input_rmb_per_million, output_rmb_per_million: rate.output_rmb_per_million, cache_rmb_per_million: rate.input_rmb_per_million }] }
  const text = JSON.stringify(policy), policy_sha256 = createHash('sha256').update(text).digest('hex')
  writeTextFileAtomic(money, text)
  writeTextFileAtomic(money + '.state.json', JSON.stringify({ version: 1, policy_hash: policy_sha256, entries: [] }))
  writeTextFileAtomic(authorization, JSON.stringify({ source: 'direct_user_confirmation', source_ui: 'project_model_settings',
    project_id: input.project_id, operation_id: project.lean_operation_id ?? 'initial', host, model: input.model,
    cap_rmb: rate.cap_rmb, policy_sha256, confirmed_at: new Date().toISOString() }))
  configureIndependentPolicy(input.project_id, { version: 1, enabled: true, channel_id: channel.id, model: input.model,
    monetary_policy_path: money, authorization_path: authorization, timeout_ms: 60000, max_tokens })
  return softwareModelSettings(input.project_id)
}
