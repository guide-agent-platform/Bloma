/**
 * kernel/llm-call 单测（2026-09-03 R2 标准件）。
 *
 * 验证收敛自 prd-engine 的调用循环语义：
 * - 首轮解析成功 → 单次调用直接返回；
 * - 首轮失败 → 重试轮换 retryFeedback prompt，history=system+首轮user+上轮assistant；
 * - attempts 用尽 / parse 抛错 / 外部 abort → 一律 null（fail-closed，不抛错）。
 */
import { describe, expect, it } from 'vitest'
import { callLlmForJson, looksJsonTruncated, type LlmAttemptFailure } from '../../main/kernel/llm-call'
import type { SDKQuery, SDKQueryOptions } from '../../main/orchestration/orchestrator'
import type { SDKMessage } from '../../shared/types'

function fakeMsg(text: string): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } } as unknown as SDKMessage
}

/** 按脚本顺序回放响应的 fake query；记录每次调用的 prompt 与 history 供断言。 */
function scriptedQuery(responses: string[]): { query: SDKQuery; calls: Array<{ prompt: string; options: SDKQueryOptions }> } {
  const calls: Array<{ prompt: string; options: SDKQueryOptions }> = []
  const query: SDKQuery = (prompt, options) => {
    calls.push({ prompt, options })
    const text = responses.shift() ?? ''
    return (async function* (): AsyncGenerator<SDKMessage> {
      yield fakeMsg(text)
    })()
  }
  return { query, calls }
}

const BASE = {
  systemPrompt: 'SYS',
  prompt: 'DO-TASK',
  env: {},
  sessionId: 's1',
  maxTokens: 64,
  temperature: 0.1,
}

const parseJson = (text: string): { ok: number } | undefined => {
  try {
    const parsed = JSON.parse(text) as { ok?: number }
    return typeof parsed.ok === 'number' ? { ok: parsed.ok } : undefined
  } catch {
    return undefined
  }
}

describe('callLlmForJson', () => {
  it('首轮解析成功：单次调用直接返回', async () => {
    const { query, calls } = scriptedQuery(['{"ok":1}'])
    const result = await callLlmForJson({ ...BASE, query, parse: parseJson })
    expect(result).toEqual({ ok: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0].prompt).toBe('DO-TASK')
    expect(calls[0].options.maxTokens).toBe(64)
    expect(calls[0].options.temperature).toBe(0.1)
  })

  it('首轮失败：重试轮换 retryFeedback，history 带上轮 assistant 累积', async () => {
    const { query, calls } = scriptedQuery(['not-json', '{"ok":2}'])
    const result = await callLlmForJson({ ...BASE, query, parse: parseJson, retryFeedback: 'RETRY-FEEDBACK' })
    expect(result).toEqual({ ok: 2 })
    expect(calls).toHaveLength(2)
    expect(calls[1].prompt).toBe('RETRY-FEEDBACK')
    const history = calls[1].options.history
    expect(history?.map((turn) => turn.role)).toEqual(['system', 'user', 'assistant'])
    expect(history?.[1]).toMatchObject({ role: 'user', content: 'DO-TASK' })
    expect(history?.[2]).toMatchObject({ role: 'assistant', content: 'not-json' })
  })

  it('attempts 用尽 → null（fail-closed）', async () => {
    const { query, calls } = scriptedQuery(['bad', 'bad'])
    const result = await callLlmForJson({ ...BASE, query, parse: parseJson, attempts: 2 })
    expect(result).toBeNull()
    expect(calls).toHaveLength(2)
  })

  it('artifact regeneration keeps actionable feedback without feeding the failed document back', async () => {
    const { query, calls } = scriptedQuery(['<html>unfinished document', '{"ok":2}'])
    const result = await callLlmForJson({ ...BASE, query, parse: parseJson, retryFeedback: 'Make the document smaller and complete', retryWithFreshContext: true })
    expect(result).toEqual({ ok: 2 })
    expect(calls[1].options.history).toEqual([{ role: 'system', content: 'SYS' }])
    expect(calls[1].prompt).toBe('Make the document smaller and complete')
    expect(calls[1].options.maxTokens).toBe(BASE.maxTokens)
  })

  it('parse 抛错按本轮失败处理，不中断重试链', async () => {
    const { query } = scriptedQuery(['{"ok":1}', '{"ok":3}'])
    let call = 0
    const result = await callLlmForJson({
      ...BASE,
      query,
      parse: (text) => {
        call += 1
        if (call === 1) throw new Error('parse blew up')
        return parseJson(text)
      },
    })
    expect(result).toEqual({ ok: 3 })
  })

  it('外部 abort → null', async () => {
    const controller = new AbortController()
    controller.abort()
    const { query, calls } = scriptedQuery(['{"ok":1}'])
    const result = await callLlmForJson({ ...BASE, query, parse: parseJson, signal: controller.signal })
    expect(result).toBeNull()
    expect(calls[0].options.signal.aborted).toBe(true)
  })

  it('thinkingLevel/providerType 透传到 query options（normalizer 零回归契约）', async () => {
    const { query, calls } = scriptedQuery(['{"ok":1}'])
    await callLlmForJson({ ...BASE, query, parse: parseJson, thinkingLevel: 'high', providerType: 'deepseek' })
    expect(calls[0].options.thinkingLevel).toBe('high')
    expect(calls[0].options.providerType).toBe('deepseek')
  })

  it('缺省不传 thinkingLevel → options 不带有效档位（undefined，与现状一致）', async () => {
    const { query, calls } = scriptedQuery(['{"ok":1}'])
    await callLlmForJson({ ...BASE, query, parse: parseJson })
    expect(calls[0].options.thinkingLevel).toBeUndefined()
    expect(calls[0].options.providerType).toBeUndefined()
  })
})

