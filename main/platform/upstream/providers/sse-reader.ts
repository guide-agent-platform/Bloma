/**
 * 共享 SSE 流式读取器（照抄 Proma 上游 packages/core/src/providers/sse-reader.ts
 * @ bf3e98c 的流式子集；裁剪 fetchTitle——Bloma 标题生成不走本层）。
 *
 * 封装通用的 SSE 解析逻辑（上游口径，Bloma 此前手写版缺失的全部稳健性在此）：
 * - 首字节超时（默认 30s，仅计响应等待期，不清截长流）
 * - 首事件前自动重试（指数退避 + jitter，5 次 / 30s 预算；已发事件不重试防重复推送）
 * - 多工具调用并行装配（pendingToolCalls 按 id 关联，outputIndex 兜底）
 * - thinking 块容错（无 content_block_start 直接发 thinking_delta / 无块时收到
 *   signature_delta 均自建块）
 * - finalArguments 兜底（provider 的 arguments.done 整参替换）
 * - JSON 参数损坏保留空参调用（不丢调用、不修补——与 Bloma 陷阱 7 口径一致）
 */

import type { ProviderRequest, StreamAdapter, StreamEventCallback, ThinkingBlock, ToolCall } from './types'
import { MonetaryBudgetError, reserveModelRequestWhenAvailable, fitMonetaryRequest } from '../../llm/monetary-budget'
import type { SDKMessage, ModelTransportReceipt } from '../../../../shared/types'
import { createHash } from 'node:crypto'

// ===== 流式请求 =====

/** streamSSE 的输入选项（上游原样） */
export interface StreamSSEOptions {
  requestGuard?: (request: { url: string; body: string }) => void
  monetaryPolicyPath?: string
  onResponse?: (receipt: ModelTransportReceipt) => void
  onAttempt?: (state: 'started' | 'failed' | 'cancelled') => void
  /** 构建好的 HTTP 请求配置 */
  request: ProviderRequest
  /** 供应商适配器（用于解析 SSE 行） */
  adapter: StreamAdapter
  /** 事件回调 */
  onEvent: StreamEventCallback
  /** AbortSignal 用于取消请求 */
  signal?: AbortSignal
  /** 首字节超时（毫秒），默认 30s。超时触发 AbortError，可被重试逻辑捕获并自动重试 */
  timeoutMs?: number
  /** 流空闲超时（毫秒），默认 120s。响应头后连续无字节（连接僵死：无事件无错误不断开）
   *  时主动中断：未发过事件走重试链安全重发；已发过事件上抛由 llm-call 带反馈重试。
   *  实证 2026-10-08：番茄钟单 740s 挂死轮，向导 8min 无回传只能 stop_delegation
   *  杀整个子会话续跑——空闲超时把自愈粒度降到单请求 2 分钟。 */
  streamIdleTimeoutMs?: number
  /** No semantic progress (text/thinking/tool arguments). Heartbeats do not reset it. */
  streamProgressTimeoutMs?: number
  /** 自定义 fetch 函数（代理等场景下由调用方注入） */
  fetchFn?: typeof globalThis.fetch
}

/** streamSSE 的返回结果（上游原样） */
export interface StreamSSEResult {
  /** 累积的完整文本内容 */
  content: string
  /** 累积的推理内容（扁平文本，所有思考块拼接） */
  reasoning: string
  /**
   * 结构化的思考块（每块含 thinking 文本和可选 signature）
   *
   * 思考+工具模式下必须原样（含签名）回传给 Anthropic 协议家族服务端：
   * 签名缺失时会被 DeepSeek v4 等服务端以 "content[].thinking must be passed back" 拒绝。
   */
  thinkingBlocks: ThinkingBlock[]
  /** 本轮返回的工具调用列表 */
  toolCalls: ToolCall[]
  /** 停止原因（'tool_use' 表示需要执行工具后继续） */
  stopReason?: string
}

// ===== 首字节前自动重试 =====

const MAX_SSE_RETRY_WAIT_MS = 30_000

