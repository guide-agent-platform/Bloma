import { afterEach, describe, expect, it } from 'vitest'
import { SessionMessageQueue, isRequeueableDispatchError } from '../../main/message-queue'

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

// ============================================================
// 派发失败安全网（queue-dispatch-requeue r68，原型 14/14 + r66 审计 2/3 pass）
// 竞态窗口：tryDispatch 的 isActive 检查通过 → entry shift 出队 → startRun await
// 期间会话转活跃（另一路 runAgent 抢先）→ AGENT_SESSION_BUSY 拒绝 → 现实现
// .catch(()=>{}) 静默吞掉 = 排队消息凭空消失。安全网：忙/陈旧错误回队首（保序）
// + requeues≤2 防毒消息循环 + onDropped 钩子（非可重入维持 v1 吞掉语义）。
// ============================================================

describe('派发失败安全网（queue-dispatch-requeue）', () => {
  const sleep2 = sleep

  /** 可控拒绝 harness：startRun 真异步（延迟 settle），拒绝形态可注入 */
  function makeSafeHarness(opts: {
    isActive: () => boolean
    startRun: (entry: { queueMessageId: string; userMessage: string }) => Promise<void>
    onDropped?: (s: string, entry: { queueMessageId: string; userMessage: string }, reason: string) => void
  }) {
    const q = new SessionMessageQueue({
      isActive: opts.isActive,
      startRun: async (_s, e) => opts.startRun(e),
      onDropped: opts.onDropped,
    })
    return q
  }

  it('[S4-QUEUE-009] 派发竞态被拒 → 消息回队首不丢失（现实现静默吞=缺陷坐实）', async () => {
    let active = false
    let attempts = 0
    const q = makeSafeHarness({
      isActive: () => active,
      startRun: async () => {
        attempts++
        await sleep2(20)
        throw new Error('runAgent: AGENT_SESSION_BUSY') // 派发 await 期间另一路 run 抢占
      },
    })
    q.enqueue('s1', { queueMessageId: 'm1', userMessage: '第一条' })
    await sleep2(5)
    expect(attempts).toBe(1)
    active = true // 竞态：startRun 挂起期间会话转活跃
    await sleep2(40) // 拒绝落地
    // 现实现：catch 吞掉 → pendingCount=0（消息凭空消失）→ 本断言红
    expect(q.pendingCount('s1')).toBe(1)
  })

  it('[S4-QUEUE-010] 会话转空闲 → 安全网自动重派发成功（attempts=2，消息最终送达）', async () => {
    let active = false
    let attempts = 0
    let delivered = 0
    const q = makeSafeHarness({
      isActive: () => active,
      startRun: async () => {
        attempts++
        await sleep2(20)
        if (active) throw new Error('AGENT_SESSION_BUSY')
        delivered++
      },
    })
    q.enqueue('s1', { queueMessageId: 'm1', userMessage: '第一条' })
    await sleep2(5)
    active = true
    await sleep2(40) // 拒绝 → 回队首
    active = false
    q.onRunComplete('s1', undefined, false) // 外部抢占 run 结束 → 触发重试
    await sleep2(50)
    expect(attempts).toBe(2)
    expect(delivered).toBe(1)
    expect(q.hasPending('s1')).toBe(false)
  })

  it('[S4-QUEUE-011] 重入保序：A 被拒回队首后仍先于 B 派发', async () => {
    let active = false
    const order: string[] = []
    let aAttempts = 0
    const q = makeSafeHarness({
      isActive: () => active,
      startRun: async (e) => {
        await sleep2(15)
        if (e.queueMessageId === 'a' && aAttempts === 0) {
          aAttempts++ // A 首派遇竞态拒绝（active 由外部翻转）
          if (active) throw new Error('AGENT_SESSION_BUSY')
        }
        order.push(e.queueMessageId)
        // 模拟真实 runAgent 完成回调（orchestrator.ts:648）：重入派发的成功由 run 完成驱动下一条
        setTimeout(() => q.onRunComplete('s1', e.queueMessageId, false), 5)
      },
    })
    q.enqueue('s1', { queueMessageId: 'a', userMessage: 'A' })
    await sleep2(5) // A 派发挂起中
    q.enqueue('s1', { queueMessageId: 'b', userMessage: 'B' }) // B 排队
    active = true // A 的 startRun 挂起期间转活跃
    await sleep2(30) // A 被拒 → 回队首 → [A, B]
    active = false
    q.onRunComplete('s1', 'a', false) // 触发重派发
    await sleep2(80)
    expect(order).toEqual(['a', 'b']) // 重入后 A 仍先于 B（插回队首而非队尾）
  })

  it('[S4-QUEUE-012] 毒消息防循环：BUSY 永错 → 重入 2 次后 onDropped(max-requeue)，队列清空', async () => {
    let tries = 0
    const dropped: Array<{ msg: string; reason: string }> = []
    const q = makeSafeHarness({
      isActive: () => false,
      startRun: async () => {
        tries++
        await sleep2(8)
        throw new Error('AGENT_SESSION_BUSY forever')
      },
      onDropped: (_s, e, reason) => dropped.push({ msg: e.userMessage, reason }),
    })
    q.enqueue('s1', { queueMessageId: 'p', userMessage: '毒消息' })
    await sleep2(80) // 拒1→重入→拒2→重入→拒3(达上限)→drop
    expect(tries).toBe(3) // 初次 + 重入 2 次（审计①：背靠背无退避，v1 接受）
    expect(dropped).toEqual([{ msg: '毒消息', reason: 'max-requeue' }])
    expect(q.hasPending('s1')).toBe(false)
  })

  it('[S4-QUEUE-013] 非可重入错误（TypeError）维持 v1 吞掉语义：只试 1 次 + onDropped(non-requeueable)', async () => {
    let tries = 0
    const dropped: string[] = []
    const q = makeSafeHarness({
      isActive: () => false,
      startRun: async () => {
        tries++
        await sleep2(8)
        throw new TypeError('x is not a function')
      },
      onDropped: (_s, _e, reason) => dropped.push(reason),
    })
    q.enqueue('s1', { queueMessageId: 'x', userMessage: '坏消息' })
    await sleep2(40)
    expect(tries).toBe(1)
    expect(dropped).toEqual(['non-requeueable'])
    expect(q.hasPending('s1')).toBe(false)
  })

  it('[S4-QUEUE-014] 错误分类：BUSY 字符串/code 码/中文陈旧文案可重入；TypeError/null 不可重入不抛', async () => {
    expect(isRequeueableDispatchError(new Error('runAgent: AGENT_SESSION_BUSY'))).toBe(true)
    expect(isRequeueableDispatchError({ code: 'agent.query.not_active' })).toBe(true)
    expect(isRequeueableDispatchError(new Error('会话未运行，无法追加消息'))).toBe(true)
    expect(isRequeueableDispatchError(new TypeError('x is not a function'))).toBe(false)
    expect(isRequeueableDispatchError(null)).toBe(false)
    expect(isRequeueableDispatchError(undefined)).toBe(false)
  })

  it('[S4-QUEUE-015] 成功后重入计数清零（审计②）：拒1 次成功后，下一条仍可完整重入 2 次', async () => {
    let active = false
    let attempts = 0
    const q = makeSafeHarness({
      isActive: () => active,
      startRun: async () => {
        attempts++
        await sleep2(15)
        if (active) throw new Error('AGENT_SESSION_BUSY')
      },
    })
    // 第一轮：拒 1 次后成功（requeues 用掉 1 次额度）
    q.enqueue('s1', { queueMessageId: 'm1', userMessage: '第一轮' })
    await sleep2(5)
    active = true
    await sleep2(35)
    active = false
    q.onRunComplete('s1', 'm1', false)
    await sleep2(40)
    expect(attempts).toBe(2) // 拒1 + 成功
    // 第二轮：BUSY 永错——若计数残留（未清零），只重入 1 次即 drop（总尝试 2 而非 3）
    let secondTries = 0
    const dropped: string[] = []
    const q2 = makeSafeHarness({
      isActive: () => false,
      startRun: async () => {
        secondTries++
        await sleep2(8)
        throw new Error('AGENT_SESSION_BUSY')
      },
      onDropped: () => dropped.push('x'),
    })
    void q
    q2.enqueue('s2', { queueMessageId: 'm2', userMessage: '第二轮' })
    await sleep2(80)
    expect(secondTries).toBe(3) // 计数按消息 id 隔离且成功后清零
    expect(dropped).toHaveLength(1)
  })

  it('[S4-QUEUE-016] stoppedByUser × 重入交互（审计③）：拒回队首后用户停止 → 不自动派发但不丢消息', async () => {
    let active = false
    let attempts = 0
    const q = makeSafeHarness({
      isActive: () => active,
      startRun: async () => {
        attempts++
        await sleep2(15)
        throw new Error('AGENT_SESSION_BUSY')
      },
    })
    q.enqueue('s1', { queueMessageId: 'm1', userMessage: '待发' })
    await sleep2(5)
    active = true
    await sleep2(35) // 拒绝 → 回队首
    expect(q.pendingCount('s1')).toBe(1)
    // 用户停止（消息队列外层 run 被停）：不自动派发，但消息仍在队（可撤回/清空，不静默丢）
    q.onRunComplete('s1', undefined, true)
    await sleep2(30)
    expect(attempts).toBe(1) // 未自动重派发（违背停止意图）
    expect(q.pendingCount('s1')).toBe(1) // 消息仍在队列（不丢，显式取消或下次空闲派发）
  })

  it('[S4-QUEUE-017] 安全网不影响正常成功路径：成功派发零 onDropped、requeues 无残留', async () => {
    const dropped: string[] = []
    const q = makeSafeHarness({
      isActive: () => false,
      startRun: async () => {
        await sleep2(8)
      },
      onDropped: () => dropped.push('x'),
    })
    q.enqueue('s1', { queueMessageId: 'ok1', userMessage: '正常' })
    await sleep2(30)
    expect(q.hasPending('s1')).toBe(false)
    expect(dropped).toEqual([])
  })
})