describe('callLlmForJson — truncationRetry（截断升预算，enricher 模式）', () => {
  const TRUNCATED = '{"ok":1' // JSON 未闭合 → looksJsonTruncated 命中

  it('截断 → 升 maxTokens 全新重生成：history 仅 system、prompt 用首轮原文', async () => {
    const { query, calls } = scriptedQuery([TRUNCATED, '{"ok":9}'])
    const result = await callLlmForJson({ ...BASE, query, parse: parseJson, retryFeedback: 'RETRY', truncationRetry: { cap: 1000 } })
    expect(result).toEqual({ ok: 9 })
    expect(calls).toHaveLength(2)
    // 缺省 factor=2：64 → 128（cap 1000 内）
    expect(calls[1].options.maxTokens).toBe(128)
    // 全新重生成：prompt 不用 retryFeedback，history 不带脏输出
    expect(calls[1].prompt).toBe('DO-TASK')
    expect(calls[1].options.history?.map((turn) => turn.role)).toEqual(['system'])
  })

  it('非截断失败不受 truncationRetry 影响：走带反馈重试（回灌坏输出）', async () => {
    const { query, calls } = scriptedQuery(['not-json', '{"ok":4}'])
    const result = await callLlmForJson({ ...BASE, query, parse: parseJson, retryFeedback: 'RETRY', truncationRetry: { cap: 1000 } })
    expect(result).toEqual({ ok: 4 })
    expect(calls[1].prompt).toBe('RETRY')
    expect(calls[1].options.maxTokens).toBe(64)
    expect(calls[1].options.history?.map((turn) => turn.role)).toEqual(['system', 'user', 'assistant'])
  })

  it('预算触 cap 仍截断 → 升无可升，直接 null（不发起重试）', async () => {
    const { query, calls } = scriptedQuery([TRUNCATED, '{"ok":9}'])
    // 初始 64，factor 2 → 128，但 cap=64 → bumped<=maxTokens → 直接失败
    const result = await callLlmForJson({ ...BASE, query, parse: parseJson, truncationRetry: { cap: 64 } })
    expect(result).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('自定义 factor：截断按 factor 升预算（cap 内）', async () => {
    const { query, calls } = scriptedQuery([TRUNCATED, TRUNCATED, '{"ok":7}'])
    const result = await callLlmForJson({ ...BASE, query, parse: parseJson, attempts: 3, truncationRetry: { cap: 10_000, factor: 4 } })
    expect(result).toEqual({ ok: 7 })
    expect(calls[1].options.maxTokens).toBe(256)
    expect(calls[2].options.maxTokens).toBe(1024)
  })
})

describe('looksJsonTruncated — 截断检测（自 enricher 迁入，行为锁定）', () => {
  it('未闭合 JSON / 字符串未闭合 / 省略号结尾 → true；完整 JSON → false', () => {
    expect(looksJsonTruncated('{"requirements":[{"id":"F-001"')).toBe(true)
    expect(looksJsonTruncated('{"a":"未闭合')).toBe(true)
    expect(looksJsonTruncated('{"a":1, "b":2...')).toBe(true)
    expect(looksJsonTruncated('{"ok":1}')).toBe(false)
    expect(looksJsonTruncated('```json\n{"ok":1}\n```')).toBe(false)
    expect(looksJsonTruncated('no json at all')).toBe(false)
  })
})

describe('尝试失败观测 onAttemptFailure（2026-10-03 e99e6319 事故）', () => {
  it.each(['timeout', 'aborted'] as const)('终止原因独立于供应商错误文字：%s', async termination => {
    const controller = new AbortController()
    const failures: LlmAttemptFailure[] = []
    const query: SDKQuery = async function* (_prompt, options) {
      await new Promise<void>(resolve => {
        options.signal.addEventListener('abort', () => resolve(), { once: true })
        if (termination === 'aborted') controller.abort()
      })
    }
    const result = await callLlmForJson({ ...BASE, query, parse: parseJson, signal: controller.signal,
      timeoutMs: termination === 'timeout' ? 5 : 1000, onAttemptFailure: failure => failures.push(failure) })
    expect(result).toBeNull()
    expect(failures).toHaveLength(1)
    expect(failures[0]?.termination).toBe(termination)
  })
  it('模型零输出 → kind=empty；有输出但解析失败 → kind=unparseable（两轮各报一次）', async () => {
    const { query } = scriptedQuery(['not-json', ''])
    const failures: Array<{ kind: string; detail: string }> = []
    const result = await callLlmForJson({
      ...BASE,
      query,
      attempts: 2,
      parse: parseJson,
      onAttemptFailure: (f) => failures.push({ kind: f.kind, detail: f.detail }),
    })
    expect(result).toBeNull()
    expect(failures.map((f) => f.kind)).toEqual(['unparseable', 'empty'])
  })

  it('query 抛错 → kind=error 带原始 message，整体仍 fail-closed 返回 null', async () => {
    const query: SDKQuery = () => {
      throw new Error('provider API 错误 (400): [1210][max_tokens参数非法]')
    }
    const failures: Array<{ kind: string; detail: string }> = []
    const result = await callLlmForJson({
      ...BASE,
      query,
      attempts: 1,
      parse: parseJson,
      onAttemptFailure: (f) => failures.push({ kind: f.kind, detail: f.detail }),
    })
    expect(result).toBeNull()
    expect(failures).toHaveLength(1)
    expect(failures[0]!.kind).toBe('error')
    expect(failures[0]!.detail).toContain('max_tokens')
  })

  it('成功路径零失败回调', async () => {
    const { query } = scriptedQuery(['{"ok":1}'])
    const failures: Array<{ kind: string; detail?: string }> = []
    const result = await callLlmForJson({
      ...BASE,
      query,
      parse: parseJson,
      onAttemptFailure: (f) => failures.push({ kind: f.kind, detail: f.detail }),
    })
    expect(result).toEqual({ ok: 1 })
    expect(failures).toHaveLength(0)
  })
})
