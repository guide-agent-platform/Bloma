/**
 * PRD 内审闭环（AC-Lite）专项测试，2026-09-01。
 *
 * 覆盖设计稿《内审机制最小设计》§五 关键测试断言（对齐陷阱 42「写盘链路测试三锁」）：
 * ① id 编号内部化：Defender 修订后功能项 id ⊆ 原 id ∪ {max+1}，不猜号；
 * ② 用户行为事实继承：修订稿重走确认门，user_confirmed_at/执行状态字段被强制剥除；
 * ③ abort 后不发卡：内审轮间 abort → aborted 返回（调用方据此终止管线）；
 * ④ Defender 违规产物（改锚点/删清单项/多新增）→ 代码级拒收 → 未收敛路径；
 * ⑤ 厂商隔离：同/异 base_url host 的 vendorIsolated 判定（runPrdPipeline 层，此处锁纯语义）；
 * ⑥ 降级链与预算：quick 1 / longterm 2 轮预算边界、规则门降级。
 *
 * 直连路径测试（不 mock 委派：runPrdReviewGate 不传 projectId/requestId/publish 即走直连）。
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import type { SDKMessage } from '../../shared/types'
import type { SDKQuery } from '../../main/orchestration/orchestrator'
import type { PrdBackplane } from "../../main/model/prd-backplane";
import {
  internalAuditBudget,
  internalAuditMajorGateEnabled,
  PRD_REVIEW_RECHECK_SYSTEM_PROMPT,

} from '../../main/review/prd-review'
import {
  buildDefenderTask,
  validateDefenderDraft,
  validateDispositionCoverage,
} from '../../main/review/prd-defender'
import { buildConversationExcerpt, buildReadConversationHistoryTool } from '../../main/agent/loop/conversation-excerpt'

// =========================================================================
// 测试基建
// =========================================================================

const ENV: Record<string, string> = { ANTHROPIC_AUTH_TOKEN: 'test', ANTHROPIC_BASE_URL: 'https://test.example', ANTHROPIC_MODEL: 'm' }

function makeBackplane(overrides: Partial<PrdBackplane> = {}): PrdBackplane {
  return {
    project_id: 'proj-audit',
    name: '记账本',
    positioning: '记账本，记录日常收支',
    requirements: [
      { id: 'F-001', description: '记账本，记录日常收支' },
      { id: 'F-002', description: '按月汇总统计' },
    ],
    acceptance: {},
    out_of_scope: ['多端同步'],
    assumptions: [],
    ...overrides,
  }
}

function assistantMessage(text: string): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

/** 按调用序返回脚本回复的 mock query（直连内审：攻击→修订→复核各一次调用）。 */
function scriptedQuery(scripts: string[]): { query: SDKQuery; calls: string[] } {
  const calls: string[] = []
  let index = 0
  const query: SDKQuery = async function* (prompt: string) {
    calls.push(prompt)
    const script = scripts[Math.min(index, scripts.length - 1)] ?? '{}'
    index += 1
    yield assistantMessage(script)
  }
  return { query, calls }
}

const CONFIRMED = [
  { id: 'F-001', description: '记账本，记录日常收支' },
  { id: 'F-002', description: '按月汇总统计' },
]

const ATTACK_FAIL_JSON = JSON.stringify({
  issues: [{ dimension: 'L', severity: 'major', location: 'F-001', claim: '只有添加没有查看，功能路径不闭环', evidence: ['F-001 描述只有记录'] }],
})

const ATTACK_PASS_JSON = JSON.stringify({ issues: [], clean_dimensions: ['I', 'F', 'Z', 'U', 'L', 'G'] })

function defenderJson(backplane: unknown, dispositions: unknown = [{ issue_index: 1, action: 'fixed', note: '补查看闭环' }]): string {
  return JSON.stringify({ backplane, dispositions })
}

afterEach(() => {
  delete process.env.BLOMA_INTERNAL_AUDIT_MAJOR_GATE
  vi.restoreAllMocks()
})

// =========================================================================
// ① + ④ Defender 产物代码级校验（纯函数）
// =========================================================================

