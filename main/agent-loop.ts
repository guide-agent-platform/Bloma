import type { AgentEvent, MessageContentBlock, PromaPermissionMode } from '../shared/types'
import { getAgentSessionPath } from '../storage/config-paths'
import { appendJsonLine } from '../storage/json-store'
import { canUseTool } from './permission-service'
import type { ConversationTurn, SDKQuery, ToolDefinition } from './orchestrator'

/**
 * Agent Loop 执行器（L1，AgentLoop 改造方案 §4.2）。
 *
 * Claude Code 式观察-行动循环：模型调用（带 tools）→ tool_use → 门禁/预算 →
 * 执行 → tool_result 回填 → 再调模型；无 tool_use 即完成。与旧管道并存（PR3 flag
 * 接线），本模块不感知 13 阶段状态机——阶段仍由编排层权威控制（陷阱 3）。
 *
 * 不变式（上游 Proma 实证，§4.2 设计要点）：
 * - 同一轮响应含多个 tool_use 时**串行执行**，全部 tool_result 打包进**同一条**
 *   user 消息返回——并发提交不完整批次会触发 400 invalid_request_error。
 * - 工具异常不崩循环：任何执行错误转 is_error tool_result 回给模型自纠，
 *   AutoGPT 式死循环由预算/轮次兜底。
 * - 取消中断后 tool_result 缺席的残局：取消即终止 loop，不再发起下一次模型调用，
 *   会话 JSONL 停在最后一条完整轮次上（API 侧无残局可续）。
 */

// =========================================================================
// 契约类型（agent-tools 与编排层共用）
// =========================================================================

/** 工具执行期共享状态（同一 loop 会话内跨工具可变；agent-tools 维护语义字段）。 */
export interface AgentLoopToolState {
  /** 最近一次成功 run_preview 的预览地址（run_gwt_tests 浏览器/静态探针依赖） */
  preview_url?: string
  /** loop 内至少一次 GWT 测试失败后置位（修复预算口径的计数开关，PR3 §4.4） */
  test_failed: boolean
  /** 测试失败后的写入类工具调用次数（edit-after-test-failure 预算，默认上限 3） */
  edits_after_test_failure: number
  /** 修复回合计数（每次新出现的 GWT 失败 +1，对应旧 test_repair_count 口径） */
  repair_round: number
}

export interface ToolContext {
  projectId: string
  sessionId: string
  requestId: string
  signal: AbortSignal
  state: AgentLoopToolState
}

/** 工具产物：output 给模型看（ACI 规范），detail 只进事件流/审计不进模型上下文。 */
export interface ToolOutcome {
  output: string
  isError?: boolean
  /** true = 本次调用被预算拦截（软着陆信号，loop 据此计数连续无进展轮） */
  budgetExhausted?: boolean
  detail?: Record<string, unknown>
}

export interface AgentLoopTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>
}

export interface AgentLoopTurnInfo {
  turn: number
  toolCalls: Array<{ name: string; turn: number }>
  inputTokens?: number
  outputTokens?: number
}

export interface AgentLoopInput {
  /** 背板锚定系统提示词（PR3 由 prd.json 注入，每轮有效防漂移） */
  system: string
  /** 初始 user 消息（任务指令） */
  task: string
  tools: AgentLoopTool[]
  query: SDKQuery
  env: Record<string, string>
  sessionId: string
  projectId: string
  requestId: string
  maxTokens: number
  /** 一次模型调用 = 一轮；建议 quick=24 / longterm=40（首跑后按埋点标定） */
  maxTurns: number
  /** 按工具名计数的静态调用预算（超限软着陆，不崩循环） */
  toolBudget?: Record<string, number>
  /** 自动化管线传 allow-all（对齐 AUTOMATED_PERMISSION_MODE：warning 放行、dangerous 拒绝） */
  permissionMode: PromaPermissionMode
  temperature?: number
  signal: AbortSignal
  publish: (type: AgentEvent['type'], payload: Record<string, unknown>) => void
  /** 每轮回调（PR3 埋点 agent_loop_turn：工具清单 + usage 若渠道返回） */
  onTurn?: (info: AgentLoopTurnInfo) => void
}

