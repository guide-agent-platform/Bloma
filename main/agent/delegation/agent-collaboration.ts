import { randomUUID } from 'node:crypto'
import { appendDelegationSettle, loadChildSessionSnapshot, replayTurnsFrom } from './delegation-persistence'
import { recordSessionActivity } from '../../platform/sessions/session-service'
import type { AgentEvent, PromaPermissionMode } from '../../../shared/types'
import type { SDKQuery } from '../../orchestration/orchestrator'
import type { ConversationTurn } from '../../orchestration/orchestrator'
import { resolveDelegationChannelOverride, type DelegationChannelOverride } from './delegation-channel'
import { ensureDelegationWatchStarted, setDelegationScanSource } from './delegation-watch'
import {
  runAgentLoop,
  type AgentLoopResult,
  type AgentLoopTool,
  type AgentLoopTurnInfo,
  type AgentLoopCompactionInfo,
  type ToolContext,
} from '../loop/agent-loop'

/**
 * 委派协作协调器（委派协作嫁接方案 §4.1，2026-08-24）。
 *
 * Proma 委派模式（agent-collaboration-tools.ts 实证）在 Bloma 的落地：编程主 agent
 * 自主循环内可 **fire-and-forget** 委派真实子会话（独立 runAgentLoop）并行协作，
 * 仅 1 层深度、每父并行上限、tool-call 幂等。父 agent 后续用 wait_for_delegations
 * 阻塞收集结果。
 *
 * 依赖纪律（避免循环依赖）：
 * - 本模块 **不 import agent-tools.ts**。子 agent 工具集由 `setChildToolsBuilder`
 *   注入（programming-orchestrator 用 `buildAgentTools({ role })` 注入）。
 * - 父 loop 的运行上下文（query/env/背板 system/maxTokens/权限）由
 *   `registerParentLoopContext` 注册，`startDelegation` 按父 sessionId 取用。
 */

// =========================================================================
// 常量
// =========================================================================

/** 委派目标描述截断上限（对齐 Proma DELEGATION_GOAL_CHAR_LIMIT）。 */
export const DELEGATION_GOAL_CHAR_LIMIT = 200

/** 子 agent 结果摘要回传上限（对齐 Proma get_delegation_results ≤50000 chars）。 */
export const DELEGATION_RESULT_CHAR_LIMIT = 50_000

/** 每父会话并行在跑委派数上限（对齐 Proma MAX_RUNNING_DELEGATIONS_PER_PARENT）。 */
export const MAX_RUNNING_DELEGATIONS_PER_PARENT = 4

/** 内存中保留的已终结委派记录上限（防 registry 无限增长）。 */
const MAX_FINISHED_DELEGATIONS = 50

/** wait_for_delegations 缺省等待上限（毫秒）。 */
const DEFAULT_DELEGATION_WAIT_TIMEOUT_MS = 600_000

// =========================================================================
// 类型
// =========================================================================

export type DelegationRole = 'explore' | 'research' | 'implement' | 'review' | 'custom'

export type DelegationStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface DelegateAgentArgs {
  task: string
  role?: DelegationRole
  expectedOutput?: string
  title?: string
  /** C1（2026-09-24）：跨渠道委派（指定渠道而非继承父渠道；modelId 须属该渠道已启用，未传自动选首个支持工具项）。 */
  channelId?: string
  modelId?: string
}

export interface StartDelegationResult {
  delegation_id: string
  child_session_id: string
  role: DelegationRole
  goal: string
  status: DelegationStatus
}

export interface DelegationSummary {
  delegation_id: string
  role: DelegationRole
  status: DelegationStatus
  goal: string
  result_summary?: string
  error?: string
  started_at: number
  /** 子 agent 通过 ask_delegation_question 挂起提问中（父 agent 应尽快 answer）。 */
  pending_question?: string
  /** C1：委派渠道覆盖摘要（如「智谱/GLM-5.3」；缺省 = 继承父会话渠道）。 */
  channel?: string
}

/** 子 agent 提问信号：ask 时 resolve，wait_for_delegations 据此提前返回让父代答。 */
export interface AskSignal {
  promise: Promise<void>
  resolve: () => void
}