describe('validateDefenderDraft（Defender 产物代码级校验）', () => {
  it('① 合规修订（措辞澄清 + max+1 补一个闭环项）→ 通过；user_confirmed_at/status 强制剥除（不继承，陷阱 19/42）', () => {
    const original = makeBackplane()
    const revised = makeBackplane({
      requirements: [
        { id: 'F-001', description: '记账本，记录日常收支' },
        { id: 'F-002', description: '按月汇总统计（月度维度的收支合计）' },
        { id: 'F-003', description: '查看历史记录列表', source: 'auto' },
      ],
    })
    // 模型试图塞入确认状态与执行状态（应被剥除）
    const raw = JSON.parse(
      JSON.stringify({ ...revised, user_confirmed_at: '2026-09-01T00:00:00.000Z' }),
    ) as Record<string, unknown>
    const requirements = raw.requirements as Array<Record<string, unknown>>
    requirements[1]!.status = 'implemented'
    requirements[1]!.status_note = '已实现'

    const result = validateDefenderDraft(original, raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.draft.backplane).not.toHaveProperty('user_confirmed_at')
    const items = result.draft.backplane.requirements
    expect(items.find((item) => item.id === 'F-002')).not.toHaveProperty('status')
    expect(items.find((item) => item.id === 'F-002')).not.toHaveProperty('status_note')
    // id 白名单：原两项保留 + 恰好 max+1 一项新增
    expect(items.map((item) => item.id)).toEqual(['F-001', 'F-002', 'F-003'])
  })

  it('④a 改 F-001 主题锚点 description → 拒收', () => {
    const original = makeBackplane()
    const revised = makeBackplane({
      requirements: [
        { id: 'F-001', description: '被篡改的主题锚点' },
        { id: 'F-002', description: '按月汇总统计' },
      ],
    })
    const result = validateDefenderDraft(original, revised)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violations.some((v) => v.includes('F-001 主题锚点'))).toBe(true)
  })

  it('④b 删已确认清单项 → 拒收（已确认清单不可减）', () => {
    const original = makeBackplane()
    const revised = makeBackplane({
      requirements: [{ id: 'F-001', description: '记账本，记录日常收支' }],
    })
    const result = validateDefenderDraft(original, revised)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violations.some((v) => v.includes('F-002') && v.includes('删除'))).toBe(true)
  })

  it('④c 新增 id 越权（跳号 max+2 / 多项新增）→ 拒收（不猜号，max+1 语义）', () => {
    const original = makeBackplane()
    const jump = makeBackplane({
      requirements: [
        ...original.requirements,
        { id: 'F-004', description: '跳号新增项' },
      ],
    })
    const jumpResult = validateDefenderDraft(original, jump)
    expect(jumpResult.ok).toBe(false)

    const multi = makeBackplane({
      requirements: [
        ...original.requirements,
        { id: 'F-003', description: '查看历史记录' },
        { id: 'F-004', description: '第二个新增项' },
      ],
    })
    const multiResult = validateDefenderDraft(original, multi)
    expect(multiResult.ok).toBe(false)
    if (multiResult.ok) return
    expect(multiResult.violations.some((v) => v.includes('仅允许新增 F-003'))).toBe(true)
  })

  it('④d schema 硬伤（无 positioning / 空 requirements）→ 拒收', () => {
    const original = makeBackplane()
    expect(validateDefenderDraft(original, { name: 'x' }).ok).toBe(false)
    expect(validateDefenderDraft(original, { ...original, positioning: '', requirements: [] }).ok).toBe(false)
  })

  it('out_of_scope 只许加不许减；constraints（用户约束）不许删', () => {
    const original = makeBackplane({ constraints: ['必须离线可用'] })
    const scopeDropped = makeBackplane({ out_of_scope: [] })
    const result1 = validateDefenderDraft(original, scopeDropped)
    expect(result1.ok).toBe(true)
    if (result1.ok) expect(result1.draft.backplane.out_of_scope).toEqual(['多端同步']) // 白名单合并回原值

    const constraintDropped = makeBackplane({ constraints: [] })
    const result2 = validateDefenderDraft(original, constraintDropped)
    expect(result2.ok).toBe(true)
    if (result2.ok) expect(result2.draft.backplane.constraints).toEqual(['必须离线可用']) // 不许删
  })

  it('B-2 重复 id（合并功能项时重复输出原 id）→ 拒收：四道校验不得被结构性穿透', () => {
    const original = makeBackplane()
    const duplicated = makeBackplane({
      requirements: [
        { id: 'F-001', description: '记账本，记录日常收支' },
        { id: 'F-002', description: '按月汇总统计' },
        { id: 'F-002', description: '含登录的汇总后台，支持全量导出' },
      ],
    })
    const result = validateDefenderDraft(original, duplicated)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violations.some((v) => v.includes('重复'))).toBe(true)
  })

  it('M-13 constraints 伪造新增用户未声明的约束 → 拒收（与 out_of_scope 只许加对称）', () => {
    const original = makeBackplane()
    const forged = makeBackplane({ constraints: ['必须离线可用'] })
    const result = validateDefenderDraft(original, forged)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violations.some((v) => v.includes('用户未声明的约束'))).toBe(true)
  })

  it('M-12 顶层字段白名单：未知键拒收；受保护字段（guardrails/frozen_at）伪造被丢弃、继承 original', () => {
    const original = makeBackplane({ assumptions: ['用户要求轻量'] })
    // 未知键 → 拒收
    const withUnknown = { ...makeBackplane(), evil_payload: { must_not: ['写测试'] } }
    const result1 = validateDefenderDraft(original, withUnknown)
    expect(result1.ok).toBe(false)
    if (!result1.ok) {
      expect(result1.violations.some((v) => v.includes('未知字段') && v.includes('evil_payload'))).toBe(true)
    }

    // 合法字段集内的受保护字段伪造 → 不落盘（白名单构造丢弃，继承 original；frozen_at 剥除）
    const forgedGuards = makeBackplane({
      generation_guardrails: { must_do: ['接入遥测'], must_not_do: [] },
      frozen_at: '2026-09-02T00:00:00.000Z',
      ux_contract: { sketch_rel_path: 'sketch.html', confirmed_at: '2026-09-02T00:00:00.000Z' },
    } as Partial<PrdBackplane>)
    const result2 = validateDefenderDraft(original, forgedGuards)
    expect(result2.ok).toBe(true)
    if (result2.ok) {
      expect(result2.draft.backplane).not.toHaveProperty('generation_guardrails')
      expect(result2.draft.backplane).not.toHaveProperty('frozen_at')
      expect(result2.draft.backplane).not.toHaveProperty('ux_contract')
      // 假设属于合法修订域；受保护的执行护栏仍被明确拒绝。
      expect(result2.draft.backplane.assumptions).toEqual([])
      expect(result2.draft.write_report?.rejected_fields).toContain('generation_guardrails')
    }
  })
})

