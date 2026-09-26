/**
 * 子会话运行上下文（2026-09-26 运行审计 P1-06 收尾：worktree 隔离的 agent 侧接口）。
 *
 * agent 层只认接口（注入位），不依赖 domain——worktree 的创建/合并/清理由 coding 层
 * （coding/worktree-isolation.ts）实现并注册；本模块提供：
 * - ChildRunContext 契约（rootOverride + onFinish）；
 * - provider 注册与获取；
 * - 隔离模式的如实注记（结果摘要尾部）与子 loop 包裹（含结束回调与异常路径）；
 * - 子会话结果摘要生成（自包含，避免宿主文件行数膨胀）。
 *
 * 自 agent-collaboration 拆出（R7 单文件 ≤800 行纪律；陷阱：改该文件先数行数）。
 */

import type { AgentLoopResult } from '../loop/agent-loop'
import { runWithProjectRootOverride } from '../../../shared/project-root-override'
import type { ChildRunContext, ChildRunContextProvider, DelegationRunRole } from '../../../shared/delegation-run-context'

export type { ChildRunContext, ChildRunContextProvider } from '../../../shared/delegation-run-context'


let childRunContextProvider: ChildRunContextProvider | undefined

/** 注册子运行上下文提供者（coding 层注入 worktree 隔离；未注册/开关 off=零变化）。 */
export function setChildRunContextProvider(provider: ChildRunContextProvider): void {
  childRunContextProvider = provider
}

/** 获取本次子会话的运行上下文（provider 未注册/开关 off 时 undefined）。 */
export function acquireChildRunContext(input: {
  projectId: string
  delegationId: string
  childSessionId: string
  role: DelegationRunRole
}): ChildRunContext | undefined {
  return childRunContextProvider?.(input)
}

/** 隔离工作模式的如实告知（追加到子会话 system；未隔离时为空串）。 */
export const ISOLATION_NOTE =
  '\n\n【隔离工作模式】你在独立分支的工作树上实现（改动不直接进项目主目录）；本会话不提供预览/测试/安全验证工具——验证由父会话在合并后统一执行，请专注于实现与逻辑自检。'

/**
 * 子 loop 包裹：有 rootOverride 时在覆盖内执行（工具构造与执行全链），
 * 结束时（含异常路径）调 onFinish 并把 meta 交由调用方并入委派记录。
 */
export async function invokeChildLoopWithContext(
  runContext: ChildRunContext | undefined,
  invoke: () => Promise<AgentLoopResult>,
): Promise<{ result: AgentLoopResult; meta?: Record<string, unknown> }> {
  let result: AgentLoopResult
  try {
    result = runContext?.rootOverride ? await runWithProjectRootOverride(runContext.rootOverride, invoke) : await invoke()
  } catch (error) {
    const meta = runContext?.onFinish?.('failed')
    if (meta) throw Object.assign(error as Error, { childWorktreeMeta: meta })
    throw error
  }
  const outcome = result.status === 'cancelled' ? 'aborted' : 'completed'
  return { result, ...(runContext?.onFinish ? { meta: runContext.onFinish(outcome) ?? undefined } : {}) }
}

/** worktree 隔离结果如实注记（父会话在结果摘要里可见合并/冲突/丢弃）。 */
export function formatWorktreeNote(worktreeMeta: Record<string, unknown> | undefined): string {
  const wt = worktreeMeta?.worktree as
    | { isolated?: boolean; branch?: string; merged?: boolean; conflicts?: string[]; discarded?: boolean; reason?: string; merge_reason?: string }
    | undefined
  if (!wt) return ''
  if (wt.isolated === false) return `\n[worktree 隔离] 未启用（${wt.reason ?? '原因未知'}）`
  if (wt.merged) return `\n[worktree 隔离] 分支 ${wt.branch} 已合并进项目——验证请在合并后的候选上统一执行`
  if (wt.conflicts && wt.conflicts.length > 0) return `\n[worktree 隔离] 合并冲突未并入（分支 ${wt.branch} 保留）：${wt.conflicts.join('、')}——请裁决后手动合并`
  if (wt.discarded) return `\n[worktree 隔离] 子会话中断，产出未并入（分支 ${wt.branch} 保留供排查）`
  return `\n[worktree 隔离] 分支 ${wt.branch} 未并入（${wt.merge_reason ?? '未知原因'}）`
}

/** 子代理结果摘要（自包含；limit 由调用方给出，避免常量跨文件依赖）。 */
export function summarizeChildResult(result: AgentLoopResult, limit: number): string {
  const header = `子代理状态：${result.status}（${result.turns} 轮，${result.toolCalls.length} 次工具调用）`
  const body = result.finalText.trim()
  const full = body ? `${header}\n${body}` : header
  return full.length > limit ? `${full.slice(0, limit)}…[截断]` : full
}


// =========================================================================
// 子会话提示词纯函数（自 agent-collaboration 迁入：R7 行数纪律）
// =========================================================================

const ROLE_INSTRUCTIONS: Record<DelegationRunRole, string> = {
  explore: '职责：探索代码库——梳理文件结构、定位相关实现、报告事实性发现。只读操作，不做修改。',
  research: '职责：调研——阅读相关代码与文档，形成结论或对比方案。只读操作，不做修改。',
  implement: '职责：实现——编写/修改项目文件完成子任务。遵循平台工具护栏（路径沙箱、语法校验、可写范围）。',
  review: '职责：审查——阅读代码指出问题（正确性/可维护性/安全隐患），给出文件定位与建议，不直接修改。',
  custom: '职责：按主 agent 在任务里给出的具体指令工作。',
}

/** 子 agent system prompt：父背板 system + role 行为说明 + 委派边界规则。 */
export function buildChildSystemPrompt(parentSystem: string, role: DelegationRunRole): string {
  return `${parentSystem}

<delegation_context>
你是主 agent 委派的一名协作子 agent（role=${role}）。
${ROLE_INSTRUCTIONS[role]}
边界：
- 只负责完成本任务；完成后用纯文本输出结果摘要，不要输出「我将…」式的过程承诺。
- 你不能再委派其他子 agent（深度限制）；需要额外信息时用现有工具自行获取。
- 不向用户提问；确实受阻时，如实说明阻塞原因并输出当前进展。
</delegation_context>`
}

export function buildDelegationPrompt(opts: {
  role: DelegationRunRole
  task: string
  expectedOutput?: string
}): string {
  const expected = opts.expectedOutput
    ? `期望输出：${opts.expectedOutput}\n（最终回复请以一行「结论:」开头的标记句总结关键信息——标记句会被上下文压缩保留，格式：结论: <要点>）`
    : '完成后用简洁文本输出结果摘要（关键发现/完成清单/未完成项与原因）。最终回复以一行「结论:」开头的标记句总结（会被上下文压缩保留）。'
  return `协作子任务（role=${opts.role}）：\n${opts.task}\n\n${expected}`
}