export interface DelegationRecord {
  delegationId: string
  parentSessionId: string
  childSessionId: string
  projectId: string
  role: DelegationRole
  goal: string
  status: DelegationStatus
  resultSummary?: string
  error?: string
  startedAt: number
  /** stop_delegation 中止子循环用。 */
  abort: AbortController
  /** 终结（completed/failed/cancelled）时 resolve；wait_for_delegations 阻塞点。 */
  completion: Promise<void>
  /** stop_delegation 手动终结时主动 resolve completion（解除 wait 阻塞；内部字段，勿直接操作）。 */
  resolveCompletion: () => void
  /** 子 agent 提问信号（ask 时 resolve；wait_for_delegations 提前返回让父代答）。 */
  askSignal: AskSignal
  /** 子 agent 挂起提问的问题（待父 answer；父答后清空）。 */
  pendingQuestion?: string
  /** ask_delegation_question 挂起的 resolve（answer 时回调，把答案回传子 loop）。 */
  pendingAnswerResolve?: (answer: string) => void
  channelOverride?: DelegationChannelOverride
}

/** 父 loop 运行上下文（构建子 AgentLoopInput 所需；runMvpViaAgentLoop 注册）。 */
export interface DelegationParentContext {
  query: SDKQuery
  env: Record<string, string>
  maxTokens: number
  /** 父 loop 轮次上限（子 loop 取 min(父上限, delegationMaxTurns)）。 */
  maxTurns: number
  /** 子 agent 独立轮次上限（比主 loop 小，控制 token 成本）。 */
  delegationMaxTurns: number
  permissionMode: PromaPermissionMode
  temperature: number
  /** 背板锚定 system prompt（buildAgentLoopSystemPrompt 产物），子 loop 在它之上加委派规则。 */
  system: string
  editFormat: 'diff' | 'whole'
  /** omit 推广（2026-08-27）：子 loop 透传父渠道 providerType，Token Plan 类渠道免 400 往返 */
  providerType?: string
  publish: (type: AgentEvent['type'], payload: Record<string, unknown>) => void
  /** 无代答者的合成父（如审查委派 review-{uuid}）——子代理提问时立即以该固定答复回传
   *  而不挂起干等（T-5：此前无人代答，提问会挂到 120/150s 超时）。 */
  autoAnswer?: string
  /** 子 loop 每轮埋点（programming-orchestrator 注入，session_id=子 sessionId）。 */
  onChildTurn?: (info: AgentLoopTurnInfo, child: { sessionId: string; requestId: string; role: DelegationRole }) => void
  /** W1-E1：子 loop 压缩观测埋点（agent_loop_compact via=delegation；同 onChildTurn 模式）。 */
  onChildCompaction?: (info: AgentLoopCompactionInfo, child: { sessionId: string; requestId: string; role: DelegationRole }) => void
  /** 追加到子 agent 工具面的定向工具（2026-09 内审闭环）：如 read_conversation_history /
   *  write_prd_draft——闭包携带调用方上下文，仅注入需要它的委派（最小攻击面）。 */
  childExtraTools?: AgentLoopTool[]
}

/** 子 agent 工具集构建器（按 role 裁剪；programming-orchestrator 注入 buildAgentTools）。 */
export type ChildToolsBuilder = (projectId: string, role: DelegationRole, editFormat: 'diff' | 'whole') => AgentLoopTool[]

export interface WaitForDelegationsArgs {
  delegationIds?: string[]
  strategy?: 'all' | 'any'
  timeout_ms?: number
}

// =========================================================================
// 内部状态
// =========================================================================

const delegations = new Map<string, DelegationRecord>()
const parentContexts = new Map<string, DelegationParentContext>()

/**
 * abort 后子循环仍不 settle 的强制收尾超时（ms）：
 * 部分工具（如 hang 类 `execute: () => new Promise<never>(() => {})`）不响应 abort 信号，
 * abort 后子循环永久挂起、completion 永不 resolve，DelegationRecord 会永远留在 registry
 * （内存泄漏 + 占用并行额度）。超时后强制终结（resolve completion + 摘除），见 startDelegation。
 */
export const ABORT_SETTLE_TIMEOUT_MS = 5000

let childToolsBuilder: ChildToolsBuilder = () => {
  throw new Error('子 agent 工具集构建器未注入（programming-orchestrator 应在 runMvpViaAgentLoop 注册 setChildToolsBuilder）')
}

// =========================================================================
// 注册表（父上下文 / 子工具构建器）
// =========================================================================

export function setChildToolsBuilder(builder: ChildToolsBuilder): void {
  childToolsBuilder = builder
}

