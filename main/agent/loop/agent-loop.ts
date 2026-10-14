import type { AgentEvent, AgentLoopStatus, LoopTerminationDetail, LoopValidationSnapshot, MessageContentBlock, PastedImageRef, PromaPermissionMode } from '../../../shared/types'
import { getAgentSessionPath } from '../../../storage/config-paths'
import { appendJsonLine } from '../../../storage/json-store'
import { appendSessionMessage } from '../../platform/sessions/session-tree'
import { buildAttachmentTools } from '../tools/attachment-tools'
import { materialImageRefs, renderMaterialContext } from '../../platform/attachments/material-context'
import { canUseTool } from '../permissions/permission-service'
import type { ConversationTurn, SDKQuery, ToolDefinition } from '../../orchestration/orchestrator'
import { prepareTaskWithSkills } from '../../platform/mcp/skill-loader'
import { appendLoopPromptOverride } from '../prompting/prompt-config'
import { findProject } from '../../project/project-service' // 白名单既有项（agent/loop→project-service，目录级）；skill 根解析上提至此
import { prepareRecallBlock } from './session-recall'
import { renderLearningsSection } from '../../project/learnings-log'
import { estimateTokenCount } from './usage-guard'
import { isDegenerateText } from '../../coding/output-integrity'
import { buildTargetedDegenerateFeedback, classifyDsmlRecovery, parseDsmlInvokes } from './dsml-recovery'
import { createDsmlDisplayFilter } from './dsml-display-filter'
import { validateToolInput } from './tool-input-validation'
import { feedbackForTool } from './tool-feedback'
import { persistentBudgetBlocked, retainedToolFeedback } from '../../../shared/tool-feedback-policy'
import { formatToolFeedback, type ToolFeedback } from '../../../shared/tool-feedback'
import { userFacingWrapUp } from '../prompting/user-facing-output'
import { isHostControlText } from '../../../shared/message-presentation'
import { closePreviewBrowserSession } from '../../coding/preview-browser'
import { drainSteerQueue, markLoopActive, markLoopInactive, markSteerMerged, pendingSteerCount, settleSteerEntry, steerConfirmEnabled, wrapSteerContent } from './steer-queue'

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
  turn: number
  toolCalls: AgentLoopToolCallRecord[]
  inputTokens?: number
  outputTokens?: number
}