/** 单次重试延迟上限（毫秒） */
const SSE_RETRY_MAX_DELAY_MS = 8_000

/** 首字节前最大自动重试次数 */
const MAX_SSE_RETRIES = 5

/** 累计重试等待预算（毫秒）——测试 seam 可覆写（0=禁用重试，确定性单发） */
let maxRetryWaitMs = MAX_SSE_RETRY_WAIT_MS

/** 测试 seam：覆写重试等待预算（不传恢复缺省）；单测里指数退避会拖慢套件。 */
export function setSseRetryWaitBudgetForTests(budgetMs?: number): void {
  maxRetryWaitMs = budgetMs ?? MAX_SSE_RETRY_WAIT_MS
}

/** HTTP 错误携带状态码，便于重试决策 */
class HTTPError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly providerCode?: string,
    readonly nonRetryable = false,
    readonly providerResetAt?: string,
  ) {
    super(message)
    this.name = 'HTTPError'
  }
}

/** Host admission/validation failures must never turn into transport retries. */
class RequestGuardError extends Error {
  constructor(error: unknown) { super(error instanceof Error ? error.message : String(error)); this.name = 'RequestGuardError' }
}

/** Provider 在 200 流内返回的语义错误，通常不是瞬时网络问题，不应自动重试。 */
class ProviderStreamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderStreamError'
  }
}

/** 计算重试延迟（指数退避 + ±20% jitter） */
function getSSERetryDelayMs(attempt: number, elapsedRetryDelayMs: number): number {
  const remainingMs = maxRetryWaitMs - elapsedRetryDelayMs
  if (remainingMs <= 0) return 0

  const base = Math.min(1000 * Math.pow(2, attempt - 1), SSE_RETRY_MAX_DELAY_MS)
  const jitter = base * (Math.random() * 0.4 - 0.2)
  return Math.min(remainingMs, Math.max(0, Math.round(base + jitter)))
}

/** 判断错误是否可重试（上游原样） */
function isRetriableError(error: unknown): boolean {
  if (error instanceof MonetaryBudgetError) return false
  if (error instanceof ProviderStreamError) return false
  if (error instanceof RequestGuardError) return false
  if (error instanceof HTTPError) {
    if (error.nonRetryable) return false
    return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
  }
  return true
}

/** 可被 AbortSignal 立即打断的 sleep；abort 时 reject AbortError */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 执行流式 SSE 请求（含首字节前自动重试；上游原样）
 */
export async function streamSSE(options: StreamSSEOptions): Promise<StreamSSEResult> {
  const { signal } = options
  let elapsedRetryDelayMs = 0

  for (let attempt = 1; ; attempt++) {
    let attemptStarted = false
    // 跟踪本次尝试是否已发出事件——一旦发出就不能再重试
    let hasEmitted = false
    const trackedOptions: StreamSSEOptions = {
      ...options,
      onAttempt: state => {
        if (state === 'started') attemptStarted = true
        try { options.onAttempt?.(state) } catch { /* accounting cannot affect delivery */ }
      },
      onEvent: (event) => {
        hasEmitted = true
        options.onEvent(event)
      },
    }

    try {
      return await runStreamAttempt(trackedOptions)
    } catch (error) {
      if (attemptStarted) {
        try { options.onAttempt?.(signal?.aborted ? 'cancelled' : 'failed') } catch { /* telemetry only */ }
      }
      // 用户主动取消：不重试
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error
      }
      // 已发出过事件：重试会导致内容重复
      if (hasEmitted) throw error
      // 永久性错误（4xx 等）或已达重试上限：直接抛出
      if (!isRetriableError(error) || attempt >= MAX_SSE_RETRIES) throw error

      const delay = getSSERetryDelayMs(attempt, elapsedRetryDelayMs)
      if (delay <= 0) throw error // 等待预算耗尽
      elapsedRetryDelayMs += delay

      const msg = error instanceof Error ? error.message : String(error)
      console.warn(`[streamSSE] 首字节前出错，${delay}ms 后第 ${attempt} 次重试: ${msg}`)
      await sleepWithAbort(delay, signal)
    }
  }
}