/** 注册父 loop 上下文（runMvpViaAgentLoop 起跑前调用，结束后 unregister）。 */
export function registerParentLoopContext(sessionId: string, context: DelegationParentContext): void {
  parentContexts.set(sessionId, context)
}

export function unregisterParentLoopContext(sessionId: string): void {
  parentContexts.delete(sessionId)
}

// =========================================================================
// 委派创建（fire-and-forget）
// =========================================================================

/**
 * 创建委派记录并 fire-and-forget 启动子 loop（对齐 Proma startDelegation：
 * delegate 工具立刻返回 delegationId，不阻塞当前轮；子会话后台独立运行）。
 *
 * 深度限制：父 agent 的 state.delegation_depth ≥ 1（即本会话已是子 agent）时拒绝。
 */
export function startDelegation(parent: ToolContext, args: DelegateAgentArgs): StartDelegationResult {
  const task = assertNonBlank(args.task, 'task')
  const role = args.role ?? 'custom'
  assertCanCreateDelegation(parent.state.delegation_depth)
  const parentCtx = parentContexts.get(parent.sessionId)
  if (!parentCtx) {
    throw new Error(`未找到父循环上下文（sessionId=${parent.sessionId}）。委派工具只在主 agent loop 内可用。`)
  }
  if (runningDelegationCount(parent.sessionId) >= MAX_RUNNING_DELEGATIONS_PER_PARENT) {
    throw new Error(`当前并行的委派子会话已达上限（${MAX_RUNNING_DELEGATIONS_PER_PARENT}）。请先 wait_for_delegations 收集或 stop_delegation 停止。`)
  }

  const delegationId = randomUUID()
  const goal = truncateText(task, DELEGATION_GOAL_CHAR_LIMIT)
  const { completion, resolveCompletion } = createDelegationCompletion()
  const childSessionId = randomUUID()

  const record: DelegationRecord = {
    delegationId,
    parentSessionId: parent.sessionId,
    childSessionId,
    projectId: parent.projectId,
    role,
    goal,
    status: 'running',
    startedAt: Date.now(),
    abort: new AbortController(),
    completion,
    resolveCompletion,
    askSignal: createAskSignal(),
    channelOverride: resolveDelegationChannelOverride(args) ?? undefined,
  }
  delegations.set(delegationId, record)
  ensureDelegationWatchStarted()
  // delegation-persistence 阶段 1（2026-08-28）：子会话索引写归属 meta——重启后
  // restoreDelegationRecord 可按 delegationId 找回子会话 JSONL（内存 registry 重启即丢）
  try {
    recordSessionActivity(childSessionId, parent.projectId, {
      parentSessionId: parent.sessionId,
      sourceDelegationId: delegationId,
    })
  } catch (error) {
    // best-effort（同 recordSessionActivity 容错口径）；warn 保证落盘失败运维可见
    console.warn('[delegation-persistence] 子会话归属写入失败:', error)
  }
  pruneFinishedDelegations()
  publishDelegationEvent(parent.sessionId, 'delegation_started', record)

  // abort 兜底（P2⑤）：abort 后子循环可能不响应（hang 类工具 execute 永不 settle，
  // runAgentLoop 的 tool.execute 不经 withAbort），超时后强制收尾——resolve completion
  // 解除 wait 阻塞 + 置 cancelled + 摘除 registry，避免 DelegationRecord 永久泄漏。
  // 正常路径（loop 在超时前 settle，或 stopDelegation 已手动收尾）下 status 已非 running，幂等跳过。
  record.abort.signal.addEventListener(
    'abort',
    () => {
      setTimeout(() => {
        if (record.status !== 'running') return
        record.status = 'cancelled'
        record.error = '已由主 agent 停止（abort），子循环未响应，超时强制收尾'
        try {
          appendDelegationSettle(record.childSessionId, 'cancelled', { error: record.error })
        } catch (error) {
          console.warn('[delegation-persistence] abort 强制收尾落盘失败:', error)
        }
        record.resolveCompletion()
        publishDelegationEvent(parent.sessionId, 'delegation_cancelled', record)
        delegations.delete(record.delegationId)
      }, ABORT_SETTLE_TIMEOUT_MS).unref?.()
    },
    { once: true },
  )

  const prompt = buildDelegationPrompt({ role, task, expectedOutput: args.expectedOutput })

  void runChildLoop({ parent, parentCtx, record, prompt, role }).then(
    (result) => settleChildLoop(record, result),
    (error) => settleChildLoopError(record, error),
  )

  return { delegation_id: delegationId, child_session_id: childSessionId, role, goal, status: record.status }
}

