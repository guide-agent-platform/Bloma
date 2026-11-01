import type { AgentEvent, AgentLoopStatus, LoopTerminationDetail, LoopValidationSnapshot, MessageContentBlock, PastedImageRef, PromaPermissionMode } from '../../../shared/types'
import type { ConversationTurn, SDKQuery } from '../../orchestration/orchestrator'
import type { ToolFeedback } from '../../../shared/tool-feedback'
import { appendSessionMessage } from '../../platform/sessions/session-tree'
import { buildAttachmentTools } from '../tools/attachment-tools'
import { materialImageRefs, renderMaterialContext } from '../../platform/attachments/material-context'
import { canUseTool } from '../permissions/permission-service'
import { appendLoopPromptOverride } from '../prompting/prompt-config'
import { estimateTokenCount } from './usage-guard'
import { closePreviewBrowserSession } from '../../coding/preview-browser'
import { drainSteerQueue, markLoopActive, markLoopInactive, settleSteerEntry, steerConfirmEnabled, wrapSteerContent } from './steer-queue'

/** Pi owns the sole model/tool loop, persistence, retries and compaction.
 * Bloma retains its public tool contracts, permission/budget admission,
 * material injection and user-steering lifecycle. */


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
 * - 取消中断后的残局：取消即终止 loop，不再发起下一次模型调用；流式中途取消时
 *   已累积的半截 assistant 文本（不含悬空 tool_use）会如实落盘取证（2026-09-04
 *   「查。」墙案：退行重复只在流中可见、事后考察不到的问题由此消除）；可重放的
 *   历史面不进残局（tool_use 无 tool_result 配对的一律不落）。
 */

// =========================================================================
// 契约类型（agent-tools 与编排层共用）
// =========================================================================

/** 工具执行期共享状态（同一 loop 会话内跨工具可变；agent-tools 维护语义字段）。 */
export interface AgentLoopToolState {
  /** Host-owned work scope, shared across executors in one production phase. */
  execution_scope?: string
  latest_tool_feedback?: Record<string, ToolFeedback>
  terminal_budget_feedback?: Record<string, ToolFeedback>
  successful_file_changes?: string[]
  /** 最近一次成功 run_preview 的预览地址（run_gwt_tests 浏览器/静态探针依赖） */
  preview_url?: string
  /** loop 内至少一次 GWT 测试失败后置位（修复预算口径的计数开关，PR3 §4.4） */
  test_failed: boolean
  /** 最近一次 run_gwt_tests 是否全过（收口判定：与 security_all_passed 同时成立 → 强制收尾总结） */
  gwt_all_passed: boolean
  /** 最近一次 run_security_scan 是否通过（收口判定，同上） */
  security_all_passed: boolean
  /** D1（咨询 D，2026-09-09）：API 契约验证通过位。初始化按背板预置——声明了
   * interface_spec 的项目 false（跑了 run_api_contract_tests 全过才 true），无契约
   * 项目 true（豁免）。确定性由宿主维护，不靠模型自报；仅 BLOMA_API_TOOL=on 时进收口判定。 */
  api_all_passed: boolean
  /** W3-D1（咨询 D2，2026-09-09）：收口预检通过位（run_preflight 全阶段过才 true）。
   * 仅 BLOMA_PREFLIGHT=on 时进收口判定；undefined=未跑。 */
  preflight_passed?: boolean
  /** D3 轻量：上一次 run_gwt_tests 的失败场景名集合（本轮对比标 [新增]/[持续]，防重复修同一失败） */
  last_gwt_failures?: string[]
  /** W2-F4：run_gwt_tests 执行计数（终验 source 分类的「loop 是否自测过」判据）；无开关常更（纯内部状态） */
  gwt_runs?: number
  /** W2-F4：run_api_contract_tests 执行计数（同上，API 契约覆盖缺口判据） */
  api_contract_runs?: number
  /** D4a：本轮已读文件的版本戳（path → rev）；edit_file 的 expected_revision 校验与 write_file 守卫共用 */
  file_revisions?: Map<string, string>
  /** W2（Phase 10，2026-09-16）：模型已登记的显式压缩请求（compact_context 工具置位；
   *  loop 在本轮工具结果落盘后与自动压缩同路径处理并复位） */
  compact_requested?: boolean
  /** W2：已完成的显式压缩次数（上限 MAX_EXPLICIT_COMPACTIONS，由 loop 在实际压缩后自增） */
  explicit_compactions?: number
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


/** output is evidence text; host feedback is shared with model history and events. */
export interface ToolOutcome {
  output: string
  /** Host-stored image references only; bytes hydrate at the existing transport boundary. */
  images?: PastedImageRef[]
  isError?: boolean
  /** true = 本次调用被预算拦截（软着陆信号，loop 据此计数连续无进展轮） */
  budgetExhausted?: boolean
  detail?: Record<string, unknown>
  feedback?: ToolFeedback
}


export interface AgentLoopTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
  /**
   * 只读并行声明（P1-2，2026-09-08 pi 差距方案 §4）：true = 可与其他 parallelSafe 工具
   * 同轮并发（无共享状态序依赖）。v1 白名单只读五件套：read_file / list_files / grep /
   * web_fetch / web_research。默认缺省 false（写类/测试/委派/权限类一律串行——状态序依赖：
   * test_failed 旗标、修复预算计数、预览地址、委派状态机）。**有 toolBudget 预算的工具
   * 即使声明 true 也退串行**（并行计数会击穿预算上限），见 executeTurnToolCalls。
   */
  parallelSafe?: boolean
  /** Host evidence hooks run after tool wrappers (including write audits). */
  recordFeedback?(feedback: ToolFeedback, ctx: ToolContext): void
  collectFeedback?(ctx: ToolContext): ToolFeedback[]
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>
}


