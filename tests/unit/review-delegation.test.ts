import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../main/agent-collaboration', () => ({
  registerParentLoopContext: vi.fn(),
  unregisterParentLoopContext: vi.fn(),
  disposeParentDelegationState: vi.fn(),
  setChildToolsBuilder: vi.fn(),
  startDelegation: vi.fn(() => ({
    delegation_id: 'del-1',
    child_session_id: 'child-1',
    role: 'research',
    goal: '裁判审查',
    status: 'running',
  })),
  waitForDelegations: vi.fn(async () => [
    {
      delegation_id: 'del-1',
      role: 'research',
      status: 'completed',
      goal: '裁判审查',
      result_summary: '子代理状态：completed（3 轮，2 次工具调用）\n{"issues":[]}',
      started_at: 1,
    },
  ]),
  stopDelegations: vi.fn(),
}))

import {
  delegatedReviewEnabled,
  runDelegatedReview,
} from '../../main/review-delegation'
import {
  disposeParentDelegationState,
  registerParentLoopContext,
  startDelegation,
  stopDelegations,
  unregisterParentLoopContext,
  waitForDelegations,
} from '../../main/agent-collaboration'
import type { SDKQuery } from '../../main/orchestrator'
import type { SDKMessage } from '../../shared/types'

/**
 * 审查委派运行时（review-delegation，2026-08-26，协作过程可视化）：
 * - 默认开启（BLOMA_DELEGATED_REVIEW ≠ '0'），'0' 关闭
 * - 委派接线：合成父键注册父上下文（不碰真实 loop 注册）→ startDelegation(role=research)
 *   → wait(timeout) → 剥「子代理状态」头行取正文 → finally 停残+注销+清理
 * - 降级：等待超时/failed/空结果 → ok:false（调用方回退直连）
 */

const query: SDKQuery = async function* (): AsyncGenerator<SDKMessage> {
  yield { type: 'result', subtype: 'success' }
}

function baseOpts() {
  return {
    goal: '裁判六维审查 PRD：测试',
    task: '任务体',
    system: 'system prompt',
    query,
    env: { ANTHROPIC_AUTH_TOKEN: 'k' },
    sessionId: 'session-real',
    projectId: 'proj-1',
    requestId: 'req-1',
    publish: vi.fn(),
  }
}