export interface AgentLoopResult {
  status: 'completed' | 'turn_limit' | 'budget_exhausted' | 'cancelled'
  turns: number
  finalText: string
  toolCalls: Array<{ name: string; turn: number }>
}

/** JSONL 审计里单条 tool_result 的截断上限（全文走事件流，防 JSONL 膨胀）。 */
const JSONL_TOOL_RESULT_CHAR_LIMIT = 4096

/** 事件流里工具输入/输出摘要的截断上限。 */
const EVENT_SUMMARY_CHAR_LIMIT = 500

/** 预算耗尽软着陆：连续 2 轮仍在撞预算（无进展）才终止，给模型收尾总结机会。 */
const BUDGET_STALL_TURNS = 2

/** 传给模型的纯文本轮窗口（上下文限界；loop 中纯文本轮罕见，见 windowMessages 注释）。 */
export const TEXT_WINDOW_TURNS = 8
/** 传给模型的工具轮对窗口（assistant tool_use + user tool_result 成对保留，绝不拆对）。 */
export const TOOL_WINDOW_ROUNDS = 8

/**
 * 判断是否为工具轮：content 为块数组且含 tool_use / tool_result。
 * （loop 的 messages 中 assistant 轮必含 tool_use、user 轮必含 tool_result——
 * 无工具即返回 completed，因此 messages 里实际没有纯文本轮，F4 窗口化对象是 tool 轮对。）
 */
function isToolTurn(turn: ConversationTurn): boolean {
  return Array.isArray(turn.content) && turn.content.some((block) => block.type === 'tool_use' || block.type === 'tool_result')
}

/**
 * Agent Loop 上下文窗口化（F4）：首轮 task 恒保留，后向扫描——
 * tool 轮按 toolRounds*2 条预算保留（相邻成对 → 最近完整 N 轮，不拆 tool_use→tool_result 配对），
 * 纯文本轮按 textWindowTurns 保留；保持原顺序。JSONL 落盘不走此路径（全量审计）。
 */
export function windowMessages(messages: ConversationTurn[], textWindowTurns: number, toolRounds: number): ConversationTurn[] {
  if (messages.length === 0) return []
  const head = messages[0]
  const tail = messages.slice(1)
  let toolBudget = toolRounds * 2
  let textBudget = textWindowTurns
  const kept: ConversationTurn[] = []
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    if (isToolTurn(tail[i])) {
      if (toolBudget > 0) {
        kept.unshift(tail[i])
        toolBudget -= 1
      }
    } else if (textBudget > 0) {
      kept.unshift(tail[i])
      textBudget -= 1
    }
  }
  return [head, ...kept]
}