/** 单次工具调用的过程记录（TurnInfo / LoopResult 共用）。
 *  path：文件类工具（write_file/edit_file/read_file 等）携带的目标相对路径——
 *  P3 loop-log 过程证据用；可选字段，既有埋点消费方向后兼容（payload 不变形）。
 *  status（2026-09-26 审计 P1-05）：ok/error——执行结果回填，消费方可区分「发过
 *  写调用」与「有效写入」（拒绝/失败写入不再被计入有效修改）。 */
export interface AgentLoopToolCallRecord {
  name: string
  turn: number
  path?: string
  status?: 'ok' | 'error'
  failureKey?: string
  progressKey?: string
  pending?: boolean
}


/** W1-E1（咨询 D3，2026-09-09）：竹节压缩观测信息——纯埋点零行为变更。
 *  编程编排层接 trackAnalytics('agent_loop_compact')；skipped=true 表示阈值满足但因
 *  上限/末段被跳过（此前该路径完全静默，E6 核查 1 的观测补齐）。 */
export interface AgentLoopCompactionInfo {
  /** 触发压缩（或首次跳过）的模型轮次 */
  at_turn: number
  /** 第几段交接（1 起）；skipped 时为已用段数 */
  segment: number
  /** 触发时的渠道回报 input tokens（触发判据本身） */
  trigger_input_tokens?: number
  /** 重置前全量 messages 估算 token（estContextTokens 同口径：仅历史轮，不含 system/工具 schema） */
  est_tokens_before?: number
  /** 重置后（task+交接+保留段）估算 token */
  est_tokens_after?: number
  /** keep-recent 保留的原文轮数（messages[1..] 的尾部连续后缀） */
  retained_turns: number
  /** 被移除的历史轮数（messages[1..] 中未保留的部分；skipped 时恒 0） */
  removed_turns: number
  /** 交接文档字符数 */
  handoff_chars: number
  /** true=LLM 交接失败走了 deterministicHandoff 兑底 */
  handoff_fallback: boolean
  /** true=阈值满足但未压缩（每 loop 只报一次）；此时仅 at_turn/segment/trigger_input_tokens/skip_reason 有意义 */
  skipped?: boolean
  skip_reason?: 'max_compactions' | 'late_turn'
  /** W2（Phase 10）：触发源——auto=usage/est 阈值（缺省值，存量兼容）；explicit=compact_context 工具登记 */
  trigger?: 'auto' | 'explicit'
}


