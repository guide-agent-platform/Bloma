/**
 * iteration/pending — 迭代群·待确认修改状态（2026-09-03 R4 群目录归位）。
 *
 * 自 programming-orchestrator 迁出的迭代挂起状态管理：修改确认门 pending
 * （用户原话 + 清洗后描述，confirm/rephrase/cancel 任一决策终结）与失败重试
 * 诉求（「再试一次」免重打）。渲染端内存级生命周期（随进程重启失效，与决策卡
 * 一致——卡片重启即消失，pending 无须持久化）。
 *
 * runIterationTask 本体（迭代闭环编排）仍在 coding/programming-orchestrator
 * （与 runMvpTask 共享大量内部函数，拆分挂后续独立批次）；本模块先行落位
 * iteration 群的独立状态面，orchestrator 侧 re-export 保持旧导出面不变。
 */

/** 修改确认卡的决策 id（confirm/rephrase/cancel），由 orchestrator 在引导路径前拦截。 */
export type IterationDecisionId = 'confirm' | 'rephrase' | 'cancel'

export interface PendingIteration {
  /** 用户原话（确认卡 reply 展示用，保证用户认得出） */
  raw: string
  /** 清洗后的需求项描述（确认后并入 F-xxx，避免整句口水话污染 PRD 背板） */
  description: string
}

// 生命周期与决策卡一致（渲染端内存级）：卡片随重启消失，pending 也无须持久化
const pendingIterations = new Map<string, PendingIteration>()

export function setPendingIteration(projectId: string, pending: PendingIteration): void {
  pendingIterations.set(projectId, pending)
}

/** 取出并清除 pending（confirm/rephrase/cancel 任一决策都终结本次待确认修改）。 */
export function takePendingIteration(projectId: string): PendingIteration | undefined {
  const pending = pendingIterations.get(projectId)
  pendingIterations.delete(projectId)
  return pending
}

// ==================== 失败重试（U12） ====================

/**
 * 最近一次迭代失败时所用的诉求（按 project 内存级记录）。
 * 渲染端点「再试一次」时由 orchestrator 取出并原样重跑 runIterationTask，
 * 避免用户重新打字描述。与 pendingIterations 同生命周期：随进程重启失效。
 */
const failedIterations = new Map<string, string>()

export function setFailedIteration(projectId: string, prompt: string): void {
  failedIterations.set(projectId, prompt)
}

export function takeFailedIteration(projectId: string): string | undefined {
  const prompt = failedIterations.get(projectId)
  failedIterations.delete(projectId)
  return prompt
}

export function isIterationDecisionId(id: string | undefined): id is IterationDecisionId {
  return id === 'confirm' || id === 'rephrase' || id === 'cancel'
}
