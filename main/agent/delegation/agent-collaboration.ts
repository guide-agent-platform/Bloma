import { randomUUID } from 'node:crypto'
import { acquireChildRunContext, formatWorktreeNote, invokeChildLoopWithContext, summarizeChildResult, buildChildSystemPrompt, buildDelegationPrompt } from './child-run-context';

/** P1-06：子运行上下文接口 re-export（coding 层 worktree 隔离经此注入）。 */
export { setChildRunContextProvider } from './child-run-context'
/** 提示词纯函数 re-export（R7 拆出后保持既有 import 路径）。 */
export { buildChildSystemPrompt, buildDelegationPrompt } from './child-run-context'
import { appendDelegationSettle, loadChildSessionSnapshot, replayTurnsFrom } from './delegation-persistence'
import { buildCompletedDelegation, registerChildWithHost } from './completed-delegation'
import { buildTaskHandoff, renderTaskHandoff, type TaskHandoff } from './task-handoff'
import { refreshHandoffEvidence, assertDelegationRecovery } from './delegation-evidence'
export { DelegationBudgetError } from './delegation-evidence'
import { awaitDelegationState } from './delegation-wait'
import { installAbortSettlement } from './delegation-abort'
export { ABORT_SETTLE_TIMEOUT_MS } from './delegation-abort'
import { recordSessionActivity } from '../../platform/sessions/session-service'
import type { AgentEvent } from '../../../shared/types';

import type { ConversationTurn } from '../../orchestration/orchestrator'
import { resolveDelegationChannelOverride, type DelegationChannelOverride } from './delegation-channel'
import { ensureDelegationWatchStarted, setDelegationScanSource } from './delegation-watch'
import { installDelegationHeartbeat } from './delegation-heartbeat'
import { runAgentLoop, type AgentLoopResult, type AgentLoopTool, type ToolContext } from '../loop/agent-loop';

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

export type { DelegationRunRole as DelegationRole } from '../../../shared/delegation-run-context'
import type { DelegationRunRole as DelegationRole } from '../../../shared/delegation-run-context'

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
  task_handoff?: TaskHandoff
  delegation_id: string
  role: DelegationRole
  status: DelegationStatus
  goal: string
  loop_status?: AgentLoopResult['status']
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
  taskHandoff?: TaskHandoff
  delegationId: string
  parentSessionId: string
  childSessionId: string
  projectId: string
  role: DelegationRole
  goal: string
  status: DelegationStatus
  loopStatus?: AgentLoopResult['status']
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
  /** P1-06：worktree 隔离运行上下文结果（合并/冲突/丢弃如实；内部字段）。 */
  worktreeMeta?: Record<string, unknown>
  /** ask_delegation_question 挂起的 resolve（answer 时回调，把答案回传子 loop）。 */
  pendingAnswerResolve?: (answer: string) => void
  channelOverride?: DelegationChannelOverride
}

import { resolveDelegationTurns, type DelegationParentContext } from './delegation-context'
export type { DelegationParentContext } from './delegation-context'

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
  registerChildWithHost(parentCtx, { delegationId, childSessionId }, () => { delegations.delete(delegationId) })
  pruneFinishedDelegations()
  publishDelegationEvent(parent.sessionId, 'delegation_started', record)

  const prompt = buildDelegationPrompt({ role, task, expectedOutput: args.expectedOutput })

  launchChildLoop({ parent, parentCtx, record, prompt, role })

  return { delegation_id: delegationId, child_session_id: childSessionId, role, goal, status: record.status }
}

/** 子 loop 正常结束：落 result summary 并置 completed（非 running 状态不覆盖，如已被 stop）。 */
function settleChildLoop(record: DelegationRecord, result: AgentLoopResult): void {
  if (record.status !== 'running') return
  record.loopStatus = result.status
  record.taskHandoff = buildTaskHandoff(result)
  record.resultSummary = summarizeChildResult(result, DELEGATION_RESULT_CHAR_LIMIT) + formatWorktreeNote(record.worktreeMeta)
  record.status = 'completed'
  // persistence：终态落盘（重启后 JSONL 末行推断依据）
  try {
    appendDelegationSettle(record.childSessionId, 'completed', { resultSummary: record.resultSummary, loopStatus: record.loopStatus, taskHandoff: record.taskHandoff })
  } catch (error) {
    console.warn('[delegation-persistence] settle 落盘失败:', error)
  }
  record.resolveCompletion()
  publishDelegationEvent(record.parentSessionId, 'delegation_completed', record)
}

