import type {AgentEvent} from '../../shared/types'
/** Test oracle for Pi failed-turn boundaries; no dispatcher execution. */
export class AssistantTurnCollector {
  private buffer = ''
  private readonly turns: Array<Array<{ type: 'text'; text?: string }>> = []

  /** publish 转发钩子（接线层把它接到 loop 的 publish 上）。 */
  readonly onPublish = (type: AgentEvent['type'] | string, payload: Record<string, unknown>): void => {
    if (type === 'message_delta' && typeof payload.text === 'string') this.buffer += payload.text
  }

  /** 轮界（onTurn 转发钩子）：把累积 buffer 换页为一轮。 */
  readonly onTurnBoundary = (): void => {
    if (this.buffer.length > 0) {
      this.turns.push([{ type: 'text', text: this.buffer }])
      this.buffer = ''
    }
  }

  readonly discardCurrentTurn = (): void => { this.buffer = '' }

  /** 收尾：残余 buffer（收工轮——无 tool_use 不触发 onTurn）收为最后一轮。 */
  flush(): ReadonlyArray<ReadonlyArray<{ type: 'text'; text?: string }>> {
    this.onTurnBoundary()
    return this.turns
  }
}