function normalizeToolCallOutputIndex(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value) return value
  return undefined
}

/** 单次 SSE 流式尝试（不含重试逻辑；上游原样） */
async function runStreamAttempt(options: StreamSSEOptions): Promise<StreamSSEResult> {
  const policyPath = options.monetaryPolicyPath ?? process.env.BLOMA_MONETARY_POLICY
  const body = fitMonetaryRequest(options.request.url, options.request.body, policyPath)
  if (body !== options.request.body) options = { ...options, request: { ...options.request, body } }
  try { options.requestGuard?.(options.request) } catch (error) { throw new RequestGuardError(error) }
  const reservation = await reserveModelRequestWhenAvailable(options.request.url, options.request.body, options.signal,
    policyPath)
  let usage: SDKMessage['usage']
  let completed = false
  try {
    const result = await runReservedStreamAttempt({ ...options, onEvent: event => {
      if (event.type === 'usage') {
        usage = { ...usage,
          ...(event.inputTokens !== undefined ? { input_tokens: event.inputTokens } : {}),
          ...(event.outputTokens !== undefined ? { output_tokens: event.outputTokens } : {}),
          ...(event.cacheReadInputTokens !== undefined ? { cache_read_input_tokens: event.cacheReadInputTokens } : {}),
          ...(event.cacheCreationInputTokens !== undefined ? { cache_creation_input_tokens: event.cacheCreationInputTokens } : {}) }
      }
      options.onEvent(event)
    } })
    completed = true
    return result
  } finally { reservation?.settle(usage, completed) }
}

