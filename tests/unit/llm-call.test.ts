/**
 * kernel/llm-call 单测（2026-09-03 R2 标准件）。
 *
 * 验证收敛自 prd-engine 的调用循环语义：
 * - 首轮解析成功 → 单次调用直接返回；
 * - 首轮失败 → 重试轮换 retryFeedback prompt，history=system+首轮user+上轮assistant；
 * - attempts 用尽 / parse 抛错 / 外部 abort → 一律 null（fail-closed，不抛错）。
 */
import { describe, expect, it } from 'vitest'
import { callLlmForJson } from '../../main/kernel/llm-call'
import type { SDKQuery, SDKQueryOptions } from '../../main/orchestrator'
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
})
