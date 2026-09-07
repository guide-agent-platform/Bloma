/**
 * guide/clarification 单测（② 追问通路，2026-09-03）。
 *
 * 覆盖状态机五态的确定性部件：
 * - sanitizeClarificationRequests：for 白名单/非空/长度/去重/上限（K-2 代码侧硬边界）；
 * - 轮次守卫：answered 计数达上限 / timeout 标记存在 → 不再挂起（状态机图④⑤）；
 * - 孤儿检测：requested 无终结 = 孤儿（重启恢复）；answered/timeout 终结 = 非孤儿；
 * - 挂起：发卡 + requested 决策行落盘 + 超时 timer 触发 onTimeout（图⑤）；
 *   take 终结后 timer 不再触发（answered 路径不重复回退）。
 */
import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ENRICHMENT_CLARIFICATION_MAX_ROUNDS,
  ENRICHMENT_CLARIFICATION_TIMEOUT_MS,
  detectOrphanEnrichmentClarification,
  countEnrichmentClarificationRounds,
  hasEnrichmentClarificationTimeout,
  hasPendingEnrichmentClarification,
  makeEnrichmentClarificationCardEvent,
  sanitizeClarificationRequests,
  shouldSuspendForEnrichmentClarification,
  suspendForEnrichmentClarification,
  takePendingEnrichmentClarification,
  type PendingEnrichmentClarification,
} from '../../main/guide/clarification'
import { recordDecision } from '../../main/decision-log'
import { getAgentSessionPath } from '../../storage/config-paths'
import type { AgentEvent } from '../../shared/types'

const originalPromaHome = process.env.PROMA_HOME
let home: string | undefined

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  restorePromaHome(originalPromaHome)
  home = undefined
  vi.useRealTimers()
})

function setup(prefix = 'bloma-clar-'): string {
  home = mkdtempSync(join(tmpdir(), prefix))
  process.env.PROMA_HOME = home
  return home
}

function seedDecision(sessionId: string, type: string, detail?: Record<string, unknown>): void {
  recordDecision({
    project_id: 'proj-clar',
    session_id: sessionId,
    entry: { type: type as never, title: 'seed', why: 'seed', detail },
  })
}

function makePending(sessionId: string, publish: (event: AgentEvent) => void = () => {}): PendingEnrichmentClarification {
  return {
    request_id: 'req-1',
    session_id: sessionId,
    project_id: 'proj-clar',
    mode: 'quick',
    requirements: [{ id: 'F-001', description: '做一个番茄钟' }],
    query: undefined,
    publish,
  }
}

describe('sanitizeClarificationRequests — K-2 代码侧硬边界', () => {
  const frozenIds = new Set(['F-001', 'F-002'])

  it('合法请求保留；for 不在冻结集/空 question/超长 question/无 options 丢弃', () => {
    const cleaned = sanitizeClarificationRequests(
      [
        { for: 'F-001', question: '音色切换用什么交互？', options: [{ id: 'a', label: '下拉列表' }, { id: 'b', label: '按钮组' }] },
        { for: 'F-999', question: '不在清单的功能项', options: [{ id: 'a', label: '选项' }] },
        { for: 'F-002', question: '   ', options: [{ id: 'a', label: '选项' }] },
        { for: 'F-002', question: 'x'.repeat(101), options: [{ id: 'a', label: '选项' }] },
        { for: 'F-001', question: '无选项的问题', options: [] },
        { for: 'F-001', question: '无 options 字段的问题' },
        'not-an-object',
        null,
      ],
      frozenIds,
    )
    expect(cleaned).toEqual([
      { for: 'F-001', question: '音色切换用什么交互？', options: [{ id: 'a', label: '下拉列表' }, { id: 'b', label: '按钮组' }] },
    ])
  })

  it('按 for+question 去重；上限 1 条（一次一道）', () => {
    const cleaned = sanitizeClarificationRequests(
      [
        { for: 'F-001', question: '问题 A', options: [{ id: 'a', label: '选项 A' }] },
        { for: 'F-001', question: '问题 A', options: [{ id: 'b', label: '选项 B' }] },
        { for: 'F-001', question: '问题 B', options: [{ id: 'a', label: '选项 A' }] },
        { for: 'F-002', question: '问题 C', options: [{ id: 'a', label: '选项 A' }] },
      ],
      frozenIds,
    )
    expect(cleaned).toEqual([
      { for: 'F-001', question: '问题 A', options: [{ id: 'a', label: '选项 A' }] },
    ])
  })

  it('非数组输入 → 空数组（fail-closed）', () => {
    expect(sanitizeClarificationRequests(undefined, frozenIds)).toEqual([])
    expect(sanitizeClarificationRequests('nope', frozenIds)).toEqual([])
  })
})