export interface AgentLoopInput {
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

// ---- W2 E2+F1（咨询 D3/D4）：loop_checkpoint v0 —— 宿主侧结构化运行时状态 ----

/** W2 开关：检查点（快照维护+压缩后恢复头+修复证据包）。缺省 off=字节级现状（零注入零写盘）。 */
export function loopCheckpointEnabled(): boolean {
  return process.env.BLOMA_LOOP_CHECKPOINT === '1' || process.env.BLOMA_LOOP_CHECKPOINT === 'true'
}

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

/** 压缩后轻量恢复头（D3 稿 §五）：宿主从检查点拼装，不依赖模型记住全过程。
 *  纯函数导出供单测；内容定位有疑问引导先 read_file/grep 确认（不规定重读整个项目）。 */
export function renderCheckpointRecoveryHeader(task: string, snapshot: LoopCheckpointSnapshot): string {
  const active = snapshot.decisions.filter((d) => !d.superseded_by)
  const val = snapshot.validation
  const fileCount = Object.keys(snapshot.progress_files).length
  const lines = [
    '【检查点恢复头（宿主生成，勿改写）】',
    `- 当前目标：${task.split('\n')[0]!.slice(0, 80)}`,
    `- 候选指纹：${val.candidate_fingerprint}（已写入文件 ${fileCount} 个，版本戳在 read_file 返回末尾）`,
    active.length > 0
      ? `- 仍有效转向：${active.map((d) => d.text.slice(0, 60)).join('；')}`
      : '- 仍有效转向：无',
    val.last_gwt_failures.length > 0
      ? `- 未闭环失败：${val.last_gwt_failures.slice(0, 5).join('、')}${val.last_gwt_failures.length > 5 ? ' 等' : ''}`
      : '- 未闭环失败：无（上轮 GWT 全过或未测）',
    `- 验证状态：GWT ${val.gwt_runs > 0 ? (val.gwt_all_passed ? '全过' : '有失败') : '未测/豁免'}｜API 契约 ${
        val.api_all_passed ? '过/豁免' : val.api_contract_runs > 0 ? '失败' : '未测'
      }｜安全 ${val.security_all_passed ? '过' : '未测'}`,
    '- 定位有疑问先 read_file/grep 确认现状再编辑；修复后使用当前已装配的验证工具重验，勿凭旧印象断言已修。',
  ]
  return lines.join('\n')
}

/** W5-G3（咨询 D5 §二 B 层）：检查点活跃投影——每轮 system 尾部的紧凑宿主状态
 *  （候选指纹/仍有效转向/未闭环失败/验证状态）。与恢复头分工：恢复头=压缩后一次性完整版，
 *  投影=每轮紧凑版（验证状态变化即最新，宿主拼装不靠模型记忆）。仅 BLOMA_LOOP_CHECKPOINT on 注入。 */
export function renderCheckpointProjection(snapshot: LoopCheckpointSnapshot): string {
  const active = snapshot.decisions.filter((d) => !d.superseded_by)
  const val = snapshot.validation
  const lines = [
    '【检查点投影（宿主状态，勿改写；每轮更新）】',
    `- 候选指纹：${val.candidate_fingerprint}（已写文件 ${Object.keys(snapshot.progress_files).length} 个，版本戳见 read_file 返回）`,
    ...(active.length > 0 ? [`- 仍有效转向：${active.map((d) => d.text.slice(0, 60)).join('；')}`] : []),
    val.last_gwt_failures.length > 0
      ? `- 未闭环失败：${val.last_gwt_failures.slice(0, 5).join('、')}${val.last_gwt_failures.length > 5 ? ' 等' : ''}`
      : '- 未闭环失败：无',
    `- 验证状态：GWT ${val.gwt_runs > 0 ? (val.gwt_all_passed ? '全过' : '有失败') : '未测/豁免'}｜API 契约 ${
      val.api_all_passed ? '过/豁免' : val.api_contract_runs > 0 ? '失败' : '未测'
    }｜安全 ${val.security_all_passed ? '过' : '未测'}`,
  ]
  return lines.join('\n')
}

/** JSONL 审计里单条 tool_result 的截断上限（全文走事件流，防 JSONL 膨胀）。 */
const JSONL_TOOL_RESULT_CHAR_LIMIT = 4096

/** 事件流里工具输入/输出摘要的截断上限。 */
const EVENT_SUMMARY_CHAR_LIMIT = 500

/** 预算耗尽软着陆：连续 2 轮仍在撞预算（无进展）才终止，给模型收尾总结机会。 */
const BUDGET_STALL_TURNS = 2

/**
 * 终轮退行重试预算（P0，2026-09-06 地牢清怪录 d066eb92 案）：传输事故（工具调用
 * 原文漏进正文/退行重复，见 output-integrity）只带反馈重试一次——防坏渠道烧穿
 * 轮次预算；重试仍脏则如实 turn_limit 交外部终验（终验是权威，成功话术由终验
 * 结果决定，不再被垃圾收工轮骗到）。
 */
const DEGENERATE_RETRY_LIMIT = 1

/** A tool-free completion summary must not inherit the full coding output budget. */
export const WRAP_UP_MAX_TOKENS = 4096

/** 终轮退行重试时的反馈 user 轮（模型可见；同时落 JSONL 审计）。 */
const DEGENERATE_RETRY_FEEDBACK =
  '【传输事故反馈】你上一轮的回复没有携带任何工具调用，且正文混入了工具调用协议原文或退行性重复文本，被平台判为无效输出。' +
  '请重新输出这一轮：任务未完成就正常调用工具继续；确实已完成就输出干净的完成总结。不要复述无效文本。'

/**
 * 收口指令（2026-08-29 线上案例 eb900c57）：GWT 全过 + 安全扫描通过 = 平台意义上的
 * 「活已干完」。此后停用全部工具并在 system 追加收口指令，逼模型立即输出完成总结——
 * 该案例第 20 轮测试/扫描已全过，最后 4 轮却继续冗余验证，把「交卷」挤出了 24 轮预算。
 */
const WRAP_UP_SUFFIX =
  '\n\n【收口】本轮已装配的功能验证与安全检查通过，工具已停用。' +
  '请基于实际工具结果输出完成摘要，分别说明已实现、已验证、未验证或受阻项；测试通过不等于全部 GUI 流程或用户需求已验收，不得扩大成功范围。'

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

// ---- keep-recent 三段式压缩（P1-1，2026-09-08 pi 差距方案）----

/** 保留段 token 预算缺省：交接文档之外保留近期原文轮次（pi 参照 ~20k，bloma 缺省 8k 保守起步）。 */
const LOOP_COMPACT_KEEP_RECENT_TOKENS_DEFAULT = 8_000

/** 保留段预算可环境覆盖（'0' = 旧行为完全回归：task+交接两段、不保留原文）；无效值回缺省。 */
function resolveKeepRecentTokens(): number {
  const raw = process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS
  if (raw === undefined || raw.trim() === '') return LOOP_COMPACT_KEEP_RECENT_TOKENS_DEFAULT
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : LOOP_COMPACT_KEEP_RECENT_TOKENS_DEFAULT
}

/** 交接模型不可用时的确定性拼装（零 LLM 兑底；含钉轮失败断言原文，审查 P1-2）。 */
function deterministicHandoff(
  turn: number,
  toolCalls: Array<{ name: string }>,
  finalText: string,
  failureExcerpt: string,
  /** W6-E4（咨询 D3 §三 D）：检查点段——硬阈值兑底从检查点拼装而非只靠工具统计 */
  checkpointSection?: string,
): string {
  const counts = new Map<string, number>()
  for (const call of toolCalls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  const usage = [...counts.entries()].map(([name, count]) => `${name}×${count}`).join('、')
  const parts = [
    `【自动交接（交接模型不可用）】已进行到第 ${turn} 轮，工具调用：${usage || '（无）'}。`,
    failureExcerpt ? `未解决的测试失败（原文）：${failureExcerpt}` : '',
    finalText.trim() ? `最近说明：${finalText.trim().slice(0, 200)}` : '',
    ...(checkpointSection ? [checkpointSection] : []),
  ]
  return parts.filter(Boolean).join('\n')
}

/** 钉轮对的 tool_result 文本（确定性交接兑底用，截 400 字；钉轮失效/未钉返回空）。
 *  P1-1 keep-recent（2026-09-08）：按配对序号定位（与钉轮赋值同口径）——保留段的
 *  对与重置后的对统一计数，文本注入轮存在时也不再错位。 */
function pinnedFailureExcerpt(messages: ConversationTurn[], pinnedTurn: number | undefined): string {
  if (pinnedTurn === undefined) return ''
  const pair = toolPairAtOrdinal(messages, pinnedTurn)
  if (!pair) return ''
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

/**
 * tail（messages[1:]）中第 ordinal 个完整工具对（assistant tool_use + 紧邻 user
 * tool_result，从 1 计，扫描时跳过文本轮）。找不到（序号越界/对不完整）返回 undefined。
 * （原 partitionWindow 钉轮定位为位置算术 2*(t-1)，窗口化路径 2026-10-03 已删，本函数改自口语义）
 * 文本注入轮（退行反馈/steer）混排时位置算术会错位，本函数按真实配对计数兜底。
 */
function toolPairAtOrdinal(messages: ConversationTurn[], ordinal: number): [ConversationTurn, ConversationTurn] | undefined {
  if (ordinal < 1) return undefined
  const tail = messages.slice(1)
  let seen = 0
  for (let i = 0; i + 1 < tail.length; i += 1) {
    if (tail[i]!.role === 'assistant' && isToolTurn(tail[i]!) && tail[i + 1]!.role === 'user' && isToolTurn(tail[i + 1]!)) {
      seen += 1
      if (seen === ordinal) return [tail[i]!, tail[i + 1]!]
      i += 1
    }
  }
  return undefined
}

/** 末位完整工具对的配对序号（钉轮赋值口径）；末位不是完整对（残局/文本轮收尾）返回
 *  undefined——不钉，退化为固定窗口。 */
function tailLastPairOrdinal(messages: ConversationTurn[]): number | undefined {
  const tail = messages.slice(1)
  if (tail.length < 2) return undefined
  const prev = tail[tail.length - 2]!
  const last = tail[tail.length - 1]!
  if (!(prev.role === 'assistant' && isToolTurn(prev) && last.role === 'user' && isToolTurn(last))) return undefined
  let pairs = 0
  for (let i = 0; i + 1 < tail.length; i += 1) {
    if (tail[i]!.role === 'assistant' && isToolTurn(tail[i]!) && tail[i + 1]!.role === 'user' && isToolTurn(tail[i + 1]!)) {
      pairs += 1
      i += 1
    }
  }
  return pairs
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
      accounting: { projectId: input.projectId, runId: input.requestId, parentSessionId: input.parentSessionId, role: input.accountingRole ?? 'orchestrator', scope: 'handoff' },
      messages: [
        { role: 'system', content: LOOP_HANDOFF_SYSTEM },
        // 钉轮一并携带（PR2）；2026-09-16 上下文同步 Proma：全量模式下交接输入也用全量
        // （滑窗模式下维持有界窗口）——否则交接文档只覆盖最近 8 轮，早期进展金丢。
        ...messages,
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

/** W1-E1（咨询 D3）：messages 全量 token 估算——与 usage_summary 的 estContextTokens 同口径
 *  （仅历史轮块文本，不含 system/工具 schema；E6 核查 2 的口径已在注释里写死防漂移）。 */
function estTokensOfMessages(list: ConversationTurn[]): number {
  return estimateTokenCount(list.map((m) => (typeof m.content === 'string' ? m.content : estimateBlocksText(m.content))).join('\n'))
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

/** P2-02（2026-09-26 运行审计）：成本硬上限（tokens；0/缺省=不限）——累计口径含
 *  主循环 usage + 交接/宽限估算（审计：maxTurns 不是总模型调用/总 token 预算）。
 *  达到即进入可解释 budget_exhausted + termination_detail.reason='cost_limit' 终态。 */
export function resolveLoopCostLimitTokens(): number {
  const raw = (process.env.BLOMA_LOOP_COST_LIMIT_TOKENS ?? '').trim()
  if (!raw) return 0
  const parsed = Number(raw)
  return Number.isFinite(parsed) && Math.floor(parsed) > 0 ? Math.floor(parsed) : 0
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

/** W5-G1（咨询 D5）：旁白事件驱动五类事件版（G2 的 A/B 对照即本开关——on 无同构开头限制）。缺省 off=字节级现状。 */
export function narrationEventsEnabled(): boolean {
  return process.env.BLOMA_NARRATION_EVENTS === '1' || process.env.BLOMA_NARRATION_EVENTS === 'true'
}


/** B3 守卫1 阈值：连续 N 轮无 write/edit 判只读失速（审计案实测 20 连续只读，6 轮早介入）。 */
const PROGRESS_READ_ONLY_TURNS = 6
/** B3 验证类工具集（守卫3：全程零命中且进入后 1/3 轮次→提醒自测）。 */
const PROGRESS_VERIFICATION_TOOLS = new Set(['run_preview', 'run_gwt_tests', 'run_security_scan', 'run_api_contract_tests', 'run_preflight', 'run_project_script', 'run_project_driver', 'drive_project_app'])

/** 当前工具面里实际注册的验证工具名单（按 PROGRESS_VERIFICATION_TOOLS 过滤，保序）。
 *  web 线拆除（2026-10-01）后多数验证工具已退役，但 agent-loop 是品类无关机制层：
 *  提醒文案与收口门都必须只引用本次 loop 真实装配的工具，不指向幽灵工具（全链路审查 P1）。 */
function registeredVerifyTools(tools: ReadonlyArray<{ name: string }>): string[] {
  return tools.map((tool) => tool.name).filter((name) => PROGRESS_VERIFICATION_TOOLS.has(name))
}
/** B3 路径归一化：plan 清单与工具入参 path 的统一形态（正斜杠、去 ./ 前缀）。 */
function normalizeProgressPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  input = { ...input, system: appendLoopPromptOverride(input.system) }
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
    return await runAgentLoopImpl(input)
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
            appendLoopMessage(input.sessionId, 'user', [{ type: 'text', text: wrapSteerContent(entry.content) }])
            if (steerConfirmEnabled() && entry.steerId) settleSteerEntry(input.sessionId, entry.steerId, 'deferred_next_run')
          }
        }
      }
      markLoopInactive(input.sessionId)
    }
  }
}

async function runAgentLoopImpl(input: AgentLoopInput): Promise<AgentLoopResult> {
  // 主 loop（depth 0）判定：steer 批间注入只在主 loop 执行（见 wrapper 注释与下方注入点）
  const isMainLoop = (input.delegationDepth ?? 0) === 0
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
  // 项目级 skill 根（PR4 后续：平台件 skill-loader 已去域依赖，根路径在此解析后传入；
  // 项目缺席（孤儿/单测）跳过项目级根，只回全局根，与旧语义一致）
  let skillProjectRoot: string | undefined
  try {
    skillProjectRoot = findProject(input.projectId).root_path
  } catch {
    skillProjectRoot = undefined
  }
  const [skillPrep, recallBlock] = await Promise.all([
    prepareTaskWithSkills(input.task, skillProjectRoot),
    prepareRecallBlock(input.task, input.delegationDepth ?? 0, `${input.sessionId}.jsonl`, { projectId: input.projectId }),
  ])
  // 历史经验（记忆栈审计裁定 §5，D0）：从 system prompt 迁到**任务头**，与 recall/skill 同层；
  // 用 <untrusted-memory> 标记降级为非指令上下文（记忆是模型输出派生，不享指令面权重，
  // 且内容已过统一净化：转义边界 + 拦绕过指令，见 memory-sanitize）。
  // 仅主 loop（depth 0）注入（与 <session-recall> 同款门控）；首轮无经验 / 名单不可读 → 空块。
  // 迁移路径：待 §11 统一出口契约 renderMemory() 落地后接管（本处为临时补丁）。
  const learningsSection = isMainLoop ? renderLearningsSection(input.projectId) : ''
  const learningsBlock = learningsSection
    ? `<untrusted-memory source="learnings" trust="advisory">\n${learningsSection}\n</untrusted-memory>`
    : ''
  const task = [learningsBlock, recallBlock, skillPrep.content].filter(Boolean).join('\n')
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
  if (!input.initialMessagePersisted) appendLoopMessage(input.sessionId, 'user', [
    { type: 'text', text: input.task },
    ...pastedImageRefs.map(r => ({ type: 'image' as const, imageId: r.imageId, media_type: r.media_type })),
  ], isHostControlText(input.task) ? 'system' : 'user')
  const ctx: ToolContext = {
    projectId: input.projectId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    signal: input.signal,
    state: createToolState(input.delegationDepth ?? 0),
  }
  // 如实化预置（全链路审查 P1，2026-10-01）：工具面未装配的验证位豁免——与 D1 的
  // 「无契约豁免 true」同构。web 线拆除后 run_gwt_tests/run_api_contract_tests 已退役：
  // 未装配而要求置位会把收口判定变死条件（永不收口，只能靠 maxTurns 耗尽）。
  // 豁免后装配了对应工具的会话语义不变（必须跑过才置位）；security 位不豁免——
  // 它是当前唯一在产验证工具（桌面子会话已装配），保持「扫描过才收口」硬门。
  if (!input.tools.some((tool) => tool.name === 'run_gwt_tests')) ctx.state.gwt_all_passed = true
  // D1（咨询 D）：背板感知的 api_all_passed 预置——声明了 interface_spec 的项目
  // 收口前必须跑过 run_api_contract_tests（全过才 true）；无契约项目豁免 true。
  // PROJECT_NOT_FOUND = 无项目上下文（纯会话 loop/测试场景）无契约概念——豁免；
  // 其他读盘失败保守 false（fail-closed）。惰性执行：首次 GWT+安全双绿时才读背板
  // （未达绿灯的 loop 零背板读盘与模块加载开销；2026-10-01 开关删除时由起步预置改此）。

  let apiChecked = false // API 收口位惰性预置标记（2026-10-01）
  let turns = 0
  let finalText = ''
  let consecutiveBudgetStallTurns = 0
  // W2 E2+F1（咨询 D3/D4）：检查点 v0 —— 活跃决策（steer 链，superseded_by 生效性管理）
  const steerDecisions: LoopCheckpointDecision[] = []
  const fileRevisionsOf = (): Record<string, string> => {
    const out: Record<string, string> = {}
    if (ctx.state.file_revisions) for (const [path, rev] of ctx.state.file_revisions) out[path] = rev
    return out
  }
  const validationOf = (): LoopValidationSnapshot => ({
    gwt_runs: ctx.state.gwt_runs ?? 0,
    api_contract_runs: ctx.state.api_contract_runs ?? 0,
    last_gwt_failures: [...(ctx.state.last_gwt_failures ?? [])],
    gwt_all_passed: ctx.state.gwt_all_passed,
    api_all_passed: ctx.state.api_all_passed,
    security_all_passed: ctx.state.security_all_passed,
    // W3→H1 消费链：预检跑过才带（undefined=未跑不影响 delivery_status 判定）
    ...(ctx.state.preflight_passed !== undefined ? { preflight_passed: ctx.state.preflight_passed } : {}),
    file_revisions: fileRevisionsOf(),
  })
  const checkpointSnapshotOf = (trigger: LoopCheckpointSnapshot['trigger'], turn: number): LoopCheckpointSnapshot => {
    const files = fileRevisionsOf()
    return {
      session_id: input.sessionId,
      at_turn: turn,
      trigger,
      decisions: steerDecisions.map((d) => ({ ...d })),
      progress_files: { ...files },
      validation: { ...validationOf(), candidate_fingerprint: candidateFingerprintOf(files) },
    }
  }
  // W2-E3 事件驱动保存：steer/验证工具/压缩/终态时向宿主推送快照（编排层接持久化，loop 内零 IO）
  const emitCheckpoint = (trigger: LoopCheckpointSnapshot['trigger'], turn: number): void => {
    if (!input.onCheckpoint) return
    input.onCheckpoint(checkpointSnapshotOf(trigger, turn))
  }
  // W5-G3（咨询 D5 §二 B 层）：检查点活跃投影每轮注入 system 尾部（仅 BLOMA_LOOP_CHECKPOINT on；
  // off=input.system 原样字节不变）。每轮重建会破坏 provider 前缀缓存——观察项，
  // 在线 A/B 时看端到端 token/耗时差。宽限轮/收口后缀不叠加投影（交卷语义优先）。
  const systemForTurn = (base: string, turn: number): string =>
    loopCheckpointEnabled() ? `${base}\n\n${renderCheckpointProjection(checkpointSnapshotOf('projection', turn))}` : base
  // 费用守卫 Hook 1（2026-08-28 队友）：逐轮累计渠道返回 usage（渠道不返回即全盲 → estContextTokens 兜底）
  const usageTotals = { inputTokens: 0, outputTokens: 0, turnsWithUsage: 0 }
  // 轮级 usage 登记（指标果集，2026-10-02）：与 usageTotals 同源累积，按轮追加
  const turnsUsage: Array<{ turn: number; inputTokens: number; outputTokens: number }> = []
  // P2-02：辅助模型调用成本（交接/宽限）——审计「主轮次数不计交接和宽限总结」，
  // 统一累计供成本上限判定与 usage_summary 如实呈现
  const auxCost = { handoffCalls: 0, graceCalls: 0, auxEstTokens: 0 }
  const attachUsage = (r: AgentLoopResult): AgentLoopResult => {
    // W2-E3：终态事件驱动保存（取消/熔断/完成全部路径部过这里）
    emitCheckpoint('final', turns)
    // W6-F6：预算/轮次耗尽产出结构化受阻报告（仅检查点开着；完成/取消不产）
    let blocked: AgentLoopResult['blocked_report']
    if (loopCheckpointEnabled() && (r.status === 'budget_exhausted' || r.status === 'turn_limit')) {
      const snapshot = checkpointSnapshotOf('final', turns)
      blocked = {
        reason: r.status,
        candidate_fingerprint: snapshot.validation.candidate_fingerprint,
        unresolved_failures: [...snapshot.validation.last_gwt_failures],
        active_decisions: snapshot.decisions.filter((d) => !d.superseded_by).map((d) => d.text.slice(0, 120)),
        verification: {
          gwt: snapshot.validation.gwt_runs > 0 ? (snapshot.validation.gwt_all_passed ? '全过' : '有失败') : '未测/豁免',
          api: snapshot.validation.api_all_passed ? '过/豁免' : snapshot.validation.api_contract_runs > 0 ? '失败' : '未测',
          security: snapshot.validation.security_all_passed ? '过' : '未测',
        },
        files_written: Object.keys(snapshot.progress_files).slice(0, 30),
        suggested_next:
          snapshot.validation.last_gwt_failures.length > 0
            ? `优先处理未闭环失败（${snapshot.validation.last_gwt_failures.slice(0, 3).join('、')}）；修复后完整重验，勿凭旧证据交差`
            : '验证面未闭环（GWT/API/安全见上）；按检查点投影继续验证后收口',
      }
      try {
        appendSessionMessage(input.sessionId, {
          role: 'system',
          content: [{ type: 'text', text: `[loop-blocked-report] ${JSON.stringify(blocked)}` }],
          timestamp: Date.now(),
        })
      } catch {
        // 取证落盘失败静默
      }
    }
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
      ...(ctx.state.successful_file_changes ? { files_changed: ctx.state.successful_file_changes.slice(0, 20) } : {}),
      ...(ctx.state.latest_tool_feedback ? { tool_feedback: retainedToolFeedback([...Object.values(ctx.state.latest_tool_feedback), ...Object.values(ctx.state.terminal_budget_feedback ?? {})]) } : {}),
      ...(blocked ? { blocked_report: blocked } : {}),
      ...(transportRecoveries > 0 ? { transport_recoveries: transportRecoveries } : {}),
      // 轮级 usage（纯增量：采集方消费，非采集方零感知）
      ...(turnsUsage.length > 0 ? { turnsUsage } : {}),
      usage: {
        inputTokens: usageTotals.inputTokens,
        outputTokens: usageTotals.outputTokens,
        turnsWithUsage: usageTotals.turnsWithUsage,
        // P2-02：统一成本口径——主循环 tokens + 交接/宽限调用与估算（审计：
        // maxTurns 不是总模型调用/总 token 预算，成本事实须完整可见）
        handoffCalls: auxCost.handoffCalls,
        graceCalls: auxCost.graceCalls,
        auxEstTokens: auxCost.auxEstTokens,
        estTotalTokens: usageTotals.inputTokens + usageTotals.outputTokens + auxCost.auxEstTokens,
        // 全块口径（r55 low 池采纳）：tool_result 内容与 tool_use input 都占上下文，
        // text-only 口径在渠道全盲时会严重低估占用。
        estContextTokens,
      },
      // W2-F4：自验状态快照随终态带出（终验 source 分类的确定性判据）
      validation: validationOf(),
    }
  }
  // 收口态：GWT 全过 + 安全扫描通过后置位，此后模型调用停用全部工具并追加收口指令
  let wrapUp = false
  // 首个 test_failed 轮（窗口钉轮，只钉一次）：修复全程可见第一次测试失败的断言细节。
  // 序号口径见 tailLastPairOrdinal（P1-1 后与 keep-recent 保留段共存：保留段配对计入序号）
  let pinnedTestTurn: number | undefined
  // 已被钉轮/交接覆盖到的 repair_round：防粘性 test_failed 在压缩后幻影重钉（审查 P1-1）
  let pinnedRepairRound = 0
  // 已压缩次数（竹节压缩，闭环 PR6）
  let compactions = 0
  // W1-E1：上限/末段跳过观测是否已报过（每 loop 至多一条）
  let compactionSkipLogged = false
  const compactThreshold = resolveCompactThreshold()
  // keep-recent 保留段预算（P1-1 三段式压缩；'0' = 旧行为完全回归）
  const keepRecentBudget = resolveKeepRecentTokens()
  // 终轮退行已重试次数（P0：传输事故只重试一次，见 DEGENERATE_RETRY_LIMIT）
  let degenerateRetries = 0
  // D2（2026-09-11 狗粮 dd6ba98d）：DSML 传输事故恢复计数（只读调用直接执行的轮数）
  let transportRecoveries = 0
  // B3（P0-B，2026-09-11）：进度对账三守卫状态（BLOMA_LOOP_PROGRESS_NUDGE off=零注入）
  let readOnlyStreak = 0
  const writtenFiles = new Set<string>()
  let verificationSeen = false
  let planNudgeDone = false
  let verifyNudgeDone = false
  // 本次 loop 真实装配的验证工具名单（提醒文案只引用现存工具，不指向幽灵工具）
  const availableVerifyTools = registeredVerifyTools(input.tools)
  // W5（Phase 8.5，2026-09-12）：任务清单工作流状态（BLOMA_TASK_WORKFLOW off=零注入）
  const fileWriteCounts = new Map<string, number>()
  let checklistProjectedFiles = 0
  let lastProjectionTurn = -2
  let earlyVerifyNudged = false
  let lastVerifyRepeatTurn = -2