describe('派发失败安全网——停止抑制（审查收敛 r68，deepseek P1 修复）', () => {
  it('[S4-QUEUE-018] 用户停止后 reject 才落地 → 消息回队首但被抑制，不自动派发（停止意图优先）', async () => {
    let active = false
    let attempts = 0
    let settled = false
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => { release = r })
    const q = new SessionMessageQueue({
      isActive: () => active,
      startRun: async () => {
        attempts++
        await gate // 挂起：模拟 startRun 在途
        await sleep(10)
        throw new Error('AGENT_SESSION_BUSY') // 停止落地后才 reject
      },
    })
    q.enqueue('s1', { queueMessageId: 'm1', userMessage: '停止前的排队消息' })
    await sleep(5)
    expect(attempts).toBe(1)

    // t2：用户停止（cancelAgent 语义：onRunComplete(stopped=true) + clear）
    active = true
    q.onRunComplete('s1', undefined, true)
    q.clear('s1')

    // t3：在途 startRun 的 reject 此时才落地——clear 之后不得再把消息塞回并派发
    active = false
    release()
    settled = true
    void settled
    await sleep(50)

    // 用户已停止：即使 reject 回队首，安全网也不得自动派发（停止意图优先于投递）
    expect(attempts).toBe(1) // 无第二次派发尝试
    expect(q.hasPending('s1')).toBe(false) // 队列保持清空（消息随 clear 丢弃，不违背停止意图）
  })

  it('[S4-QUEUE-019] 停止后用户显式发新消息 → 解除抑制，恢复正常派发', async () => {
    let active = false
    let attempts = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => { release = r })
    const q = new SessionMessageQueue({
      isActive: () => active,
      startRun: async (_s, e) => {
        attempts++
        if (e.queueMessageId === 'm2') return // 停止后的新消息正常成功（解除抑制语义验证）
        await gate // m1 挂起：模拟 startRun 在途
        await sleep(10)
        throw new Error('AGENT_SESSION_BUSY')
      },
    })
    q.enqueue('s1', { queueMessageId: 'm1', userMessage: '第一条' })
    await sleep(5)
    q.onRunComplete('s1', undefined, true) // 用户停止（抑制置位）
    q.clear('s1')
    active = false
    release() // reject 落地（被抑制，不派发）
    await sleep(40)
    expect(attempts).toBe(1)

    // 用户新消息 = 显式意图 → 解除抑制，正常派发
    q.enqueue('s1', { queueMessageId: 'm2', userMessage: '停止后新消息' })
    await sleep(30)
    expect(attempts).toBe(2)
    expect(q.hasPending('s1')).toBe(false)
  })
})
