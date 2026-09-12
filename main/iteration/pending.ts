/**
 * iteration/pending — 迭代群·待确认修改状态（2026-09-03 R4 群目录归位）。
 *
 * 自 programming-orchestrator 迁出的迭代挂起状态管理：
 * - MVP 就绪三按钮卡（keep/optimize/rebuild）的补充/确认态 `pendingReviewAction`；
 * - 失败重试诉求（「再试一次」免重打）。
 * 二者均为渲染端内存级生命周期（随进程重启失效，与决策卡一致——卡片重启即消失，
 * 无须持久化）。
 *
 * runIterationTask 本体（迭代闭环编排）仍在 coding/programming-orchestrator
 *（与 runMvpTask 共享大量内部函数，拆分挂后续独立批次）；本模块先行落位
 * iteration 群的独立状态面，orchestrator 侧 re-export 保持旧导出面不变。
 */

/**
 * MVP 就绪三按钮卡的决策 id（2026-09-11 卡位改版：生成完即弹，分流只依赖用户选项）。
 *
 * - keep            保持现状：不改，回 ready，随后发「走向完整产物」引导卡；
 * - optimize        局部优化：跳输入框说改哪里 → 局部修改（其余保持现状）；
 * - rebuild         整版重做：先问重做方向 → 二次确认 → 整版重做；
 * - rebuild_confirm 二次确认卡：确认整版重做；
 * - rebuild_cancel  二次确认卡：再想想（保持当前版本）。
 *
 * 旧 id（confirm/rephrase/cancel）废弃：卡片为内存级生命周期，无持久化兼容负担。
 */
export type IterationDecisionId = 'keep' | 'optimize' | 'rebuild' | 'rebuild_confirm' | 'rebuild_cancel'

// ==================== 局部优化 / 整版重做补充态（2026-09-11 卡位改版） ====================

/**
 * 「局部优化 / 整版重做」补充态：用户点卡选项后置位，表示「我会去输入框说具体内容」。
 * 用户下一句输入即消费本标记——
 * - optimize          → 直接走局部修改（localOnly），不再弹确认卡；
 * - rebuild_direction → 收集到重做方向后转二次确认（rebuild_confirm），不直接开跑；
 * - rebuild_confirm   → 等用户点二次确认卡（不走文本消费）。
 * 与 pendingIterations 同生命周期（内存级，随进程重启失效）。
 */
export interface PendingReviewAction {
  kind: 'optimize' | 'rebuild_direction' | 'rebuild_confirm'
  /** rebuild_confirm 阶段：已收集的重做方向 */
  direction?: string
}

const pendingReviewActions = new Map<string, PendingReviewAction>()

export function setPendingReviewAction(projectId: string, action: PendingReviewAction): void {
  pendingReviewActions.set(projectId, action)
}

export function takePendingReviewAction(projectId: string): PendingReviewAction | undefined {
  const action = pendingReviewActions.get(projectId)
  pendingReviewActions.delete(projectId)
  return action
}

export function clearPendingReviewAction(projectId: string): void {
  pendingReviewActions.delete(projectId)
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
  return id === 'keep' || id === 'optimize' || id === 'rebuild' || id === 'rebuild_confirm' || id === 'rebuild_cancel'
}