  for (let turn = 1; turn <= input.maxTurns; turn += 1) {
    if (input.signal.aborted) return attachUsage(loopCancelled(turns, finalText, toolCalls, 'turn_start', input.signal))

    // ---- 模型调用（L0 带 tools；messages 全量透传，system 提取由查询层负责）----
    const assistantBlocks: MessageContentBlock[] = []
    // 网关脏增量清洗 + 文本整段化（2026-08-25 线上案例）：ds 渠道在带 tools 的流式
    // 响应里会往 token 增量之间插入字面 "\n\n" 的独立纯空白增量（有时连发多个），
    // 裸拼接会让旁白「每词一段」；同时把连续 text 增量合并为单块落盘（对齐 guide
    // 路径的整段化，JSONL 不再落几百个碎块）。
    const cleaner = createWhitespaceArtifactCleaner()
    // R1-loop（2026-09-19 狗粮 7601e5ae）：DSML 协议残片呈现过滤——只拦 publish，
    // textParts/assistantBlocks 仍存原文（JSONL 留档、模型侧历史不变）；跨增量
    // 分裂标记由 holdback 状态机扣住裁决。
    const dsmlFilter = createDsmlDisplayFilter()
    const textParts: string[] = []
    const emitText = (text: string): void => {
      // 助手旁白照常进事件流上屏（与 runAgent 的 message_delta 语义一致）
      for (const piece of dsmlFilter.push(text)) input.publish('message_delta', { text: piece })
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
        maxTokens: wrapUp ? Math.min(input.maxTokens, WRAP_UP_MAX_TOKENS) : input.maxTokens,
        accounting: { projectId: input.projectId, runId: input.requestId, parentSessionId: input.parentSessionId, role: input.accountingRole ?? 'orchestrator', scope: 'loop' },
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.providerType !== undefined ? { providerType: input.providerType } : {}),
        ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
        messages: [{ role: 'system', content: wrapUp ? `${systemForTurn(input.system, turn)}${WRAP_UP_SUFFIX}` : systemForTurn(input.system, turn) }, ...messages],
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
        } else if (sdk.type === 'thinking' && typeof sdk.thinking === 'string' && sdk.thinking) {
          // 思考增量（2026-10-04）：只上屏呈现（渲染端「思考中·Xs」/可展开原文），
          // 不进 assistantBlocks/协议历史——重放、DSML、零编辑守卫均零感知
          input.publish('thinking_delta', { text: sdk.thinking })
        } else if (sdk.type === 'result') {
          stopReason = sdk.stop_reason
          usage = sdk.usage?.input_tokens !== undefined ? {
            input_tokens: sdk.usage.input_tokens + (sdk.usage.cache_read_input_tokens ?? 0) + (sdk.usage.cache_creation_input_tokens ?? 0),
            output_tokens: sdk.usage.output_tokens,
          } : sdk.usage
        }
      }
      flushTextRun()
      // R1-loop：冲出被扣住的标记前缀（若最终不是 DSML 开标记）
      for (const piece of dsmlFilter.end()) input.publish('message_delta', { text: piece })
    } catch (error) {
      if (isLoopCancelled(error, input.signal)) {
        // 取消取证落盘（2026-09-04 ddee1f39「查。」墙案）：流中半截输出如实落 JSONL，
        // 「事后考察不到」从此可查。只保留 text 块——已到的 tool_use 无 tool_result
        // 配对，带着落盘会让恢复/续跑重放历史时 400（可重放面不进残局）；取消后
        // 不再 emitText 追发 UI 增量。落盘失败静默，不影响取消语义。
        try {
          const partial = [...textParts, ...cleaner.end()].join('')
          const textBlocks = assistantBlocks.filter((block) => block.type === 'text')
          const blocks: MessageContentBlock[] = partial
            ? [...textBlocks, { type: 'text', text: partial }]
            : [...textBlocks]
          if (blocks.length > 0) appendLoopMessage(input.sessionId, 'assistant', blocks)
        } catch {
          // 取证落盘失败静默（取消语义优先）
        }
        return attachUsage(loopCancelled(turns, finalText, toolCalls, 'model_stream', input.signal))
      }
      throw error
    }
    // 空流守卫（2026-10-03 e99e6319 事故）：流「正常结束」但零内容块且无正输出 usage——
    // 渠道网关异常形态（当晚 zhipu 对超限 max_tokens 回 200 零内容流），绝不能当正常
    // 完成往下走（后续 no-marks 拒收/模板兜底会把渠道故障伪装成行为问题误导归因）。
    // 思考耗尽型零正文不在此列：usage.output_tokens > 0（思考计费）走既有零正文告警。
    if (assistantBlocks.length === 0 && !(usage && (usage.output_tokens ?? 0) > 0)) {
      throw new Error(
        `EMPTY_MODEL_STREAM: 渠道返回零内容零用量流（turn ${turn}，model=${input.env.ANTHROPIC_MODEL ?? '?'}）`
          + '——疑似网关/渠道故障，非模型行为问题',
      )
    }
    if (usage) {
      usageTotals.inputTokens += usage.input_tokens ?? 0
      usageTotals.outputTokens += usage.output_tokens ?? 0
      usageTotals.turnsWithUsage += 1
      turnsUsage.push({ turn, inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 })
    }
    turns = turn
    finalText = textOfBlocks(assistantBlocks)
    appendLoopMessage(input.sessionId, 'assistant', assistantBlocks)

    const streamedToolUses = assistantBlocks.filter((block): block is MessageContentBlock & { type: 'tool_use'; id: string; name: string } => block.type === 'tool_use')
    // D2（2026-09-11 狗粮 dd6ba98d）：DSML 传输事故恢复。JSONL 已按原文落盘（事故
    // 证据保留）；此处的恢复只改「发给模型的 messages」与本轮执行：只读调用解析
    // 回 tool_use 直接执行（意图/参数完整且零副作用），写类不盲执行（参数值信道
    // 损坏会写坏代码）改定向反馈重试。开关 BLOMA_DSML_RECOVERY（缺省 on）。
    let turnToolUses = streamedToolUses
    let dsmlFeedbackThisTurn: string | undefined
    // R1-loop（2026-09-19 狗粮 7601e5ae #496）：写类 DSML 意图在预算边界不丢——重试
    // 耗尽收口时随 termination_detail 留痕（狗粮实锤被丢弃的 write_file 重建 dist
    // 意图正是唯一正确修复动作，信息价值已验证）
    let dsmlDroppedIntents: string[] | undefined
    if (turnToolUses.length === 0 && isDegenerateText(finalText)) {
      const parsed = parseDsmlInvokes(finalText)
      if (parsed && classifyDsmlRecovery(parsed, new Set(toolByName.keys())) === 'execute') {
        const recoveredUses = parsed.invokes.map((invoke, index) => ({ id: `dsml-${turn}-${index}`, name: invoke.name, input: invoke.input }))
        // assistantBlocks 重建：丢弃退化正文块，保留协议块前的合法旁白 + 合成 tool_use。
        // （旁白已作为 message_delta 上屏，此处只影响模型侧对话历史。）
        assistantBlocks.length = 0
        if (parsed.prose) assistantBlocks.push({ type: 'text', text: parsed.prose })
        for (const use of recoveredUses) assistantBlocks.push({ type: 'tool_use', id: use.id, name: use.name, input: use.input })
        turnToolUses = recoveredUses.map((use) => ({ ...use, type: 'tool_use' as const }))
        transportRecoveries += 1
        console.warn(`[agent-loop] DSML 传输事故恢复：轮 ${turn} 解析出 ${recoveredUses.length} 个只读调用（${recoveredUses.map((u) => u.name).join('、')}），按正常轮执行`)
      } else if (parsed) {
        // 写类/未知工具：不盲执行，构造定向反馈（具体到调用意图）供下方重试用
        dsmlFeedbackThisTurn = buildTargetedDegenerateFeedback(parsed)
        dsmlDroppedIntents = parsed.invokes.map((invoke) => `${invoke.name}${typeof invoke.input?.path === 'string' && invoke.input.path ? `:${invoke.input.path}` : ''}`)
      }
    }
    // P3 loop-log：文件类工具的入参 path 提取进过程记录（write_file/edit_file 均携带；
    // 其他工具无 path 字段则省略——可选字段，既有埋点消费方零感知）
    const turnCalls: AgentLoopToolCallRecord[] = turnToolUses.map((use) => {
      const rawPath = use.input?.path
      const path = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : undefined
      return { name: use.name, turn, ...(path ? { path } : {}) }
    })
    toolCalls.push(...turnCalls)
    // B3 状态推进：写类调用清零失速计数并登记触达文件；验证类工具标记已自测
    const wroteThisTurn = turnCalls.some((call) => call.name === 'write_file' || call.name === 'edit_file')
    readOnlyStreak = wroteThisTurn ? 0 : readOnlyStreak + 1
    if (wroteThisTurn) {
      for (const call of turnCalls) {
        if ((call.name === 'write_file' || call.name === 'edit_file') && call.path) {
          const normalized = normalizeProgressPath(call.path)
          writtenFiles.add(normalized)
          // W5：只计全量重写（write_file），edit_file 是正确姿势不计数
          if (call.name === 'write_file') fileWriteCounts.set(normalized, (fileWriteCounts.get(normalized) ?? 0) + 1)
        }
      }
    }
    if (turnCalls.some((call) => PROGRESS_VERIFICATION_TOOLS.has(call.name))) verificationSeen = true
    input.onTurn?.({ turn, toolCalls: turnCalls, inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens })

    // 无 tool_use = 模型声明收工（真伪由外部强制终验收口，不信模型自述）。
    // 但「零 tool_use + 正文退行」不是声明收工，是传输事故（d066eb92：DSML 原文
    // 漏进正文，工具调用从未送达）——带反馈重试一轮；重试仍脏则如实 turn_limit
    // 交终验，垃圾文本不得作为完成总结进入交付链。
    if (turnToolUses.length === 0) {
      if (isDegenerateText(finalText)) {
        if (degenerateRetries < DEGENERATE_RETRY_LIMIT) {
          degenerateRetries += 1
          // D2：解析出调用意图时用定向反馈（具体到工具与参数），否则泛化措辞——
          // 定向反馈比泛化重试更可能把模型从 DSML 退化盆地里拉出来
          const feedback = dsmlFeedbackThisTurn ?? DEGENERATE_RETRY_FEEDBACK
          appendLoopMessage(input.sessionId, 'user', [{ type: 'text', text: feedback }])
          messages.push({ role: 'user', content: [{ type: 'text', text: feedback }] })
          continue
        }
        // P2a：status 语义不变（如实 turn_limit 交终验），附真实出口原因观测；
        // R1-loop：写类 DSML 意图随出口留痕（不再无声丢弃）
        return attachUsage({
          status: 'turn_limit',
          turns,
          finalText,
          toolCalls,
          termination_detail: {
            reason: 'degenerate_output',
            retries: degenerateRetries,
            ...(dsmlDroppedIntents?.length ? { dropped_tool_intents: dsmlDroppedIntents } : {}),
          },
        })
      }
      return attachUsage({ status: 'completed', turns, finalText, toolCalls })
    }

    // ---- 工具执行：连续 parallelSafe 段并发 + 其余串行；整批 tool_result 按源序进同一条 user 消息（不变式）----
    const execution = await executeTurnToolCalls(input, toolByName, budgetUsed, turnToolUses, turn, ctx)
    if (execution.cancelled) {
      // P1-04（2026-09-26 运行审计）：批次取消不再丢已完成结果——assistant tool_use
      // 已落盘，若整批丢弃已收集的 tool_result，会话历史会留下未配对 tool_use；
      // 已完成工具照常保存，未执行/被中断的补 cancelled 占位结果，配对完整可重放。
      const covered = new Set((execution.partialResults ?? []).map((block) => (block.type === 'tool_result' ? block.tool_use_id : undefined)))
      const completionBlocks: MessageContentBlock[] = [...(execution.partialResults ?? [])]
      for (const use of turnToolUses) {
        if (!covered.has(use.id)) {
          completionBlocks.push({ type: 'tool_result', tool_use_id: use.id, content: '本次运行已被取消，该工具调用未执行完成。', is_error: true })
        }
      }
      if (completionBlocks.length > 0) {
        appendLoopMessage(input.sessionId, 'user', completionBlocks)
        messages.push({ role: 'user', content: completionBlocks })
      }
      return attachUsage(loopCancelled(turns, finalText, toolCalls, 'tool_execution', input.signal))
    }
    const { resultBlocks, budgetStallThisTurn, terminalBudgetStop } = execution
    // P1-05（2026-09-26 审计）：本轮工具调用回填执行结果——resultBlocks 与 turnToolUses
    // 按源序对齐，拒绝/失败写入（is_error）不再被下游零编辑守卫计为有效修改。
    resultBlocks.forEach((block, i) => {
      if (block.type !== 'tool_result') return
      const call = turnCalls[i]
      if (call) call.status = block.is_error === true ? 'error' : 'ok'
    })
    appendLoopMessage(input.sessionId, 'user', resultBlocks)
    messages.push({ role: 'assistant', content: assistantBlocks })
    messages.push({ role: 'user', content: resultBlocks })
    if (terminalBudgetStop) return attachUsage({ status: 'budget_exhausted', turns, finalText, toolCalls,
      termination_detail: { reason: 'persistent_tool_budget' } })

    // W2-E3：验证工具执行后事件驱动保存（检查点的验证状态/候选指纹随之更新）
    if (turnCalls.some((call) => call.name === 'run_gwt_tests')) emitCheckpoint('gwt', turn)
    if (turnCalls.some((call) => call.name === 'run_api_contract_tests')) emitCheckpoint('api', turn)
    if (turnCalls.some((call) => call.name === 'run_security_scan')) emitCheckpoint('security', turn)

    // ---- P0-1 steer（运行中转向）批间注入点：resultBlocks 落盘后、下一轮模型调用前 ----
    // 主 loop 的天然批间边界：逐条 drain → JSONL 落盘 → messages.push → publish
    // steer_injected。注入内容照常参与滑窗/竹节压缩（窗口自然滑出；压缩时进交接输入，
    // 无需特判）。「整批 tool_result 进同一条 user 消息」不变式不受影响。
    // 委派等待期（wait_for_delegations 阻塞中）注入照常在下一次批间生效，不打断等待。
    if (isMainLoop) {
      const steerEntries = drainSteerQueue(input.sessionId)
      for (const entry of steerEntries) {
        const wrapped = wrapSteerContent(entry.content)
        appendLoopMessage(input.sessionId, 'user', [{ type: 'text', text: wrapped }])
        messages.push({ role: 'user', content: [{ type: 'text', text: wrapped }] })
        // I3（P7-7，仅 on 时）：注入完成是 merged_this_run 的唯一事实源——payload 追加
        //  steer_id/status，状态账本同点推进（off 时 entry.steerId 缺省，字节不变）。
        const confirmOn = steerConfirmEnabled() && entry.steerId !== undefined
        if (confirmOn) markSteerMerged(input.sessionId, entry.steerId!)
        input.publish('steer_injected', {
          content: entry.content,
          message: wrapped,
          at_turn: turn,
          remaining: pendingSteerCount(input.sessionId),
          ...(confirmOn ? { steer_id: entry.steerId, status: 'merged_this_run' as const } : {}),
        })
        // W2-E2：转向即活跃决策——新转向取代全部旧转向（superseded_by 链，不把冲突新旧同时注入）
        const steerId = `steer-${turn}-${steerDecisions.length + 1}`
        for (const decision of steerDecisions) if (!decision.superseded_by) decision.superseded_by = steerId
        steerDecisions.push({ id: steerId, kind: 'steer', text: wrapped.slice(0, 200), at_turn: turn })
        emitCheckpoint('steer', turn)
      }
    }

    // ---- B3（P0-B，2026-09-11 审计案 35c1a633）：进度对账三守卫批间注入 ----
    // 与 steer 同点位（resultBlocks 落盘后、下一轮模型调用前）；注入计入滑窗/压缩管道，
    // 不破坏「整批 tool_result 单条 user 消息」不变式。开关 off=零注入字节级现状；
    // 只挂主 loop（修复轮任务窄且无 plan 上下文）；wrapUp 激活后不再打扰（模型在交卷）。
    if (isMainLoop && !wrapUp && !input.disableProgressNudge) {
      const nudges: string[] = []
      // 守卫1 只读失速：连续 N 轮无 write/edit → 提醒落盘（注入后重置，再失速两计数再提）
      if (readOnlyStreak >= PROGRESS_READ_ONLY_TURNS) {
        nudges.push(
          `已连续 ${readOnlyStreak} 轮只读（无 write_file/edit_file）。读取与检查足够后请立即把实现落盘：先写入口与核心模块，再逐步补齐。`,
        )
        readOnlyStreak = 0
      }
      // 守卫2 清单对账：轮次消耗 ≥75% 且 plan 清单存在 → 未触达文件列名（含入口接线）
      if (!planNudgeDone && input.planFiles && input.planFiles.length > 0 && turn >= Math.ceil(input.maxTurns * 0.75)) {
        const untouched = input.planFiles.filter((path) => !writtenFiles.has(normalizeProgressPath(path)))
        if (untouched.length > 0) {
          nudges.push(
            `轮次已消耗 ${turn}/${input.maxTurns}，技术合同清单中以下文件尚未写入：${untouched.join('、')}。若确已不需要请在旁白说明原因；否则优先补齐（注意：index.html 未引用构建产物 dist/app.js 时页面无法加载功能）。`,
          )
          planNudgeDone = true
        }
      }
      // 守卫3 自测提醒：进入后 1/3 轮次仍零验证工具调用。文案只引用当前工具面
      // 真实存在的验证工具（全链路审查 P1，2026-10-01：不再点名已退役的幽灵工具）；
      // 无验证工具时仍提醒（防只读空转），但指引如实——自查后交卷或说明受阻。
      if (!verifyNudgeDone && !verificationSeen && turn >= Math.ceil((input.maxTurns * 2) / 3)) {
        const verifyHint =
          availableVerifyTools.length > 0
            ? `（${availableVerifyTools.join(' / ')}）`
            : '（当前会话未装配验证工具）'
        nudges.push(
          `已进行 ${turn}/${input.maxTurns} 轮，尚未运行过任何自测工具${verifyHint}。请尽快自测一次，尽早暴露问题，不要把验证全部留到收尾。`,
        )
        verifyNudgeDone = true
      }
      if (nudges.length > 0) {
        const nudgeText = `【进度对账（宿主注入）】\n${nudges.join('\n')}`
        appendLoopMessage(input.sessionId, 'user', [{ type: 'text', text: nudgeText }])
        messages.push({ role: 'user', content: [{ type: 'text', text: nudgeText }] })
      }
    }

    // ---- W5（Phase 8.5，2026-09-12 狗粮 dd6ba98d）：任务清单工作流批间注入 ----
    // 与 B3 同点位同模式；开关独立（BLOMA_TASK_WORKFLOW 缺省 on）。只挂主 loop
    // （修复/迭代轮任务窄）；wrapUp 后不打扰；无 planFiles 时不启用（清单不存在）。
    if (isMainLoop && !wrapUp && input.planFiles && input.planFiles.length > 0) {
      const w5Nudges: string[] = []
      // 守卫4 重复写：本轮出现同文件第二次及以上的全量 write_file → 改用 edit_file
      //（对症当晚「state/loop/input/collision 等 6 文件完整重写第二遍」病灶）
      const rewrittenThisTurn = [
        ...new Set(
          turnCalls
            .filter((call) => call.name === 'write_file' && call.path && (fileWriteCounts.get(normalizeProgressPath(call.path)) ?? 0) >= 2)
            .map((call) => normalizeProgressPath(call.path!)),
        ),
      ]
      if (rewrittenThisTurn.length > 0) {
        w5Nudges.push(
          `${rewrittenThisTurn.join('、')} 本轮已完整写过；若确需微调请用 edit_file 改差异段，不要整文件重写（已完成清单项勿重做）。`,
        )
      }
      // 进度投影：新文件完成且距上次投影 ≥2 轮（防刷屏）——把「清单 N/M + 勿重写」
      // 的工作感持续送达，防写后丢任务感陷入全量重读
      const doneInPlan = input.planFiles.filter((path) => writtenFiles.has(normalizeProgressPath(path)))
      if (writtenFiles.size > checklistProjectedFiles && turn - lastProjectionTurn >= 2) {
        checklistProjectedFiles = writtenFiles.size
        lastProjectionTurn = turn
        w5Nudges.push(
          `【清单进度】实施清单文件已完成 ${doneInPlan.length}/${input.planFiles.length}；已完成文件勿重写（微调用 edit_file），按清单继续下一项，读过的内容不要重读。`,
        )
      }
      // 早验证（B3 守卫3 的前移分支）：写完 ≥3 个文件仍零验证且已过 1/3 轮次（一次性）
      // + 狗粮 52f19ab4 增强：清单全部完成后零验证 → 每 2 轮重复强提醒（祈使句）——
      //   当晚清单 10/10 后模型仍花 12 轮通读自己的文件而不跑测试，一次性劝告被无视
      if (!earlyVerifyNudged && !verificationSeen && writtenFiles.size >= 3 && turn >= Math.ceil(input.maxTurns / 3)) {
        earlyVerifyNudged = true
        w5Nudges.push(
          availableVerifyTools.length > 0
            ? `已写入 3 个以上文件但尚未运行任何自测：现在就跑一次 ${availableVerifyTools[0]}，尽早暴露问题，不要把验证全部留到收尾。`
            : '已写入 3 个以上文件但尚未自测：当前会话未装配验证工具，请逐文件核对关键路径与入口引用，不要把检查全部留到收尾。',
        )
      }
      if (!verificationSeen && doneInPlan.length >= input.planFiles.length && turn - lastVerifyRepeatTurn >= 2) {
        lastVerifyRepeatTurn = turn
        const verifyCmd =
          availableVerifyTools.length > 0
            ? `立即运行 ${availableVerifyTools.join(' / ')}，按结果决定收口或修复。`
            : '当前会话未装配验证工具：请对照清单逐项自查关键路径与入口引用，自查无误即输出完成总结。'
        w5Nudges.push(
          `实施清单已全部完成（${doneInPlan.length}/${input.planFiles.length}）——不要再通读自己写的文件，读不能代替测试：${verifyCmd}`,
        )
      }
      if (w5Nudges.length > 0) {
        const w5Text = `【任务清单工作流（宿主注入）】\n${w5Nudges.join('\n')}`
        appendLoopMessage(input.sessionId, 'user', [{ type: 'text', text: w5Text }])
        messages.push({ role: 'user', content: [{ type: 'text', text: w5Text }] })
      }
    }

    // 钉轮信号：出现「新的」测试失败（repair_round 增长；粘性 test_failed 不算）且
    // 尚未钉过 → 钉本轮（末位完整工具对的配对序号；无保留段且各轮皆工具轮时与旧口径
    // turn - pinBaseTurn 等值，见 tailLastPairOrdinal 注释）
    if (ctx.state.test_failed && ctx.state.repair_round > pinnedRepairRound) {
      if (pinnedTestTurn === undefined) pinnedTestTurn = tailLastPairOrdinal(messages)
      pinnedRepairRound = ctx.state.repair_round
    }

    // 收口判定（2026-08-29 线上案例 eb900c57）：验证全绿 = 活已干完，下一轮起停用全部
    // 工具 + system 追加收口指令，逼模型交卷而非继续冗余验证。判定保持纯状态位语义
    // （谁装配谁置位；未装配的验证位在初始化处豁免，见 runAgentLoop 入口 gwt/api 预置）。
    if (!apiChecked && ctx.state.gwt_all_passed && ctx.state.security_all_passed) {
      apiChecked = true
      if (!availableVerifyTools.includes('run_api_contract_tests')) {
        // 如实化（全链路审查 P1，2026-10-01）：工具未装配=豁免。web 线拆除后
        // run_api_contract_tests 已退役，背板有契约而无工具的会话不得死锁收口。
        ctx.state.api_all_passed = true
      } else {
        try {
          const { readPrdBackplane } = await import('../../project/document-engine')
          const spec = readPrdBackplane(input.projectId)?.interface_spec
          ctx.state.api_all_passed = !spec || spec.length === 0
        } catch (error) {
          ctx.state.api_all_passed = String((error as Error).message).includes('PROJECT_NOT_FOUND')
        }
      }
    }
    // GWT 工具缺席时的豁免位不能冒充真实功能验证。桌面会话由阶段宿主验收，
    // 仅扫描通过不得提前撤走实现/自测/GUI 工具；旧功能验证面保留全绿后收口语义。
    wrapUp = input.tools.some((tool) => tool.name === 'run_gwt_tests') && ctx.state.gwt_all_passed && ctx.state.security_all_passed && ctx.state.api_all_passed && (!preflightEnabled() || ctx.state.preflight_passed === true)

    consecutiveBudgetStallTurns = budgetStallThisTurn ? consecutiveBudgetStallTurns + 1 : 0
    // ---- P2-02：成本硬上限（每轮末检查；opt-in 缺省 0=不限，行为零变化）----
    // 累计 = 主循环 usage + 交接/宽限估算；达限立即进入可解释终态（不静默烧额度）
    const costLimit = resolveLoopCostLimitTokens()
    const observedCost = usageTotals.inputTokens + usageTotals.outputTokens + auxCost.auxEstTokens
    if (costLimit > 0 && observedCost >= costLimit) {
      return attachUsage({
        status: 'budget_exhausted',
        turns,
        finalText,
        toolCalls,
        termination_detail: { reason: 'cost_limit' as const, retries: 0, limit: costLimit, observed: observedCost },
      })
    }
    if (consecutiveBudgetStallTurns >= BUDGET_STALL_TURNS) {
      return attachUsage({ status: 'budget_exhausted', turns, finalText, toolCalls })
    }

    // ---- usage 竹节压缩（闭环 PR6）：阈值触发交接，重置为 task+交接文档 ----
    // W1-E1（咨询 D3）：阈值满足单独提取——满足但因上限/末段被跳过时报一次 skip 观测
    // （此前该路径完全静默；纯埋点，压缩行为零变化）。E6 核查 1 定案：上限后=静默跳过。
    // W6-E4：渠道 usage 盲时（本轮无 usage）用 est 兜底判据（BLOMA_COMPACT_EST_FALLBACK，
    // 缺省 off=现状触发器失明；W1 以撒案 24 轮 input=0 一次都没压缩的根治位）。
    // P2-02：usage 可信度区分——input_tokens 缺失或为 0 都算盲（旧口径仅 undefined 算盲，
    // provider 恒返 0 时估算兜底不启用 → 自动压缩触发器失明）
    const usageBlind = usage === undefined || (usage.input_tokens ?? 0) <= 0
    const estFallbackMet =
      usageBlind && estTokensOfMessages(messages) >= compactThreshold
    const compactThresholdMet =
      compactThreshold > 0 && ((usage?.input_tokens ?? 0) >= compactThreshold || estFallbackMet)
    // W2（Phase 10）：显式压缩——compact_context 工具置位后在本安全点（本轮工具对已落盘）
    // 与自动压缩同路径处理；独立计数（不占用自动压缩的 LOOP_MAX_COMPACTIONS 预算），
    // 自动触发器失明（glm input_tokens=0）时它是模型侧唯一的主动收缩出口。
    const explicitCompactRequested = ctx.state.compact_requested === true
    ctx.state.compact_requested = false
    const explicitEligible =
      explicitCompactRequested &&
      (ctx.state.explicit_compactions ?? 0) < MAX_EXPLICIT_COMPACTIONS &&
      turn < input.maxTurns - 1
    if (
      (compactThresholdMet && compactions < LOOP_MAX_COMPACTIONS && turn < input.maxTurns - 3) ||
      explicitEligible
    ) {
      if (input.signal.aborted) return attachUsage(loopCancelled(turns, finalText, toolCalls, 'handoff', input.signal))
      const handoff = await requestHandoff(input, messages, pinnedTestTurn)
      if (input.signal.aborted) return attachUsage(loopCancelled(turns, finalText, toolCalls, 'handoff', input.signal))
      // 确定性兑底也携带钉轮失败断言原文（审查 P1-2：交接失败恰是最需要细节的降级路径）
      // W6-E4：检查点开着时兑底交接附带检查点段（硬阈值兜底从检查点拼装，D3 §三 D）
      const summary =
        handoff ||
        deterministicHandoff(
          turn,
          toolCalls,
          finalText,
          pinnedFailureExcerpt(messages, pinnedTestTurn),
          loopCheckpointEnabled()
            ? renderCheckpointProjection(checkpointSnapshotOf('compaction', turn)).replace('【检查点投影（宿主状态，勿改写；每轮更新）】', '【检查点状态】')
            : undefined,
        )
      // keep-recent 三段式（P1-1）：task + 交接文档 + 近期原文保留段——重置在「交接文档」
      // 之外保留最近原文轮次（预算 keepRecentBudget；'0' 时 retained 为空 = 旧行为两段）。
      // 保留段在重置前的 messages 上计算（含本轮刚落盘的工具对）；交接 LLM 失败的确定性
      // fallback 路径同样带保留段（降级路径恰最需要细节，对齐审查 P1-2 先例）。
      // W1-E1：重置前先留观测口径（est/保留/移除计数——保留段是尾部连续后缀，计数即定位）。
      const retained = keepRecentTurns(messages, keepRecentBudget)
      const estTokensBefore = estTokensOfMessages(messages)
      // P2-02：交接调用计入统一成本口径（不计 turns，但计成本——审计原文）
      auxCost.handoffCalls += 1
      auxCost.auxEstTokens += estTokensBefore + estimateTokenCount(summary)
      const historyTurnsBefore = messages.length - 1
      const removedTurns = historyTurnsBefore - retained.length
      messages.length = 0
      // W2：段号 = 自动+显式总段数（无显式时与现状字节一致）；计数分离——显式不占自动预算
      const segmentNo = compactions + (ctx.state.explicit_compactions ?? 0) + 1
      messages.push({
        role: 'user',
        content:
          `${input.task}\n\n【此前进度交接（第 ${segmentNo} 段）】\n${summary}` +
          (retained.length > 0 ? '\n\n【近期原文保留】以下是压缩前最近的原文轮次（保真参考，未经改写，时间从早到晚）。' : ''),
      })
      messages.push(...retained)
      // W2 E2+F1（咨询 D3 §五）：压缩后恢复头由检查点生成——宿主拼装的短恢复（当前目标/仍有效
      // 转向/未闭环失败/验证状态/候选指纹），不依赖模型记住全过程。开关 off=字节级现状（零注入）。
      if (loopCheckpointEnabled()) {
        const header = renderCheckpointRecoveryHeader(input.task, checkpointSnapshotOf('compaction', turn))
        const first = messages[0]!
        messages[0] = {
          role: 'user',
          content: typeof first.content === 'string' ? `${first.content}\n\n${header}` : first.content,
        }
        emitCheckpoint('compaction', turn)
      }
      if (explicitEligible) ctx.state.explicit_compactions = (ctx.state.explicit_compactions ?? 0) + 1
      else compactions += 1
      // 重置钉轮坐标系（审查 P1-1）：旧失败已被交接文档覆盖（repair_round 快照对齐，
      // 后续只有新失败才重钉；避免粘性 test_failed 幻影钉在无关轮对上）。P1-1 后配对
      // 序号按 tail 实际配对计数（tailLastPairOrdinal），无需再维护基线轮号。
      pinnedTestTurn = undefined
      pinnedRepairRound = ctx.state.repair_round
      input.publish('loop_compaction', {
        at_turn: turn,
        input_tokens: usage?.input_tokens,
        compactions,
        // W2：显式触发观测（缺省 auto 保持存量字段形态，新增字段消费方后兼容）
        trigger: explicitEligible ? 'explicit' : 'auto',
        explicit_compactions: ctx.state.explicit_compactions ?? 0,
        keep_recent_turns: retained.length,
        // W1-E1 观测扩展（新增字段，消费方后兼容）：重置前后估算与移除/兑底口径
        est_tokens_before: estTokensBefore,
        est_tokens_after: estTokensOfMessages(messages),
        removed_turns: removedTurns,
        handoff_fallback: !handoff,
      })
      input.onCompaction?.({
        at_turn: turn,
        segment: segmentNo,
        trigger: explicitEligible ? 'explicit' : 'auto',
        trigger_input_tokens: usage?.input_tokens,
        est_tokens_before: estTokensBefore,
        est_tokens_after: estTokensOfMessages(messages),
        retained_turns: retained.length,
        removed_turns: removedTurns,
        handoff_chars: summary.length,
        handoff_fallback: !handoff,
      })
      // 交接文档落 JSONL 审计（与 [channel-switch] 同一 system 行呈现模式，审查 P1-2）
      appendSessionMessage(input.sessionId, {
        role: 'system',
        content: [
          {
            type: 'text',
            text: `[loop-compaction] 第 ${segmentNo} 段交接（at_turn=${turn}，input_tokens=${usage?.input_tokens ?? '-'}，keep_recent=${retained.length} 轮${explicitEligible ? '，trigger=explicit' : ''}）：\n${summary.slice(0, 1000)}`,
          },
        ],
        timestamp: Date.now(),
      })
    } else if (compactThresholdMet && !compactionSkipLogged) {
      // W1-E1：上限/末段跳过首次发生时报一次（每 loop 至多一条防逐轮噪音）。原因优先级：
      // 上限跳过（max_compactions）比末段保护（late_turn）更有诊断价值。
      compactionSkipLogged = true
      input.onCompaction?.({
        at_turn: turn,
        segment: compactions,
        trigger_input_tokens: usage?.input_tokens,
        skipped: true,
        skip_reason: compactions >= LOOP_MAX_COMPACTIONS ? 'max_compactions' : 'late_turn',
        retained_turns: 0,
        removed_turns: 0,
        handoff_chars: 0,
        handoff_fallback: false,
      })
    }
  }

  // ---- 宽限收口轮（2026-08-29 线上案例 eb900c57）：预算耗尽不再直接判 turn_limit ----
  // 该案例产物第 20 轮已全部就绪（测试/扫描全过），只差「输出完成总结」这个动作被挤掉。
  // 补一次无 tools 的收口调用让模型交卷：出文本 → completed（外部终验仍照跑，不信自述）；
  // 仍坚持要工具 → 如实 turn_limit。宽限轮不计 turns、不发 onTurn（epilogue 不是工作轮）。
  // P2-02：宽限交卷调用计入统一成本口径（不计 turns，但计成本）
  auxCost.graceCalls += 1
  auxCost.auxEstTokens += estTokensOfMessages(messages)
  let grace = await runGraceWrapUpTurn(input, messages, pinnedTestTurn)
  if (grace.kind === 'text') auxCost.auxEstTokens += estimateTokenCount(grace.text)
  // D2 补口（狗粮 52f19ab4，2026-09-12）：宽限交卷轮退化但解析出工具意图 → 明确告知
  // 工具已停用，再给一次交卷机会（当晚 40 轮耗尽后模型在无 tools 交卷调用里仍想
  // read_file → DSML 原文死；主循环的 D2 恢复不覆盖 grace 路径）
  if (grace.kind === 'text' && isDegenerateText(grace.text)) {
    const parsedGrace = parseDsmlInvokes(grace.text)
    if (parsedGrace) {
      const graceFeedback = [
        '【收口指令（宿主注入）】工具调用已全部停用（检测到你仍想调用 ' + parsedGrace.invokes.map((invoke) => invoke.name).join('、') + '）。',
        input.system.includes('【工作区短回复约定】') ? '请用2～3句日常中文说明结果、重要限制和下一步，详细证据保留工作记录。' : '无需再读取或修改任何文件——请直接输出完成总结：逐项说明已完成的实施清单项与自测情况；未验证的部分如实说明。',
      ].join('\n')
      appendLoopMessage(input.sessionId, 'user', [{ type: 'text', text: graceFeedback }])
      messages.push({ role: 'user', content: [{ type: 'text', text: graceFeedback }] })
      auxCost.graceCalls += 1
      auxCost.auxEstTokens += estTokensOfMessages(messages)
      grace = await runGraceWrapUpTurn(input, messages, pinnedTestTurn)
      if (grace.kind === 'text') auxCost.auxEstTokens += estimateTokenCount(grace.text)
    }
  }
  // 宽限轮交卷文本同样不可是传输事故：退行文本不作完成总结，按 turn_limit 收口。
  // P1-05（2026-09-26 审计）：宽限交卷的 completed 附 termination_detail.grace_wrap_up
  // 观测——status 语义不变（外部终验权威、不信自述），但出口可区分「轮内完成」与
  // 「预算耗尽后交卷」，下游不再把两者混计。
  if (grace.kind === 'text' && !isDegenerateText(grace.text)) {
    return attachUsage({ status: 'completed', turns, finalText: grace.text, toolCalls, termination_detail: { reason: 'grace_wrap_up' as const } })
  }
  if (grace.kind === 'cancelled') return attachUsage(loopCancelled(turns, finalText, toolCalls, 'grace_turn', input.signal))
  // P2a：宽限轮交卷文本仍退化（重试后仍脏）→ 同样附真实出口原因；其余（refused/failed）维持裸 turn_limit
  const graceDegenerate = grace.kind === 'text' && isDegenerateText(grace.text)
  return attachUsage({
    status: 'turn_limit',
    turns,
    finalText,
    toolCalls,
    ...(graceDegenerate ? { termination_detail: { reason: 'degenerate_output' as const, retries: degenerateRetries } } : {}),
  })
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
  // R1-loop：与主循环同口径的 DSML 呈现过滤（狗粮 8 例中 7 例发生在宽限/收口轮）
  const dsmlFilter = createDsmlDisplayFilter()
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
      maxTokens: Math.min(input.maxTokens, WRAP_UP_MAX_TOKENS),
      accounting: { projectId: input.projectId, runId: input.requestId, parentSessionId: input.parentSessionId, role: input.accountingRole ?? 'orchestrator', scope: 'grace' },
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
      messages: [
        { role: 'system', content: `${input.system}${GRACE_TURN_SUFFIX}${userFacingWrapUp(input.system)}` },
        // 2026-09-16 上下文同步 Proma：与主路径同口径（全量模式传全量；滑窗逃生口维持窗口）
        ...messages,
      ],
      // 空数组而非缺省：与「无 tools 的交接调用」在调用方可区分（tools === undefined）
      tools: [],
    })) {
      if (sdk.type === 'assistant' && sdk.message) {
        for (const block of sdk.message.content) {
          if (block.type === 'text' && block.text) {
            const pieces = cleaner.push(block.text)
            for (const piece of pieces) {
              for (const display of dsmlFilter.push(piece)) input.publish('message_delta', { text: display })
            }
            textParts.push(...pieces)
          } else {
            flushText()
            blocks.push(block)
          }
        }
      }
    }
    for (const piece of cleaner.end()) {
      for (const display of dsmlFilter.push(piece)) input.publish('message_delta', { text: display })
      textParts.push(piece)
    }
    for (const display of dsmlFilter.end()) input.publish('message_delta', { text: display })
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
  const validationError = validateToolInput(use.name, toolInput, tool.input_schema)
  if (validationError) return { output: validationError, isError: true, feedback: { schema_version: 1, execution: 'not_run', verification: 'unverified', category: 'invalid_input', recovery: 'correct_input' } }

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