export function createToolState(): AgentLoopToolState {
  return { test_failed: false, edits_after_test_failure: 0, repair_round: 0 }
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const definitions: ToolDefinition[] = input.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }))
  const toolByName = new Map(input.tools.map((tool) => [tool.name, tool]))
  const budgetUsed: Record<string, number> = {}
  const toolCalls: Array<{ name: string; turn: number }> = []
  const messages: ConversationTurn[] = [{ role: 'user', content: input.task }]
  const ctx: ToolContext = {
    projectId: input.projectId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    signal: input.signal,
    state: createToolState(),
  }

  let turns = 0
  let finalText = ''
  let consecutiveBudgetStallTurns = 0

  for (let turn = 1; turn <= input.maxTurns; turn += 1) {
    if (input.signal.aborted) return loopCancelled(turns, finalText, toolCalls)

    // ---- 模型调用（L0 带 tools；messages 全量透传，system 提取由查询层负责）----
    const assistantBlocks: MessageContentBlock[] = []
    let stopReason: string | undefined
    let usage: { input_tokens?: number; output_tokens?: number } | undefined
    try {
      for await (const sdk of input.query('', {
        env: input.env,
        signal: input.signal,
        sessionId: input.sessionId,
        maxTokens: input.maxTokens,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        messages: [{ role: 'system', content: input.system }, ...windowMessages(messages, TEXT_WINDOW_TURNS, TOOL_WINDOW_ROUNDS)],
        tools: definitions,
      })) {
        if (sdk.type === 'assistant' && sdk.message) {
          assistantBlocks.push(...sdk.message.content)
          // 助手旁白照常进事件流上屏（与 runAgent 的 message_delta 语义一致）
          for (const block of sdk.message.content) {
            if (block.type === 'text' && block.text) input.publish('message_delta', { text: block.text })
          }
        } else if (sdk.type === 'result') {
          stopReason = sdk.stop_reason
          usage = sdk.usage
        }
      }
    } catch (error) {
      if (isLoopCancelled(error, input.signal)) return loopCancelled(turns, finalText, toolCalls)
      throw error
    }
    turns = turn
    finalText = textOfBlocks(assistantBlocks)
    appendLoopMessage(input.sessionId, 'assistant', assistantBlocks)

    const turnToolUses = assistantBlocks.filter((block): block is MessageContentBlock & { type: 'tool_use'; id: string; name: string } => block.type === 'tool_use')
    const turnCalls = turnToolUses.map((use) => ({ name: use.name, turn }))
    toolCalls.push(...turnCalls)
    input.onTurn?.({ turn, toolCalls: turnCalls, inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens })

    // 无 tool_use = 模型声明收工（真伪由外部强制终验收口，不信模型自述）
    if (turnToolUses.length === 0) return { status: 'completed', turns, finalText, toolCalls }

    // ---- 工具执行：串行 + 整批 tool_result 进同一条 user 消息（不变式）----
    const resultBlocks: MessageContentBlock[] = []
    let budgetStallThisTurn = false
    for (const use of turnToolUses) {
      if (input.signal.aborted) return loopCancelled(turns, finalText, toolCalls)
      input.publish('tool_call_started', {
        tool: use.name,
        turn,
        input_summary: summarizeJson(use.input),
      })
      const startedAt = Date.now()
      const outcome = await executeToolCall(input, toolByName, budgetUsed, use, ctx)
      if (outcome.budgetExhausted) budgetStallThisTurn = true
      input.publish('tool_call_completed', {
        tool: use.name,
        turn,
        status: outcome.isError ? 'error' : outcome.budgetExhausted ? 'budget' : 'ok',
        duration_ms: Date.now() - startedAt,
        output_summary: outcome.output.slice(0, EVENT_SUMMARY_CHAR_LIMIT),
        is_error: outcome.isError === true,
      })
      resultBlocks.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: outcome.output,
        ...(outcome.isError ? { is_error: true } : {}),
      })
    }
    appendLoopMessage(input.sessionId, 'user', resultBlocks)
    messages.push({ role: 'assistant', content: assistantBlocks })
    messages.push({ role: 'user', content: resultBlocks })

    consecutiveBudgetStallTurns = budgetStallThisTurn ? consecutiveBudgetStallTurns + 1 : 0
    if (consecutiveBudgetStallTurns >= BUDGET_STALL_TURNS) {
      return { status: 'budget_exhausted', turns, finalText, toolCalls }
    }
  }

  return { status: 'turn_limit', turns, finalText, toolCalls }
}

/**
 * 单次工具调用：门禁（canUseTool）→ 预算 → 执行。
 * 任何失败都转 tool_result 回给模型（拒绝/超预算/异常），绝不崩循环。
 */
