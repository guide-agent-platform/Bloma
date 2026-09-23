/**
 * 审查委派运行时（review-delegation）——把裁判审查升级为真·委派子 agent，2026-08-26。
 *
 * 目的（用户拍板：协作过程可视化）：PRD 六维审查与 MVP 语义审查不再由平台直连
 * LLM 静默完成，而是经委派体系（agent-collaboration M1–M4）派生独立子 agent
 * （role='research'，物理只读工具面），全过程经 delegation_started/completed/failed
 * 生命周期事件流入 DelegationFeed / CollaborationPanel 实时可见，子会话 JSONL
 * 可回放审查过程。
 *
 * role 选择：research（read_file/list_files/grep/web_fetch + ask，只读）而非
 * review（后者带写工具）——裁判铁律「只判定不修复」用工具面物理保证，而非提示词约束。
 *
 * 运行开关：BLOMA_DELEGATED_REVIEW（缺省开启，='0' 关闭回退直连）。
 * 失败降级链：委派（默认）→ 直连 LLM（各审查模块既有路径）→ 规则门——任何一环
 * 失败不阻断主流程。父上下文用合成键（review-{uuid}）注册，避免与 MVP 主 loop
 * 的真实父上下文注册互相覆盖；事件载荷仍携带真实 session/project 归属渲染端。
 */

import { randomUUID } from 'node:crypto'
import type { AgentEvent } from '../../shared/types'
import {
  disposeParentDelegationState,
  registerParentLoopContext,
  setChildToolsBuilder,
  startDelegation,
  stopDelegations,
  unregisterParentLoopContext,
  waitForDelegations,
  type DelegationSummary,
} from '../agent/delegation/agent-collaboration'
import { buildAgentTools } from '../agent/tools/agent-tools'
import { buildDomainTools, domainToolOptionsDefaults } from '../coding/tool-handlers'
import { createToolState, type AgentLoopTool, type ToolContext } from '../agent/loop/agent-loop'
import type { SDKQuery } from '../orchestration/orchestrator'

/** 委派审查运行开关（缺省开启；测试与紧急回退用 '0' 关闭）。 */
export function delegatedReviewEnabled(): boolean {
  return process.env.BLOMA_DELEGATED_REVIEW !== '0'
}

export interface DelegatedReviewOutcome {
  ok: boolean
  /** 子 agent 最终输出（去掉「子代理状态：…」头行后的正文） */
  finalText?: string
  delegationId?: string
  failure?: 'disabled' | 'timeout' | 'failed' | 'bad_status' | 'empty' | 'aborted'
}

/** 单次委派审查的等待上限（子 agent 只读审查，正常 1-4 轮内完成）。 */
const REVIEW_DELEGATION_TIMEOUT_MS = 120_000
/** 子 agent 轮次上限（防审查 agent 过度展开）。 */
const REVIEW_DELEGATION_MAX_TURNS = 8

/**
 * 派出审查子 agent 并等待收敛。任何异常都返回 failure（不抛错）——调用方据此
 * 降级到直连路径；**唯一例外是 aborted（用户主动停止）**，调用方必须立即终止管线、
 * 不得降级直连。finally 里统一收尾：超时/中止残留的 running 子会话强制停止、
 * 合成父上下文注销、委派状态清理（防孤儿子 agent 后台偷跑，对齐审计 P1-2 精神）。
 */