/** 子 loop 异常结束：落 error 并置 failed（非 running 状态不覆盖）。 */
function settleChildLoopError(record: DelegationRecord, error: unknown): void {
  if (record.status !== 'running') return
  const carriedMeta = (error as { childWorktreeMeta?: Record<string, unknown> } | undefined)?.childWorktreeMeta
  if (carriedMeta) record.worktreeMeta = { ...(record.worktreeMeta ?? {}), ...carriedMeta }
  record.error = errorMessage(error) + formatWorktreeNote(record.worktreeMeta)
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
  const runAbort = record.abort
  const childRequestId = randomUUID()
  const maxTurns = resolveDelegationTurns(parentCtx, role)
  // P1-06 收尾：子运行上下文（worktree 隔离）；provider 未注册/开关 off → 零变化
  const runContext = acquireChildRunContext({ projectId: parent.projectId, delegationId: record.delegationId, childSessionId: record.childSessionId, role })
  const isolationNote = runContext?.rootOverride
    ? '\n\n【隔离工作模式】你在独立分支的工作树上实现（改动不直接进项目主目录）；本会话不提供预览/测试/安全验证工具——验证由父会话在合并后统一执行，请专注于实现与逻辑自检。'
    : ''
  const invoke = (): Promise<AgentLoopResult> => runAgentLoop({
    system: `${buildChildSystemPrompt(parentCtx.childSystemBuilder?.(role, record.childSessionId) ?? parentCtx.system, role)}${isolationNote}`,
    task: parentCtx.delegationTurnLimits?.[role] ? prompt + '\n\n【执行预算】本轮上限 ' + maxTurns + ' 轮，每轮为一次模型请求。沿用历史中的已读事实，避免重复通读；保留最后约 1/4 轮数用于真实验证与交付收口。未完成时明确列出未落盘/未验证项，不得声称工作已完成。' : prompt,
    historyTurns: opts.replayTurns,
    materials: parentCtx.materials,
    tools: [...(parentCtx.childToolsBuilder ?? childToolsBuilder)(parent.projectId, role, parentCtx.editFormat), ...(parentCtx.childExtraTools ?? [])],
    query: parentCtx.query,
    // C1：渠道覆盖从 record 取（query 复用，env/providerType/maxTokens 换子渠道值；continue 同源）
    env: record.channelOverride?.env ?? parentCtx.env,
    sessionId: record.childSessionId,
    parentSessionId: parent.sessionId,
    accountingRole: role,
    projectId: parent.projectId,
    requestId: childRequestId,
    maxTokens: record.channelOverride?.maxTokens ?? parentCtx.maxTokens,
    maxTurns,
    ...(role === 'implement' && parentCtx.executionScope ? { workMode: 'implementation' as const } : {}),
    executionScope: parentCtx.executionScope,
    runtime: parentCtx.runtime,
    runtimeScope: parentCtx.runtimeScope,
    permissionMode: parentCtx.permissionMode,
    delegationDepth: parent.state.delegation_depth + 1,
    temperature: parentCtx.temperature,
    providerType: record.channelOverride?.providerType ?? parentCtx.providerType,
    signal: runAbort.signal,
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
  const { result, meta } = await invokeChildLoopWithContext(runContext, invoke)
  if (meta && record.abort === runAbort) record.worktreeMeta = { ...(record.worktreeMeta ?? {}), ...meta }
  return result
}

/** A stopped invocation can finish late after continuation reused the record. */
function launchChildLoop(opts: Parameters<typeof runChildLoop>[0]): void {
  const ownedAbort = opts.record.abort
  installAbortSettlement(opts.record, () => {
    publishDelegationEvent(opts.record.parentSessionId, 'delegation_cancelled', opts.record)
    delegations.delete(opts.record.delegationId)
  })
  void runChildLoop(opts).then(
    result => { if (opts.record.abort === ownedAbort) settleChildLoop(opts.record, result) },
    error => { if (opts.record.abort === ownedAbort) settleChildLoopError(opts.record, error) },
  )
}

// =========================================================================
// 委派读取 / 等待
// =========================================================================

export function getDelegationSummary(record: DelegationRecord): DelegationSummary {
  refreshDelegationHandoff(record)
  return {
    ...(record.taskHandoff ? { task_handoff: record.taskHandoff } : {}),
    delegation_id: record.delegationId,
    role: record.role,
    status: record.status,
    goal: record.goal,
    result_summary: record.resultSummary,
    ...(record.loopStatus ? { loop_status: record.loopStatus } : {}),
    error: record.error,
    started_at: record.startedAt,
    pending_question: record.pendingQuestion,
    channel: record.channelOverride ? `${record.channelOverride.channelName}/${record.channelOverride.modelName}` : undefined,
  }
}

function refreshDelegationHandoff(record: DelegationRecord): void {
  const parent = parentContexts.get(record.parentSessionId)
  if (!record.taskHandoff || !parent || record.status === 'running') return
  const tools = (parent.childToolsBuilder ?? childToolsBuilder)(record.projectId, record.role, parent.editFormat)
  record.taskHandoff = refreshHandoffEvidence(record, tools)
}

export function findDelegation(parentSessionId: string, delegationId: string): DelegationRecord | undefined {
  const record = delegations.get(delegationId)
  if (!record || record.parentSessionId !== parentSessionId) return undefined
  return record
}

/** Explicit experimental replay: rehydrate a finished, parent-owned implement handoff only. */
export function restoreCompletedDelegation(parent: Pick<ToolContext, 'projectId' | 'sessionId'>, delegationId: string): DelegationRecord {
  const existing = findDelegation(parent.sessionId, delegationId)
  if (existing) return existing
  const record = buildCompletedDelegation(parent, delegationId, createDelegationCompletion(), createAskSignal())
  delegations.set(delegationId, record)
  return record
}

function forEachRunningDelegation(fn: (record: DelegationRecord) => void): void {
  for (const record of delegations.values()) if (record.status === 'running') fn(record)
}

export function listDelegations(parentSessionId: string): DelegationRecord[] {
  return [...delegations.values()].filter((record) => record.parentSessionId === parentSessionId)
}

/** 委派生命周期事件发布（M4-C）：父上下文在册时经 publish 发事件；已结束静默跳过。
 *  失败事件附归因数据（刀5，2026-10-02）：error 摘要 + 覆盖渠道名（人话卡侦测源）。 */
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
    ...(record.loopStatus ? { loop_status: record.loopStatus } : {}),
    ...(type === 'delegation_failed' && record.error ? { error: record.error.slice(0, 200), channel: record.channelOverride?.channelName } : {}),
  })
}

