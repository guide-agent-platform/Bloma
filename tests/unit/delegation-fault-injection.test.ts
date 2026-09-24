import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '../../shared/types'
import type { SDKQuery } from '../../main/orchestration/orchestrator'
import { createToolState, type AgentLoopTool, type ToolContext } from '../../main/agent/loop/agent-loop'
import type { AgentEvent } from '../../shared/types'
import {
  askDelegationQuestion,
  delegateAgentOnce,
  disposeParentDelegationState,
  findDelegation,
  listDelegations,
  registerParentLoopContext,
  setChildToolsBuilder,
  startDelegation,
  unregisterParentLoopContext,
  waitForDelegations,
} from '../../main/agent/delegation/agent-collaboration'

/**
 * C6 委派链路故障注入测试集（协作机制改造批次 4，2026-09-24）。
 *
 * 四类故障注入（C6① 流挂死触发 C4 两级已由 delegation-watch.test 集成腿覆盖，不重复）：
 * - ② 渠道中途断流：query yield 后 throw → 委派如实结算失败（不悬挂、不误报完成）
 * - ③ ask 无人代答：wait 提前返回（askSignal）+ stop 兜底占位答复收尾（不永久挂起）
 * - ④ 父 loop 提前结束（dispose）：running 子会话全部中止 + 取消事件发布 + 幂等缓存清理
 */

function textMessage(text: string): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

/** 中途断流：先正常产出一条，再抛渠道错误。 */
function breakingQuery(): SDKQuery {
  return async function* () {
    yield textMessage('部分输出后渠道中断')
    throw new Error('CHANNEL_STREAM_BROKEN: 连接中断')
  }
}

function oneShotQuery(finalText: string): SDKQuery {
  return async function* () {
    yield textMessage(finalText)
    yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
  }
}

/** 发 tool_use 的 query：子 loop 执行指定工具（配 askTool/hangTool 使子会话停在工具执行）。 */
function toolUseQuery(toolName: string): SDKQuery {
  return async function* () {
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `h-${toolName}`, name: toolName, input: {} }] } }
    yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
  }
}

/** 挂起工具（响应 abort）；ask 工具版本：execute 内发起子会话提问。 */
function hangTool(): AgentLoopTool {
  return {
    name: 'hang_tool',
    description: '测试用挂起工具',
    input_schema: { type: 'object', properties: {} },
    execute: () => new Promise<{ output: string }>(() => undefined),
  }
}

function askTool(): AgentLoopTool {
  return {
    name: 'ask_tool',
    description: '测试用提问工具',
    input_schema: { type: 'object', properties: {} },
    execute: async (_input, ctx) => {
      const answer = await askDelegationQuestion(ctx, '测试问题：需要补充什么？')
      return { output: `父答复：${answer}` }
    },
  }
}

let parentSessionId = 'session-fault'

function parentContext(): ToolContext {
  return {
    projectId: 'project-fault',
    sessionId: parentSessionId,
    requestId: 'req-fault',
    signal: new AbortController().signal,
    state: createToolState(0),
  }
}

