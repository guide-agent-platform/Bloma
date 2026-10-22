/**
 * kernel/llm-call — 单轮 JSON 调用标准件（2026-09-03 模块化 R2）。
 *
 * 职责切分（与 agent-loop 互补）：**单轮变换用调用，多轮探索用 agent-loop（派遣式另走
 * delegation 机制）**。本件收敛了 prd-leg / enricher / earsifier / normalizer 各自手搓的
 * stream→accumulate→parse→带反馈重试 循环——四处实现细节有出入（陷阱温床），统一为一处。
 *
 * 契约：
 * - parse 返回 undefined 视为本轮失败 → 带反馈重试（attempts 上限内）；parse 抛错同失败处理；
 * - 全部尝试失败 / abort / 超时 / 流内异常 → 返回 null（调用方走自己的确定性兜底，fail-closed）；
 * - timeoutMs > 0 才设 timer（对齐 2026-08-16「取消时间限制」决策）；缺省 0 = 无超时；
 * - 重试轮 history 缺省构造：system + 首轮 user prompt + 上轮 assistant 累积（模型看得见
 *   自己上次输出了什么，反馈才有靶子）；与 prd-engine 既有行为逐字一致；
 * - truncationRetry（R2 尾巴，enricher 模式）：解析失败且输出呈截断态 → 在 cap 内升
 *   maxTokens 并全新重生成（history 仅 system、不带脏输出、prompt 用首轮原文）；预算触
 *   cap 仍截断 → 直接返回 null（升无可升）。截断检测 looksJsonTruncated 同件导出。
 */

import type { ConversationTurn, SDKQuery, SDKQueryOptions } from '../orchestration/orchestrator'
import type { MessageContentBlock } from '../../shared/types';
import type { ThinkingLevel } from '../../shared/reasoning-profile'

/** 单轮尝试失败观测（2026-10-03 e99e6319 事故）：调用方可据此把真实原因写进决策日志。 */
export interface LlmAttemptFailure {
  attempt: number
  /** error=query 抛错（带原始 message）；empty=模型零输出；unparseable=有输出但解析失败。 */
  kind: 'error' | 'empty' | 'unparseable'
  /** Distinguish caller cancellation and the call deadline without parsing provider error text. */
  termination?: 'timeout' | 'aborted'
  detail: string
}

export interface LlmJsonCallOptions<T> {
  /** system 提示词（含角色/输出契约/守卫口径） */
  systemPrompt: string
  /** 首轮 user 内容（任务指令 + 注入的全部输入） */
  prompt: string
  query: SDKQuery
  env: Record<string, string>
  sessionId: string
  maxTokens: number
  temperature: number
  /** 尝试次数（含首轮）；缺省 2 = 首轮 + 带反馈重试一次 */
  attempts?: number
  /** 重试轮的 user 内容（带反馈重试提示）；缺省沿用首轮 prompt */
  retryFeedback?: string | (() => string)
  /** 推理档位（reasoning-profile 2026-08-27）：判定/校验类任务启用；缺省不传 = 现状 off */
  thinkingLevel?: ThinkingLevel
  /** 渠道 providerType（omit 黑名单判断用；不传 = 不做 omit，off 档下与现状一致） */
  providerType?: string
  /**
   * 截断升预算重试（enricher 模式，R2 尾巴）：解析失败且输出呈截断态时，在 cap 内按
   * factor（缺省 2）升 maxTokens 并全新重生成；预算触 cap 仍截断 → 直接返回 null。
   * 缺省不启用：解析失败一律走带反馈重试（回灌坏输出）。
   */
  truncationRetry?: { cap: number; factor?: number }
  signal?: AbortSignal
  /** >0 才设 timer；缺省 0 = 无超时（供测试注入） */
  timeoutMs?: number
  /** 尝试失败观测（可选，不影响返回契约；2026-10-03：fail-closed 吞错零观测的事故补丁）。 */
  onAttemptFailure?: (failure: LlmAttemptFailure) => void
  /** 解析 + 校验：undefined = 本轮失败（进入重试） */
  parse: (text: string) => T | undefined
}