/** 子 loop 正常结束：落 result summary 并置 completed（非 running 状态不覆盖，如已被 stop）。 */
function settleChildLoop(record: DelegationRecord, result: AgentLoopResult): void {
  if (record.status !== 'running') return
  record.resultSummary = summarizeChildResult(result)
  record.status = 'completed'
  // persistence：终态落盘（重启后 JSONL 末行推断依据）
  try {
    appendDelegationSettle(record.childSessionId, 'completed', { resultSummary: record.resultSummary })
  } catch (error) {
    console.warn('[delegation-persistence] settle 落盘失败:', error)
  }
  record.resolveCompletion()
  publishDelegationEvent(record.parentSessionId, 'delegation_completed', record)
}

/** 子 loop 异常结束：落 error 并置 failed（非 running 状态不覆盖）。 */
function settleChildLoopError(record: DelegationRecord, error: unknown): void {
  if (record.status !== 'running') return
  record.error = errorMessage(error)
  record.status = 'failed'
  try {
    appendDelegationSettle(record.childSessionId, 'failed', { error: record.error })
  } catch {
    // 落盘失败不阻断内存态收尾
  }
  record.resolveCompletion()
  publishDelegationEvent(record.parentSessionId, 'delegation_failed', record)
}

/** 子 agent 事件白名单：仅委派生命周期与工具行事件可进入父会话事件流。
 * 子 agent 的 message_delta / message_completed 是内部旁白（审查六维分析、探索过程
 * 叙述），进入主聊天流会在流式显示后被终态固化清除——用户看到「输出了又消失且
 * 无记录」（2026-08-27 线上案例 ba16fd1a）。协作可视化由 delegation_* 生命周期
 * 胶囊 + tool_call_completed（detail 白名单，陷阱 35）承担，聊天类事件一律拦截。 */
const CHILD_LOOP_ALLOWED_EVENT_TYPES = new Set<AgentEvent['type']>([
  'delegation_started',
  'delegation_completed',
  'delegation_failed',
  'delegation_cancelled',
  'delegation_question',
  'tool_call_started',
  'tool_call_completed',
])

/** 子 agent 循环：复用 runAgentLoop，独立 sessionId/requestId，role 裁剪工具集。 */
async function runChildLoop(opts: {
  parent: ToolContext
  parentCtx: DelegationParentContext
  record: DelegationRecord
  prompt: string
  role: DelegationRole
  /** continue 续跑重放的历史轮次（阶段 3）；startDelegation 全新会话不传 */
  replayTurns?: ConversationTurn[]
}): Promise<AgentLoopResult> {
  const { parent, parentCtx, record, prompt, role } = opts
  const childRequestId = randomUUID()
  const maxTurns = Math.max(1, Math.min(parentCtx.delegationMaxTurns, parentCtx.maxTurns))
  return runAgentLoop({
    system: buildChildSystemPrompt(parentCtx.system, role),
    task: prompt,
    historyTurns: opts.replayTurns,
    tools: [...childToolsBuilder(parent.projectId, role, parentCtx.editFormat), ...(parentCtx.childExtraTools ?? [])],
    query: parentCtx.query,
    // C1：渠道覆盖从 record 取（query 复用，env/providerType/maxTokens 换子渠道值；continue 同源）
    env: record.channelOverride?.env ?? parentCtx.env,
    sessionId: record.childSessionId,
    projectId: parent.projectId,
    requestId: childRequestId,
    maxTokens: record.channelOverride?.maxTokens ?? parentCtx.maxTokens,
    maxTurns,
    permissionMode: parentCtx.permissionMode,
    delegationDepth: parent.state.delegation_depth + 1,
    temperature: parentCtx.temperature,
    providerType: record.channelOverride?.providerType ?? parentCtx.providerType,
    signal: record.abort.signal,
    // 子 agent 聊天类事件（message_delta 等）不进父会话聊天流（见白名单注释）
    publish: (type, payload) => {
      if (CHILD_LOOP_ALLOWED_EVENT_TYPES.has(type)) parentCtx.publish(type, payload)
    },
    onTurn: parentCtx.onChildTurn
      ? (info) => parentCtx.onChildTurn!(info, { sessionId: record.childSessionId, requestId: childRequestId, role })
      : undefined,
    onCompaction: parentCtx.onChildCompaction
      ? (info) => parentCtx.onChildCompaction!(info, { sessionId: record.childSessionId, requestId: childRequestId, role })
      : undefined,
  })
}

