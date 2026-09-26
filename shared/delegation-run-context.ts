/**
 * 委派运行上下文契约（2026-09-26 运行审计 P1-06 收尾）。
 *
 * 放 shared（最低层）：agent 层（provider 注册/消费）与 coding 层（worktree 隔离实现，
 * 经注入位装配）都依赖本契约——依赖倒置，coding 层无需反向依赖 agent 层。
 */

/** 委派角色（与 agent-collaboration 的 DelegationRole 同集；此处为跨层契约副本）。 */
export type DelegationRunRole = 'explore' | 'research' | 'implement' | 'review' | 'custom'

/** 子运行上下文：worktree 隔离等由 coding 层实现、agent 层只认接口。 */
export interface ChildRunContext {
  /** 子会话项目根覆盖（worktree 路径）；缺省=不隔离（写主目录）。 */
  rootOverride?: string
  /** 子会话结束回调（outcome 如实）；返回 meta 并入委派结果摘要。 */
  onFinish?: (outcome: 'completed' | 'aborted' | 'failed') => Record<string, unknown> | void
}

export type ChildRunContextProvider = (input: {
  projectId: string
  delegationId: string
  childSessionId: string
  role: DelegationRunRole
}) => ChildRunContext | undefined