describe('review-delegation 审查委派运行时', () => {
  const original = process.env.BLOMA_DELEGATED_REVIEW

  beforeEach(() => {
    delete process.env.BLOMA_DELEGATED_REVIEW
    vi.mocked(registerParentLoopContext).mockClear()
    vi.mocked(unregisterParentLoopContext).mockClear()
    vi.mocked(disposeParentDelegationState).mockClear()
    vi.mocked(startDelegation).mockClear()
    vi.mocked(waitForDelegations).mockClear()
    vi.mocked(stopDelegations).mockClear()
  })

  afterEach(() => {
    if (original === undefined) delete process.env.BLOMA_DELEGATED_REVIEW
    else process.env.BLOMA_DELEGATED_REVIEW = original
    vi.restoreAllMocks()
  })

  it('默认开启；委派完成 → 剥头行取正文；注册/清理成对出现', async () => {
    expect(delegatedReviewEnabled()).toBe(true)

    const result = await runDelegatedReview(baseOpts())

    expect(result).toMatchObject({ ok: true, delegationId: 'del-1', finalText: '{"issues":[]}' })
    // role=research（物理只读，裁判不可改产物）
    expect(startDelegation).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1' }),
      expect.objectContaining({ role: 'research', task: '任务体' }),
    )
    // 父上下文用合成键（review- 前缀），与真实 loop 注册隔离
    const parentKey = vi.mocked(registerParentLoopContext).mock.calls[0][0]
    expect(parentKey.startsWith('review-')).toBe(true)
    const ctx = vi.mocked(registerParentLoopContext).mock.calls[0][1]
    expect(ctx.system).toBe('system prompt')
    expect(ctx.permissionMode).toBe('allow-all')
    // 等待带超时上限
    expect(waitForDelegations).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: parentKey }),
      expect.objectContaining({ strategy: 'all', delegationIds: ['del-1'] }),
    )
    // finally 清理三件套
    expect(stopDelegations).toHaveBeenCalledWith(parentKey)
    expect(unregisterParentLoopContext).toHaveBeenCalledWith(parentKey)
    expect(disposeParentDelegationState).toHaveBeenCalledWith(parentKey)
  })

  it("BLOMA_DELEGATED_REVIEW='0' → disabled，不触碰委派基建", async () => {
    process.env.BLOMA_DELEGATED_REVIEW = '0'
    expect(delegatedReviewEnabled()).toBe(false)
    const result = await runDelegatedReview(baseOpts())
    expect(result).toMatchObject({ ok: false, failure: 'disabled' })
    expect(startDelegation).not.toHaveBeenCalled()
  })

  it('等待超时（status 仍 running）→ failure:timeout，仍执行清理', async () => {
    vi.mocked(waitForDelegations).mockResolvedValueOnce([
      { delegation_id: 'del-1', role: 'research', status: 'running', goal: 'g', started_at: 1 },
    ])
    const result = await runDelegatedReview(baseOpts())
    expect(result).toMatchObject({ ok: false, failure: 'timeout' })
    expect(stopDelegations).toHaveBeenCalled()
  })

  it('子 agent failed / 空正文 → failure，调用方据此回退直连', async () => {
    vi.mocked(waitForDelegations).mockResolvedValueOnce([
      { delegation_id: 'del-1', role: 'research', status: 'failed', goal: 'g', error: 'x', started_at: 1 },
    ])
    expect(await runDelegatedReview(baseOpts())).toMatchObject({ ok: false, failure: 'failed' })

    vi.mocked(waitForDelegations).mockResolvedValueOnce([
      { delegation_id: 'del-1', role: 'research', status: 'completed', goal: 'g', result_summary: '子代理状态：completed（1 轮，0 次工具调用）', started_at: 1 },
    ])
    expect(await runDelegatedReview(baseOpts())).toMatchObject({ ok: false, failure: 'empty' })
  })

  it('startDelegation 抛错 → failure:failed（不抛出），清理仍执行', async () => {
    vi.mocked(startDelegation).mockImplementationOnce(() => {
      throw new Error('并行上限')
    })
    const result = await runDelegatedReview(baseOpts())
    expect(result).toMatchObject({ ok: false, failure: 'failed' })
    expect(unregisterParentLoopContext).toHaveBeenCalled()
  })

  // AGENT_STOP 断链修复（2026-08-27 线上 abb1a19f）：确认后管线不经过 runAgent，
  // 必须由 signal 传导停止——否则审查子 agent 只能等到 120s 超时，用户「暂停」完全无效
  it('等待审查期间用户停止（signal abort）→ failure:aborted + stopDelegations 清理子 agent', async () => {
    const controller = new AbortController()
    vi.mocked(waitForDelegations).mockImplementationOnce(() => new Promise(() => {}) as never)
    const promise = runDelegatedReview({ ...baseOpts(), signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    const outcome = await promise
    expect(outcome).toMatchObject({ ok: false, failure: 'aborted' })
    expect(stopDelegations).toHaveBeenCalled()
    expect(unregisterParentLoopContext).toHaveBeenCalled()
    expect(disposeParentDelegationState).toHaveBeenCalled()
  })

  it('调用前已停止（signal 预 abort）→ 直接 aborted，不消费审查结果', async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await runDelegatedReview({ ...baseOpts(), signal: controller.signal })
    expect(outcome).toMatchObject({ ok: false, failure: 'aborted' })
    expect(stopDelegations).toHaveBeenCalled()
  })
})