/** 单轮 JSON 调用：成功返回 parse 结果，任何失败返回 null（不抛错，fail-closed）。 */
export async function callLlmForJson<T>(options: LlmJsonCallOptions<T>): Promise<T | null> {
  const attempts = options.attempts ?? 2
  const controller = new AbortController()
  const timer =
    (options.timeoutMs ?? 0) > 0 ? setTimeout(() => controller.abort(), options.timeoutMs as number) : undefined
  const signal = combineSignals(controller.signal, options.signal)

  try {
    let accumulated = ''
    let maxTokens = options.maxTokens
    let truncated = false
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // 截断重试走全新重生成（history 仅 system、prompt 用首轮原文）；格式错误把坏输出回灌
      const history: ConversationTurn[] =
        attempt === 0 || truncated
          ? [{ role: 'system', content: options.systemPrompt }]
          : [
              { role: 'system', content: options.systemPrompt },
              { role: 'user', content: options.prompt },
              { role: 'assistant', content: accumulated },
            ]
      const prompt = attempt === 0 || truncated ? options.prompt : (typeof options.retryFeedback === 'function' ? options.retryFeedback() : options.retryFeedback ?? options.prompt)
      let round: string
      try {
        round = await runSingleTurn(options, maxTokens, history, prompt, signal)
      } catch (error) {
        // 流抛错（网络/HTTP/abort）——这是唯一能看到服务端拒绝原因的地方，必须转交观测
        options.onAttemptFailure?.({
          attempt,
          kind: 'error',
          ...(signal.aborted ? { termination: options.signal?.aborted ? 'aborted' as const : 'timeout' as const } : {}),
          detail: (error instanceof Error ? error.message : String(error)).slice(0, 200),
        })
        throw error
      }
      accumulated = round
      // 检查合并信号（外部 abort 或内部超时任一触发即停，比只查内部 timer 更严谨）
      if (signal.aborted) {
        options.onAttemptFailure?.({ attempt, kind: 'error', termination: options.signal?.aborted ? 'aborted' : 'timeout', detail: '调用已停止' })
        return null
      }
      if (round === '') {
        options.onAttemptFailure?.({ attempt, kind: 'empty', detail: '模型零输出（空流/零正文）' })
      }
      const parsedNow = safeParse(options.parse, accumulated)
      if (parsedNow !== undefined) return parsedNow
      if (round !== '') {
        options.onAttemptFailure?.({
          attempt,
          kind: 'unparseable',
          detail: `输出无法解析（${round.length} 字符）：${round.slice(0, 80)}`,
        })
      }
      // 截断升预算（enricher 模式）：解析失败且输出呈截断态 → 下一轮升预算全新重生成。
      // parse 成功不看截断（截断判断发生在解析失败之后，与 enricher 既有语义一致）。
      const truncationRetry = options.truncationRetry
      truncated = truncationRetry ? looksJsonTruncated(accumulated) : false
      if (truncated && truncationRetry) {
        const factor = truncationRetry.factor ?? 2
        const bumped = Math.min(maxTokens * factor, truncationRetry.cap)
        // 预算已触渠道硬限仍截断：升 maxTokens 不可行 → 直接失败，调用方走确定性兜底
        if (bumped <= maxTokens) return null
        maxTokens = bumped
      }
    }
    return null
  } catch (error) {
    // fail-closed 保持契约不变，但不再零观测（2026-10-03：空流/4xx 被双层吞掉导致整晚归因绕路）
    console.error(
      '[llm-call] 调用异常（fail-closed → null）:',
      error instanceof Error ? error.message : String(error),
    )
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 执行单轮流式调用并累积 assistant 文本（异常上抛由外层 catch 归一为 null）。 */
async function runSingleTurn<T>(
  options: LlmJsonCallOptions<T>,
  maxTokens: number,
  history: ConversationTurn[],
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const queryOptions: SDKQueryOptions = {
    env: options.env,
    signal,
    sessionId: options.sessionId,
    history,
    maxTokens,
    temperature: options.temperature,
    // R2 尾巴：推理档位/providerType 透传（normalizer 等判定类任务用；缺省不传 = 现状）
    thinkingLevel: options.thinkingLevel,
    providerType: options.providerType,
  }
  let round = ''
  for await (const sdkMessage of options.query(prompt, queryOptions)) {
    if (sdkMessage.type !== 'assistant' || !sdkMessage.message) continue
    const text = extractText(sdkMessage.message.content)
    if (text) round += text
  }
  return round
}

/** parse 抛错归一为本轮失败（不中断重试链）。 */
function safeParse<T>(parse: (text: string) => T | undefined, text: string): T | undefined {
  try {
    return parse(text)
  } catch {
    return undefined
  }
}

/**
 * 检测模型输出是否被截断（max_tokens 用尽导致 JSON 未闭合；R2 尾巴自 enricher 迁入）。
 * 只做结构判断，绝不修补内容（陷阱 7：代码型 JSON 不做正则修补）。
 */
export function looksJsonTruncated(text: string): boolean {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.lastIndexOf('{')
  if (start < 0) return false
  // 模型截断惯用的省略/占位符结尾
  if (/(?:\.\.\.|…)\s*$|\/\/\s*(?:rest|more|remaining|todo|未完|略|其余)\s*$/i.test(cleaned)) return true
  const tail = cleaned.slice(start)
  let depth = 0
  let inString = false
  let escaped = false
  for (const ch of tail) {
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') depth = Math.max(0, depth - 1)
  }
  return inString || depth > 0
}

function combineSignals(self: AbortSignal, external?: AbortSignal): AbortSignal {
  if (!external) return self
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  self.addEventListener('abort', onAbort, { once: true })
  external.addEventListener('abort', onAbort, { once: true })
  if (self.aborted || external.aborted) controller.abort()
  return controller.signal
}

function extractText(blocks: MessageContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}
