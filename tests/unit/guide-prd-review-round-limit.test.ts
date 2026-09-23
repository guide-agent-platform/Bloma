import { restorePromaHome } from '../support/proma-home-guard'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../main/coding/programming-orchestrator', () => ({
  runSketchTask: vi.fn().mockResolvedValue({ preview_url: 'http://localhost', snapshot: {}, summary: 'ok' }),
  setProgrammingEventPublisher: vi.fn(),
}))
vi.mock('../../main/platform-services', () => ({
  trackAnalytics: vi.fn(),
}))
vi.mock('../../main/guide/guide-research', () => ({
  normalizeResearchQuery: (q: string) => q,
  researchMarketSimilar: vi.fn(async () => ({ available: false, queries: [], results: [], summary: '' })),
}))
vi.mock('../../main/project-service', () => ({
  findProject: vi.fn(() => ({
    project_id: 'proj-1',
    workspace_slug: 'default-software-builder',
    name: '未命名项目',
    mode: 'quick',
    template_type: 'web_fullstack',
    status: 'active',
    current_stage: 'clarifying',
    root_path: '/tmp/proj-1',
  })),
  updateProject: vi.fn(),
}))
vi.mock('../../main/session-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/session-service')>()
  return { ...actual, readPrimaryIntent: vi.fn((): string | undefined => undefined) }
})
vi.mock('../../main/decision-log', () => ({
  recordDecision: vi.fn(),
  parseDecisionText: (text: string) => {
    // 真实 parseDecisionText 依赖读盘导出，测试内联同构实现（供轮次计数扫描）
    const match = /^\[decision\] (\{.*\})$/.exec(text.trim())
    if (!match) return undefined
    try {
      const parsed = JSON.parse(match[1]) as { type?: string; title?: string; why?: string; detail?: unknown }
      if (typeof parsed.title === 'string' && typeof parsed.why === 'string') {
        return { type: parsed.type, title: parsed.title, why: parsed.why, detail: parsed.detail }
      }
    } catch {
      // 损坏行
    }
    return undefined
  },
}))

import { countTrailingPrdReviewRounds } from '../../main/guide/guide-agent-service'

/**
 * 审查确认轮次熔断（2026-08-30 用户拍板「确认环节最多两轮」）：
 * 裁判连续出示 N 轮逐题选择题仍不过 → 不再逐条追问，直接转 PRD 确认门过目。
 * 计数 = 会话 JSONL 尾部连续的 prd_review 发卡决策数；prd_review_answered（作答）
 * 透明不计数不断；prd_review_overridden / prd_confirm 为终止类（审查确认环节结束）。
 */

const SESSION_ID = 'sess-review-round'

describe('countTrailingPrdReviewRounds 连续审查确认轮计数', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'proma-review-round-'))
    process.env.PROMA_HOME = home
    mkdirSync(join(home, 'agent-sessions'), { recursive: true })
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 })
  const decision = (type: string) => ({
    role: 'system',
    content: [{ type: 'text', text: `[decision] {"type":"${type}","title":"t","why":"w"}` }],
    timestamp: 2,
  })

  function writeSession(lines: unknown[]): void {
    writeFileSync(
      join(home, 'agent-sessions', `${SESSION_ID}.jsonl`),
      lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
      'utf8',
    )
  }

  it('新会话/无审查决策 → 0', () => {
    writeSession([user('做个记账的'), decision('requirement_confirmed')])
    expect(countTrailingPrdReviewRounds(SESSION_ID)).toBe(0)
  })

  it('单轮发卡 → 1（不熔断）', () => {
    writeSession([user('做个记账的'), decision('prd_review'), decision('prd_review_answered')])
    expect(countTrailingPrdReviewRounds(SESSION_ID)).toBe(1)
  })

  it('两轮发卡（answered 透明不计数）→ 2（已达熔断阈值）', () => {
    writeSession([
      user('做个记账的'),
      decision('prd_review'),
      decision('prd_review_answered'),
      decision('prd_review'),
      decision('prd_review_answered'),
    ])
    expect(countTrailingPrdReviewRounds(SESSION_ID)).toBe(2)
  })

  it('三轮发卡 → 计数封顶 2（阈值即返回）', () => {
    writeSession([
      user('做个记账的'),
      decision('prd_review'),
      decision('prd_review_answered'),
      decision('prd_review'),
      decision('prd_review_answered'),
      decision('prd_review'),
    ])
    expect(countTrailingPrdReviewRounds(SESSION_ID)).toBe(2)
  })

  it('遇 prd_confirm（进入确认门）→ 断，其后发卡重新从 0 起', () => {
    writeSession([
      user('做个记账的'),
      decision('prd_review'),
      decision('prd_review_overridden'), // 全忽略 → 转确认门
      decision('prd_confirm'),
      // 之后新一轮（如调整重走）再发卡
      decision('prd_review'),
    ])
    expect(countTrailingPrdReviewRounds(SESSION_ID)).toBe(1)
  })

  it('会话文件不存在 → 0（新会话/测试字面 id 不炸）', () => {
    expect(countTrailingPrdReviewRounds('no-such-session')).toBe(0)
  })
})