/** 阻塞等待委派收敛（all/any + timeout）。超时不抛错，返回当前状态让父 agent 决定继续等或停止。 */
export async function waitForDelegations(
  parent: ToolContext,
  args: WaitForDelegationsArgs,
): Promise<DelegationSummary[]> {
  parent.signal.throwIfAborted()
  const ids = args.delegationIds ?? listDelegations(parent.sessionId).map((record) => record.delegationId)
  const records = ids.map((id) => {
    const record = findDelegation(parent.sessionId, id)
    if (!record) throw new Error(`未找到当前会话下的委派: ${id}`)
    return record
  })
  if (records.length === 0) return []

  await awaitDelegationState(records, parent.signal, args.strategy, args.timeout_ms ?? DEFAULT_DELEGATION_WAIT_TIMEOUT_MS)
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
  refreshDelegationHandoff(record)
  assertDelegationRecovery(record)
  const parentCtx = parentContexts.get(parent.sessionId)
  if (!parentCtx) {
    throw new Error(`未找到父循环上下文（sessionId=${parent.sessionId}）。委派工具只在主 agent loop 内可用。`)
  }
  // 复用与 startDelegation 相同的并行上限门禁（审计 P2-5）：continue 会把 running 数 +1，
  // 绕过检查即可突破「每父并行 ≤ MAX_RUNNING_DELEGATIONS_PER_PARENT」硬上限。
  if (runningDelegationCount(parent.sessionId) >= MAX_RUNNING_DELEGATIONS_PER_PARENT) {
    throw new Error(`当前并行的委派子会话已达上限（${MAX_RUNNING_DELEGATIONS_PER_PARENT}）。请先 wait_for_delegations 收集或 stop_delegation 停止。`)
  }

  const previousHandoff = record.taskHandoff
  record.taskHandoff = undefined
  record.status = 'running'
  record.loopStatus = undefined
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

  let prompt = buildDelegationPrompt({ role: record.role, task: trimmedTask })
  // 阶段 3 续跑重放：终态子会话 JSONL 历史读回 + follow-up 末位 user 轮——
  // 模型看到完整旧上下文（资产复用），而非只有新指令的重开；超窗由 compacting-window 兑底
  let replayTurns: ConversationTurn[] | undefined
  try {
    const snap = loadChildSessionSnapshot(record.childSessionId)
    const handoff = previousHandoff ?? snap.lastSettle?.taskHandoff
    if (handoff) prompt = `${renderTaskHandoff(handoff)}\n\n${prompt}`
    if (snap.lastSettle && snap.messages.length > 0) {
      replayTurns = replayTurnsFrom(snap.messages)
    }
  } catch (error) {
    console.warn('[delegation-persistence] 续跑历史读回失败，退化为无历史续跑:', error)
  }
  launchChildLoop({ parent, parentCtx, record, prompt, role: record.role, replayTurns })
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
    // Active parents still own these records for dependencies and continuation.
    .filter((record) => record.status !== 'running' && !parentContexts.has(record.parentSessionId))
    .sort((a, b) => a.startedAt - b.startedAt)
  const excess = finished.length - MAX_FINISHED_DELEGATIONS
  for (let index = 0; index < excess; index += 1) {
    delegations.delete(finished[index]!.delegationId)
  }
}


// =========================================================================
// 工具函数
// =========================================================================


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
installDelegationHeartbeat({ forEachRunningDelegation })