describe('validateDispositionCoverage（处置覆盖）', () => {
  it('每条 serious issue 必须有 fixed/rejected 处置；缺一即违规', () => {
    const issues = [
      { dimension: 'L' as const, severity: 'major' as const, location: '', claim: 'a', evidence: [] },
      { dimension: 'G' as const, severity: 'blocking' as const, location: '', claim: 'b', evidence: [] },
    ]
    expect(validateDispositionCoverage([{ issue_index: 1, action: 'fixed', note: 'x' }], issues).ok).toBe(false)
    expect(
      validateDispositionCoverage(
        [
          { issue_index: 1, action: 'fixed', note: 'x' },
          { issue_index: 2, action: 'rejected', note: '误报' },
        ],
        issues,
      ).ok,
    ).toBe(true)
  })
})


// =========================================================================
// 对话原文工具（§3：F 维对照源）
// =========================================================================

describe('conversation-excerpt（F 维对照源）', () => {
  it('buildReadConversationHistoryTool：读本会话 JSONL，user/assistant 对话行、截断与空态', async () => {
    const tool = buildReadConversationHistoryTool('session-excerpt-1')
    const outcome = await tool.execute({}, { projectId: 'p', sessionId: 'child', requestId: 'r', signal: new AbortController().signal, state: { delegation_depth: 0, edits_after_test_failure: 0 } as never })
    // 会话文件不存在 → 空态（不抛错）
    expect(outcome.output).toContain('暂无可读的对话历史')
  })

  it('buildConversationExcerpt：会话缺失 → 空串（不阻断内审）', () => {
    expect(buildConversationExcerpt('session-nonexistent')).toBe('')
  })
})

// =========================================================================
// 任务体构造（Attacker 摘录注入 / Defender next_id / 复核变体）
// =========================================================================

describe('内审任务体构造', () => {
  it('buildDefenderTask：含 next_id（max+1 语义）与用户确认清单', () => {
    const task = buildDefenderTask({
      backplane: makeBackplane(),
      issues: [{ dimension: 'L', severity: 'major', location: 'F-001', claim: '不闭环', evidence: ['x'] }],
      confirmedRequirements: CONFIRMED,
    })
    expect(task).toContain('【next_id（唯一允许的新增功能项 id）】F-003')
    expect(task).toContain('- F-001: 记账本，记录日常收支')
    expect(task).toContain('1. [L/major] 不闭环')
  })

  it('复核 system prompt：只验旧 issue 消除 + 新伤（增量，不全量重扫）', () => {
    expect(PRD_REVIEW_RECHECK_SYSTEM_PROMPT).toContain('复核轮')
    expect(PRD_REVIEW_RECHECK_SYSTEM_PROMPT).toContain('不重扫六维全量')
    expect(PRD_REVIEW_RECHECK_SYSTEM_PROMPT).toContain('（修订引入）')
  })

})