export interface AgentLoopTurnInfo {
  /** Failed/truncated provider output is observable, never stage-advance evidence. */
  failed?: boolean
  turn: number
  toolCalls: AgentLoopToolCallRecord[]
  inputTokens?: number
  outputTokens?: number
}


export interface AgentLoopInput {
  /** Production desktop sessions use the upstream Pi session/agent runtime. */

  /** A stage boundary must never resume another stage's native transcript. */
  runtimeScope?: string
  /** Host prerequisite check after a no-tool final response; feedback keeps the loop open. */
  beforeComplete?: (ctx: ToolContext) => Promise<string | undefined>
  /** Bounded current host facts after compaction; does not replay tools. */
  recoveryContext?: () => string
  /** Host decision pending: end this turn before another tool or request. */
  shouldPause?: () => boolean
  parentSessionId?: string
  accountingRole?: string
  materials?: import('../../../shared/attachment-types').MaterialContext
  /** 背板锚定系统提示词（PR3 由 prd.json 注入，每轮有效防漂移） */
  system: string
  /** 初始 user 消息（任务指令） */
  task: string
  /** Chat reception already persisted the user's message with a stable identity. */
  initialMessagePersisted?: boolean
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
  /** 非写型 loop（调度员等）关闭 B3 进度对账三守卫注入（守卫假设具备写/自测工具；
   *  首跑实证：纯委派调度员触发只读失速误注入。缺省 false=现状）。 */
  disableProgressNudge?: boolean
  /** Writable executors opt in; read-only research is never forced to edit. */
  workMode?: 'implementation'
  executionScope?: string
  /** 续跑重放历史轮次（delegation continue 阶段 3，2026-08-28 队友）：作为 messages 开头
   * 传入模型，task 仍是最新 user 轮；不写入 JSONL——重放轮已在子会话文件里 */
  historyTurns?: ConversationTurn[]
  /** omit 推广（2026-08-27 队友）：透传父渠道 providerType，Token Plan 类渠道免 400 往返 */
  providerType?: string
  /** 推理档位透传（reasoning-profile 2026-08-27）：loop 默认按 BLOMA_LOOP_THINKING 环境变量
   * 决定思考档位，缺省 low（快速档、不吞 max_tokens）；传 off 关闭。 */
  thinkingLevel?: import('../../../shared/reasoning-profile').ThinkingLevel
  /** 剪贴板粘贴图片引用（clipboard-paste P1，2026-08-29 队友）：与 task 同轮组装 [text, ...image] 块数组 */
  images?: PastedImageRef[]
  /** 会话级 usage 聚合（费用守卫 Hook 1，2026-08-28 队友）：渠道不返回 usage 时
   * turnsWithUsage=0，estContextTokens（估算器）成为唯一占用信号。估算为启发式，
   * 只作守卫/展示不作计费 */
  usage?: { inputTokens: number; outputTokens: number; estContextTokens: number; turnsWithUsage: number }
  temperature?: number
  signal: AbortSignal
  publish: (type: AgentEvent['type'], payload: Record<string, unknown>) => void
  /** 每轮回调（PR3 埋点 agent_loop_turn：工具清单 + usage 若渠道返回；
   *  P3 loop-log 同一回调实时 append 过程记录，零新接线） */
  onTurn?: (info: AgentLoopTurnInfo) => void
  /** W1-E1 压缩观测回调（埋点 agent_loop_compact：压缩发生或首次跳过；不影响行为） */
  onCompaction?: (info: AgentLoopCompactionInfo) => void
  /** Host observation only; does not grant tools or alter execution policy. */
  onRuntimeObservation?: (info: import('./runtime-observation').RuntimeObservation) => void
  /** W2-E3 检查点回调（事件驱动：steer/验证工具/压缩/终态时触发；编排层接持久化，loop 内零 IO） */
  onCheckpoint?: (snapshot: LoopCheckpointSnapshot) => void
  /** B3（P0-B）：技术合同清单（plan 腿 filesToTouch 路径，编排器透传；仅开关 on 时参与
   *  进度对账守卫2，off 时字段不读不注入字节级现状；修复轮不传——修复卡即 mini-plan） */
  planFiles?: string[]
}


