import { afterEach, describe, expect, it } from 'vitest'
import { SessionMessageQueue } from '../../main/message-queue'

/**
 * S4-QUEUE-001~008：会话消息队列（message-queue-port.md，蓝本 Proma
 * agent-queue-coordinator.ts）。生成期间用户消息不丢：忙时排队、完成后自动派发。
 *
 * 运行生命周期建模：startRun 挂起直到手动 completeRun()，模拟真实 runAgent
 * （activeSessions 从 run 开始到结束全程占用）。
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('SessionMessageQueue（会话消息队列）', () => {
  afterEach(() => {
    // 无全局定时器残留（每个用例自建 harness）
  })

  function makeHarness() {
    const active = new Set<string>()
    const started: Array<{ s: string; m: string }> = []
    const dispatched: Array<{ s: string; m: string }> = []
    const pendingRuns = new Map<string, () => void>()
    const q = new SessionMessageQueue({
      isActive: (s) => active.has(s),
      startRun: async (s, e) => {
        active.add(s)
        started.push({ s, m: e.queueMessageId })
        await new Promise<void>((resolve) => pendingRuns.set(e.queueMessageId, resolve))
      },
      onDispatched: (s, e) => {
        dispatched.push({ s, m: e.queueMessageId })
      },
    })
    const completeRun = async (s: string, m: string, stopped = false) => {
      active.delete(s)
      pendingRuns.get(m)?.()
      await sleep(5)
      q.onRunComplete(s, m, stopped)
      await sleep(5)
    }
    return { q, active, started, dispatched, completeRun }
  }

  it('[S4-QUEUE-001] 空闲时入队 → 立即派发且会话被占用', () => {
    const { q, active, started } = makeHarness()
    q.enqueue('s1', { queueMessageId: 'm1', userMessage: '你好' })
    expect(started).toHaveLength(1)
    expect(started[0]?.m).toBe('m1')
    expect(active.has('s1')).toBe(true)
    expect(q.hasPending('s1')).toBe(true)
  })

  it('[S4-QUEUE-002] 活跃 run 期间入队 → 不派发只排队（消息不丢）', () => {
    const { q, started } = makeHarness()
    q.enqueue('s1', { queueMessageId: 'm1', userMessage: '你好' })
    q.enqueue('s1', { queueMessageId: 'm2', userMessage: '第二条' })
    expect(started).toHaveLength(1)
    expect(q.pendingCount('s1')).toBe(2) // dispatching(m1) + queue(m2)
  })

  it('[S4-QUEUE-003] 同 ID 重复入队 → 去重（防双击决策卡）', () => {
    const { q } = makeHarness()
    q.enqueue('s1', { queueMessageId: 'm1', userMessage: '你好' })
    q.enqueue('s1', { queueMessageId: 'm2', userMessage: '第二条' })
    q.enqueue('s1', { queueMessageId: 'm2', userMessage: '第二条' })
    expect(q.pendingCount('s1')).toBe(2)
  })

  it('[S4-QUEUE-004] run 自然完成 → 自动派发下一条', async () => {
    const { q, started, active, completeRun } = makeHarness()
    q.enqueue('s1', { queueMessageId: 'm1', userMessage: '你好' })
    q.enqueue('s1', { queueMessageId: 'm2', userMessage: '第二条' })
    await completeRun('s1', 'm1', false)
    expect(started).toHaveLength(2)
    expect(started[1]?.m).toBe('m2')
    expect(active.has('s1')).toBe(true)
  })

  it('[S4-QUEUE-005] 用户停止 → 不自动派发（违背停止意图）', async () => {
    const { q, started, completeRun } = makeHarness()
    q.enqueue('s1', { queueMessageId: 'm1', userMessage: '你好' })
    q.enqueue('s1', { queueMessageId: 'm2', userMessage: '第二条' })
    await completeRun('s1', 'm1', false)
    q.enqueue('s1', { queueMessageId: 'm3', userMessage: '第三条' })
    await completeRun('s1', 'm2', true)
    expect(started).toHaveLength(2)
    expect(q.pendingCount('s1')).toBe(1)
  })

  it('[S4-QUEUE-006] 取消排队消息 → 生效（停止后排队中的消息可撤回，历史干净）', async () => {
    const { q, active, completeRun } = makeHarness()
    q.enqueue('s1', { queueMessageId: 'm1', userMessage: '你好' })
    q.enqueue('s1', { queueMessageId: 'm2', userMessage: '第二条' })
    await completeRun('s1', 'm1', false)
    // m2 停止完成 → m3 留在队列（stoppedByUser 不自动派发）
    q.enqueue('s1', { queueMessageId: 'm3', userMessage: '第三条' })
    await completeRun('s1', 'm2', true)
    expect(q.pendingCount('s1')).toBe(1) // 仅 m3 排队
    const ok = q.cancel('s1', 'm3')
    expect(ok).toBe(true)
    expect(q.pendingCount('s1')).toBe(0)
    expect(active.has('s1')).toBe(false)
  })

  it('[S4-QUEUE-007] run 抛错 → dispatching 清理（finally 兜底），后续可派发且无未处理 rejection', async () => {
    const started2: string[] = []
    const q2 = new SessionMessageQueue({
      isActive: () => false,
      startRun: async (_s, e) => {
        started2.push(e.queueMessageId)
        if (e.queueMessageId === 'x1') throw new Error('RUN_FAILED')
      },
    })
    q2.enqueue('s2', { queueMessageId: 'x1', userMessage: 'a' })
    await sleep(10)
    q2.enqueue('s2', { queueMessageId: 'x2', userMessage: 'b' })
    await sleep(10)
    expect(started2).toHaveLength(2) // x2 正常派发，未被 x1 失败卡死
  })

  it('[S4-QUEUE-008] 多会话互不干扰（per-session 队列）', () => {
    const s: string[] = []
    const q3 = new SessionMessageQueue({ isActive: () => false, startRun: async (_s, e) => { s.push(e.queueMessageId) } })
    q3.enqueue('a', { queueMessageId: 'a1', userMessage: '1' })
    q3.enqueue('b', { queueMessageId: 'b1', userMessage: '2' })
    expect(s).toHaveLength(2)
    expect(s).toContain('a1')
    expect(s).toContain('b1')
  })
})