// =========================================================================
// 委派读取 / 等待
// =========================================================================

export function getDelegationSummary(record: DelegationRecord): DelegationSummary {
  return {
    delegation_id: record.delegationId,
    role: record.role,
    status: record.status,
    goal: record.goal,
    result_summary: record.resultSummary,
    error: record.error,
    started_at: record.startedAt,
    pending_question: record.pendingQuestion,
    channel: record.channelOverride ? `${record.channelOverride.channelName}/${record.channelOverride.modelName}` : undefined,
  }
}

export function findDelegation(parentSessionId: string, delegationId: string): DelegationRecord | undefined {
  const record = delegations.get(delegationId)
  if (!record || record.parentSessionId !== parentSessionId) return undefined
  return record
}

function forEachRunningDelegation(fn: (record: DelegationRecord) => void): void {
  for (const record of delegations.values()) if (record.status === 'running') fn(record)
}

export function listDelegations(parentSessionId: string): DelegationRecord[] {
  return [...delegations.values()].filter((record) => record.parentSessionId === parentSessionId)
}

/**
 * 委派生命周期事件发布（M4-C，渲染端协作视图的数据源）：
 * 父 loop 上下文在册时经 publish 通道发事件（payload: delegation_id / child_session_id /
 * role / goal / status）；父 loop 已结束（unregister）时静默跳过——事件流断供不阻塞 registry。
 */
function publishDelegationEvent(
  parentSessionId: string,
  type: 'delegation_started' | 'delegation_completed' | 'delegation_failed' | 'delegation_cancelled',
  record: DelegationRecord,
): void {
  parentContexts.get(parentSessionId)?.publish(type, {
    delegation_id: record.delegationId,
    child_session_id: record.childSessionId,
    role: record.role,
    goal: record.goal,
    status: record.status,
  })
}

/** 阻塞等待委派收敛（all/any + timeout）。超时不抛错，返回当前状态让父 agent 决定继续等或停止。 */
export async function waitForDelegations(
  parent: ToolContext,
  args: WaitForDelegationsArgs,
): Promise<DelegationSummary[]> {
  const ids = args.delegationIds ?? listDelegations(parent.sessionId).map((record) => record.delegationId)
  const records = ids.map((id) => {
    const record = findDelegation(parent.sessionId, id)
    if (!record) throw new Error(`未找到当前会话下的委派: ${id}`)
    return record
  })
  if (records.length === 0) return []

  const timeoutMs = args.timeout_ms ?? DEFAULT_DELEGATION_WAIT_TIMEOUT_MS
  const timeout = new Promise<'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs)
    timer.unref?.()
  })

  // 子 agent 提问信号：任一 ask_delegation_question 挂起即提前返回（父 agent 据此代答，
  // 而不是干等到 timeout）。不参与 Promise.any 的终结判定，仅作 race 的提前出路。
  const questionSignals = records.map((record) => record.askSignal.promise)
  if (args.strategy === 'any') {
    await Promise.race([Promise.any(records.map((record) => record.completion)), Promise.any(questionSignals), timeout])
  } else {
    await Promise.race([Promise.all(records.map((record) => record.completion)), Promise.any(questionSignals), timeout])
  }
  return records.map(getDelegationSummary)
}

// =========================================================================
// 停止（Proma stop_delegation / stop_delegations）
// =========================================================================

/**
 * 停止单个委派子会话：中止子循环（abort）、状态置 cancelled、主动 resolve completion
 * 解除 wait 阻塞。已终结的委派不做变更，返回当前状态。
 */
export function stopDelegation(parentSessionId: string, delegationId: string): DelegationSummary {
  const record = findDelegation(parentSessionId, delegationId)
  if (!record) throw new Error(`未找到当前会话下的委派: ${delegationId}`)
  if (record.status === 'running') {
    record.status = 'cancelled'
    record.error = '已由主 agent 停止（stop_delegation）'
    try {
      appendDelegationSettle(record.childSessionId, 'cancelled', { error: record.error })
    } catch (error) {
      console.warn('[delegation-persistence] stop 落盘失败:', error)
    }
    record.abort.abort()
    record.resolveCompletion()
    publishDelegationEvent(parentSessionId, 'delegation_cancelled', record)
  }
  return getDelegationSummary(record)
}

