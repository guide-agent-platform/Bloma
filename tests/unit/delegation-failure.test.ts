import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '../../shared/types'
import type { SDKQuery } from '../../main/orchestration/orchestrator'
import { createToolState, runAgentLoop } from '../../main/agent/loop/agent-loop'
import {
  findDelegation,
  getDelegationSummary,
  listDelegations,
  registerParentLoopContext,
  setChildToolsBuilder,
  startDelegation,
  unregisterParentLoopContext,
} from '../../main/agent/delegation/agent-collaboration'

/**
 * delegation_failed 的 AbortError 归一化（H1，2026-08-25 经典方法补盲）。
 *
 * 真路径：runAgentLoop 对 AbortError 会转 loopCancelled（agent-loop.ts:216），真路径不可达
 * 「子代理已被停止」分支（agent-collaboration.ts errorMessage:611-615）。因此本档用
 * vi.mock 覆写 runAgentLoop 使其 reject 一个 AbortError，验证：
 * - settleChildLoopError 触发 → record.status='failed'
 * - errorMessage 把 AbortError 归一化为「子代理已被停止」
 * - delegation_failed 事件发布
 *
 * 隔离纪律（R1）：本档**不得 import programming-orchestrator**（其运行时 import
 * runAgentLoop，会被 vi.mock 连带替换，污染其它用例）；importOriginal 保留 createToolState 等。
 */

function textMessage(text: string): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

function abortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

vi.mock('../../main/agent/loop/agent-loop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/agent/loop/agent-loop')>()
  return { ...actual, runAgentLoop: vi.fn() }
})

describe('delegation_failed：AbortError 归一化（H1，独立 mock 档）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let parentSessionId = 'session-abort-0'

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-collab-abort-'))
    parentSessionId = `session-abort-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setChildToolsBuilder(() => [])
    vi.mocked(runAgentLoop).mockReset()
  })
  afterEach(() => {
    for (const record of listDelegations(parentSessionId)) {
      if (record.status === 'running') record.abort.abort()
    }
    unregisterParentLoopContext(parentSessionId)
    restorePromaHome(originalPromaHome)
  })

  function registerParentCapturing(query: SDKQuery): Array<{ type: string; payload: Record<string, unknown> }> {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    registerParentLoopContext(parentSessionId, {
      query,
      env: {},
      maxTokens: 256,
      maxTurns: 6,
      delegationMaxTurns: 4,
      permissionMode: 'allow-all',
      temperature: 0.5,
      system: '父系统提示（背板）',
      editFormat: 'diff',
      publish: (type, payload) => events.push({ type, payload }),
    })
    return events
  }

  it('[S4-AGENT-003-归] 子 loop reject AbortError → record.error 归一化为「子代理已被停止」+ delegation_failed 事件', async () => {
    vi.mocked(runAgentLoop).mockRejectedValueOnce(abortError())
    // runAgentLoop 被 mock，query 不被真正迭代；传一个正常收尾的桩即可
    const events = registerParentCapturing(async function* () {
      yield textMessage('不会到达')
    })

    const created = startDelegation(
      {
        projectId: 'project-parent',
        sessionId: parentSessionId,
        requestId: 'req-parent',
        signal: new AbortController().signal,
        state: createToolState(0),
      },
      { task: '会失败的子任务', role: 'research' },
    )

    await findDelegation(parentSessionId, created.delegation_id)!.completion
    const record = findDelegation(parentSessionId, created.delegation_id)!
    const summary = getDelegationSummary(record)

    // AbortError → errorMessage 归一化（非「The operation was aborted.」原文）
    expect(record.status).toBe('failed')
    expect(record.error).toBe('子代理已被停止')
    expect(summary.error).toBe('子代理已被停止')
    // failed 事件发布，payload 含委派标识；无 completed 事件
    const failed = events.find((event) => event.type === 'delegation_failed')
    expect(failed).toBeTruthy()
    expect(failed!.payload).toMatchObject({ delegation_id: created.delegation_id, status: 'failed' })
    expect(events.some((event) => event.type === 'delegation_completed')).toBe(false)
  })
})
