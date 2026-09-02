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
 *   自己上次输出了什么，反馈才有靶子）；与 prd-engine 既有行为逐字一致。
 */

import type { ConversationTurn, SDKQuery, SDKQueryOptions } from '../orchestrator'
import type { MessageContentBlock, SDKMessage } from '../../shared/types'

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
  retryFeedback?: string
  /** 重试轮 history 构造（缺省：system + 首轮 prompt + 上轮 assistant 累积） */
  buildRetryHistory?: (systemPrompt: string, prompt: string, accumulated: string) => ConversationTurn[]
  signal?: AbortSignal
  /** >0 才设 timer；缺省 0 = 无超时（供测试注入） */
  timeoutMs?: number
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
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const history: ConversationTurn[] | undefined =
        attempt === 0
          ? [{ role: 'system', content: options.systemPrompt }]
          : (options.buildRetryHistory?.(options.systemPrompt, options.prompt, accumulated) ?? [
              { role: 'system', content: options.systemPrompt },
              { role: 'user', content: options.prompt },
              { role: 'assistant', content: accumulated },
            ])
      const round = await runSingleTurn(options, attempt, history, signal)
      accumulated = round
      // 检查合并信号（外部 abort 或内部超时任一触发即停，比只查内部 timer 更严谨）
      if (signal.aborted) return null
      const parsedNow = safeParse(options.parse, accumulated)
      if (parsedNow !== undefined) return parsedNow
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 执行单轮流式调用并累积 assistant 文本（异常上抛由外层 catch 归一为 null）。 */
async function runSingleTurn<T>(
  options: LlmJsonCallOptions<T>,
  attempt: number,
  history: ConversationTurn[],
  signal: AbortSignal,
): Promise<string> {
  const queryOptions: SDKQueryOptions = {
    env: options.env,
    signal,
    sessionId: options.sessionId,
    history,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
  }
  const prompt = attempt === 0 ? options.prompt : (options.retryFeedback ?? options.prompt)
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
