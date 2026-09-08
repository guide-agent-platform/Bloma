import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  STEER_WRAP_PREFIX,
  clearSteerQueue,
  drainSteerQueue,
  enqueueSteer,
  isSteerableSession,
  markLoopActive,
  markLoopInactive,
  pendingSteerCount,
  resetSteerQueuesForTests,
  wrapSteerContent,
} from '../../main/steer-queue'

/**
 * SteerQueue 单元测试（P0-1 运行中转向，2026-09-08 pi 差距方案 §1）。
 * 纯内存模块：enqueue/drain/clear/mark 全同步，无 IO、无外部依赖。
 */

function entry(id: string, content = `补充 ${id}`) {
  return { queueMessageId: id, content, enqueuedAt: 1 }
}

describe('steer-queue（P0-1 运行中转向）', () => {
  beforeEach(() => resetSteerQueuesForTests())
  afterEach(() => resetSteerQueuesForTests())

  it('包裹函数：`【用户中途补充】` + 原文', () => {
    expect(wrapSteerContent('把按钮改成蓝色')).toBe(`${STEER_WRAP_PREFIX}把按钮改成蓝色`)
  })

  it('无活跃主 loop → enqueue 返回 false（调用方回退 runAgent），队列不残留', () => {
    expect(isSteerableSession('session-a')).toBe(false)
    expect(enqueueSteer('session-a', entry('r1'))).toBe(false)
    expect(pendingSteerCount('session-a')).toBe(0)
    expect(drainSteerQueue('session-a')).toEqual([])
  })

  it('markLoopActive 后 enqueue 成功；多条目保序 drain；markLoopInactive 后恢复拒绝', () => {
    markLoopActive('session-a')
    expect(isSteerableSession('session-a')).toBe(true)
    expect(enqueueSteer('session-a', entry('r1', '先补充'))).toBe(true)
    expect(enqueueSteer('session-a', entry('r2', '后补充'))).toBe(true)
    expect(pendingSteerCount('session-a')).toBe(2)

    const drained = drainSteerQueue('session-a')
    expect(drained.map((item) => item.content)).toEqual(['先补充', '后补充'])
    expect(pendingSteerCount('session-a')).toBe(0)
    // drain 幂等：第二次取空
    expect(drainSteerQueue('session-a')).toEqual([])

    markLoopInactive('session-a')
    expect(isSteerableSession('session-a')).toBe(false)
    expect(enqueueSteer('session-a', entry('r3'))).toBe(false)
  })

  it('request_id 去重：同 queueMessageId 二次入队不重复', () => {
    markLoopActive('session-a')
    expect(enqueueSteer('session-a', entry('r1'))).toBe(true)
    expect(enqueueSteer('session-a', entry('r1'))).toBe(true)
    expect(pendingSteerCount('session-a')).toBe(1)
  })

  it('clear 清空待注入队列（abort/停止语义：不留 limbo）', () => {
    markLoopActive('session-a')
    enqueueSteer('session-a', entry('r1'))
    enqueueSteer('session-a', entry('r2'))
    clearSteerQueue('session-a')
    expect(pendingSteerCount('session-a')).toBe(0)
    expect(drainSteerQueue('session-a')).toEqual([])
  })

  it('活跃标记与会话相互独立：A 活跃不影响 B', () => {
    markLoopActive('session-a')
    expect(enqueueSteer('session-b', entry('r1'))).toBe(false)
    expect(enqueueSteer('session-a', entry('r1'))).toBe(true)
    markLoopInactive('session-b') // 未标记的 unmark 不抛错
    markLoopInactive('session-a')
  })
})