/** 批量停止（Proma stop_delegations）：delegation_ids 缺省 = 停止当前全部委派。 */
export function stopDelegations(parentSessionId: string, delegationIds?: string[]): DelegationSummary[] {
  const ids =
    delegationIds && delegationIds.length > 0
      ? delegationIds
      : listDelegations(parentSessionId).map((record) => record.delegationId)
  return ids.map((id) => stopDelegation(parentSessionId, id))
}

/**
 * 父 loop 收尾（正常结束 / 异常 / 用户停止）时的一次性清理（审计 P1-2 + P2-4）：
 * 1. 先 stopDelegations——running 子委派既不被 abort 也不被 stop 会在后台偷跑消耗 token，
 *    且父 loop 结束后无人收集其结果（孤儿 + 资源泄漏）。先于 unregister 执行，
 *    delegation_cancelled 事件仍能经在册的父上下文 publish 出去。
 * 2. 清空该父会话的 tool-call 幂等缓存——delegationCallCache 跨 session 永不清理会无界增长。
 * 3. 注销父上下文。
 */
export function disposeParentDelegationState(parentSessionId: string): void {
  stopDelegations(parentSessionId)
  const prefix = `${parentSessionId}:`
  for (const key of delegationCallCache.keys()) {
    if (key.startsWith(prefix)) delegationCallCache.delete(key)
  }
  unregisterParentLoopContext(parentSessionId)
}

// =========================================================================
// 提问冒泡 / 父代答（Proma answer_delegation_question）
// =========================================================================

/**
 * 子 agent 挂起提问（ask_delegation_question 工具的协调函数）：
 * 把问题记到 record + resolve askSignal（wait_for_delegations 提前返回）+ 发 delegation_question
 * 事件；返回一个 Promise，父 agent 通过 answerDelegationQuestion 回答时 resolve（答案回传子 loop）。
 * abort 兜底：子循环被停止时 resolve 一个占位答复，让子 loop 能正常收尾而不是永久挂起。
 */
export function askDelegationQuestion(ctx: ToolContext, question: string): Promise<string> {
  const record = findRecordByChildSession(ctx.sessionId)
  if (!record) throw new Error(`未找到当前子会话对应的委派记录（child_session_id=${ctx.sessionId}）`)
  if (record.status !== 'running') throw new Error(`委派已不在运行（status=${record.status}），不能提问`)
  if (record.pendingQuestion) throw new Error('已有待回答的问题，请等待主 agent 回答后再提问')

  // T-5：无代答者的合成父（审查委派）——不挂起干等超时，立即回固定答复
  const parentCtx = parentContexts.get(record.parentSessionId)
  if (parentCtx?.autoAnswer !== undefined) {
    parentCtx.publish('delegation_question', {
      delegation_id: record.delegationId,
      child_session_id: record.childSessionId,
      role: record.role,
      question,
      auto_answered: true,
    })
    return Promise.resolve(parentCtx.autoAnswer)
  }

  record.pendingQuestion = question
  record.askSignal.resolve()
  parentContexts.get(record.parentSessionId)?.publish('delegation_question', {
    delegation_id: record.delegationId,
    child_session_id: record.childSessionId,
    role: record.role,
    question,
  })

  return new Promise<string>((resolve) => {
    record.pendingAnswerResolve = resolve
    if (ctx.signal.aborted) {
      resolve('[子代理已被停止，未收到回答]')
      return
    }
    ctx.signal.addEventListener(
      'abort',
      () => resolve('[子代理已被停止，未收到回答]'),
      { once: true },
    )
  })
}

/** 父 agent 代答子 agent 挂起的问题（answer_delegation_question 工具）：回答回传子 loop 挂起点。 */
export function answerDelegationQuestion(
  parentSessionId: string,
  delegationId: string,
  answer: string,
): { delegation_id: string; answered: boolean } {
  const record = findDelegation(parentSessionId, delegationId)
  if (!record) throw new Error(`未找到当前会话下的委派: ${delegationId}`)
  if (!record.pendingQuestion) {
    throw new Error(`委派 ${delegationId} 没有待回答的问题（当前 status=${record.status}）。用 get_delegation_results 查看。`)
  }
  // m-13：子代理在等待回答期间已终结（stop/超时/失败）——残留的 pendingQuestion 指向
  // 已 settle 的 promise（abort 兑底已 resolve），回答无法送达；如实报错并清理残留，
  // 不谎报「已回答成功」
  if (record.status !== 'running') {
    record.pendingQuestion = undefined
    record.pendingAnswerResolve = undefined
    record.askSignal = createAskSignal()
    throw new Error(`委派 ${delegationId} 已结束（status=${record.status}），回答未能送达：子代理在等待回答期间已停止。`)
  }
  record.pendingAnswerResolve?.(answer)
  record.pendingQuestion = undefined
  record.pendingAnswerResolve = undefined
  // 重建 askSignal（审计 P1-1）：Promise 只能 resolve 一次。若沿用已 resolve 的旧 signal，
  // 父 agent answer 后再次 wait_for_delegations 会因 questionSignals 里仍是 resolved 状态而
  // 立即假提前返回（子 agent 还在 running）。重建后下一次提问产生新 signal。
  record.askSignal = createAskSignal()
  return { delegation_id: delegationId, answered: true }
}