export async function runDelegatedReview(opts: {
  goal: string
  task: string
  system: string
  query: SDKQuery
  env: Record<string, string>
  sessionId: string
  projectId: string
  requestId: string
  publish: (event: AgentEvent) => void
  timeoutMs?: number
  /** 主链路中止信号（AGENT_STOP）：abort 即停子 agent 并返回 failure:'aborted'，不降级直连 */
  signal?: AbortSignal
  /** 追加到子 agent 工具面的定向工具（2026-09 内审闭环）：闭包携带调用方上下文
   *  （如 read_conversation_history 的本会话 id、write_prd_draft 的草稿接收器），
   *  仅注入需要它的审查委派，不进通用工具面。 */
  extraTools?: AgentLoopTool[]
  /** 子 agent 轮次上限覆盖（内审 Defender 修订轮需要比默认更紧的预算）。 */
  maxTurns?: number
}): Promise<DelegatedReviewOutcome> {
  if (!delegatedReviewEnabled()) return { ok: false, failure: 'disabled' }

  // 子 agent 工具构建器防御性注册（与 runMvpViaAgentLoop 同款；重复注册幂等）
  setChildToolsBuilder((projectId, role, editFormat) => [...buildAgentTools({ projectId, role, editFormat }), ...buildDomainTools({ projectId, role, editFormat })])

  // 合成父键：与真实 loop 的父上下文注册完全隔离，事件归属靠闭包里的真实 id
  const parentKey = `review-${randomUUID()}`
  const parent: ToolContext = {
    projectId: opts.projectId,
    sessionId: parentKey,
    requestId: opts.requestId,
    // 主链路 signal 缺席时维持旧语义（孤立信号）；传入时仅作 abort 感知用，
    // 子 loop 的查询中止靠 finally 里 stopDelegations(parentKey) abort record.abort
    signal: opts.signal ?? new AbortController().signal,
    state: createToolState(),
  }

  try {
    registerParentLoopContext(parentKey, {
      query: opts.query,
      env: opts.env,
      maxTokens: 640000,
      maxTurns: opts.maxTurns ?? REVIEW_DELEGATION_MAX_TURNS,
      delegationMaxTurns: opts.maxTurns ?? REVIEW_DELEGATION_MAX_TURNS,
      permissionMode: 'allow-all',
      temperature: 0.1,
      system: opts.system,
      editFormat: 'diff',
      childExtraTools: opts.extraTools,
      // T-5：审查委派是合成父（无真实 agent 代答）——子代理提问立即回固定答复，
      // 不挂起干等到 120/150s 超时
      autoAnswer: '（本审查任务没有人工或主 agent 代答：请基于任务描述与项目产物自行判定，不要再次提问。）',
      publish: (type, payload) => {
        opts.publish({
          event_id: randomUUID(),
          session_id: opts.sessionId,
          project_id: opts.projectId,
          type,
          payload,
          created_at: new Date().toISOString(),
        })
      },
    })

    const started = startDelegation(parent, {
      // goal 拼进 task 首行（2026-08-29 线上：DelegationFeed 的 goal 列取 task 截断，
      // 此前丢弃 opts.goal 导致审查委派显示「【PRD 全文（背板 JSON）】{"name":…」
      // 碎片+「子会话·调研」标签——用户误读为「已经开始做草图」。首行短句让
      // 时间轴一眼可辨「裁判六维审查 PRD：xxx」/「裁判语义审查产物 vs PRD：xxx」。
      task: `${opts.goal}\n\n${opts.task}`,
      role: 'research',
      expectedOutput: '按任务要求输出严格 JSON 裁决',
    })

    const summaries = await Promise.race([
      waitForDelegations(parent, {
        strategy: 'all',
        delegationIds: [started.delegation_id],
        timeout_ms: opts.timeoutMs ?? REVIEW_DELEGATION_TIMEOUT_MS,
      }),
      // 主链路 abort（AGENT_STOP）提前出赛：waitForDelegations 不监听外部 signal，
      // 不 race 的话停止后仍要干等到子收敛或 120s 超时（线上 abb1a19f 实测断链）
      opts.signal
        ? new Promise<DelegationSummary[]>((resolve) => {
            if (opts.signal!.aborted) return resolve([])
            opts.signal!.addEventListener(
              'abort',
              () => resolve([]),
              { once: true },
            )
          })
        : null,
    ].filter((p): p is Promise<DelegationSummary[]> => p !== null))
    if (opts.signal?.aborted) {
      // finally 里 stopDelegations 会中止子 agent——aborted 语义不得触发调用方降级直连
      return { ok: false, delegationId: started.delegation_id, failure: 'aborted' }
    }
    const summary: DelegationSummary | undefined = summaries[0]
    if (!summary) return { ok: false, delegationId: started.delegation_id, failure: 'empty' }
    if (summary.status === 'running') {
      // 等待超时仍未收敛（waitForDelegations 超时不抛错）：如实报 timeout
      return { ok: false, delegationId: started.delegation_id, failure: 'timeout' }
    }
    if (summary.status !== 'completed' || !summary.result_summary) {
      return { ok: false, delegationId: started.delegation_id, failure: summary.status === 'failed' ? 'failed' : 'bad_status' }
    }
    // result_summary 形如「子代理状态：completed（N 轮，M 次工具调用）\n正文」——剥头行
    const body = summary.result_summary.split('\n').slice(1).join('\n').trim()
    if (!body) return { ok: false, delegationId: started.delegation_id, failure: 'empty' }
    return { ok: true, delegationId: started.delegation_id, finalText: body }
  } catch (error) {
    console.error('[review-delegation] 委派审查异常，降级直连:', error)
    return { ok: false, failure: 'failed' }
  } finally {
    try {
      stopDelegations(parentKey)
    } catch {
      // 已终结时停止是 no-op；异常忽略
    }
    unregisterParentLoopContext(parentKey)
    disposeParentDelegationState(parentKey)
  }
}