describe('轮次守卫与孤儿检测 — 会话即真相源', () => {
  it('无决策行 → 可挂起；answered 达上限 → 不再挂起（状态机图④）', () => {
    setup()
    expect(shouldSuspendForEnrichmentClarification('s-guard')).toBe(true)
    for (let i = 0; i < ENRICHMENT_CLARIFICATION_MAX_ROUNDS; i += 1) {
      seedDecision('s-guard', 'enrichment_clarification_answered')
    }
    expect(countEnrichmentClarificationRounds('s-guard')).toBe(ENRICHMENT_CLARIFICATION_MAX_ROUNDS)
    expect(shouldSuspendForEnrichmentClarification('s-guard')).toBe(false)
  })

  it('timeout 标记存在 → 永不再挂起（超时回退粘滞，图⑤）', () => {
    setup()
    seedDecision('s-timeout', 'enrichment_clarification_timeout')
    expect(hasEnrichmentClarificationTimeout('s-timeout')).toBe(true)
    expect(shouldSuspendForEnrichmentClarification('s-timeout')).toBe(false)
  })

  it('孤儿检测：requested 无终结 → 返回 requests 原文（重启恢复）', () => {
    setup()
    seedDecision('s-orphan', 'enrichment_clarification_requested', {
      requests: [{ for: 'F-001', question: '问题 A', options: [{ id: 'a', label: '选项 A' }] }],
    })
    expect(detectOrphanEnrichmentClarification('s-orphan')).toEqual([{ for: 'F-001', question: '问题 A', options: [{ id: 'a', label: '选项 A' }] }])
  })

  it('孤儿检测：answered/timeout 终结 → 非孤儿；无关决策行 → undefined', () => {
    setup()
    seedDecision('s-done', 'enrichment_clarification_requested', { requests: [{ for: 'F-001', question: '问题 A', options: [{ id: 'a', label: '选项 A' }] }] })
    seedDecision('s-done', 'enrichment_clarification_answered')
    expect(detectOrphanEnrichmentClarification('s-done')).toBeUndefined()

    seedDecision('s-clean', 'enrichment_stats')
    expect(detectOrphanEnrichmentClarification('s-clean')).toBeUndefined()
    expect(detectOrphanEnrichmentClarification('s-missing')).toBeUndefined()
  })
})

describe('挂起与超时 — 状态机图①②⑤', () => {
  it('挂起：发卡（kind=enrichment_clarification）+ requested 落盘 + hasPending=true', () => {
    setup()
    const events: AgentEvent[] = []
    const pending = makePending('s-suspend', (event) => events.push(event))
    suspendForEnrichmentClarification(pending, [{ for: 'F-001', question: '问题 A', options: [{ id: 'a', label: '选项 A' }] }], () => {})
    expect(hasPendingEnrichmentClarification('proj-clar')).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('user_decision_required')
    expect(events[0].payload).toMatchObject({ kind: 'enrichment_clarification' })
    expect(detectOrphanEnrichmentClarification('s-suspend')).toEqual([{ for: 'F-001', question: '问题 A', options: [{ id: 'a', label: '选项 A' }] }])
    // take 终结（answered 语义）
    const taken = takePendingEnrichmentClarification('proj-clar')
    expect(taken?.session_id).toBe('s-suspend')
    expect(hasPendingEnrichmentClarification('proj-clar')).toBe(false)
  })

  it('超时回退：T 未答 → onTimeout 触发 + pending 清除（图⑤）', () => {
    vi.useFakeTimers()
    setup()
    const onTimeout = vi.fn()
    const pending = makePending('s-timeout-fire', () => {})
    suspendForEnrichmentClarification(pending, [{ for: 'F-001', question: '问题 A', options: [{ id: 'a', label: '选项 A' }] }], onTimeout)
    vi.advanceTimersByTime(ENRICHMENT_CLARIFICATION_TIMEOUT_MS - 1)
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(hasPendingEnrichmentClarification('proj-clar')).toBe(false)
  })

  it('answered（take）后超时 timer 不再触发（防重复回退）', () => {
    vi.useFakeTimers()
    setup()
    const onTimeout = vi.fn()
    suspendForEnrichmentClarification(makePending('s-take-first', () => {}), [{ for: 'F-001', question: '问题 A', options: [{ id: 'a', label: '选项 A' }] }], onTimeout)
    takePendingEnrichmentClarification('proj-clar')
    vi.advanceTimersByTime(ENRICHMENT_CLARIFICATION_TIMEOUT_MS * 2)
    expect(onTimeout).not.toHaveBeenCalled()
  })
})

describe('makeEnrichmentClarificationCardEvent — 卡片事件契约', () => {
  it('payload 携带 kind/title/requests，事件四要素齐全', () => {
    const event = makeEnrichmentClarificationCardEvent(
      { session_id: 's-card', project_id: 'p-card' },
      [{ for: 'F-001', question: '问题 A', options: [{ id: 'a', label: '选项 A' }] }],
    )
    expect(event.type).toBe('user_decision_required')
    expect(event.session_id).toBe('s-card')
    expect(event.project_id).toBe('p-card')
    expect(event.event_id).toBeTruthy()
    expect(event.created_at).toBeTruthy()
    expect(event.payload).toEqual({
      kind: 'enrichment_clarification',
      title: '整理 PRD 前，先确认几个关键点',
      requests: [{ for: 'F-001', question: '问题 A', options: [{ id: 'a', label: '选项 A' }] }],
    })
  })
})
