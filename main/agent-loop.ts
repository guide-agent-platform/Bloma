import type { AgentEvent, AgentLoopStatus, MessageContentBlock, PastedImageRef, PromaPermissionMode } from '../shared/types'
import { getAgentSessionPath } from '../storage/config-paths'
import { appendJsonLine } from '../storage/json-store'
import { canUseTool } from './permission-service'
import type { ConversationTurn, SDKQuery, ToolDefinition } from './orchestrator'
import { prepareTaskWithSkills } from './skill-loader'
import { prepareRecallBlock } from './session-recall'
import { estimateTokenCount } from './usage-guard'
import { windowMessagesWithDigest } from './compacting-window'

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
  /** 最近一次 run_gwt_tests 是否全过（收口判定：与 security_all_passed 同时成立 → 强制收尾总结） */
  gwt_all_passed: boolean
  /** 最近一次 run_security_scan 是否通过（收口判定，同上） */
  security_all_passed: boolean
  /** 测试失败后的写入类工具调用次数（edit-after-test-failure 预算，默认上限 3） */
  edits_after_test_failure: number
  /** 修复回合计数（每次新出现的 GWT 失败 +1，对应旧 test_repair_count 口径） */
  repair_round: number
  /** 委派深度（0=主 agent；子 agent = 父深度+1。委派工具据此判深，≥1 禁止再派） */
  delegation_depth: number
}

export interface ToolContext {
  projectId: string
  sessionId: string
  requestId: string
  signal: AbortSignal
  state: AgentLoopToolState
  /** 当前工具调用的 tool_use_id（executeToolCall 每次执行前设置；委派等有副作用工具用它做幂等键） */
  toolCallId?: string
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
  /** 委派深度（缺省 0 = 主 agent；子 agent = 父深度+1，写入工具 state） */
  delegationDepth?: number
  /** 续跑重放历史轮次（delegation continue 阶段 3，2026-08-28 队友）：作为 messages 开头
   * 传入模型，task 仍是最新 user 轮；不写入 JSONL——重放轮已在子会话文件里 */
  historyTurns?: ConversationTurn[]
  /** omit 推广（2026-08-27 队友）：透传父渠道 providerType，Token Plan 类渠道免 400 往返 */
  providerType?: string
  /** 剪贴板粘贴图片引用（clipboard-paste P1，2026-08-29 队友）：与 task 同轮组装 [text, ...image] 块数组 */
  images?: PastedImageRef[]
  /** 会话级 usage 聚合（费用守卫 Hook 1，2026-08-28 队友）：渠道不返回 usage 时
   * turnsWithUsage=0，estContextTokens（估算器）成为唯一占用信号。估算为启发式，
   * 只作守卫/展示不作计费 */
  usage?: { inputTokens: number; outputTokens: number; estContextTokens: number; turnsWithUsage: number }
  temperature?: number
  signal: AbortSignal
  publish: (type: AgentEvent['type'], payload: Record<string, unknown>) => void
  /** 每轮回调（PR3 埋点 agent_loop_turn：工具清单 + usage 若渠道返回） */
  onTurn?: (info: AgentLoopTurnInfo) => void
}

export interface AgentLoopResult {
  status: AgentLoopStatus
  turns: number
  finalText: string
  toolCalls: Array<{ name: string; turn: number }>
  /** 会话级 usage 聚合（费用守卫 Hook 1，2026-08-28 队友）：逐轮累计渠道返回 usage + 全块口径估算 */
  usage?: { inputTokens: number; outputTokens: number; estContextTokens: number; turnsWithUsage: number }
}

/** JSONL 审计里单条 tool_result 的截断上限（全文走事件流，防 JSONL 膨胀）。 */
const JSONL_TOOL_RESULT_CHAR_LIMIT = 4096

/** 事件流里工具输入/输出摘要的截断上限。 */
const EVENT_SUMMARY_CHAR_LIMIT = 500

/** 预算耗尽软着陆：连续 2 轮仍在撞预算（无进展）才终止，给模型收尾总结机会。 */
const BUDGET_STALL_TURNS = 2