function registerParent(query: SDKQuery): void {
  registerParentLoopContext(parentSessionId, {
    query,
    env: {},
    maxTokens: 256,
    maxTurns: 6,
    delegationMaxTurns: 4,
    permissionMode: 'allow-all',
    temperature: 0.5,
    system: '父系统提示',
    editFormat: 'diff',
    publish: () => undefined,
  })
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('C6 委派链路故障注入', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-fault-'))
    parentSessionId = `session-fault-${Date.now()}-${Math.random().toString(36).slice(2)}`
  })
  afterEach(async () => {
    disposeParentDelegationState(parentSessionId)
    await settle()
    unregisterParentLoopContext(parentSessionId)
    if (originalPromaHome === undefined) delete process.env.PROMA_HOME
    else process.env.PROMA_HOME = originalPromaHome
  })

  it('② 渠道中途断流：委派如实结算失败（不悬挂、不误报完成、error 可观测）', async () => {
    registerParent(breakingQuery())
    setChildToolsBuilder(() => [])
    const created = startDelegation(parentContext(), { task: '会断流的子任务', role: 'research' })

    const summaries = await waitForDelegations(parentContext(), { delegationIds: [created.delegation_id], timeout_ms: 5000 })
    const summary = summaries[0]!
    // 如实失败：不悬挂（返回时已终结）、不误报 completed
    expect(summary.status).not.toBe('running')
    expect(summary.status).not.toBe('completed')
    if (summary.status === 'failed') {
      expect(summary.error ?? '').toBeTruthy()
    }
  })

  it('③ ask 无人代答：wait 提前返回（pending_question 可见）+ stop 兜底收尾不永久挂起', async () => {
    registerParent(toolUseQuery('ask_tool'))
    setChildToolsBuilder(() => [askTool()])
    const created = startDelegation(parentContext(), { task: '会提问的子任务', role: 'research' })

    // askSignal 提前唤醒 wait（不等满超时）
    const start = Date.now()
    const summaries = await waitForDelegations(parentContext(), { delegationIds: [created.delegation_id], timeout_ms: 8000 })
    expect(Date.now() - start).toBeLessThan(8000)
    const summary = summaries[0]!
    expect(summary.status).toBe('running')
    expect(summary.pending_question).toContain('测试问题')

    // stop 兜底：ask 挂起的 promise 由 abort 占位答复收尾，子 loop 正常终结不永久挂起
    const record = findDelegation(parentSessionId, created.delegation_id)!
    record.abort.abort()
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(record.status).not.toBe('running')
  })

  it('④ 父 loop 提前结束（dispose）：running 子会话全部中止 + 取消事件发布 + 幂等缓存清理', async () => {
    const published: Array<{ type: string; payload: Record<string, unknown> }> = []
    registerParentLoopContext(parentSessionId, {
      query: toolUseQuery('hang_tool'),
      env: {},
      maxTokens: 256,
      maxTurns: 6,
      delegationMaxTurns: 4,
      permissionMode: 'allow-all',
      temperature: 0.5,
      system: '父系统提示',
      editFormat: 'diff',
      publish: (type: AgentEvent['type'], payload: Record<string, unknown>) => published.push({ type, payload }),
    })
    setChildToolsBuilder(() => [hangTool()])

    // 经幂等缓存路径创建（dispose 应清理该缓存）
    const created = delegateAgentOnce(parentSessionId, 'toolcall-fault-1', () =>
      startDelegation(parentContext(), { task: '孤儿观察一', role: 'research' }),
    )
    const created2 = startDelegation(parentContext(), { task: '孤儿观察二', role: 'research' })
    expect(listDelegations(parentSessionId).filter((r) => r.status === 'running')).toHaveLength(2)

    disposeParentDelegationState(parentSessionId)
    await settle()

    // 全部中止（无孤儿后台偷跑）
    const records = listDelegations(parentSessionId)
    expect(records.every((r) => r.status !== 'running')).toBe(true)
    expect(records.find((r) => r.delegationId === created.delegation_id)?.status).toBe('cancelled')
    expect(records.find((r) => r.delegationId === created2.delegation_id)?.status).toBe('cancelled')
    // 取消事件经在册父上下文发布（dispose 先 stop 后 unregister 的顺序保证）
    expect(published.some((e) => e.type === 'delegation_cancelled')).toBe(true)

    // 幂等缓存已清：同 toolCallId 再次 delegate 不命中旧缓存（新 loop 重新注册父上下文后可正常创建）
    registerParentLoopContext(parentSessionId, {
      query: oneShotQuery('重建后完成'),
      env: {},
      maxTokens: 256,
      maxTurns: 6,
      delegationMaxTurns: 4,
      permissionMode: 'allow-all',
      temperature: 0.5,
      system: '父系统提示',
      editFormat: 'diff',
      publish: () => undefined,
    })
    const recreated = delegateAgentOnce(parentSessionId, 'toolcall-fault-1', () =>
      startDelegation(parentContext(), { task: '缓存清理后重建', role: 'research' }),
    )
    expect(recreated.delegation_id).toBeTruthy()
    expect(recreated.delegation_id).not.toBe(created.delegation_id)
  })
})