// =========================================================================
// 续跑（Proma continue_delegation）
// =========================================================================

/**
 * 让一个已终结（completed/failed/cancelled）的委派继续：重置为 running、复用 childSessionId
 * （同一独立 JSONL 追加轮）、用新任务 prompt 重启子 loop。running 中的委派拒绝续跑。
 */
export function continueDelegation(parent: ToolContext, delegationId: string, task: string): StartDelegationResult {
  const trimmedTask = assertNonBlank(task, 'task')
  const record = findDelegation(parent.sessionId, delegationId)
  if (!record) throw new Error(`未找到当前会话下的委派: ${delegationId}`)
  if (record.status === 'running') throw new Error(`委派 ${delegationId} 仍在运行中，不能继续（先 wait_for_delegations 或 stop_delegation）。`)
  const parentCtx = parentContexts.get(parent.sessionId)
  if (!parentCtx) {
    throw new Error(`未找到父循环上下文（sessionId=${parent.sessionId}）。委派工具只在主 agent loop 内可用。`)
  }
  // 复用与 startDelegation 相同的并行上限门禁（审计 P2-5）：continue 会把 running 数 +1，
  // 绕过检查即可突破「每父并行 ≤ MAX_RUNNING_DELEGATIONS_PER_PARENT」硬上限。
  if (runningDelegationCount(parent.sessionId) >= MAX_RUNNING_DELEGATIONS_PER_PARENT) {
    throw new Error(`当前并行的委派子会话已达上限（${MAX_RUNNING_DELEGATIONS_PER_PARENT}）。请先 wait_for_delegations 收集或 stop_delegation 停止。`)
  }

  record.status = 'running'
  record.resultSummary = undefined
  record.error = undefined
  record.pendingQuestion = undefined
  record.pendingAnswerResolve = undefined
  record.abort = new AbortController()
  const { completion, resolveCompletion } = createDelegationCompletion()
  record.completion = completion
  record.resolveCompletion = resolveCompletion
  record.askSignal = createAskSignal()
  // 续跑即新任务（审计 P2-6）：goal/startedAt 跟随本次 task，事件与渲染端不再显示旧 goal。
  record.goal = truncateText(trimmedTask, DELEGATION_GOAL_CHAR_LIMIT)
  record.startedAt = Date.now()

  const prompt = buildDelegationPrompt({ role: record.role, task: trimmedTask })
  // 阶段 3 续跑重放：终态子会话 JSONL 历史读回 + follow-up 末位 user 轮——
  // 模型看到完整旧上下文（资产复用），而非只有新指令的重开；超窗由 compacting-window 兑底
  let replayTurns: ConversationTurn[] | undefined
  try {
    const snap = loadChildSessionSnapshot(record.childSessionId)
    if (snap.lastSettle && snap.messages.length > 0) {
      replayTurns = replayTurnsFrom(snap.messages)
    }
  } catch (error) {
    console.warn('[delegation-persistence] 续跑历史读回失败，退化为无历史续跑:', error)
  }
  void runChildLoop({ parent, parentCtx, record, prompt, role: record.role, replayTurns }).then(
    (result) => settleChildLoop(record, result),
    (error) => settleChildLoopError(record, error),
  )
  publishDelegationEvent(parent.sessionId, 'delegation_started', record)
  return {
    delegation_id: record.delegationId,
    child_session_id: record.childSessionId,
    role: record.role,
    goal: record.goal,
    status: 'running',
  }
}