/**
 * 收口指令（2026-08-29 线上案例 eb900c57）：GWT 全过 + 安全扫描通过 = 平台意义上的
 * 「活已干完」。此后停用全部工具并在 system 追加收口指令，逼模型立即输出完成总结——
 * 该案例第 20 轮测试/扫描已全过，最后 4 轮却继续冗余验证，把「交卷」挤出了 24 轮预算。
 */
const WRAP_UP_SUFFIX =
  '\n\n【收口】run_gwt_tests 与 run_security_scan 都已全部通过，任务已经完成。' +
  '不要再调用任何工具、不要再做任何检查，立即输出最终完成总结。'

/**
 * 宽限收口轮指令：轮次预算耗尽时的最后一口气——工具已全部停用，只给模型一次纯文本
 * 交卷机会（出总结 → completed；仍坚持要工具 → 如实 turn_limit）。
 */
const GRACE_TURN_SUFFIX =
  '\n\n【收尾】轮次预算已用尽，所有工具已停用。请立即基于当前进展输出最终完成总结：' +
  '哪些功能已完成、哪些未完成或仍有问题。不要再尝试调用工具。'

// ---- usage 竹节压缩（闭环 PR6，随感 14/15/38）----

/** 触发阈值缺省（input tokens）；标定依据由 PR8 脚本回填（拍板项 B 首版值）。 */
const LOOP_COMPACT_INPUT_TOKENS_DEFAULT = 100_000
/** 每 loop 至多压缩次数：task + 2 次交接 = 3 节（随感 38 竹节≤3 节）。 */
const LOOP_MAX_COMPACTIONS = 2
/** 交接调用（无 tools 小请求）的 maxTokens。 */
const LOOP_HANDOFF_MAX_TOKENS = 1024
const LOOP_HANDOFF_SYSTEM =
  '你是工程交接助手。把当前进展压缩成交接文档：已完成/未解决（含失败的测试断言原文）/下一步。不超过 600 字，保留文件名、报错原文等关键细节。'

/** 阈值可环境覆盖（'0' = 关闭）；无效值回缺省。每次 runAgentLoop 读取（便于测试与运行时调整）。 */
function resolveCompactThreshold(): number {
  const raw = process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS
  if (raw === undefined || raw.trim() === '') return LOOP_COMPACT_INPUT_TOKENS_DEFAULT
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : LOOP_COMPACT_INPUT_TOKENS_DEFAULT
}

/** 交接模型不可用时的确定性拼装（零 LLM 兑底；含钉轮失败断言原文，审查 P1-2）。 */
function deterministicHandoff(
  turn: number,
  toolCalls: Array<{ name: string }>,
  finalText: string,
  failureExcerpt: string,
): string {
  const counts = new Map<string, number>()
  for (const call of toolCalls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  const usage = [...counts.entries()].map(([name, count]) => `${name}×${count}`).join('、')
  const parts = [
    `【自动交接（交接模型不可用）】已进行到第 ${turn} 轮，工具调用：${usage || '（无）'}。`,
    failureExcerpt ? `未解决的测试失败（原文）：${failureExcerpt}` : '',
    finalText.trim() ? `最近说明：${finalText.trim().slice(0, 200)}` : '',
  ]
  return parts.filter(Boolean).join('\n')
}

/** 钉轮对的 tool_result 文本（确定性交接兑底用，截 400 字；钉轮失效/未钉返回空）。 */
function pinnedFailureExcerpt(messages: ConversationTurn[], pinnedTurn: number | undefined): string {
  if (pinnedTurn === undefined) return ''
  const a = 2 * (pinnedTurn - 1)
  const pair = messages.slice(1 + a, 1 + a + 2)
  if (pair.length < 2) return ''
  const texts: string[] = []
  for (const turn of pair) {
    if (!Array.isArray(turn.content)) continue
    for (const block of turn.content) {
      if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.trim()) {
        texts.push(block.content)
      }
    }
  }
  return texts.join('\n').slice(0, 400)
}

