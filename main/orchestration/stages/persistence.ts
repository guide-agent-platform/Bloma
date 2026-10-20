/**
 * 消息与事件落盘（PR4b 拆出）：SDK 消息→事件转换、助手/终态消息持久化、事件构造。
 * 纯机械搬移（零行为变化）；对外契约经 orchestrator re-export 保持不变。
 */
import { randomUUID } from 'node:crypto'


import type { AgentEvent, AgentMessage, AgentSendMessageInput, MessageContentBlock, SDKMessage } from '../../../shared/types';


import { appendSessionMessage } from '../../platform/sessions/session-tree'






export { buildSdkEnv } from '../../platform/llm/channel-manager'
















import { ActiveRun } from './run-registry'

/** 用户主动取消的判定：中止信号抛出的 AbortError 或查询入口的 AGENT_CANCELLED。 */
export function isUserCancelled(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true
  return String(error).includes('AGENT_CANCELLED')
}

export function appendAgentMessage(sessionId: string, message: AgentMessage): void {
  appendSessionMessage(sessionId, message)
}

export function persistAssistantMessages(sessionId: string, sdkMessages: SDKMessage[]): void {
  // 流式模式下每个 assistant 消息只携带一段 delta 文本，这里合并成一条完整助手消息
  const texts: string[] = []
  for (const sdk of sdkMessages) {
    if (sdk.type !== 'assistant' || !sdk.message) continue
    for (const block of sdk.message.content) {
      if (block.type === 'text' && block.text) texts.push(block.text)
    }
  }
  if (texts.length === 0) return
  appendAgentMessage(sessionId, {
    role: 'assistant',
    content: [{ type: 'text', text: texts.join('') }],
    timestamp: Date.now(),
  })
}

/**
 * 将终态（成功/失败）以 system 消息追加到会话 JSONL，
 * 使本地日志可独立还原会话结束原因，不依赖内存流事件。
 */
export function persistTerminalMessage(
  sessionId: string,
  status: 'completed' | 'error',
  detail?: { code?: string; message?: string },
): void {
  const text =
    status === 'completed'
      ? '[terminal] status=completed'
      : `[terminal] status=error code=${detail?.code ?? 'AGENT_SDK_ERROR'} message=${truncate(detail?.message ?? '')}`
  appendAgentMessage(sessionId, {
    role: 'system',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  })
}

export function truncate(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

export function convertSDKMessage(input: AgentSendMessageInput, sdkMessage: SDKMessage): AgentEvent | undefined {
  if (sdkMessage.type === 'assistant') {
    return makeEvent(input, 'message_delta', {
      text: extractText(sdkMessage.message?.content ?? []),
      content: sdkMessage.message?.content ?? [],
    })
  }
  if (sdkMessage.type === 'result') {
    return makeEvent(input, 'message_completed', { subtype: sdkMessage.subtype ?? 'success' })
  }
  return undefined
}

export function makeEvent(input: AgentSendMessageInput, type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent {
  return {
    event_id: randomUUID(),
    session_id: input.session_id,
    project_id: input.project_id,
    type,
    payload,
    created_at: new Date().toISOString(),
  }
}

export function publishRunEvent(input: AgentSendMessageInput, run: ActiveRun, type: AgentEvent['type'], payload: Record<string, unknown>): void {
  run.publisher(makeEvent(input, type, payload))
}

export function extractText(blocks: MessageContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

/** 合并一次运行中所有 assistant 消息的纯文本（用于交付物检测）。 */
export function extractAssistantText(sdkMessages: SDKMessage[]): string {
  const texts: string[] = []
  for (const sdk of sdkMessages) {
    if (sdk.type !== 'assistant' || !sdk.message) continue
    for (const block of sdk.message.content) {
      if (block.type === 'text' && block.text) texts.push(block.text)
    }
  }
  return texts.join('')
}

/** 检测模型是否把完整 HTML / 代码块当成交付物贴进对话（无工具路径的典型表象）。 */
export function detectCodeDelivery(text: string): boolean {
  return /<!doctype\s+html|<html[\s>]|```(?:html|jsx?|tsx?|css|json)?/i.test(text)
}

