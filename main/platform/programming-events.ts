/**
 * 编程事件发布器与前台运行检查器（web 线拆除刀2 自 coding/stages/stage-runtime 迁出，
 * 2026-10-01）：两者是品类无关的运行时接线件——IPC 层接线设置、向导/桌面线共用。
 * 消费者经 coding/programming-orchestrator re-export 桩零改动；桩清理挂账（见
 * export * 桩清理条目）后直连本文件。
 */
import type { AgentEvent } from '../../shared/types'
import { emitAgentEvent } from './events/agent-event-bus'

export type ProgrammingEventPublisher = (event: AgentEvent) => void

export let programmingEventPublisher: ProgrammingEventPublisher = () => undefined
export let foregroundRunChecker: (sessionId: string) => boolean = () => false

export function setForegroundRunChecker(checker: (sessionId: string) => boolean): void {
  foregroundRunChecker = checker
}

export function setProgrammingEventPublisher(publisher: ProgrammingEventPublisher): void {
  // P2-A 事件总线（2026-09-08）：接线时套一层 emit——事件先广播到 onAgentEvent 订阅面
  // 再转发原发布目标；原发布链路零改动（行为不变，总线只读旁路）
  programmingEventPublisher = (event) => {
    emitAgentEvent(event)
    publisher(event)
  }
}