async function executeToolCall(
  input: AgentLoopInput,
  toolByName: Map<string, AgentLoopTool>,
  budgetUsed: Record<string, number>,
  use: { name: string; input?: Record<string, unknown>; id?: string },
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const tool = toolByName.get(use.name)
  if (!tool) {
    return { output: `未知工具「${use.name}」。可用工具：${[...toolByName.keys()].join('、')}`, isError: true }
  }
  const toolInput = use.input ?? {}

  // 权限门禁：loop 是无人值守自动化，仅支持 allow-all（warning 放行、dangerous 交由
  // canUseTool 判定）；非 allow-all（ask/safe）直接拒绝进 is_error 让模型自纠——
  // 避免 canUseTool 在 ask 模式下落 pending 等 UI 造成永久挂起（取消信号也无法中断）。
  // 副作用：非 allow-all 下 safe 工具也一并拒绝，生产 loop 恒 allow-all，接受。
  if (input.permissionMode !== 'allow-all') {
    return { output: `权限拒绝：本次运行不允许执行「${use.name}」。请改用其他方式完成，或直接输出当前进展总结。`, isError: true }
  }
  try {
    // 与 AbortSignal 竞速（withAbort）：即便 canUseTool 意外落 pending（如未来
    // dangerous-under-allow-all），取消也能中断，绝不进程级永久阻塞。
    const permission = await withAbort(canUseTool(use.name, toolInput, input.sessionId, input.permissionMode, input.projectId), input.signal)
    if (permission.behavior === 'deny') {
      return { output: `权限拒绝：本次运行不允许执行「${use.name}」。请改用其他方式完成，或直接输出当前进展总结。`, isError: true }
    }
  } catch (error) {
    return { output: `权限检查失败：${errorMessage(error)}`, isError: true }
  }

  // 静态预算（按工具名计数）：超限软着陆——明示收尾，标记 budgetExhausted
  const budget = input.toolBudget?.[use.name]
  if (typeof budget === 'number') {
    const used = budgetUsed[use.name] ?? 0
    if (used >= budget) {
      return { output: `「${use.name}」的调用预算已用尽（上限 ${budget} 次）。请不要再调用该工具，基于已有结果输出完成总结。`, budgetExhausted: true }
    }
    budgetUsed[use.name] = used + 1
  }

  try {
    return await tool.execute(toolInput, ctx)
  } catch (error) {
    // 工具异常不崩循环：错误摘要回给模型自纠（AutoGPT 式死循环由预算/轮次兜底）
    return { output: `工具执行出错：${errorMessage(error)}`, isError: true }
  }
}

/**
 * 把 promise 与 AbortSignal 竞速：signal 已 abort 立即 reject AGENT_CANCELLED；
 * 中途 abort 也 reject（once 监听，settle 后移除）。用于把「可能永不 settle 的等待」
 * 纳入取消范围，避免进程级永久阻塞（如 ask 权限 pending）。
 */
export function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('AGENT_CANCELLED'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('AGENT_CANCELLED'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function loopCancelled(turns: number, finalText: string, toolCalls: Array<{ name: string; turn: number }>): AgentLoopResult {
  return { status: 'cancelled', turns, finalText, toolCalls }
}

/** 取消判定：中止信号已触发，或查询抛出 AbortError / AGENT_CANCELLED 家族错误。 */
function isLoopCancelled(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  if (error instanceof Error && error.name === 'AbortError') return true
  return String(error).includes('AGENT_CANCELLED')
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 500 ? `${message.slice(0, 500)}…` : message
}

function textOfBlocks(blocks: MessageContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

function summarizeJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, EVENT_SUMMARY_CHAR_LIMIT)
  } catch {
    return String(value).slice(0, EVENT_SUMMARY_CHAR_LIMIT)
  }
}

/** loop 轮次落盘：assistant 轮（含 tool_use）与 user 轮（tool_result）照常 append JSONL。 */
function appendLoopMessage(sessionId: string, role: 'assistant' | 'user', blocks: MessageContentBlock[]): void {
  appendJsonLine(getAgentSessionPath(sessionId), {
    role,
    content: blocks.map((block) =>
      block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > JSONL_TOOL_RESULT_CHAR_LIMIT
        ? { ...block, content: `${block.content.slice(0, JSONL_TOOL_RESULT_CHAR_LIMIT)}…[截断，全文见事件流]` }
        : block,
    ),
    timestamp: Date.now(),
  })
}
