import type { AgentEvent } from '../shared/types'
import { buildPrdBackplane, readPrdBackplane, readUxContractSketch, syncDocuments } from './document-engine'
import { generateMvp } from './mvp-engine'
import { DEFAULT_MAX_TOKENS, generateMvpLlm } from './mvp-engine-llm'
import { buildSdkEnv, decryptApiKey, getChannelByIdRaw, getFirstEnabledChannel } from './channel-manager'
import { trackAnalytics } from './platform-services'
import { findProject, readLastSketchRequirements, updateProject } from './project-service'
import type { SDKQuery } from './orchestrator'

/**
 * 自动修复循环（A2-08，闭环 ATK-Z-001）。
 *
 * 修复分两档，LLM 优先、模板兜底（self-healing-judge @S2-JUDGE-001「分析错误原因」）：
 * - `dependency_error` / `syntax_error` / `runtime_error` / `test_error` / `security_error`
 *   → 有模型句柄时，把失败原因作为 repairContext 交给 LLM 针对性重新生成 MVP；失败/无渠道
 *   再回退确定性模板重建（generateMvp）。
 * - `constraint_error` → 重新生成 PRD/GWT 骨架（文档层面，不改代码，A2-10 硬约束退回对接）。
 *
 * 计数：`runtime_repair_count` / `test_repair_count` 各 ≤3（component-design §7），
 * 成功归零；达上限进入 `blocked_for_user_decision`（让渡），熔断回滚由调用方接入。
 * 安全修复独立计数：`security_repair_count` ≤3（PRD §10.5），不计入普通退回次数。
 * 埋点：`self_repair_triggered`（含 attempt）+ `programming_execution`。
 */

export type RepairCategory = 'dependency_error' | 'syntax_error' | 'runtime_error' | 'test_error' | 'constraint_error' | 'security_error'

export const RUNTIME_REPAIR_LIMIT = 3
export const TEST_REPAIR_LIMIT = 3
export const SECURITY_REPAIR_LIMIT = 3

/** 修复类别 → P0 可读文案（A4：`repairing` 事件补 `user_visible_summary`；安全文案不含 XSS/SQL 注入等术语） */
export const REPAIR_CATEGORY_SUMMARY: Record<RepairCategory, string> = {
  dependency_error: '预览缺少运行依赖，正在自动修复',
  syntax_error: '预览代码存在语法错误，正在自动修复',
  runtime_error: '预览运行时报错，正在自动修复',
  test_error: '功能检查未通过，正在自动修复',
  constraint_error: '功能要求未完全对齐，正在重新整理文档',
  security_error: '检测到安全隐患，正在自动修复',
}

type RepairKind = 'runtime' | 'test' | 'constraint' | 'security'

export interface RepairCheck {
  ok: boolean
  preview_url?: string
}

export interface RepairCycleInput {
  request_id: string
  session_id: string
  project_id: string
  category: RepairCategory
  publish: (type: AgentEvent['type'], payload: Record<string, unknown>) => void
  /** 修复后重新校验：返回 ok 表示本轮修复成功（校验逻辑由调用方注入） */
  verify: (projectId: string) => Promise<RepairCheck>
  /** LLM 修复句柄（分析错误原因并重新生成）；缺省时回退模板重建。 */
  query?: SDKQuery
  channel_id?: string
  signal?: AbortSignal
  /** 本次修复针对的具体错误（供 LLM 分析原因用） */
  error?: { category: string; summary: string }
}

export interface RepairCycleResult {
  repaired: boolean
  blocked: boolean
  attempt: number
  stage: 'testing' | 'repairing' | 'blocked_for_user_decision'
}

export function getRepairCount(projectId: string, kind: RepairKind): number {
  if (kind === 'constraint') return 0
  const project = findProject(projectId)
  if (kind === 'security') return project.security_repair_count ?? 0
  return kind === 'runtime' ? (project.runtime_repair_count ?? 0) : (project.test_repair_count ?? 0)
}

export async function runRepairCycle(input: RepairCycleInput): Promise<RepairCycleResult> {
  const { request_id, session_id, project_id, category } = input
  const kind = repairKind(category)
  const limit =
    kind === 'test' ? TEST_REPAIR_LIMIT : kind === 'security' ? SECURITY_REPAIR_LIMIT : RUNTIME_REPAIR_LIMIT
  const attempt = getRepairCount(project_id, kind) + 1

  // 进入 repairing 阶段并广播
  updateProject(project_id, { current_stage: 'repairing' })
  input.publish('stage_changed', { stage: 'repairing' })
  input.publish('repairing', { attempt, category, user_visible_summary: REPAIR_CATEGORY_SUMMARY[category] })
  trackAnalytics({
    request_id,
    event: {
      event_type: 'self_repair_triggered',
      project_id,
      session_id,
      payload: { attempt, category },
      privacy_level: 'research_safe',
    },
  })

  // 达上限 → 让渡（熔断回滚在 Sprint 3 接入 rollback_snapshot）
  if (kind !== 'constraint' && getRepairCount(project_id, kind) >= limit) {
    updateProject(project_id, { current_stage: 'blocked_for_user_decision' })
    input.publish('stage_changed', { stage: 'blocked_for_user_decision' })
    return { repaired: false, blocked: true, attempt, stage: 'blocked_for_user_decision' }
  }

  const patch = await applyRepairPatchWithLlm(
    { request_id, session_id, project_id },
    category,
    { query: input.query, channel_id: input.channel_id, signal: input.signal, error: input.error },
  )
  trackAnalytics({
    request_id,
    event: {
      event_type: 'programming_execution',
      project_id,
      session_id,
      payload: { action: 'repair', category, patch: patch.summary },
      privacy_level: 'research_safe',
    },
  })

  const check = await input.verify(project_id)
  if (check.ok) {
    // 修复成功：计数归零，回到 testing 重测
    const resetPatch: Record<string, number> = {}
    if (kind === 'runtime') resetPatch.runtime_repair_count = 0
    if (kind === 'test') resetPatch.test_repair_count = 0
    if (kind === 'security') resetPatch.security_repair_count = 0
    updateProject(project_id, { current_stage: 'testing', ...resetPatch })
    input.publish('stage_changed', { stage: 'testing' })
    return { repaired: true, blocked: false, attempt, stage: 'testing' }
  }

  // 修复失败：计数 +1，返回让调用方再次进入循环（security 独立计数，不计入普通退回）
  if (kind === 'runtime') updateProject(project_id, { runtime_repair_count: attempt })
  if (kind === 'test') updateProject(project_id, { test_repair_count: attempt })
  if (kind === 'security') updateProject(project_id, { security_repair_count: attempt })
  return { repaired: false, blocked: false, attempt, stage: 'repairing' }
}