export interface AgentLoopResult {
  files_changed?: string[]
  tool_feedback?: ToolFeedback[]
  status: AgentLoopStatus
  turns: number
  finalText: string
  toolCalls: AgentLoopToolCallRecord[]
  /** 轮级 usage（指标果集，2026-10-02）：每次模型调用的渠道返回 usage 按轮登记。
   *  支撑「段首上下文重建成本」（前 N 轮 input/总 input）与「回炉 token 比」度量——
   *  段式编排 vs 连续会话的结构性差异以此为尺。纯增量可选字段，非采集方零感知。 */
  turnsUsage?: Array<{ turn: number; inputTokens: number; outputTokens: number }>
  /** 会话级 usage 聚合（费用守卫 Hook 1，2026-08-28 队友）：逐轮累计渠道返回 usage + 全块口径估算 */
  usage?: {
    inputTokens: number
    outputTokens: number
    estContextTokens: number
    turnsWithUsage: number
    /** P2-02：交接/宽限等辅助模型调用（不计入 turns，但计成本） */
    handoffCalls?: number
    graceCalls?: number
    auxEstTokens?: number
    estTotalTokens?: number
  }
  /** W1-E1（咨询 D3）：cancelled 终态的触发源观测——phase=loop 内观察点（取消被家觉的位置），
   *  source=abort reason 解析（'AGENT_CANCELLED: <source>' 约定见 orchestrator.cancelAgent；
   *  无 reason 的 abort 归 'unattributed'，如委派 stop/程序化中止）。纯增量字段，非 cancelled 无此字段。 */
  cancel_detail?: { phase: LoopCancelPhase; source?: string; reason?: string }
  /** W2-F4：自验状态快照（终验 source 五分类判据）；由 attachUsage 从工具状态拼装 */
  validation?: LoopValidationSnapshot
  /** W6-F6（咨询 D4 §六）：预算/轮次耗尽的结构化受阻报告（非裸终止）。仅 BLOMA_LOOP_CHECKPOINT on 且非完成终态携带。 */
  blocked_report?: {
    reason: 'budget_exhausted' | 'turn_limit'
    candidate_fingerprint: string
    unresolved_failures: string[]
    active_decisions: string[]
    verification: { gwt: string; api: string; security: string }
    files_written: string[]
    suggested_next: string
  }
  /** P2a（2026-09-11 狗粮 94f449c6）：异常终止的真实出口原因——status 仍为 turn_limit
 *  （终验/裁判语义不变），degenerate_output = 末轮输出退化重试后仍脏（传输事故），
 *  与真实跑满轮数区分，防误导归因（当晚 37/40 轮被误读「轮数耗尽」）。 */
  termination_detail?: LoopTerminationDetail
  /** D2（2026-09-11 狗粮 dd6ba98d）：DSML 传输事故恢复轮数（只读调用解析回 tool_use
 *  直接执行的次数）；>0 说明渠道协议泄漏发生过且被兑底救回，观测入账。 */
  transport_recoveries?: number
}


