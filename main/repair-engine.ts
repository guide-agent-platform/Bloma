import type { AgentEvent } from '../shared/types'
import { syncDocuments } from './document-engine'
import { generateMvp } from './mvp-engine'
import { trackAnalytics } from './platform-services'
import { findProject, readLastSketchRequirements, updateProject } from './project-service'

/**
 * 自动修复循环（A2-08，闭环 ATK-Z-001）。
 *
 * 模板化补丁库：按错误类别预置确定性补丁，修复后重新校验：
 * - `dependency_error` / `syntax_error` / `runtime_error` → 按模板重建 MVP 文件
 *   （模板确定性，清除部分写入/缺失依赖/语法损坏；端口问题由 runSandbox 换端口兜底）
 * - `test_error` → 按模板重建前端文件，恢复 P0 功能入口
 * - `constraint_error` → 重新生成 PRD/GWT 骨架（文档层面，不改代码，A2-10 硬约束退回对接）
 *
 * 计数：`runtime_repair_count` / `test_repair_count` 各 ≤3（component-design §7），
 * 成功归零；达上限进入 `blocked_for_user_decision`（让渡），熔断回滚在 Sprint 3。
 * 埋点：`self_repair_triggered`（含 attempt）+ `programming_execution`。
 */

export type RepairCategory = 'dependency_error' | 'syntax_error' | 'runtime_error' | 'test_error' | 'constraint_error'

export const RUNTIME_REPAIR_LIMIT = 3
export const TEST_REPAIR_LIMIT = 3

/** 修复类别 → P0 可读文案（A4：`repairing` 事件补 `user_visible_summary`） */
export const REPAIR_CATEGORY_SUMMARY: Record<RepairCategory, string> = {
  dependency_error: '预览缺少运行依赖，正在自动修复',
  syntax_error: '预览代码存在语法错误，正在自动修复',
  runtime_error: '预览运行时报错，正在自动修复',
  test_error: '功能检查未通过，正在自动修复',
  constraint_error: '功能要求未完全对齐，正在重新整理文档',
}

type RepairKind = 'runtime' | 'test' | 'constraint'

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
  return kind === 'runtime' ? (project.runtime_repair_count ?? 0) : (project.test_repair_count ?? 0)
}

export async function runRepairCycle(input: RepairCycleInput): Promise<RepairCycleResult> {
  const { request_id, session_id, project_id, category } = input
  const kind = repairKind(category)
  const limit = kind === 'test' ? TEST_REPAIR_LIMIT : RUNTIME_REPAIR_LIMIT
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

  const patch = applyRepairPatch({ request_id, session_id, project_id }, category)
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
    updateProject(project_id, { current_stage: 'testing', ...resetPatch })
    input.publish('stage_changed', { stage: 'testing' })
    return { repaired: true, blocked: false, attempt, stage: 'testing' }
  }

  // 修复失败：计数 +1，返回让调用方再次进入循环
  if (kind === 'runtime') updateProject(project_id, { runtime_repair_count: attempt })
  if (kind === 'test') updateProject(project_id, { test_repair_count: attempt })
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

  // 模板化重建：确定性模板覆盖，消除缺失/损坏文件
  const mvp = generateMvp({ project_id: input.project_id, requirements })
  return { patched: true, summary: `已按模板重建 MVP（${mvp.files.length} 个文件）` }
}

function repairKind(category: RepairCategory): RepairKind {
  if (category === 'test_error') return 'test'
  if (category === 'constraint_error') return 'constraint'
  return 'runtime'
}