/** 一次无 tools 的交接小调用（复用 input.query/env 同渠道）；任何失败返回 '' 交由确定性兑底。 */
async function requestHandoff(input: AgentLoopInput, messages: ConversationTurn[], pinnedTestTurn: number | undefined): Promise<string> {
  let text = ''
  try {
    for await (const sdk of input.query('', {
      env: input.env,
      signal: input.signal,
      sessionId: input.sessionId,
      maxTokens: LOOP_HANDOFF_MAX_TOKENS,
      messages: [
        { role: 'system', content: LOOP_HANDOFF_SYSTEM },
        // 钉轮一并携带（PR2）：交接文档必须看得到首个测试失败轮的断言原文
        ...windowMessages(messages, TEXT_WINDOW_TURNS, TOOL_WINDOW_ROUNDS, pinnedTestTurn),
      ],
    })) {
      if (sdk.type === 'assistant' && sdk.message) {
        for (const block of sdk.message.content) {
          if (block.type === 'text' && block.text) text += block.text
        }
      }
    }
  } catch {
    return ''
  }
  return text.trim()
}

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
 *
 * 钉轮（闭环治理 PR2，对抗审查 M2 取舍落地）：pinnedTurn 指向首个 test_failed 轮（1-based），
 * 该轮的 assistant+user 对在窗口预算之外恒保留——长循环下第 1 次 run_gwt_tests 失败的
 * 断言细节不会随 8 轮硬窗口出窗，模型修复不再重复踩已修过的坑。只钉完整对
 * （角色成对且都是工具轮）；对不完整（cancelled 残局）不钉，退化为固定窗口。
 */
/**
 * 窗口分区（compacting-window 移植的重构基础，2026-08-28 队友）：同一后向扫描算法，
 * 同时返回保留集与驱逐集。windowMessages 基于它保持原行为；windowMessagesWithDigest
 * 基于驱逐集生成摘要。pinnedTurn 支持本地钉轮（首个测试失败轮恒保留，不占窗口预算）。
 */
export function partitionWindow(
  messages: ConversationTurn[],
  textWindowTurns: number,
  toolRounds: number,
  pinnedTurn?: number,
): { head: ConversationTurn | null; kept: ConversationTurn[]; evicted: ConversationTurn[] } {
  if (messages.length === 0) return { head: null, kept: [], evicted: [] }
  const head = messages[0]
  const tail = messages.slice(1)
  // pinnedTurn t 的对 = tail[2(t-1)]（assistant tool_use）+ tail[2(t-1)+1]（user tool_result）
  const pinned = new Set<number>()
  if (pinnedTurn !== undefined) {
    const a = 2 * (pinnedTurn - 1)
    const b = a + 1
    const assistant = tail[a]
    const result = tail[b]
    if (
      assistant && result &&
      assistant.role === 'assistant' && isToolTurn(assistant) &&
      result.role === 'user' && isToolTurn(result)
    ) {
      pinned.add(a)
      pinned.add(b)
    }
  }
  let toolBudget = toolRounds * 2
  let textBudget = textWindowTurns
  const keptIdx = new Set<number>()
  for (const idx of pinned) keptIdx.add(idx) // 钉住的对恒保留（不占预算）
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    if (pinned.has(i)) continue
    if (isToolTurn(tail[i])) {
      if (toolBudget > 0) {
        keptIdx.add(i)
        toolBudget -= 1
      }
    } else if (textBudget > 0) {
      keptIdx.add(i)
      textBudget -= 1
    }
  }
  const kept = [...keptIdx].sort((a, b) => a - b).map((i) => tail[i])
  const evicted = tail.filter((_, i) => !keptIdx.has(i))
  return { head, kept, evicted }
}

export function windowMessages(
  messages: ConversationTurn[],
  textWindowTurns: number,
  toolRounds: number,
  pinnedTurn?: number,
): ConversationTurn[] {
  const { head, kept } = partitionWindow(messages, textWindowTurns, toolRounds, pinnedTurn)
  if (!head) return []
  return [head, ...kept]
}

