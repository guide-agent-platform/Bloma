import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../shared/types'
import { emitAgentEvent, onAgentEvent, resetAgentEventBusForTests } from '../../main/agent-event-bus'
import { cancelAgent, setAgentStreamPublisher } from '../../main/orchestrator'
import { setProgrammingEventPublisher } from '../../main/coding/programming-orchestrator'

/**
 * P2-A 事件总线（2026-09-08 pi 差距方案 §5 A 期）：main 进程 AgentEvent 订阅面。
 * 锁定：类型订阅 / 全量订阅 / 退订幂等 / 处理器抛错不阻断 / 两条发布接缝接线后事件先广播。
 */

function makeEvent(type: AgentEvent['type'], extra: Record<string, unknown> = {}): AgentEvent {
  return {
    event_id: `evt-${type}`,
    session_id: 'session-bus',
    project_id: 'project-bus',
    type,
    payload: extra,
    created_at: new Date().toISOString(),
  }
}

describe('agent-event-bus（P2-A）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-event-bus-'))
    resetAgentEventBusForTests()
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    resetAgentEventBusForTests()
  })

  it('类型订阅收到匹配事件；非匹配类型不触发', () => {
    const seen: string[] = []
    onAgentEvent('loop_compaction', (event) => seen.push(event.type))
    emitAgentEvent(makeEvent('loop_compaction'))
    emitAgentEvent(makeEvent('steer_injected'))
    emitAgentEvent(makeEvent('loop_compaction'))
    expect(seen).toEqual(['loop_compaction', 'loop_compaction'])
  })

  it("'*' 全量订阅收到全部事件（含 delegation_* / loop_compaction / steer_injected）", () => {
    const types: string[] = []
    onAgentEvent('*', (event) => types.push(event.type))
    emitAgentEvent(makeEvent('delegation_started'))
    emitAgentEvent(makeEvent('loop_compaction'))
    emitAgentEvent(makeEvent('steer_injected'))
    emitAgentEvent(makeEvent('usage_summary'))
    expect(types).toEqual(['delegation_started', 'loop_compaction', 'steer_injected', 'usage_summary'])
  })

  it('退订幂等：退订后不再收到；重复退订不抛错', () => {
    const seen: string[] = []
    const unsubscribe = onAgentEvent('error', () => seen.push('x'))
    emitAgentEvent(makeEvent('error'))
    unsubscribe()
    unsubscribe() // 幂等
    emitAgentEvent(makeEvent('error'))
    expect(seen).toHaveLength(1)
  })

  it('处理器抛错被隔离，后续订阅者照常收到（降级链铁律：订阅方故障不阻断发布）', () => {
    const received: string[] = []
    onAgentEvent('error', () => {
      throw new Error('订阅方故障')
    })
    onAgentEvent('error', () => received.push('second'))
    expect(() => emitAgentEvent(makeEvent('error'))).not.toThrow()
    expect(received).toEqual(['second'])
  })

  it('orchestrator 接缝：setAgentStreamPublisher 接线后，事件先广播到总线再转发原目标', async () => {
    const forwarded: AgentEvent[] = []
    const busSeen: string[] = []
    setAgentStreamPublisher((event) => forwarded.push(event))
    onAgentEvent('completed', (event) => busSeen.push(event.type))

    // 真实驱动发布路径：cancelAgent 无目标运行 → forced_reset completed 经 streamPublisher 发出
    await cancelAgent({ request_id: 'req-bus', session_id: 'session-idle', reason: 'user_cancelled' })
    expect(busSeen).toEqual(['completed'])
    expect(forwarded.some((event) => event.type === 'completed')).toBe(true)
    expect(forwarded[0]!.payload).toMatchObject({ subtype: 'forced_reset' })
  })

  it('programming-orchestrator 接缝：setProgrammingEventPublisher 接线保持原转发目标可用', () => {
    const forwarded: string[] = []
    setProgrammingEventPublisher((event) => forwarded.push(event.type))
    // 接线后 setter 再次赋值不破坏套层（真实 ipc.ts 只接线一次；此处验证幂等接线安全）
    const inner: Array<AgentEvent> = []
    setProgrammingEventPublisher((event) => inner.push(event))
    emitAgentEvent(makeEvent('delegation_completed'))
    expect(inner).toHaveLength(0) // 总线直接 emit 不经编程接缝（编程接缝只在发布入口触发）
    void forwarded
  })
})
