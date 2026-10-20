/**
 * SDK 查询与重试胶（PR4b 拆出）：流式发布器/查询注入状态、测试钩子、runWithRetry 重试策略与退避。
 * 纯机械搬移（零行为变化）；对外契约经 orchestrator re-export 保持不变。
 */
/**
 * SDK 查询与重试胶（PR4b 拆出）：流式发布器/查询注入状态、测试钩子、runWithRetry 重试策略与退避。
 * 纯机械搬移（零行为变化）；对外契约经 orchestrator re-export 保持不变。
 */



import type { AgentSendMessageInput, SDKMessage } from '../../../shared/types';






import { emitAgentEvent } from '../../platform/events/agent-event-bus'


export { buildSdkEnv } from '../../platform/llm/channel-manager'
import { extractErrorStatusCode, isInfrastructureFailure, isUserCancelledQuery, pickBackupChannelEnv, readFallbackContext, recordChannelSwitch } from '../../platform/llm/runtime-fallback';


import type { SDKQueryOptions } from './orchestration-contracts'














import { anthropicMessagesQueryViaProviders } from '../../platform/upstream/providers/loop-query'

import { SDKQuery, StreamPublisher } from './orchestration-contracts'
import { MAX_RETRIES, MAX_RETRY_DURATION_MS, SILENT_RETRY_THRESHOLD } from './run-registry'
import { makeEvent } from './persistence'

export let streamPublisher: StreamPublisher = () => undefined
export let sdkQuery: SDKQuery = queryWithRuntimeFallback
export let retrySleep: (ms: number) => Promise<void> = sleep

export function setAgentStreamPublisher(publisher: StreamPublisher): void {
  // P2-A 事件总线（2026-09-08）：接线时套一层 emit——事件先广播到 onAgentEvent 订阅面
  // 再转发原发布目标；原发布链路零改动（行为不变，总线只读旁路）
  streamPublisher = (event) => {
    emitAgentEvent(event)
    publisher(event)
  }
}

export function setSDKQueryForTests(query: SDKQuery): void {
  sdkQuery = query
}

export function resetSDKQueryForTests(): void {
  sdkQuery = queryWithRuntimeFallback
}

/** 生产侧 query 访问器：读取模块级 sdkQuery（默认 anthropicMessagesQuery），供 ipc.ts 透传给 runMvpTask。 */
export function getSdkQuery(): SDKQuery {
  return sdkQuery
}

export function setRetrySleepForTests(sleepFn: (ms: number) => Promise<void>): void {
  retrySleep = sleepFn
}

export async function runWithRetry(input: AgentSendMessageInput, sdkCall: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + MAX_RETRY_DURATION_MS
  let attempt = 0

  for (;;) {
    try {
      await sdkCall()
      return
    } catch (error) {
      if (!shouldRetry(error)) throw error
      attempt += 1
      const remaining = deadline - Date.now()
      if (remaining <= 0 || attempt >= MAX_RETRIES) throw error

      if (attempt > SILENT_RETRY_THRESHOLD) {
        streamPublisher(makeEvent(input, 'retrying', { attempt, max_retries: MAX_RETRIES }))
      }

      await retrySleep(Math.min(backoffMs(attempt), remaining))
    }
  }
}

export function shouldRetry(error: unknown): boolean {
  const statusCode = getStatusCode(error)
  if (statusCode === 429 || statusCode === 529) return true
  if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) return true
  const message = error instanceof Error ? error.message : String(error)
  return /\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/i.test(message)
}

export function getStatusCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const value = (error as { statusCode?: unknown }).statusCode
    if (typeof value === 'number') return value
  }
  const message = error instanceof Error ? error.message : String(error)
  const match = message.match(/\b(429|529|5\d\d)\b/)
  return match ? Number(match[1]) : undefined
}

export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 15_000)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}


/**
 * 请求期被动渠道回退（T9）：包住 anthropicMessagesQuery 作为模块默认 query。
 *
 * 首调命中基础设施故障（429/5xx/网络错误，见 isInfrastructureFailure）且**尚未流出
 * 任何正文**时，按 env 携带的回退上下文切备用渠道重试一次；内容型失败（截断/解析
 * 错发生在引擎层，到不了这里）、用户取消、已流出正文（重试会导致 delta 重复拼接）
 * 一律原样上抛，走调用方既有重试链。切换本身经 recordChannelSwitch 落决策日志
 * 与 [channel-switch] 系统行，绝不静默。
 */
async function* queryWithRuntimeFallback(prompt: string, options: SDKQueryOptions): AsyncGenerator<SDKMessage> {
  // R1-providers（2026-09-19「照抄 Proma」）：传输层用上游 providers 口径（首字节超时/
  // 首事件前重试/多工具并行装配/双认证头）；旧 anthropicMessagesQuery 已删（2026-10-01）。
  // T9 被动渠道回退包裹层不变。
  const baseQuery = anthropicMessagesQueryViaProviders
  const context = readFallbackContext(options.env)
  let emitted = false
  const iterator = baseQuery(prompt, options)[Symbol.asyncIterator]()
  try {
    for (;;) {
      const next = await iterator.next()
      if (next.done) return
      if (next.value.type === 'assistant') emitted = true
      yield next.value
    }
  } catch (error) {
    if (!context || emitted || isUserCancelledQuery(error) || !isInfrastructureFailure(error)) throw error
    const backup = pickBackupChannelEnv(context)
    if (!backup) throw error
    const statusCode = extractErrorStatusCode(error)
    recordChannelSwitch({
      context,
      reason: statusCode ? `http_${statusCode}` : 'network_error',
      to: backup,
      statusCode,
    })
    yield* baseQuery(prompt, {
      ...options,
      env: backup.env,
      // 备用渠道有自己的 max_tokens 上限（16384 主渠道对备用渠道可能 400）
      maxTokens: backup.channel.max_tokens ?? options.maxTokens,
      // omit 推广（审查 P2-②）：回退切换备用渠道时重派生 providerType，避免陈旧主渠道
      // omit 判定（主非 omit→备 Token Plan 仍发 disabled 再 400；主 omit→备非 omit 丢禁思考）
      providerType: backup.channel.provider_type,
    })
  } finally {
    try {
      await iterator.return?.(undefined)
    } catch {
      // 已完成/已抛错时是 no-op，忽略
    }
  }
}