/** W1-E1：取消在 loop 内可被观察的五个位置（cancel_detail.phase 的取值）。 */
export type LoopCancelPhase = 'turn_start' | 'model_stream' | 'tool_execution' | 'handoff' | 'grace_turn'


/** 活跃决策 v0：用户运行中转向（steer）链——新转向 superseded_by 旧转向（不把冲突新旧同时注入）。
 *  plan/mode 级决策在 system 内拼装，loop 不可见，待 W5-G3 投影时接入。 */
export interface LoopCheckpointDecision {
  id: string
  kind: 'steer'
  text: string
  at_turn: number
  superseded_by?: string
}


/** 检查点快照（E3 事件驱动更新：steer/验证工具/压缩/终态时触发；宿主全量留档，每轮只注入投影） */
export interface LoopCheckpointSnapshot {
  session_id: string
  at_turn: number
  trigger: 'steer' | 'gwt' | 'api' | 'security' | 'compaction' | 'projection' | 'final'
  decisions: LoopCheckpointDecision[]
  /** 工作进度 v0：已写文件集（path→版本戳；工具结果维度，非模型声明） */
  progress_files: Record<string, string>
  validation: LoopValidationSnapshot & { candidate_fingerprint: string }
}


/** 候选指纹：已读文件版本集的确定性摘要（fnv1a；同指纹=同文件集同版本状态） */
export function candidateFingerprintOf(fileRevisions: Record<string, string>): string {
  const basis = Object.keys(fileRevisions).sort().map((p) => `${p}:${fileRevisions[p]}`).join('\n')
  let hash = 0x811c9dc5
  for (let i = 0; i < basis.length; i += 1) {
    hash ^= basis.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `fp-${hash.toString(16).padStart(8, '0')}-${Object.keys(fileRevisions).length}`
}


/** JSONL 审计里单条 tool_result 的截断上限（全文走事件流，防 JSONL 膨胀）。 */
const JSONL_TOOL_RESULT_CHAR_LIMIT = 4096



/**
 * 判断是否为工具轮：content 为块数组且含 tool_use / tool_result。
 * （loop 的 messages 中 assistant 轮必含 tool_use、user 轮必含 tool_result——
 * 无工具即返回 completed，因此 messages 里实际没有纯文本轮，F4 窗口化对象是 tool 轮对。）
 */
function isToolTurn(turn: ConversationTurn): boolean {
  return Array.isArray(turn.content) && turn.content.some((block) => block.type === 'tool_use' || block.type === 'tool_result')
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


/** 单轮占用估算（keep-recent 预算累加用；与 usage_summary 的 estContextTokens 同口径）。 */
function turnEstTokens(turn: ConversationTurn): number {
  return estimateTokenCount(typeof turn.content === 'string' ? turn.content : estimateBlocksText(turn.content))
}


/**
 * keep-recent 保留段（P1-1 三段式压缩）：竹节压缩重置时，在「task + 交接文档」之外
 * 保留最近的**原文**轮次——此前压缩一发生窗口历史归零，正常对话细节全丢（pi 参照：
 * 压缩 = 摘要 + 保留近 20k tokens 原文）。
 *
 * 语义（方案 §3.2）：
 * - 预算从尾向头累加（estimateTokenCount 既有估算器），保留集恒为 messages 的**连续后缀**
 *  （首个装不下的单元即停，不留「中空」历史）；
 * - tool_use/tool_result 成对保留（切点永不在 tool_result，按对计数（原窗口化路径同名语义，2026-10-03 已随其删除改述）
 *   配对保护先例）；纯文本轮（退行反馈/steer 注入等）独立成单元，不拆对；
 * - 装不下的整对丢弃（其内容由交接文档兜底）；首条 task（head）不进保留段——新首消息
 *   已含 task+交接；
 * - 交接文档优先级高于保留段（预算冲突先砍保留段）；钉轮不占保留预算（钉轮失败细节已由
 *   pinnedFailureExcerpt 进交接文档，语义共存）。
 */
export function keepRecentTurns(messages: ConversationTurn[], budgetTokens: number): ConversationTurn[] {
  if (budgetTokens <= 0 || messages.length <= 1) return []
  const tail = messages.slice(1)
  // 尾向头先切单元：user 工具轮与其前邻 assistant 工具轮合为一个完整对；其余独立成单元。
  // units 为「从新到旧」序。
  const units: ConversationTurn[][] = []
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const current = tail[i]!
    if (current.role === 'user' && isToolTurn(current) && i >= 1) {
      const prev = tail[i - 1]!
      if (prev.role === 'assistant' && isToolTurn(prev)) {
        units.push([prev, current])
        i -= 1
        continue
      }
    }
    units.push([current])
  }
  const kept: ConversationTurn[] = []
  let used = 0
  for (const unit of units) {
    const cost = unit.reduce((n, turn) => n + turnEstTokens(turn), 0)
    if (used + cost > budgetTokens) break // 连续后缀：首个装不下的单元即停
    kept.unshift(...unit)
    used += cost
  }
  return kept
}


export function createToolState(delegationDepth = 0): AgentLoopToolState {
  return {
    test_failed: false,
    gwt_all_passed: false,
    security_all_passed: false,
    // D1：无契约豁免预置 true；有契约项目由调用方（runAgentLoop 入口）按背板改 false。
    // createToolState 不知道 projectId，保持纯函数；背板感知的预置在 loopApiToolEnabled()
    // 的消费侧做（见 runAgentLoop 内 initStateApiContract）。
    api_all_passed: true,
    edits_after_test_failure: 0,
    repair_round: 0,
    delegation_depth: delegationDepth,
  }
}


/** W2（Phase 10，2026-09-16，同步 Proma CompactContext）：显式压缩工具 compact_context 开关。
 * 缺省 off=字节级现状（工具不注册、loop 无显式触发路径）。对位 W1-E6 发现的「压缩失明」：
 * glm 渠道 input_tokens 恒 0 时自动触发器失效，模型可在完成大阶段后主动交接口收缩窗口。 */
export function compactToolEnabled(): boolean {
  return process.env.BLOMA_COMPACT_TOOL === '1' || process.env.BLOMA_COMPACT_TOOL === 'true'
}


/** W2：显式压缩次数上限（独立于自动压缩的 LOOP_MAX_COMPACTIONS=2；防模型滥用交接轮次烧额度）。 */
export const MAX_EXPLICIT_COMPACTIONS = 4


/** D2/D3 开关：验证工具返回的证据边界行 + 失败 [新增]/[持续] 标注。缺省 off=字节级现状。 */
export function toolEvidenceEnabled(): boolean {
  return process.env.BLOMA_TOOL_EVIDENCE === '1' || process.env.BLOMA_TOOL_EVIDENCE === 'true'
}


/** D4：write_file 覆盖未读既有文件拦截。缺省 on（2026-10-02 全链路审查 P1-4 无条件化：
 *  盲覆盖是并行子会话静默覆盖彼此成果的主通道，「依赖提示词自律」不成立——运行审计
 *  P1-06 同结论）。新建文件不受影响；BLOMA_WRITE_GUARD=0/false 为显式逃生口。 */
export function writeGuardEnabled(): boolean {
  const raw = process.env.BLOMA_WRITE_GUARD
  return raw !== '0' && raw !== 'false'
}


/** W3-D1/D2 开关（咨询 D2《验证分层与收口预检》）：run_preflight 工具注册 + 收口判定升级为
 *  「预检通过」+ prompt 工作方式/终止条件全验证面。缺省 off=字节级现状。 */
export function preflightEnabled(): boolean {
  return process.env.BLOMA_PREFLIGHT === '1' || process.env.BLOMA_PREFLIGHT === 'true'
}


export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  input = { ...input, system: appendLoopPromptOverride(input.system), images: (input.images ?? []).filter(ref =>
    ref && typeof ref.imageId === 'string' && /^[A-Za-z0-9_-]+\/[A-Za-z0-9-]+\.(png|jpeg|jpg|gif|webp)$/.test(ref.imageId)
    && ['image/png','image/jpeg','image/gif','image/webp'].includes(ref.media_type)) }
  if (input.materials?.attachments.length) {
    const materials = renderMaterialContext(input.materials, input.sessionId)
    const images = new Map([...(input.images ?? []), ...materialImageRefs(input.materials)].map(image => [image.imageId, image]))
    input = { ...input, task: `${input.task}\n\n${materials}`, images: [...images.values()].slice(-4), tools: [...input.tools, ...buildAttachmentTools(input.materials).filter(tool => !input.tools.some(existing => existing.name === tool.name))] }
  }
  // P0-1 steer（运行中转向，2026-09-08）：只主 loop（depth 0）开放。进入即 mark——
  // IPC steer 通道据此判定可注入；finally 里先 drain 残余（未及批间注入的，落 JSONL 保真；
  // abort 后的残余丢弃——取消语义优先，cancelAgent 已清队列，这里兜竞态窗口）再 unmark。
  const isMainLoop = (input.delegationDepth ?? 0) === 0
  if (isMainLoop) markLoopActive(input.sessionId)
  try {
    const { runPiSession } = await import('./pi-runtime')
    return await runPiSession(input)
  } finally {
    // W1（Phase 10，预览浏览器工具族）：loop 结束即关同会话的持久浏览器句柄
    // （开关 off 时无会话，重载 map 查找零成本）；看门狗仅作跨 run 泄漏兑底。
    void closePreviewBrowserSession(input.sessionId).catch(() => undefined)
    if (isMainLoop) {
      const leftovers = drainSteerQueue(input.sessionId)
      if (leftovers.length > 0) {
        // I3（on 时）残余收口：自然收尾→留待下一轮（内容已落 JSONL，下一 run 可见，
        //  状态条如实翻转）；abort 残余→未采用（丢弃路径，与 cancel 语义一致）
        for (const entry of leftovers) {
          if (input.signal.aborted) {
            if (steerConfirmEnabled() && entry.steerId) settleSteerEntry(input.sessionId, entry.steerId, 'rejected')
          } else {
            // 内容不丢、并入对话历史：下一条消息/下一个 run 恢复时模型可见
            appendLoopMessage(input.sessionId, 'user', [{ type: 'text', text: wrapSteerContent(entry.content) }], 'user')
            if (steerConfirmEnabled() && entry.steerId) settleSteerEntry(input.sessionId, entry.steerId, 'deferred_next_run')
          }
        }
      }
      markLoopInactive(input.sessionId)
    }
  }
}


