/**
 * 委派协作工具族（PR4d 自 agent-tools 拆出）：delegate/wait/get/stop×2/answer/continue（parent 专属）
 * 与 ask_delegation_question（子角色冒泡提问）。纯机械搬移，角色裁剪语义与拆分前一致。
 */
import type { AgentLoopTool } from '../loop/agent-loop'
import {
  answerDelegationQuestion,
  askDelegationQuestion,
  continueDelegation,
  delegateAgentOnce,
  findDelegation,
  getDelegationSummary,
  listDelegations,
  startDelegation,
  stopDelegation,
  stopDelegations,
  waitForDelegations,
  type DelegationRole,
  type DelegationSummary,
  type StartDelegationResult,
} from './agent-collaboration'

export function buildDelegationTools(role: 'parent' | DelegationRole): AgentLoopTool[] {

  // 主 agent（parent）专属委派协作工具集：M1 delegate_agent；M2 wait/get/stop；M3 answer/continue
  const delegate_agent: AgentLoopTool = {
    name: 'delegate_agent',
    description:
      '委派一个真实协作子会话并行处理独立子任务（fire-and-forget：立即返回 delegation_id，不阻塞当前轮）。' +
      '子会话是独立 agent，仅限 1 层深度（子代理不能再委派）。适合长耗时、可并行、需要独立追踪的任务。' +
      '用 wait_for_delegations 收集结果、get_delegation_results 读取摘要。',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '发给子 agent 的完整任务说明，必须自包含必要上下文' },
        role: {
          type: 'string',
          enum: ['explore', 'research', 'implement', 'review', 'custom'],
          description: '子任务角色：explore 探索代码库 / research 调研 / implement 实现 / review 审查 / custom 自定义',
        },
        expectedOutput: { type: 'string', description: '希望子 agent 最终返回的格式或要点（可选）' },
      },
      required: ['task'],
    },
    execute: async (toolInput, ctx) => {
      const created = delegateAgentOnce(ctx.sessionId, ctx.toolCallId, () =>
        startDelegation(ctx, {
          task: String(toolInput.task ?? ''),
          role: normalizeDelegationRole(toolInput.role),
          expectedOutput: typeof toolInput.expectedOutput === 'string' ? toolInput.expectedOutput : undefined,
        }),
      )
      return {
        output:
          `已委派协作子会话（delegation_id=${created.delegation_id}，role=${created.role}，status=${created.status}）。` +
          '用 wait_for_delegations 等待结果、get_delegation_results 读取摘要。',
        detail: { ...created },
      }
    },
  }

  const wait_for_delegations: AgentLoopTool = {
    name: 'wait_for_delegations',
    description:
      '阻塞等待委派子会话收敛（本工具调用会挂起当前轮直到等待完成或超时）。' +
      'strategy=all 等全部完成、any 等任一完成；超时（timeout_ms，缺省 600000ms）返回当前状态不抛错，由父 agent 决定继续等还是停止。' +
      'delegation_ids 缺省 = 等待当前全部委派。',
    input_schema: {
      type: 'object',
      properties: {
        delegation_ids: { type: 'array', items: { type: 'string' }, description: '要等待的委派 ID 列表（缺省=当前全部）' },
        strategy: { type: 'string', enum: ['all', 'any'], description: 'all=全部收敛（默认）/ any=任一完成即返回' },
        timeout_ms: { type: 'number', description: '等待上限（毫秒，缺省 600000）' },
      },
    },
    execute: async (toolInput, ctx) => {
      const summaries = await waitForDelegations(ctx, {
        delegationIds: stringArrayOrUndefined(toolInput.delegation_ids),
        strategy: toolInput.strategy === 'any' ? 'any' : 'all',
        timeout_ms: optionalNumberOr(toolInput.timeout_ms),
      })
      return {
        output: `委派等待返回（${summaries.length} 个）：\n${formatDelegationSummaries(summaries)}`,
        detail: { summaries },
      }
    },
  }

  const get_delegation_results: AgentLoopTool = {
    name: 'get_delegation_results',
    description:
      '非阻塞读取委派子会话的状态摘要（delegation_id / role / status / goal / result_summary），不做等待。' +
      'delegation_ids 缺省 = 当前全部委派；已终结记录保留最近 50 条。',
    input_schema: {
      type: 'object',
      properties: {
        delegation_ids: { type: 'array', items: { type: 'string' }, description: '要读取的委派 ID 列表（缺省=当前全部）' },
      },
    },
    execute: async (toolInput, ctx) => {
      const ids = stringArrayOrUndefined(toolInput.delegation_ids)
      const records =
        ids && ids.length > 0
          ? ids.map((id) => {
              const record = findDelegation(ctx.sessionId, id)
              if (!record) throw new Error(`未找到当前会话下的委派: ${id}`)
              return record
            })
          : listDelegations(ctx.sessionId)
      const summaries = records.map(getDelegationSummary)
      return {
        output: `委派状态摘要（${summaries.length} 个）：\n${formatDelegationSummaries(summaries)}`,
        detail: { summaries },
      }
    },
  }

  const stop_delegation: AgentLoopTool = {
    name: 'stop_delegation',
    description:
      '停止一个委派子会话：中止其子循环、状态置 cancelled、解除正在等待它的 wait_for_delegations 阻塞，返回该委派当前摘要。',
    input_schema: {
      type: 'object',
      properties: { delegation_id: { type: 'string', description: '要停止的委派 ID' } },
      required: ['delegation_id'],
    },
    execute: async (toolInput, ctx) => {
      if (typeof toolInput.delegation_id !== 'string' || !toolInput.delegation_id.trim()) {
        return { output: '缺少 delegation_id 参数。', isError: true }
      }
      const summary = stopDelegation(ctx.sessionId, toolInput.delegation_id.trim())
      return { output: `已停止委派 ${summary.delegation_id}（status=${summary.status}）。`, detail: { ...summary } }
    },
  }

  const stop_delegations: AgentLoopTool = {
    name: 'stop_delegations',
    description: '批量停止委派子会话。delegation_ids 缺省 = 停止当前全部委派；返回被停止的委派摘要列表。',
    input_schema: {
      type: 'object',
      properties: {
        delegation_ids: { type: 'array', items: { type: 'string' }, description: '要停止的委派 ID 列表（缺省=当前全部）' },
      },
    },
    execute: async (toolInput, ctx) => {
      const summaries = stopDelegations(ctx.sessionId, stringArrayOrUndefined(toolInput.delegation_ids))
      return {
        output: `已停止 ${summaries.length} 个委派：\n${formatDelegationSummaries(summaries)}`,
        detail: { summaries },
      }
    },
  }

  // 委派化联网调研（闭环 PR5，随感 43「查资料 fork 出去」）：主 loop 上下文只进
  // ≤4000 字精干结论，原文抓取全部发生在 research 子代理（其工具面含 web_fetch）。
  const ask_delegation_question: AgentLoopTool = {
    name: 'ask_delegation_question',
    description:
      '（协作子 agent）向主 agent 提问：遇到需要用户决策、额外信息或授权确认时调用。' +
      '本工具会挂起等待主 agent 回答，回答返回后继续执行；主 agent 也可用 stop_delegation 中止。',
    input_schema: {
      type: 'object',
      properties: { question: { type: 'string', description: '要问主 agent 的问题（一次一个，需决策的具体问题）' } },
      required: ['question'],
    },
    execute: async (toolInput, ctx) => {
      if (typeof toolInput.question !== 'string' || !toolInput.question.trim()) {
        return { output: '缺少 question 参数。', isError: true }
      }
      if (ctx.state.delegation_depth < 1) {
        return { output: 'ask_delegation_question 只在委派子会话（子 agent）里可用。', isError: true }
      }
      const answer = await askDelegationQuestion(ctx, toolInput.question.trim())
      return { output: `主 agent 回答：${answer}` }
    },
  }

  const answer_delegation_question: AgentLoopTool = {
    name: 'answer_delegation_question',
    description:
      '回答委派子 agent 冒泡的问题（子 agent 调 ask_delegation_question 挂起）。' +
      '回答会回传给子 agent 的挂起点，子 agent 继续执行。用 get_delegation_results 查看哪些委派有 pending_question。',
    input_schema: {
      type: 'object',
      properties: {
        delegation_id: { type: 'string', description: '要回答的委派 ID' },
        answer: { type: 'string', description: '给子 agent 的回答（决策/信息/授权）' },
      },
      required: ['delegation_id', 'answer'],
    },
    execute: async (toolInput, ctx) => {
      const delegationId = String(toolInput.delegation_id ?? '')
      const answer = String(toolInput.answer ?? '')
      if (!delegationId.trim()) return { output: '缺少 delegation_id 参数。', isError: true }
      if (!answer.trim()) return { output: '缺少 answer 参数。', isError: true }
      const result = answerDelegationQuestion(ctx.sessionId, delegationId.trim(), answer.trim())
      return { output: `已回答委派 ${result.delegation_id} 的问题。`, detail: { ...result } }
    },
  }

  const continue_delegation: AgentLoopTool = {
    name: 'continue_delegation',
    description:
      '让一个已终结（completed/failed/cancelled）的委派继续：用新任务指令重启同一子会话（同一 child session，JSONL 追加轮）。' +
      '正在运行中的委派不能续跑（先 wait 或 stop）。适合「已拿到初稿 → 追加一轮修改/验证」。',
    input_schema: {
      type: 'object',
      properties: {
        delegation_id: { type: 'string', description: '要续跑的委派 ID（已终结）' },
        task: { type: 'string', description: '追加给子 agent 的新任务指令（自包含，含上一轮结果引用）' },
      },
      required: ['delegation_id', 'task'],
    },
    execute: async (toolInput, ctx) => {
      const delegationId = String(toolInput.delegation_id ?? '')
      const task = String(toolInput.task ?? '')
      if (!delegationId.trim()) return { output: '缺少 delegation_id 参数。', isError: true }
      if (!task.trim()) return { output: '缺少 task 参数。', isError: true }
      const result = continueDelegation(ctx, delegationId.trim(), task.trim())
      return {
        output: `已继续委派 ${result.delegation_id}（role=${result.role}，child_session=${result.child_session_id}，status=${result.status}）。用 wait_for_delegations 收集续跑结果。`,
        detail: { ...result },
      }
    },
  }
  if (role !== 'parent') {
    // 子角色（explore/research/implement/review/custom）：仅 ask 冒泡提问（M1 口径不变）
    return [ask_delegation_question]
  }
  // parent：全委派面（delegate/wait/get/stop×2/answer/continue；ask 是子侧工具不入 parent 面）
  return [delegate_agent, wait_for_delegations, get_delegation_results, stop_delegation, stop_delegations, answer_delegation_question, continue_delegation]
}

function normalizeDelegationRole(value: unknown): DelegationRole {
  if (value === 'explore' || value === 'research' || value === 'implement' || value === 'review' || value === 'custom') {
    return value
  }
  return 'custom'
}
function optionalNumberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

function formatDelegationSummaries(summaries: DelegationSummary[]): string {
  if (summaries.length === 0) return '（无委派记录）'
  return summaries
    .map((summary) => {
      const result = summary.status === 'completed' && summary.result_summary ? `｜${summary.result_summary.slice(0, 200)}` : ''
      const error = summary.error ? `｜${summary.error}` : ''
      return `- ${summary.delegation_id} role=${summary.role} status=${summary.status}${result}${error}`
    })
    .join('\n')
}