/** 占用估算文本：text 正文 + tool_result 内容 + tool_use input 序列化 + image 占位（全块口径，r55 队友）。 */
export function estimateBlocksText(blocks: MessageContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === 'text') return b.text ?? ''
      if (b.type === 'tool_result') return typeof b.content === 'string' ? b.content : ''
      if (b.type === 'tool_use') return JSON.stringify(b.input ?? {})
      if (b.type === 'image') return '[图片]' // clipboard-paste P1：防用量估算漏计图片块（占位口径，非 base64）
      return ''
    })
    .join('\n')
}

/** 畸形粘贴引用过滤（fuzz 加固，S4-AGENT-093 队友）：非对象/缺 imageId/非法 media_type/穿越串一律滤除 */
function sanitizePastedImageRefs(images?: PastedImageRef[]): PastedImageRef[] {
  if (!images?.length) return []
  return images.filter((r): r is PastedImageRef => {
    if (!r || typeof r !== 'object' || typeof r.imageId !== 'string' || typeof r.media_type !== 'string') return false
    return /^[A-Za-z0-9_-]+\/[A-Za-z0-9-]+\.(png|jpeg|jpg|gif|webp)$/.test(r.imageId)
  })
}

export function createToolState(delegationDepth = 0): AgentLoopToolState {
  return {
    test_failed: false,
    gwt_all_passed: false,
    security_all_passed: false,
    edits_after_test_failure: 0,
    repair_round: 0,
    delegation_depth: delegationDepth,
  }
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
  // continue 重放（阶段 3，2026-08-28 队友）：历史轮次前缀不写入 JSONL（已在子会话文件里），仅进模型上下文
  // skill 机制（2026-08-28）：任务含 /skill: 命令时从两级白名单根前置注入（无命令零 IO）。
  // 注入块只随当条 user 消息进窗口（digest/窗口自然滑出），不污染 system；
  // JSONL 落注入后文本——审计=模型实际所见，continue 重放一致。
  // 跨会话检索（guidance v5 ②）：主 loop（depth 0）指代词任务前置 <session-recall> 历史摘录
  // （模块内失败静默）；与 skill 注入一次拼接，任务原文始终在最后。
  const [skillPrep, recallBlock] = await Promise.all([
    prepareTaskWithSkills(input.task, input.projectId),
    prepareRecallBlock(input.task, input.delegationDepth ?? 0),
  ])
  const task = recallBlock ? `${recallBlock}\n${skillPrep.content}` : skillPrep.content
  // clipboard-paste P1（2026-08-29）：带图时首条 user 轮为 [text, ...image 短引用] 块数组；
  // 水合只在 anthropicMessagesQuery 请求体边界发生（JSONL/模型历史全程轻量）。
  const pastedImageRefs = sanitizePastedImageRefs(input.images)
  const taskBlocks: MessageContentBlock[] | undefined = pastedImageRefs.length
    ? [
        { type: 'text', text: task },
        ...pastedImageRefs.map((r) => ({ type: 'image' as const, imageId: r.imageId, media_type: r.media_type })),
      ]
    : undefined
  const messages: ConversationTurn[] = [
    ...(input.historyTurns ?? []),
    taskBlocks ? { role: 'user' as const, content: taskBlocks } : { role: 'user' as const, content: task },
  ]
  // 初始 task 落盘（审计完整性：JSONL 是子会话全量审计，缺首条 user 会让 continue 重放丢任务原文）
  appendLoopMessage(input.sessionId, 'user', taskBlocks ?? [{ type: 'text', text: task }])
  const ctx: ToolContext = {
    projectId: input.projectId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    signal: input.signal,
    state: createToolState(input.delegationDepth ?? 0),
  }

  let turns = 0
  let finalText = ''
  let consecutiveBudgetStallTurns = 0
  // 费用守卫 Hook 1（2026-08-28 队友）：逐轮累计渠道返回 usage（渠道不返回即全盲 → estContextTokens 兜底）
  const usageTotals = { inputTokens: 0, outputTokens: 0, turnsWithUsage: 0 }
  const attachUsage = (r: AgentLoopResult): AgentLoopResult => {
    // 渲染层透明条数据源（v6 ② b）：loop 结束发布 usage_summary 事件（取消/熔断路径同样发布——用量是事实）
    const estContextTokens = estimateTokenCount(
      messages
        .map((m) => (typeof m.content === 'string' ? m.content : estimateBlocksText(m.content)))
        .join('\n'),
    )
    input.publish('usage_summary', {
      session_id: input.sessionId,
      input_tokens: usageTotals.inputTokens,
      output_tokens: usageTotals.outputTokens,
      est_context_tokens: estContextTokens,
      turns_with_usage: usageTotals.turnsWithUsage,
    })
    return {
      ...r,
      usage: {
        inputTokens: usageTotals.inputTokens,
        outputTokens: usageTotals.outputTokens,
        turnsWithUsage: usageTotals.turnsWithUsage,
        // 全块口径（r55 low 池采纳）：tool_result 内容与 tool_use input 都占上下文，
        // text-only 口径在渠道全盲时会严重低估占用。
        estContextTokens,
      },
    }
  }
  // 收口态：GWT 全过 + 安全扫描通过后置位，此后模型调用停用全部工具并追加收口指令
  let wrapUp = false
  // 首个 test_failed 轮（窗口钉轮，只钉一次）：修复全程可见第一次测试失败的断言细节。
  // 相对轮号（turn - pinBaseTurn）：压缩重置后 tail 从零计数，索引映射恒成立（审查 P1-1）
  let pinnedTestTurn: number | undefined
  let pinBaseTurn = 0
  // 已被钉轮/交接覆盖到的 repair_round：防粘性 test_failed 在压缩后幻影重钉（审查 P1-1）
  let pinnedRepairRound = 0
  // 已压缩次数（竹节压缩，闭环 PR6）
  let compactions = 0
  const compactThreshold = resolveCompactThreshold()

  for (let turn = 1; turn <= input.maxTurns; turn += 1) {
    if (input.signal.aborted) return attachUsage(loopCancelled(turns, finalText, toolCalls))

    // ---- 模型调用（L0 带 tools；messages 全量透传，system 提取由查询层负责）----
    const assistantBlocks: MessageContentBlock[] = []
    // 网关脏增量清洗 + 文本整段化（2026-08-25 线上案例）：ds 渠道在带 tools 的流式
    // 响应里会往 token 增量之间插入字面 "\n\n" 的独立纯空白增量（有时连发多个），
    // 裸拼接会让旁白「每词一段」；同时把连续 text 增量合并为单块落盘（对齐 guide
    // 路径的整段化，JSONL 不再落几百个碎块）。
    const cleaner = createWhitespaceArtifactCleaner()
    const textParts: string[] = []
    const emitText = (text: string): void => {
      // 助手旁白照常进事件流上屏（与 runAgent 的 message_delta 语义一致）
      input.publish('message_delta', { text })
      textParts.push(text)
    }
    const flushTextRun = (): void => {
      for (const piece of cleaner.end()) emitText(piece)
      if (textParts.length > 0) {
        assistantBlocks.push({ type: 'text', text: textParts.join('') })
        textParts.length = 0
      }
    }
    let stopReason: string | undefined
    let usage: { input_tokens?: number; output_tokens?: number } | undefined
    try {
      for await (const sdk of input.query('', {
        env: input.env,
        signal: input.signal,
        sessionId: input.sessionId,
        maxTokens: input.maxTokens,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.providerType !== undefined ? { providerType: input.providerType } : {}),
        messages: [{ role: 'system', content: wrapUp ? `${input.system}${WRAP_UP_SUFFIX}` : input.system }, ...windowMessagesWithDigest(messages, TEXT_WINDOW_TURNS, TOOL_WINDOW_ROUNDS, pinnedTestTurn)],
        tools: wrapUp ? [] : definitions,
      })) {
        if (sdk.type === 'assistant' && sdk.message) {
          for (const block of sdk.message.content) {
            if (block.type === 'text' && block.text) {
              for (const piece of cleaner.push(block.text)) emitText(piece)
            } else {
              // tool_use 块前先把挂起的空白与文本段收口，保持块序与流序一致
              flushTextRun()
              assistantBlocks.push(block)
            }
          }
        } else if (sdk.type === 'result') {
          stopReason = sdk.stop_reason
          usage = sdk.usage
        }
      }
      flushTextRun()
    } catch (error) {
      if (isLoopCancelled(error, input.signal)) return attachUsage(loopCancelled(turns, finalText, toolCalls))
      throw error
    }
    if (usage) {
      usageTotals.inputTokens += usage.input_tokens ?? 0
      usageTotals.outputTokens += usage.output_tokens ?? 0
      usageTotals.turnsWithUsage += 1
    }
    turns = turn
    finalText = textOfBlocks(assistantBlocks)
    appendLoopMessage(input.sessionId, 'assistant', assistantBlocks)

    const turnToolUses = assistantBlocks.filter((block): block is MessageContentBlock & { type: 'tool_use'; id: string; name: string } => block.type === 'tool_use')
    const turnCalls = turnToolUses.map((use) => ({ name: use.name, turn }))
    toolCalls.push(...turnCalls)
    input.onTurn?.({ turn, toolCalls: turnCalls, inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens })

    // 无 tool_use = 模型声明收工（真伪由外部强制终验收口，不信模型自述）
    if (turnToolUses.length === 0) return attachUsage({ status: 'completed', turns, finalText, toolCalls })

    // ---- 工具执行：串行 + 整批 tool_result 进同一条 user 消息（不变式）----
    const resultBlocks: MessageContentBlock[] = []
    let budgetStallThisTurn = false
    for (const use of turnToolUses) {
      if (input.signal.aborted) return attachUsage(loopCancelled(turns, finalText, toolCalls))
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
        // M4-C：结构化 detail 透传进事件流（委派工具返回 id/role/status 等，渲染端据此派生协作视图）。
        // 限字段白名单（防敏感/超长数据泄漏）：只取委派工具的标识与状态字段，丢弃 result_summary 等长文本。
        ...(outcome.detail ? { detail: sanitizeToolDetail(outcome.detail) } : {}),
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
    // 钉轮信号：出现「新的」测试失败（repair_round 增长；粘性 test_failed 不算）且
    // 尚未钉过 → 钉本轮（相对轮号）
    if (ctx.state.test_failed && ctx.state.repair_round > pinnedRepairRound) {
      if (pinnedTestTurn === undefined) pinnedTestTurn = turn - pinBaseTurn
      pinnedRepairRound = ctx.state.repair_round
    }

    // 收口判定（2026-08-29 线上案例 eb900c57）：GWT 全过 + 安全扫描通过 = 活已干完，
    // 下一轮起停用全部工具 + system 追加收口指令，逼模型交卷而非继续冗余验证。
    wrapUp = ctx.state.gwt_all_passed && ctx.state.security_all_passed

    consecutiveBudgetStallTurns = budgetStallThisTurn ? consecutiveBudgetStallTurns + 1 : 0
    if (consecutiveBudgetStallTurns >= BUDGET_STALL_TURNS) {
      return attachUsage({ status: 'budget_exhausted', turns, finalText, toolCalls })
    }

    // ---- usage 竹节压缩（闭环 PR6）：阈值触发交接，重置为 task+交接文档 ----
    if (
      compactThreshold > 0 &&
      (usage?.input_tokens ?? 0) >= compactThreshold &&
      compactions < LOOP_MAX_COMPACTIONS &&
      turn < input.maxTurns - 3
    ) {
      if (input.signal.aborted) return attachUsage(loopCancelled(turns, finalText, toolCalls))
      const handoff = await requestHandoff(input, messages, pinnedTestTurn)
      if (input.signal.aborted) return attachUsage(loopCancelled(turns, finalText, toolCalls))
      // 确定性兑底也携带钉轮失败断言原文（审查 P1-2：交接失败恰是最需要细节的降级路径）
      const summary = handoff || deterministicHandoff(turn, toolCalls, finalText, pinnedFailureExcerpt(messages, pinnedTestTurn))
      messages.length = 0
      messages.push({ role: 'user', content: `${input.task}\n\n【此前进度交接（第 ${compactions + 1} 段）】\n${summary}` })
      compactions += 1
      // 重置钉轮坐标系（审查 P1-1）：基线推进到本轮，旧失败已被交接文档覆盖（repair_round
      // 快照对齐，后续只有新失败才重钉；避免粘性 test_failed 幻影钉在无关轮对上）
      pinBaseTurn = turn
      pinnedTestTurn = undefined
      pinnedRepairRound = ctx.state.repair_round
      input.publish('loop_compaction', { at_turn: turn, input_tokens: usage?.input_tokens, compactions })
      // 交接文档落 JSONL 审计（与 [channel-switch] 同一 system 行呈现模式，审查 P1-2）
      appendJsonLine(getAgentSessionPath(input.sessionId), {
        role: 'system',
        content: [{ type: 'text', text: `[loop-compaction] 第 ${compactions} 段交接（at_turn=${turn}，input_tokens=${usage?.input_tokens ?? '-'}）：\n${summary.slice(0, 1000)}` }],
        timestamp: Date.now(),
      })
    }
  }

  // ---- 宽限收口轮（2026-08-29 线上案例 eb900c57）：预算耗尽不再直接判 turn_limit ----
  // 该案例产物第 20 轮已全部就绪（测试/扫描全过），只差「输出完成总结」这个动作被挤掉。
  // 补一次无 tools 的收口调用让模型交卷：出文本 → completed（外部终验仍照跑，不信自述）；
  // 仍坚持要工具 → 如实 turn_limit。宽限轮不计 turns、不发 onTurn（epilogue 不是工作轮）。
  const grace = await runGraceWrapUpTurn(input, messages, pinnedTestTurn)
  if (grace.kind === 'text') return attachUsage({ status: 'completed', turns, finalText: grace.text, toolCalls })
  if (grace.kind === 'cancelled') return attachUsage(loopCancelled(turns, finalText, toolCalls))
  return attachUsage({ status: 'turn_limit', turns, finalText, toolCalls })
}