/** 按子会话 id 找委派记录（子 agent 的 ask 工具在子 loop 里，ctx.sessionId 是子会话 id）。 */
function findRecordByChildSession(childSessionId: string): DelegationRecord | undefined {
  for (const record of delegations.values()) {
    if (record.childSessionId === childSessionId) return record
  }
  return undefined
}

// =========================================================================
// 幂等（tool-call 重放/重试防御）
// =========================================================================

const delegationCallCache = new Map<string, StartDelegationResult>()

/**
 * 按 (sessionId, toolCallId) 幂等创建委派：同一次 tool_use 的重放/重试只 create 一次。
 * toolCallId 缺失时**不走幂等缓存**（审计 P3-7）：`anonymous` 兜底键会让同 session 多个
 * 无 id 调用错误复用第一个的结果（幂等变成错误共享），直接 create 更安全。
 */
export function delegateAgentOnce(
  sessionId: string,
  toolCallId: string | undefined,
  createFn: () => StartDelegationResult,
): StartDelegationResult {
  if (toolCallId === undefined || toolCallId === '') return createFn()
  const key = `${sessionId}:${toolCallId}`
  const existing = delegationCallCache.get(key)
  if (existing) return existing
  const created = createFn()
  delegationCallCache.set(key, created)
  return created
}

// =========================================================================
// 深度 / 并行限制
// =========================================================================

export function assertCanCreateDelegation(depth: number): void {
  if (depth >= 1) {
    throw new Error('协作子会话不能继续创建新的子会话（委派深度限制 1 层）')
  }
}

function runningDelegationCount(parentSessionId: string): number {
  let count = 0
  for (const record of delegations.values()) {
    if (record.parentSessionId === parentSessionId && record.status === 'running') count += 1
  }
  return count
}

function pruneFinishedDelegations(): void {
  const finished = [...delegations.values()]
    .filter((record) => record.status !== 'running')
    .sort((a, b) => a.startedAt - b.startedAt)
  const excess = finished.length - MAX_FINISHED_DELEGATIONS
  for (let index = 0; index < excess; index += 1) {
    delegations.delete(finished[index]!.delegationId)
  }
}

// =========================================================================
// 提示词构造（纯函数，可测）
// =========================================================================

const ROLE_INSTRUCTIONS: Record<DelegationRole, string> = {
  explore: '职责：探索代码库——梳理文件结构、定位相关实现、报告事实性发现。只读操作，不做修改。',
  research: '职责：调研——阅读相关代码与文档，形成结论或对比方案。只读操作，不做修改。',
  implement: '职责：实现——编写/修改项目文件完成子任务。遵循平台工具护栏（路径沙箱、语法校验、可写范围）。',
  review: '职责：审查——阅读代码指出问题（正确性/可维护性/安全隐患），给出文件定位与建议，不直接修改。',
  custom: '职责：按主 agent 在任务里给出的具体指令工作。',
}

/** 子 agent system prompt：父背板 system + role 行为说明 + 委派边界规则。 */
export function buildChildSystemPrompt(parentSystem: string, role: DelegationRole): string {
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
  role: DelegationRole
  task: string
  expectedOutput?: string
}): string {
  const expected = opts.expectedOutput
    ? `期望输出：${opts.expectedOutput}\n（最终回复请以一行「结论:」开头的标记句总结关键信息——标记句会被上下文压缩保留，格式：结论: <要点>）`
    : '完成后用简洁文本输出结果摘要（关键发现/完成清单/未完成项与原因）。最终回复以一行「结论:」开头的标记句总结（会被上下文压缩保留）。'
  return `协作子任务（role=${opts.role}）：\n${opts.task}\n\n${expected}`
}

// =========================================================================
// 工具函数
// =========================================================================

function summarizeChildResult(result: AgentLoopResult): string {
  const header = `子代理状态：${result.status}（${result.turns} 轮，${result.toolCalls.length} 次工具调用）`
  const body = result.finalText.trim()
  const full = body ? `${header}\n${body}` : header
  return truncateText(full, DELEGATION_RESULT_CHAR_LIMIT)
}

function createDelegationCompletion(): { completion: Promise<void>; resolveCompletion: () => void } {
  let resolveCompletion!: () => void
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })
  return { completion, resolveCompletion }
}

function createAskSignal(): AskSignal {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…[截断]`
}

function assertNonBlank(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} 必填（非空字符串）`)
  }
  return value.trim()
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return '子代理已被停止'
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 500 ? `${message.slice(0, 500)}…` : message
}

setDelegationScanSource({ forEachRunningDelegation, stopDelegation })