type GraceWrapUpOutcome = { kind: 'text'; text: string } | { kind: 'refused' } | { kind: 'cancelled' } | { kind: 'failed' }


/**
 * 单次工具调用：门禁（canUseTool）→ 预算 → 执行。
 * 任何失败都转 tool_result 回给模型（拒绝/超预算/异常），绝不崩循环。
 */
export async function executeToolCall(
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
  // Pi validates the full declared schema before entering this host boundary.

  // 权限门禁：loop 是无人值守自动化，仅支持 allow-all（warning 放行、dangerous 交由
  // canUseTool 判定）；非 allow-all（ask/safe）直接拒绝进 is_error 让模型自纠——
  // 避免 canUseTool 在 ask 模式下落 pending 等 UI 造成永久挂起（取消信号也无法中断）。
  // 副作用：非 allow-all 下 safe 工具也一并拒绝，生产 loop 恒 allow-all，接受
  //（该行为已由 tests/unit/agent-loop-permission.test.ts 锁定，防未来无意放宽）。
  if (input.permissionMode !== 'allow-all') {
    return { output: `权限拒绝：本次运行不允许执行「${use.name}」。请改用其他方式完成，或直接输出当前进展总结。`, isError: true,
      feedback: { schema_version: 1, execution: 'not_run', verification: 'unverified', source: 'host', category: 'permission', reason: 'PERMISSION_MODE', recovery: 'wait_permission' } }
  }
  try {
    // 与 AbortSignal 竞速（withAbort）：即便 canUseTool 意外落 pending（如未来
    // dangerous-under-allow-all），取消也能中断，绝不进程级永久阻塞。
    const permission = await withAbort(canUseTool(use.name, toolInput, input.sessionId, input.permissionMode, input.projectId), input.signal)
    if (permission.behavior === 'deny') {
      return { output: `权限拒绝：${permission.message ?? `本次运行不允许执行「${use.name}」`}。请按拒因调整操作，或直接输出当前进展总结。`, isError: true,
        feedback: { schema_version: 1, execution: 'not_run', verification: 'unverified', source: 'host', category: 'permission', reason: 'PERMISSION_DENIED', recovery: 'wait_permission' } }
    }
  } catch (error) {
    return { output: `权限检查失败：${errorMessage(error)}`, isError: true }
  }

  // 静态预算（按工具名计数）：超限软着陆——明示收尾，标记 budgetExhausted
  const budget = input.toolBudget?.[use.name]
  if (typeof budget === 'number') {
    const used = budgetUsed[use.name] ?? 0
    if (used >= budget) {
      return { output: `「${use.name}」的本轮调用预算已用尽（上限 ${budget} 次）。本轮不要再调用，保存未完成项。`, budgetExhausted: true,
        feedback: { schema_version: 1, execution: 'not_run', verification: 'unverified', source: 'host', category: 'budget', recovery: 'resume',
          budget: { resource: 'tool_calls', scope: 'invocation', used, limit: budget, remaining: 0, resets_on: 'new_invocation' } } }
    }
    budgetUsed[use.name] = used + 1
  }

  try {
    // P1-04（2026-09-26 运行审计）：工具执行与取消信号竞速——等待可取消，永不
    // settle 的工具不再挂死 loop（与权限门禁同款 withAbort 语义）。注意：竞速只
    // 停止等待，不替代资源终止——工具自身的资源回收由 ctx.signal 驱动（各工具
    // 自理，如 web_fetch 的超时 signal；kill/close 句柄挂账）。
    return await withAbort(tool.execute(toolInput, ctx), input.signal)
  } catch (error) {
    if (input.signal.aborted) throw error // 取消向上传播为批次取消，不吞成 is_error
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
  if (signal.aborted) {
    // The producer may synchronously abort before returning a rejected promise
    // (for example admission racing cancellation). It still needs an observer.
    void promise.catch(() => undefined)
    return Promise.reject(new Error('AGENT_CANCELLED'))
  }
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


interface WhitespaceArtifactCleaner {
  /** 喂入一个 text 增量，返回应立即放行的增量（0~2 段）。 */
  push(text: string): string[]
  /** 流结束/遇到非文本块：把挂起的空白如实放行（一次性，幂等）。 */
  end(): string[]
}


function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 500 ? `${message.slice(0, 500)}…` : message
}


/** loop 轮次落盘：assistant 轮（含 tool_use）与 user 轮（tool_result）照常 append JSONL。 */
function appendLoopMessage(sessionId: string, role: 'assistant' | 'user', blocks: MessageContentBlock[], origin: 'user' | 'system' | 'agent' = role === 'user' ? 'system' : 'agent'): void {
  appendSessionMessage(sessionId, {
    role,
    origin,
    content: blocks.map((block) =>
      block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > JSONL_TOOL_RESULT_CHAR_LIMIT
        ? { ...block, content: `${block.content.slice(0, JSONL_TOOL_RESULT_CHAR_LIMIT)}…[截断，全文见事件流]` }
        : block,
    ),
    timestamp: Date.now(),
  })
}