type GraceWrapUpOutcome = { kind: 'text'; text: string } | { kind: 'refused' } | { kind: 'cancelled' } | { kind: 'failed' }

/**
 * 宽限收口轮：maxTurns 耗尽后的无 tools 交卷调用（GRACE_TURN_SUFFIX 见注释）。
 * 文本照常进事件流上屏 + JSONL 审计；取消 → cancelled；其余失败按 turn_limit 兜底
 * （工作轮的结果才是主体，宽限轮失败不翻盘）。
 */
async function runGraceWrapUpTurn(
  input: AgentLoopInput,
  messages: ConversationTurn[],
  pinnedTestTurn: number | undefined,
): Promise<GraceWrapUpOutcome> {
  if (input.signal.aborted) return { kind: 'cancelled' }
  const blocks: MessageContentBlock[] = []
  const textParts: string[] = []
  const cleaner = createWhitespaceArtifactCleaner()
  const flushText = (): void => {
    if (textParts.length === 0) return
    blocks.push({ type: 'text', text: textParts.join('') })
    textParts.length = 0
  }
  try {
    for await (const sdk of input.query('', {
      env: input.env,
      signal: input.signal,
      sessionId: input.sessionId,
      maxTokens: input.maxTokens,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      messages: [
        { role: 'system', content: `${input.system}${GRACE_TURN_SUFFIX}` },
        ...windowMessagesWithDigest(messages, TEXT_WINDOW_TURNS, TOOL_WINDOW_ROUNDS, pinnedTestTurn),
      ],
      // 空数组而非缺省：与「无 tools 的交接调用」在调用方可区分（tools === undefined）
      tools: [],
    })) {
      if (sdk.type === 'assistant' && sdk.message) {
        for (const block of sdk.message.content) {
          if (block.type === 'text' && block.text) {
            const pieces = cleaner.push(block.text)
            for (const piece of pieces) input.publish('message_delta', { text: piece })
            textParts.push(...pieces)
          } else {
            flushText()
            blocks.push(block)
          }
        }
      }
    }
    for (const piece of cleaner.end()) {
      input.publish('message_delta', { text: piece })
      textParts.push(piece)
    }
    flushText()
  } catch (error) {
    if (isLoopCancelled(error, input.signal)) return { kind: 'cancelled' }
    console.error('[agent-loop] 宽限收口轮失败，按 turn_limit 收口:', errorMessage(error))
    return { kind: 'failed' }
  }
  appendLoopMessage(input.sessionId, 'assistant', blocks)
  if (blocks.some((block) => block.type === 'tool_use')) return { kind: 'refused' }
  return { kind: 'text', text: textOfBlocks(blocks) }
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
  ctx.toolCallId = use.id
  const toolInput = use.input ?? {}

  // 权限门禁：loop 是无人值守自动化，仅支持 allow-all（warning 放行、dangerous 交由
  // canUseTool 判定）；非 allow-all（ask/safe）直接拒绝进 is_error 让模型自纠——
  // 避免 canUseTool 在 ask 模式下落 pending 等 UI 造成永久挂起（取消信号也无法中断）。
  // 副作用：非 allow-all 下 safe 工具也一并拒绝，生产 loop 恒 allow-all，接受
  //（该行为已由 tests/unit/agent-loop-permission.test.ts 锁定，防未来无意放宽）。
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

interface WhitespaceArtifactCleaner {
  /** 喂入一个 text 增量，返回应立即放行的增量（0~2 段）。 */
  push(text: string): string[]
  /** 流结束/遇到非文本块：把挂起的空白如实放行（一次性，幂等）。 */
  end(): string[]
}

/**
 * 网关脏增量清洗器（2026-08-25 线上实测，ds 渠道带 tools 的流）：
 * token 增量之间被插入字面 "\n\n" 的独立纯空白增量（词块本身自带前导空格）。
 * 判据：纯空白增量先挂起——后继增量以空白开头 → 必是词间工件（模型原文不可能
 * 是「词\n\n 词」形态），连同此前累积的空白一并丢弃；后继以非空白开头（如合法
 * 段落分隔 "\n\n## 标题"）或流结束/遇到工具块 → 如实保留。
 * 已知取舍：罕见 markdown「空行 + 行首空格」会被误并入上一段，视觉损失远小于
 * 当前「每词一段」的污染，接受。
 */
function createWhitespaceArtifactCleaner(): WhitespaceArtifactCleaner {
  let pending = ''
  return {
    push(text: string): string[] {
      if (text.trim() === '') {
        pending += text
        return []
      }
      if (pending !== '') {
        if (/^\s/.test(text)) {
          pending = ''
          return [text]
        }
        const kept = pending
        pending = ''
        return [kept, text]
      }
      return [text]
    },
    end(): string[] {
      if (pending === '') return []
      const kept = pending
      pending = ''
      return [kept]
    },
  }
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

/**
 * tool_call_completed 的 detail 白名单透传（M4-C §7 限字段）：
 * 只取委派工具的结构化标识/状态（delegation_id / child_session_id / role / goal / status /
 * pending_question / error），丢弃 result_summary 等可能超长/含敏感内容的长文本字段。
 * 无白名单命中返回 undefined（该工具无 detail 或 detail 无委派字段，事件不带 detail）。
 */
const TOOL_DETAIL_SAFE_KEYS = [
  'delegation_id',
  'child_session_id',
  'role',
  'goal',
  'status',
  'pending_question',
  'error',
] as const

function sanitizeToolDetail(detail: Record<string, unknown>): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {}
  for (const key of TOOL_DETAIL_SAFE_KEYS) {
    if (detail[key] !== undefined) result[key] = detail[key]
  }
  return Object.keys(result).length > 0 ? result : undefined
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