// =========================================================================
// P1-2 只读工具并行执行（2026-09-08 pi 差距方案 §4）
// =========================================================================

/** 并发上限（保守）：读盘/网络密集的只读工具并行，避免瞬时 IO/请求洪峰。 */
export const PARALLEL_CONCURRENCY_LIMIT = 4

/** 一轮工具执行的结果：cancelled 时携带 partialResults（已完成工具的结果块，
 *  2026-09-26 审计 P1-04：不再整批丢弃——调用方补齐配对 tool_result 后落盘）。 */
export type TurnToolExecution =
  | { cancelled: true; partialResults?: MessageContentBlock[] }
  | { cancelled: false; resultBlocks: MessageContentBlock[]; budgetStallThisTurn: boolean; terminalBudgetStop: boolean }

/**
 * 单轮工具执行（P1-2）：保持「整批 tool_result 按源序进同一条 user 消息」不变式，
 * 把**连续** parallelSafe（且无 toolBudget 预算）的工具并发执行，遇非 parallelSafe 先 join。
 *
 * 保守执行策略（方案 §4.2）：
 * 1. 按 assistant 源序分组：连续 parallelSafe 段内并发（上限 PARALLEL_CONCURRENCY_LIMIT）；
 *    有 toolBudget 的工具即使 parallelSafe 也退串行（并行计数会击穿静态预算上限）。
 * 2. resultBlocks 一律按源序拼装——模型看到的 tool_result 顺序 = 模型发出的 tool_use 顺序。
 * 3. 事件流：tool_call_started 各自启动时发、completed 各自完成时发（渲染端逐事件渲染，
 *    无序依赖）；usage/toolCalls 记录在调用点已按源序推进（toolCalls.push 先于本函数）。
 * 4. 取消：串行位沿用旧语义（执行前检查，partial 丢弃）；并发段启动前 + join 后检查。
 *    工具自身异常已由 executeToolCall 转 is_error，Promise.all 不会因单工具失败 reject；
 *    工具内部经 ctx.signal/withAbort 感知取消。
 *
 * 已知软风险（接受，方案 §4.2）：web_research 子代理与主 loop 并行写入交错时可能读到
 * 中间态——其结论是建议性调研（writeFileSync 单次写入原子性兜底），不作为权威输入；
 * 且生产面 web_research 带 toolBudget（runMvpViaAgentLoop 传 { web_research: 4 }）恒串行。
 */
