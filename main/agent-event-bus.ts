/**
 * AgentEventBus（P2-A 事件总线，2026-09-08 pi 差距方案 §5 A 期）——main 进程 AgentEvent
 * 流的订阅面，先服务科研埋点与实验插桩。
 *
 * 定位：A 期「只抽订阅面、不改行为」。真实发布路径有两条接缝（orchestrator 的
 * setAgentStreamPublisher 与 programming-orchestrator 的 setProgrammingEventPublisher），
 * 两个 setter 在接线时统一套一层 emit——任何被指派的发布者收发的 AgentEvent 都先广播到
 * 本总线（onAgentEvent 订阅）再转发原目标。行为零变化：原发布链路逐字节不变，总线只是
 * 旁路只读观察。默认 no-op 发布者在未接线时不广播（单元测试事件不进总线，与现状一致）。
 *
 * 订阅语义：onAgentEvent(type, handler) 返回退订函数；type 支持单事件名或 '*'（全量）。
 * 处理器抛错只 console 留痕、绝不阻断发布链路（降级链铁律）。
 *
 * B/C 期（钩子/注册）gate 前：本模块只读，不提供 block/改参能力。
 */

import type { AgentEvent } from '../shared/types'

/** 订阅回调；返回 false 可让退订器复用（约定：抛错即由总线吞掉并留痕）。 */
export type AgentEventHandler = (event: AgentEvent) => void

/** 事件类型或 '*'（全量订阅）。 */
export type AgentEventSelector = AgentEvent['type'] | '*'

const handlers = new Map<AgentEventSelector, Set<AgentEventHandler>>()

/**
 * 订阅一类（或全量）AgentEvent。返回退订函数（幂等）。
 * 处理器抛错不会中断发布链路（总线层吞掉 + console 留痕）。
 */
export function onAgentEvent(type: AgentEventSelector, handler: AgentEventHandler): () => void {
  const set = handlers.get(type) ?? new Set<AgentEventHandler>()
  set.add(handler)
  handlers.set(type, set)
  let unsubscribed = false
  return () => {
    if (unsubscribed) return
    unsubscribed = true
    const current = handlers.get(type)
    if (!current) return
    current.delete(handler)
    if (current.size === 0) handlers.delete(type)
  }
}

/** 广播一条事件到匹配的订阅者（setter 套层调用；匹配 = 具体类型命中 + '*' 全量命中）。 */
export function emitAgentEvent(event: AgentEvent): void {
  const targets: AgentEventHandler[] = []
  const specific = handlers.get(event.type)
  if (specific) for (const handler of specific) targets.push(handler)
  const wildcard = handlers.get('*')
  if (wildcard) for (const handler of wildcard) targets.push(handler)
  if (targets.length === 0) return
  for (const handler of targets) {
    try {
      handler(event)
    } catch (error) {
      // 订阅方故障绝不阻断发布链路（对齐委派超时/审查降级先例的降级链铁律）
      console.warn('[agent-event-bus] 订阅处理器抛错，已隔离：', error instanceof Error ? error.message : String(error))
    }
  }
}

/** 测试 seam：清空全部订阅，保证用例间不串扰。 */
export function resetAgentEventBusForTests(): void {
  handlers.clear()
}