async function runReservedStreamAttempt(options: StreamSSEOptions): Promise<StreamSSEResult> {
  const { request, adapter, onEvent, signal, fetchFn = fetch, timeoutMs = 30_000, streamIdleTimeoutMs = 120_000, streamProgressTimeoutMs = 120_000 } = options

  // 真正的"首字节超时"：仅在等待 HTTP 响应期间计时，收到响应后立即清除。
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(new DOMException('First byte timeout', 'TimeoutError')), timeoutMs)
  const effectiveSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal

  // 1. 发起请求（支持通过 fetchFn 注入代理）
  effectiveSignal.throwIfAborted()
  options.onAttempt?.('started')
  let response: Response
  try {
    response = await fetchFn(request.url, {
      method: 'POST', headers: request.headers, body: request.body, signal: effectiveSignal,
    })
  } finally { clearTimeout(timer) }

  const contentType = response.headers.get('content-type') ?? ''
  const receipt = (fields: Partial<ModelTransportReceipt> = {}) => {
    try { options.onResponse?.({ status: response.status, content_type: contentType, ...fields }) } catch { /* telemetry only */ }
  }
  receipt()
  if (response.ok && /application\/json/i.test(contentType)) {
    const text = await response.text()
    let code: unknown
    try { const raw = JSON.parse(text); code = raw.error?.code ?? raw.code } catch { /* invalid JSON is still a protocol failure */ }
    const safeCode = typeof code === 'number' || typeof code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? String(code) : undefined
    receipt({ response_bytes: Buffer.byteLength(text), sse_data_lines: 0, body_sha256: createHash('sha256').update(text).digest('hex'), json_error_code: safeCode })
    throw new ProviderStreamError(`PROVIDER_JSON_RESPONSE: HTTP ${response.status}${safeCode ? `, code ${safeCode}` : ''}; expected an SSE stream`)
  }

  // 2. 错误检查
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let code: unknown, providerMessage = ''
    try { const raw = JSON.parse(text); code = raw.error?.code ?? raw.code; providerMessage = typeof raw.error?.message === 'string' ? raw.error.message : '' } catch { /* non-JSON errors keep the ordinary HTTP retry policy */ }
    const safeCode = typeof code === 'number' || typeof code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? String(code) : undefined
    receipt({ response_bytes: Buffer.byteLength(text), body_sha256: createHash('sha256').update(text).digest('hex'), json_error_code: safeCode })
    // BigModel documents 1113 as insufficient prepaid credit, despite HTTP 429.
    // Repeating it is not rate-limit recovery and creates additional unknown holds.
    const creditExhausted = new URL(request.url).hostname === 'open.bigmodel.cn' && response.status === 429 && safeCode === '1113'
    const fixedQuotaExhausted = new URL(request.url).hostname === 'open.bigmodel.cn' && response.status === 429 && safeCode === '1308'
      && /小时.*(?:上限|限额)|限额将在|(?:usage|quota).*(?:limit|reset)/i.test(providerMessage)
    const resetAt = fixedQuotaExhausted ? providerMessage.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)?.[0] : undefined
    throw new HTTPError(`provider API 错误 (${response.status}): ${text.slice(0, 300)}`, response.status, safeCode, creditExhausted || fixedQuotaExhausted, resetAt)
  }

  if (!response.body) {
    throw new Error('响应体为空')
  }

  // 3. 读取流
  let content = ''
  let reasoning = ''
  let stopReason: string | undefined
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  // 工具调用追踪
  const pendingToolCalls = new Map<string, { id: string; name: string; args: string; metadata?: Record<string, unknown> }>()
  const toolCallIdsByOutputIndex = new Map<string, string>()
  let currentToolCallId: string | undefined

  // 思考块追踪（Anthropic 协议：每个 thinking 块由多个 thinking_delta + signature_delta 组成）
  const thinkingBlocks: ThinkingBlock[] = []
  let currentThinking: ThinkingBlock | null = null

  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let progressTimer: ReturnType<typeof setTimeout> | undefined
  let progressTimedOut = false
  let protocolEnded = false
  let responseBytes = 0, dataLines = 0
  const responseHash = createHash('sha256')
  const armProgressTimer = (): void => {
    if (progressTimer) clearTimeout(progressTimer)
    progressTimer = setTimeout(() => {
      progressTimedOut = true
      void reader.cancel().catch(() => {})
    }, streamProgressTimeoutMs)
  }
  try {
    // 流空闲超时（批11.8，2026-10-08）：连接僵死自洁——无字节的 read() 到期后
    // cancel 流解阻塞，携专用错误上抛（isRetriableError 对其放行 → 外层安全重试）
    let idleTimedOut = false
    const armIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleTimedOut = true
        console.warn(`[streamSSE] 流空闲超时（${Math.round(streamIdleTimeoutMs / 1000)}s 无字节）——连接疑似僵死，主动中断重试`)
        void reader.cancel().catch(() => {})
      }, streamIdleTimeoutMs)
    }
    armProgressTimer()
    while (!protocolEnded) {
      armIdleTimer()
      let readResult: ReadableStreamReadResult<Uint8Array>
      try {
        readResult = await reader.read()
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
      }
      if (progressTimedOut) {
        const err = new Error(`SSE 流无有效进展超时：${Math.round(streamProgressTimeoutMs / 1000)}s 无正文、推理或工具参数增量（心跳不计进展）`)
        err.name = 'StreamProgressTimeoutError'
        throw err
      }
      if (idleTimedOut) {
        const err = new Error(`SSE 流空闲超时：${Math.round(streamIdleTimeoutMs / 1000)}s 无任何字节（连接僵死）`)
        err.name = 'StreamIdleTimeoutError'
        throw err
      }
      const { done, value } = readResult
      if (done) break

      responseBytes += value.byteLength
      responseHash.update(value)

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // 保留最后一个可能不完整的行
      buffer = lines.pop() || ''

      for (const line of lines) {
        // SSE 规范：冒号后的空格是可选的，兼容 "data: {...}" 和 "data:{...}" 两种格式
        let data: string
        if (line.startsWith('data: ')) {
          data = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          data = line.slice(5).trim()
        } else {
          continue
        }
        dataLines++
        if (data === '[DONE]') { protocolEnded = true; break }
        if (!data) continue

        // 4. 委托给 adapter 解析供应商特定 JSON
        const events = adapter.parseSSELine(data)

        for (const event of events) {
          if ((event.type === 'chunk' || event.type === 'reasoning') && event.delta ||
              event.type === 'tool_call_start' || event.type === 'tool_call_delta' && (event.argumentsDelta || event.finalArguments)) armProgressTimer()
          if (event.type === 'chunk') {
            content += event.delta
          } else if (event.type === 'reasoning') {
            reasoning += event.delta
            // 同步追加到当前思考块
            if (currentThinking) {
              currentThinking.thinking += event.delta
            } else {
              // 容错：有些 Provider 不发 content_block_start，直接发 thinking_delta
              currentThinking = { thinking: event.delta }
              thinkingBlocks.push(currentThinking)
            }
          } else if (event.type === 'reasoning_signature') {
            if (currentThinking) {
              currentThinking.signature = (currentThinking.signature ?? '') + event.signature
            } else {
              // 容错：signature_delta 出现时没有活跃思考块，自建一个
              currentThinking = { thinking: '', signature: event.signature }
              thinkingBlocks.push(currentThinking)
            }
          } else if (event.type === 'reasoning_block_start') {
            currentThinking = { thinking: '' }
            thinkingBlocks.push(currentThinking)
          } else if (event.type === 'reasoning_block_stop') {
            currentThinking = null
          } else if (event.type === 'tool_call_start') {
            currentToolCallId = event.toolCallId
            const outputIndex = normalizeToolCallOutputIndex(event.metadata?.outputIndex)
            if (outputIndex) toolCallIdsByOutputIndex.set(outputIndex, event.toolCallId)
            const existing = pendingToolCalls.get(event.toolCallId)
            pendingToolCalls.set(event.toolCallId, {
              id: event.toolCallId,
              name: event.toolName,
              args: existing?.args ?? '',
              metadata: { ...existing?.metadata, ...event.metadata },
            })
          } else if (event.type === 'tool_call_delta') {
            const outputIndex = normalizeToolCallOutputIndex(event.metadata?.outputIndex)
            const tcId = event.toolCallId || (outputIndex ? toolCallIdsByOutputIndex.get(outputIndex) : undefined) || currentToolCallId
            if (tcId) {
              const pending = pendingToolCalls.get(tcId)
              if (pending) {
                pending.args = event.finalArguments !== undefined
                  ? event.finalArguments
                  : pending.args + event.argumentsDelta
              }
            }
          } else if (event.type === 'done' && event.stopReason) {
            stopReason = event.stopReason
          } else if (event.type === 'error') {
            throw new ProviderStreamError(event.error)
          }
          onEvent(event)
          if (event.type === 'done' && event.terminal) protocolEnded = true
        }
        if (protocolEnded) break
      }
    }
  } finally {
    receipt({ response_bytes: responseBytes, sse_data_lines: dataLines, protocol_ended: protocolEnded, body_sha256: responseHash.digest('hex') })
    if (idleTimer) clearTimeout(idleTimer)
    if (progressTimer) clearTimeout(progressTimer)
    if (protocolEnded) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }

  // 将 pending 工具调用解析为最终结果
  const toolCalls: ToolCall[] = []
  for (const [, pending] of pendingToolCalls) {
    try {
      toolCalls.push({
        id: pending.id,
        name: pending.name,
        arguments: pending.args ? JSON.parse(pending.args) : {},
        metadata: pending.metadata,
      })
    } catch {
      // JSON 解析失败仍保留工具调用（空参数）
      toolCalls.push({
        id: pending.id,
        name: pending.name,
        arguments: {},
        metadata: pending.metadata,
      })
    }
  }

  // 有工具调用但无显式 stopReason 时自动推断
  if (toolCalls.length > 0 && !stopReason) {
    stopReason = 'tool_use'
  }

  onEvent({ type: 'done', stopReason })
  return { content, reasoning, thinkingBlocks, toolCalls, stopReason }
}

export { HTTPError, ProviderStreamError }