export async function executeTurnToolCalls(
  input: AgentLoopInput,
  toolByName: Map<string, AgentLoopTool>,
  budgetUsed: Record<string, number>,
  turnToolUses: Array<MessageContentBlock & { type: 'tool_use'; id: string; name: string }>,
  turn: number,
  ctx: ToolContext,
): Promise<TurnToolExecution> {
  const resultBlocks: MessageContentBlock[] = []
  let budgetStallThisTurn = false
  let terminalBudgetStop = false

  // 单工具全流程：事件 + 执行；返回结果块（push 交给调用方——源序由调用方保证）。
  const runOne = async (use: { name: string; input?: Record<string, unknown>; id?: string }): Promise<MessageContentBlock> => {
    input.publish('tool_call_started', { tool: use.name, turn, tool_call_id: use.id, input_summary: summarizeJson(use.input) })
    const startedAt = Date.now()
    const outcome = await executeToolCall(input, toolByName, budgetUsed, use, ctx)
    const feedback = feedbackForTool(use.name, outcome)
    if (['write_file', 'edit_file'].includes(use.name) && !outcome.isError && !outcome.budgetExhausted && typeof outcome.detail?.path === 'string') {
      ctx.state.successful_file_changes = [...new Set([...(ctx.state.successful_file_changes ?? []), outcome.detail.path])]
    }
    if (feedback) {
      const facts = ctx.state.latest_tool_feedback ??= {}
      delete facts[use.name]; facts[use.name] = feedback
      if (persistentBudgetBlocked([feedback])) (ctx.state.terminal_budget_feedback ??= {})[use.name] = feedback
      if (persistentBudgetBlocked([feedback])) terminalBudgetStop = true
    }
    if (outcome.budgetExhausted) budgetStallThisTurn = true
    input.publish('tool_call_completed', {
      tool: use.name,
      tool_call_id: use.id,
      turn,
      status: outcome.budgetExhausted ? 'budget' : outcome.isError ? 'error' : 'ok',
      ...(feedback ? { feedback } : {}),
      duration_ms: Date.now() - startedAt,
      output_summary: outcome.output.slice(0, EVENT_SUMMARY_CHAR_LIMIT),
      is_error: outcome.isError === true,
      // M4-C：结构化 detail 透传进事件流（委派工具返回 id/role/status 等，渲染端据此派生协作视图）。
      // 限字段白名单（防敏感/超长数据泄漏）：只取委派工具的标识与状态字段，丢弃 result_summary 等长文本。
      ...(outcome.detail ? { detail: sanitizeToolDetail(outcome.detail) } : {}),
    })
    return {
      type: 'tool_result',
      tool_use_id: use.id,
      content: feedback ? formatToolFeedback(feedback, outcome.output) : outcome.output,
      ...(outcome.isError ? { is_error: true } : {}),
    }
  }

  // 源序单点消费：串行位按序 push；并发段 Promise.all 保持批次内顺序（completed[i] ↔ batch[i]），
  // join 后整体按源序 push——「整批 tool_result 一条 user 消息、块序=源序」不变式保持。
  let index = 0
  while (index < turnToolUses.length) {
    if (input.signal.aborted) return { cancelled: true, partialResults: resultBlocks }
    const use = turnToolUses[index]!
    const tool = toolByName.get(use.name)
    const parallelizable = tool?.parallelSafe === true && input.toolBudget?.[use.name] === undefined
    if (!parallelizable) {
      // 串行位：前面并发段都已 join 完，join 语义天然满足；执行中 abort 转批次取消
      //（P1-04：已完成结果随 partialResults 保留，不丢弃）
      try {
        resultBlocks.push(await runOne(use))
      } catch (error) {
        if (input.signal.aborted) return { cancelled: true, partialResults: resultBlocks }
        throw error
      }
      index += 1
      continue
    }
    // 切出连续 parallelSafe 段
    let end = index
    while (end < turnToolUses.length) {
      const candidate = toolByName.get(turnToolUses[end]!.name)
      if (!(candidate?.parallelSafe === true && input.toolBudget?.[turnToolUses[end]!.name] === undefined)) break
      end += 1
    }
    const group = turnToolUses.slice(index, end)
    // 并发上限内的小池：避免一次性 Promise.all 数十个只读调用打满 fd/网络。
    // P1-04：allSettled 化——取消时同批已完成的结果保留（Promise.all 会丢），
    // 非取消 reject（理论不发生，executeToolCall 已兕底）向上抛。
    for (let cursor = 0; cursor < group.length; cursor += PARALLEL_CONCURRENCY_LIMIT) {
      if (input.signal.aborted) return { cancelled: true, partialResults: resultBlocks }
      const batch = group.slice(cursor, cursor + PARALLEL_CONCURRENCY_LIMIT)
      const settled = await Promise.allSettled(batch.map((item) => runOne(item)))
      if (input.signal.aborted) {
        settled.forEach((outcome, i) => {
          if (outcome.status === 'fulfilled') resultBlocks.push(outcome.value)
        })
        return { cancelled: true, partialResults: resultBlocks }
      }
      for (const outcome of settled) {
        if (outcome.status === 'rejected') throw outcome.reason
        resultBlocks.push(outcome.value)
      }
    }
    index = end
  }
  return { cancelled: false, resultBlocks, budgetStallThisTurn, terminalBudgetStop }
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

/** W1-E1（咨询 D3）：从 AbortSignal.reason 解析取消来源——'AGENT_CANCELLED: <source>' 约定见
 *  orchestrator.cancelAgent（用户停止='user_cancelled'）；无 reason 的 abort（委派 stop/程序化）
 *  归 'unattributed'。 */
function cancelSourceOf(signal?: AbortSignal): { source?: string; reason?: string } {
  const reason: unknown = signal?.reason
  if (reason === undefined) return {}
  const message = reason instanceof Error ? reason.message : String(reason)
  const marker = message.match(/^AGENT_CANCELLED:\s*(.+)$/)
  return { source: marker?.[1] ?? 'unattributed', reason: message.slice(0, 200) }
}

function loopCancelled(
  turns: number,
  finalText: string,
  toolCalls: Array<{ name: string; turn: number }>,
  phase: LoopCancelPhase,
  signal?: AbortSignal,
): AgentLoopResult {
  return { status: 'cancelled', turns, finalText, toolCalls, cancel_detail: { phase, ...cancelSourceOf(signal) } }
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
export function createWhitespaceArtifactCleaner(): WhitespaceArtifactCleaner {
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
