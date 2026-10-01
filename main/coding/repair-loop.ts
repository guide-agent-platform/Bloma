/**
 * 修复循环通用机制（web 线拆除刀3 缩桩，2026-10-01）：
 * 保留品类无关的修复纪律件——写边界判定、修复预算与轮次上限、策略轮换
 * （direct-fix → re-read-design → alternate-approach，修复循环对齐批精华，
 * 桌面线修复腿对齐 Proma-Easy 时复用）；web 终验修复执行体
 * （buildRepairTasks/runRepairLoop/renderRepairTaskCard/renderDiagnosisEscalation）
 * 随 web 生成线退役。实现自 git HEAD 原文保真迁入，断言语义不变。
 */
import type { ProjectMode } from '../../shared/types'

/** W4-F2/F3（咨询 D4）：修复轮修改授权边界 + repair_control 窄入口。 */
export function repairScopeEnabled(): boolean {
  return process.env.BLOMA_REPAIR_SCOPE === '1'
}

/** B2 判定：工具调用记录里是否存在有效写类调用（write_file/edit_file）。
 *  开关已删除（2026-10-01 开关面收敛批）：零编辑不计预算已是无条件承诺。 */
export function hasWriteEditToolCall(toolCalls: Array<{ name: string; path?: string; status?: 'ok' | 'error' }>): boolean {
  return toolCalls.some((call) => (call.name === 'write_file' || call.name === 'edit_file') && call.status !== 'error')
}

/** 受保护路径缺省（权威契约/宿主产物；拒绝任何扩大申请） */
const PROTECTED_WRITE_PATHS = ['prd.json', 'test-report.json', 'documents/loop-checkpoint.json', 'documents/decisions.md']

export type RepairSource = 'gwt' | 'build'

export interface RepairTask {
  id: string
  scenario: string
  reason: string
  kind?: 'product' | 'precondition' | 'selector' | 'mapping'
  source: RepairSource
}

export const REPAIR_BUDGET_DEFAULTS: Record<ProjectMode, number> = { quick: 2, longterm: 3 }

export const REPAIR_MAX_TURNS_DEFAULTS: Record<ProjectMode, number> = { quick: 12, longterm: 16 }

/** env 正整数解析（对齐 resolveAgentLoopMaxTurns 口径：非数字/≤0 回退缺省）。 */
function resolvePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  // 先取整再校验：'0.5' 不得 floor 成 0 让修复轮零预算
  const floored = Math.floor(parsed)
  return Number.isFinite(parsed) && floored > 0 ? floored : fallback
}

export function resolveRepairBudget(mode: ProjectMode): number {
  return resolvePositiveIntEnv(process.env.BLOMA_REPAIR_BUDGET, REPAIR_BUDGET_DEFAULTS[mode])
}

/** 修复轮 maxTurns（模式缺省 + BLOMA_REPAIR_TURNS 覆盖）。 */
export function resolveRepairMaxTurns(mode: ProjectMode): number {
  return resolvePositiveIntEnv(process.env.BLOMA_REPAIR_TURNS, REPAIR_MAX_TURNS_DEFAULTS[mode])
}

/** 修复策略轮换（修复循环对齐批，对照 Proma-Easy nanju-repair-loop）：
 *  轮 1 direct-fix / 轮 2 re-read-design（强制重读 PRD 对照偏差）/ 轮 3+ alternate-approach
 *  （强制换实现路径）——空转漂移治本（每轮指令不同，不可能同思路漂移）。 */
export const REPAIR_STRATEGY_SEQUENCE = ['direct-fix', 're-read-design', 'alternate-approach'] as const

export type RepairStrategy = (typeof REPAIR_STRATEGY_SEQUENCE)[number]

export function repairStrategyForRound(round: number): RepairStrategy {
  const idx = Math.min(round - 1, REPAIR_STRATEGY_SEQUENCE.length - 1)
  return REPAIR_STRATEGY_SEQUENCE[Math.max(idx, 0)]
}

export function buildRepairModeSection(round: number): string {
  const strategy = repairStrategyForRound(round)
  const zeroEditGuard = '本轮结束时必须存在至少一次 write_file/edit_file——零编辑的修复轮视为无效（会被回退不计入预算）。'
  const continuationNote = '【续接】你的此前工作轮次（含上一轮生成/修复的完整记录）已附在历史中——基于已有理解直接继续，不要从零重读全部文件。'
  if (strategy === 're-read-design') {
    return [
      '【修复模式·策略二：重读设计】上一轮定向修复未收敛——先重读项目锚（PRD 需求与验收要点）与失败场景涉及的设计意图，列出「设计要求 vs 当前实现」的具体偏差，再按偏差逐项修改。',
      '不要重新生成整个项目，不要改动修复任务卡之外的任何文件或功能。',
      continuationNote,
      zeroEditGuard,
    ].join('\n')
  }
  if (strategy === 'alternate-approach') {
    return [
      '【修复模式·策略三：换实现路径】前两轮同思路修复仍未收敛——放弃在原处反复微调，为失败场景换一种实现路径（不同的 DOM 结构 / 不同的算法 / 不同的模块组织），改完说明新路径与旧路径的差异。',
      '不要重新生成整个项目，不要改动修复任务卡之外的任何文件或功能。',
      continuationNote,
      zeroEditGuard,
    ].join('\n')
  }
  return [
    '【修复模式·策略一：定向修复】当前处于定向修复轮：下方的修复任务卡是本轮全部工作，完成后简要总结即可。',
    '不要重新生成整个项目，不要改动修复任务卡之外的任何文件或功能。',
    continuationNote,
    zeroEditGuard,
  ].join('\n')
}