/** 模板化补丁库：按类别应用确定性补丁。 */
export function applyRepairPatch(
  input: { request_id: string; session_id: string; project_id: string },
  category: RepairCategory,
): { patched: boolean; summary: string } {
  const requirements = readLastSketchRequirements(input.project_id)

  if (category === 'constraint_error') {
    // 硬约束退回：重新生成 PRD + GWT 骨架（文档层面），不修改代码
    syncDocuments({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      checkpoint: 'mvp_before_generation',
    })
    return { patched: true, summary: '已重新生成 PRD 与 GWT 骨架' }
  }

  // 模板化重建：确定性模板覆盖，消除缺失/损坏文件。
  // security_error 同样走模板重建（确定性产物不含注入/XSS 类危险模式），
  // 完整 OWASP 安全扫描器由 Sprint 3 独立承接，本处提供独立计数契约。
  const mvp = generateMvp({ project_id: input.project_id, requirements })
  return { patched: true, summary: `已按模板重建 MVP（${mvp.files.length} 个文件）` }
}

export interface RepairLlmOptions {
  query?: SDKQuery
  channel_id?: string
  signal?: AbortSignal
  error?: { category: string; summary: string }
}

/**
 * 修复补丁的 LLM 优先入口（self-healing-judge @S2-JUDGE-001「分析错误原因」）。
 *
 * constraint_error 属文档层面重生成，无代码修复语义，直接走模板；
 * 其余类别先尝试把失败原因交给 LLM 针对性重新生成 MVP，失败/无渠道再回退模板重建。
 */
export async function applyRepairPatchWithLlm(
  input: { request_id: string; session_id: string; project_id: string },
  category: RepairCategory,
  opts: RepairLlmOptions,
): Promise<{ patched: boolean; summary: string }> {
  if (category === 'constraint_error') return applyRepairPatch(input, category)
  const llmResult = await repairMvpViaLlm(input, category, opts)
  if (llmResult) return llmResult
  return applyRepairPatch(input, category)
}

/**
 * 用 LLM 分析失败原因并重新生成 MVP（复用 mvp-engine-llm 的 repairContext 注入）。
 * 任何失败（无 query/无渠道/密钥不可解密/生成异常）返回 null，交给模板兜底。
 */
async function repairMvpViaLlm(
  input: { request_id: string; session_id: string; project_id: string },
  category: RepairCategory,
  opts: RepairLlmOptions,
): Promise<{ patched: boolean; summary: string } | null> {
  if (!opts.query) return null
  const channel = opts.channel_id ? getChannelByIdRaw(opts.channel_id) : getFirstEnabledChannel()
  if (!channel) return null
  let apiKey: string
  try {
    apiKey = decryptApiKey(channel.api_key)
  } catch {
    return null
  }
  // 模型名用 name（真实模型 ID）：id 是渠道内唯一标识，不能传给 API
  const model = channel.models.find((item) => item.enabled)?.name ?? 'claude-sonnet-4-6'
  const env = buildSdkEnv(apiKey, channel.base_url, model, channel.provider_type)

  // 修复与生成同一份事实源（§4.2 双契约）：读冻结 prd.json（含 ux_contract）而非临时重建，
  // 保证修复版与原生成版消费同一份行为契约 + 草图契约
  const backplane = readPrdBackplane(input.project_id)
  const sketchHtml = readUxContractSketch(input.project_id, backplane)
  try {
    await generateMvpLlm({
      project_id: input.project_id,
      backplane,
      query: opts.query,
      env,
      sessionId: input.session_id,
      maxTokens: channel.max_tokens ?? DEFAULT_MAX_TOKENS,
      signal: opts.signal,
      sketchHtml,
      repairContext: {
        category,
        error: opts.error?.summary ?? REPAIR_CATEGORY_SUMMARY[category],
      },
    })
    return { patched: true, summary: `已分析错误原因并重新生成 MVP（${category}）` }
  } catch {
    return null
  }
}

function repairKind(category: RepairCategory): RepairKind {
  if (category === 'test_error') return 'test'
  if (category === 'constraint_error') return 'constraint'
  if (category === 'security_error') return 'security'
  return 'runtime'
}
