import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  STEER_WRAP_PREFIX,
  clearSteerQueue,
  classifySteerImpact,
  drainSteerQueue,
  enqueueSteer,
  getSteerStatuses,
  isSteerableSession,
  markLoopActive,
  markLoopInactive,
  markSteerMerged,
  pendingSteerCount,
  registerSteer,
  rejectPendingSteer,
  resetSteerQueuesForTests,
  resolveSteer,
  setSteerStatusListener,
  settleSteerEntry,
  steerConfirmEnabled,
  wrapSteerContent,
  type SteerLedgerEntry,
  type SteerStatusListener,
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

describe('I3 转向生效确认链（P7-7，BLOMA_STEER_CONFIRM）', () => {
  beforeEach(() => resetSteerQueuesForTests())
  afterEach(() => {
    resetSteerQueuesForTests()
    delete process.env.BLOMA_STEER_CONFIRM
  })

  it('开关读取：缺省 off，1/true 为 on', () => {
    expect(steerConfirmEnabled()).toBe(false)
    process.env.BLOMA_STEER_CONFIRM = '1'
    expect(steerConfirmEnabled()).toBe(true)
    process.env.BLOMA_STEER_CONFIRM = 'true'
    expect(steerConfirmEnabled()).toBe(true)
  })

  it('off=字节级现状：enqueueSteer 不登记账本，getSteerStatuses 恒空', () => {
    markLoopActive('session-off')
    enqueueSteer('session-off', entry('r1'))
    expect(pendingSteerCount('session-off')).toBe(1)
    expect(getSteerStatuses('session-off')).toEqual([])
  })

  describe('分级（宁低勿高：低档=注入即确认与现状一致，误判代价最小）', () => {
    it('低档：文案/颜色/微调与未命中句', () => {
      expect(classifySteerImpact('把按钮改成蓝色')).toBe('low')
      expect(classifySteerImpact('标题文案改成「我的笔记」')).toBe('low')
      expect(classifySteerImpact('字体大一点')).toBe('low')
      expect(classifySteerImpact('你好')).toBe('low')
    })
    it('中档：新功能/流程结构信号', () => {
      expect(classifySteerImpact('再加一个搜索功能')).toBe('medium')
      expect(classifySteerImpact('新增一个导出页面')).toBe('medium')
      expect(classifySteerImpact('流程改成先预览再保存')).toBe('medium')
      expect(classifySteerImpact('步骤换一种方式做')).toBe('medium')
    })
    it('高档：核心目标/数据模型转向信号（窄表从严）', () => {
      expect(classifySteerImpact('不要这个应用了，换个方向做待办')).toBe('high')
      expect(classifySteerImpact('重新设计数据结构')).toBe('high')
      expect(classifySteerImpact('推翻重来')).toBe('high')
      expect(classifySteerImpact('存储方案改成数据库')).toBe('high')
    })
    it('宁低勿高：高档措辞不明显时归低（「换一个配色」不拦）', () => {
      expect(classifySteerImpact('换一个配色方案')).toBe('low')
      expect(classifySteerImpact('改一下颜色')).toBe('low')
    })
  })

  it('registerSteer 低档：received 直接入队（简短确认即注入）+ listener 上报', () => {
    markLoopActive('session-i3')
    const seen: SteerLedgerEntry[] = []
    setSteerStatusListener((change) => seen.push({ ...change }))
    const registered = registerSteer('session-i3', entry('r1', '把按钮改成蓝色'), 'proj-1')
    expect(registered?.status).toBe('received')
    expect(registered?.impact).toBe('low')
    expect(pendingSteerCount('session-i3')).toBe(1)
    expect(seen.map((item) => item.status)).toEqual(['received'])
    // 注入队列携带 steerId（注入点据此推进 merged）
    const drained = drainSteerQueue('session-i3')
    expect(drained[0]?.steerId).toBe('r1')
  })

  it('registerSteer 中/高档：pending_impact 不入队，等三选回执', () => {
    markLoopActive('session-i3')
    const medium = registerSteer('session-i3', entry('r2', '再加一个搜索功能'))
    expect(medium?.status).toBe('pending_impact')
    expect(medium?.impact).toBe('medium')
    expect(pendingSteerCount('session-i3')).toBe(0) // 未入注入队列
    const high = registerSteer('session-i3', entry('r3', '不要这个应用了'))
    expect(high?.status).toBe('pending_impact')
    expect(high?.impact).toBe('high')
    expect(pendingSteerCount('session-i3')).toBe(0)
  })

  it('registerSteer 无活跃 loop：不登记返回 undefined（IPC 回退 runAgent）', () => {
    expect(registerSteer('session-idle', entry('r1'))).toBeUndefined()
    expect(getSteerStatuses('session-idle')).toEqual([])
  })

  describe('resolveSteer 三选（影响卡回执）', () => {
    beforeEach(() => markLoopActive('session-r'))
    it('inject_now：入队 received', () => {
      registerSteer('session-r', entry('r1', '再加一个搜索功能'))
      const resolved = resolveSteer('session-r', 'r1', 'inject_now')
      expect(resolved?.status).toBe('received')
      expect(pendingSteerCount('session-r')).toBe(1)
      expect(drainSteerQueue('session-r')[0]?.steerId).toBe('r1')
    })
    it('defer：deferred_next_run 形成可见待办（不入队）', () => {
      registerSteer('session-r', entry('r1', '再加一个搜索功能'))
      const resolved = resolveSteer('session-r', 'r1', 'defer')
      expect(resolved?.status).toBe('deferred_next_run')
      expect(pendingSteerCount('session-r')).toBe(0)
      expect(getSteerStatuses('session-r')[0]?.status).toBe('deferred_next_run')
    })
    it('reject：rejected（不改了）', () => {
      registerSteer('session-r', entry('r1', '再加一个搜索功能'))
      expect(resolveSteer('session-r', 'r1', 'reject')?.status).toBe('rejected')
    })
    it('非 pending_impact 状态回执拒收（重复三选/未知 id）', () => {
      registerSteer('session-r', entry('r1', '再加一个搜索功能'))
      resolveSteer('session-r', 'r1', 'reject')
      expect(resolveSteer('session-r', 'r1', 'defer')).toBeUndefined()
      expect(resolveSteer('session-r', 'unknown', 'defer')).toBeUndefined()
    })
    it('loop 已结束时选「本轮就改」：如实转留待下一轮，不静默失效', () => {
      registerSteer('session-r', entry('r1', '再加一个搜索功能'))
      markLoopInactive('session-r')
      const resolved = resolveSteer('session-r', 'r1', 'inject_now')
      expect(resolved?.status).toBe('deferred_next_run')
      expect(pendingSteerCount('session-r')).toBe(0)
    })
  })

  it('markSteerMerged 是 merged_this_run 的唯一入口（幂等；未注入恒非 merged）', () => {
    markLoopActive('session-m')
    registerSteer('session-m', entry('r1', '把按钮改成蓝色'))
    // 已入队但未注入：账本状态是 received——「这轮会做吗」此刻答案=会（待注入），不是已纳入
    expect(getSteerStatuses('session-m')[0]?.status).toBe('received')
    // 模拟注入完成推进
    markSteerMerged('session-m', 'r1')
    expect(getSteerStatuses('session-m')[0]?.status).toBe('merged_this_run')
    // 幂等：二次推进无副作用；未知 id 安全
    markSteerMerged('session-m', 'r1')
    markSteerMerged('session-m', 'ghost')
    expect(getSteerStatuses('session-m')).toHaveLength(1)
  })

  it('resolveSteer 后的 defer/reject 不能被 markSteerMerged 覆盖为已纳入', () => {
    markLoopActive('session-m2')
    registerSteer('session-m2', entry('r1', '再加一个搜索功能'))
    resolveSteer('session-m2', 'r1', 'reject')
    markSteerMerged('session-m2', 'r1') // 任何路径尝试宣布「已纳入」
    expect(getSteerStatuses('session-m2')[0]?.status).toBe('rejected')
  })

  it('rejectPendingSteer（停止语义）：未注入条目标 rejected，merged/deferred 不动', () => {
    markLoopActive('session-stop')
    registerSteer('session-stop', entry('r1', '把按钮改成蓝色'))
    registerSteer('session-stop', entry('r2', '再加一个搜索功能'))
    registerSteer('session-stop', entry('r3', '标题改一下'))
    resolveSteer('session-stop', 'r2', 'defer')
    markSteerMerged('session-stop', 'r3')
    const rejected = rejectPendingSteer('session-stop')
    expect(rejected.map((item) => item.steerId)).toEqual(['r1'])
    const statuses = Object.fromEntries(getSteerStatuses('session-stop').map((item) => [item.steerId, item.status]))
    expect(statuses).toEqual({ r1: 'rejected', r2: 'deferred_next_run', r3: 'merged_this_run' })
  })

  it('settleSteerEntry（loop 收尾残余）：未终结条目按参数收口，已终结不动', () => {
    markLoopActive('session-fin')
    registerSteer('session-fin', entry('r1', '把按钮改成蓝色'))
    settleSteerEntry('session-fin', 'r1', 'deferred_next_run')
    expect(getSteerStatuses('session-fin')[0]?.status).toBe('deferred_next_run')
    settleSteerEntry('session-fin', 'r1', 'rejected') // 已终结不再改
    expect(getSteerStatuses('session-fin')[0]?.status).toBe('deferred_next_run')
  })

  it('statusListener 抛错不阻断状态机（降级链铁律）', () => {
    markLoopActive('session-err')
    setSteerStatusListener(() => {
      throw new Error('listener boom')
    })
    const registered = registerSteer('session-err', entry('r1', '把按钮改成蓝色'))
    expect(registered?.status).toBe('received') // 状态照常推进
    expect(pendingSteerCount('session-err')).toBe(1)
  })

  it('体验验收①（E2）：生成中问「你刚提的修改这轮会做吗」——答案与账本状态一一对应', () => {
    // 「这轮会做吗」的答案映射（getSteerStatuses 是权威答案源）：
    const answerOf = (status: SteerLedgerEntry['status']): string => {
      if (status === 'merged_this_run' || status === 'received') return '会'
      if (status === 'pending_impact') return '待你确认'
      if (status === 'deferred_next_run') return '下一轮'
      return '不会'
    }
    markLoopActive('session-acceptance')
    // 场景 A 低档注入链：received（会）→ 注入完成 merged（会）——两态答案一致且与事件同步
    registerSteer('session-acceptance', entry('low1', '把按钮改成蓝色'))
    let statuses = getSteerStatuses('session-acceptance')
    expect(answerOf(statuses.find((item) => item.steerId === 'low1')!.status)).toBe('会')
    markSteerMerged('session-acceptance', 'low1')
    statuses = getSteerStatuses('session-acceptance')
    expect(answerOf(statuses.find((item) => item.steerId === 'low1')!.status)).toBe('会')
    // 场景 B 中档未确认：待你确认——不是「会」也不是「不会」（此前 UI 回执恒「已注入」的失真源头）
    registerSteer('session-acceptance', entry('mid1', '再加一个搜索功能'))
    statuses = getSteerStatuses('session-acceptance')
    expect(answerOf(statuses.find((item) => item.steerId === 'mid1')!.status)).toBe('待你确认')
    // 场景 C 停止：未注入的都如实「不会」，不再静默消失
    rejectPendingSteer('session-acceptance')
    statuses = getSteerStatuses('session-acceptance')
    expect(answerOf(statuses.find((item) => item.steerId === 'mid1')!.status)).toBe('不会')
    // 场景 D 留待下一轮
    registerSteer('session-acceptance', entry('mid2', '还要一个导出页面'))
    resolveSteer('session-acceptance', 'mid2', 'defer')
    statuses = getSteerStatuses('session-acceptance')
    expect(answerOf(statuses.find((item) => item.steerId === 'mid2')!.status)).toBe('下一轮')
  })
})
   
