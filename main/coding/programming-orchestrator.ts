/**
 * 编程编排 re-export 桩（web 线拆除刀2 重写，2026-10-01）：
 * web 生成线（stages 九件）已退役删除；本桩只保留品类无关通用件的转发，
 * 存量消费者与 vi.mock 工厂零改动。清桩挂账（export * 桩清理条目）时
 * 消费者改直连真实源后本文件删除。
 *
 * 转发面：
 * - iteration/pending：迭代挂起状态管理（pending review / failed iteration）
 * - platform/programming-events：编程事件发布器与前台运行检查器
 * - model/prd-backplane：需求 id 生成与修改描述清洗（PRD 语义纯函数）
 * - platform/llm/model-resolution：生成默认 maxTokens（原名 DEFAULT_MAX_TOKENS）
 * - coding/sketch-engine：PRD 背板解析（sketch-engine 本体处置挂刀3）
 */
export {
  clearPendingReviewAction,
  isIterationDecisionId,
  setFailedIteration,
  setPendingReviewAction,
  takeFailedIteration,
  takePendingReviewAction,
} from '../iteration/pending'
export type { IterationDecisionId, PendingReviewAction } from '../iteration/pending'

export {
  setProgrammingEventPublisher,
  setForegroundRunChecker,
} from '../platform/programming-events'

export { nextRequirementId, refineModificationDescription } from '../model/requirement-utils'

export { GENERATION_MAX_TOKENS as DEFAULT_MAX_TOKENS } from '../platform/llm/model-resolution'

export { resolvePrdBackplane } from '../guide/pipeline'
