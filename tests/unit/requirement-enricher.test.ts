import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  enrichRequirementsLlm,
  guardBehaviorAssertions,
  mergeEnrichment,
  extractUserTexts,
  type EnrichedSketchRequirement,
} from '../../main/guide/requirement-enricher'
import { DEFAULT_BEHAVIOR_ASSERTION, type SketchRequirement } from '../../main/coding/sketch-engine'
import { getAgentSessionPath } from '../../storage/config-paths'
import { appendJsonLine } from '../../storage/json-store'
import type { SDKMessage } from '../../shared/types'
import type { SDKQuery, SDKQueryOptions } from '../../main/orchestration/orchestrator'

/**
 * 功能项加厚（2026-08-18 设计 §5 测试计划）单元测试。
 *
 * 覆盖：enrichRequirementsLlm 成功/失败/重试/截断恢复/预算扩容/渠道硬限/abort；
 * guardBehaviorAssertions ①格式守卫 + ②接地守卫；mergeEnrichment 只填缺省字段、
 * 权威 id 集、优先级规则③、全灭保留薄形态、迁移重判、内部异常回退合并底。
 */

const originalPromaHome = process.env.PROMA_HOME
let home: string | undefined

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  restorePromaHome(originalPromaHome)
  home = undefined
})

function setup(prefix = 'bloma-enrich-'): void {
  home = mkdtempSync(join(tmpdir(), prefix))
  process.env.PROMA_HOME = home
}

function seedSession(sessionId: string, userText: string): void {
  appendJsonLine(getAgentSessionPath(sessionId), {
    role: 'user',
    content: [{ type: 'text', text: userText }],
    timestamp: Date.now(),
  })
}

function queryReturning(text: string): SDKQuery {
  return async function* (): AsyncGenerator<SDKMessage> {
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
    yield { type: 'result', subtype: 'success' }
  }
}

interface RecordedCall {
  prompt: string
  options: SDKQueryOptions
}

/** 逐次返回预设输出，并记录每次调用的 prompt/options（history/maxTokens 断言用）。 */
function recordingQuery(outputs: string[]): { query: SDKQuery; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  let i = 0
  const query: SDKQuery = async function* (prompt, options): AsyncGenerator<SDKMessage> {
    calls.push({ prompt, options })
    const text = outputs[Math.min(i, outputs.length - 1)]
    i += 1
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
    yield { type: 'result', subtype: 'success' }
  }
  return { query, calls }
}

describe('guardBehaviorAssertions — ①格式守卫 + ②接地守卫', () => {
  it('①格式守卫：presenceFallback（人工验收/无法解析）断言丢弃，存活断言保留', () => {
    const guard = guardBehaviorAssertions(
      [
        { assertion: '用户手动测试功能正常', source: '要能正常使用' },
        { assertion: '能正常工作', source: '要能正常工作' },
        { assertion: '点击保存按钮→列表新增一条记录', source: '要能记收入和支出' },
      ],
      ['要能正常使用', '要能记收入和支出'],
      '展示本月结余',
    )
    expect(guard.formatDropped).toBe(2)
    expect(guard.groundingDropped).toBe(0)
    expect(guard.survived).toEqual(['点击保存按钮→列表新增一条记录'])
  })

  it('②接地守卫：source 未命中 user 轮次/该项 description → 丢弃', () => {
    const guard = guardBehaviorAssertions(
      [{ assertion: '点击保存按钮→列表新增一条记录', source: '保存按钮样式要好看' }],
      ['我想做一个家庭记账本'],
      '展示本月结余',
    )
    expect(guard.groundingDropped).toBe(1)
    expect(guard.survived).toEqual([])
  })

  it('②接地守卫：source 长度 <4 → 丢弃（即使出现在对话里）', () => {
    const guard = guardBehaviorAssertions(
      [{ assertion: '点击保存按钮→列表新增一条记录', source: '保存' }],
      ['要能保存记录'],
      '展示本月结余',
    )
    expect(guard.groundingDropped).toBe(1)
    expect(guard.survived).toEqual([])
  })

  it('②接地守卫：source 逐字命中 description（无 user 轮次）→ 存活', () => {
    const guard = guardBehaviorAssertions(
      [{ assertion: '点击保存按钮→列表新增一条记录', source: '能记录收入和支出' }],
      [],
      '能记录收入和支出，月底看结余',
    )
    expect(guard.groundingDropped).toBe(0)
    expect(guard.survived).toEqual(['点击保存按钮→列表新增一条记录'])
  })

  it('②接地守卫：source 只在助手轮次出现 → 丢弃（userTexts 仅含 user 轮次）', () => {
    const guard = guardBehaviorAssertions(
      [{ assertion: '点击保存按钮→列表新增一条记录', source: '我帮你整理成家庭记账本' }],
      ['我想要一个家庭记账本'],
      '做一个家庭记账本',
    )
    expect(guard.groundingDropped).toBe(1)
    expect(guard.survived).toEqual([])
  })
})

describe('mergeEnrichment — 只填缺省字段、权威 id 集、合并底', () => {
  it('成功路径：薄项加厚（story/断言/优先级齐全），description 未变', () => {
    const frozen = [{ id: 'F-001', description: '做一个家庭记账本' }]
    const enriched: EnrichedSketchRequirement[] = [
      {
        id: 'F-001',
        story: '作为用户，我想记录收支，以便月底看结余',
        behavior_assertions: [{ assertion: '点击保存按钮→列表新增一条记录', source: '要能记收入和支出' }],
        priority: 'P0',
      },
    ]
    const { requirements, stats } = mergeEnrichment(frozen, enriched, [], ['我要能记收入和支出'])
    expect(requirements[0].description).toBe('做一个家庭记账本')
    expect(requirements[0].story).toBe('作为用户，我想记录收支，以便月底看结余')
    expect(requirements[0].behavior_assertions).toEqual(['点击保存按钮→列表新增一条记录'])
    expect(requirements[0].priority).toBe('P0')
    expect(stats).toEqual({ formatDropped: 0, groundingDropped: 0, prioritySuppressed: 0 })
  })

  it('修订不被盘上旧值回滚（全链路审查 P1-5，2026-10-01）：冻结清单已带用户亲答的修订厚字段，旧 prd.json 同 id 字段不得覆盖', () => {
    // 场景：用户在审查卡/追问/确认卡里 revise 过 F-003（applyNormalization 写入冻结清单），
    // 盘上 prd.json 还是上一轮旧值——旧方向 existing 无条件覆盖，用户修订落盘即回滚。
    const frozen: SketchRequirement[] = [
      {
        id: 'F-003',
        description: '关掉后还在',
        story: '用户确认后的新故事',
        behavior_assertions: ['关闭窗口→数据仍在'],
        priority: 'P0',
      },
    ]
    const existing: SketchRequirement[] = [
      {
        id: 'F-003',
        description: '临时保存',
        story: '旧故事',
        behavior_assertions: ['点击保存→提示成功'],
        priority: 'P2',
      },
    ]
    // LLM 失败路径（enriched=null）与空加厚路径都必须保住冻结清单的修订
    const fallback = mergeEnrichment(frozen, null, existing)
    expect(fallback.requirements[0].story).toBe('用户确认后的新故事')
    expect(fallback.requirements[0].behavior_assertions).toEqual(['关闭窗口→数据仍在'])
    expect(fallback.requirements[0].priority).toBe('P0')
    const enrichedEmpty = mergeEnrichment(frozen, [], existing)
    expect(enrichedEmpty.requirements[0].story).toBe('用户确认后的新故事')
    expect(enrichedEmpty.requirements[0].priority).toBe('P0')
    // 冻结清单薄字段（F-004 无 story）仍由盘上旧值补齐（方向反转不破坏补缺省语义）
    const thin = mergeEnrichment(
      [...frozen, { id: 'F-004', description: '新功能项' }],
      null,
      [...existing, { id: 'F-004', description: '新功能项', story: '盘上旧故事' }],
    )
    expect(thin.requirements[1].story).toBe('盘上旧故事')
  })

  it('既有字段保留：已有 story/断言/priority 不被 LLM 改写（只填缺省）', () => {
    const frozen = [{ id: 'F-002', description: '展示本月结余' }]
    const existing: SketchRequirement[] = [
      {
        id: 'F-002',
        description: '展示本月结余',
        story: '已有故事',
        behavior_assertions: ['点击刷新按钮→结余数字变化'],
        priority: 'P1',
      },
    ]
    const enriched: EnrichedSketchRequirement[] = [
      {
        id: 'F-002',
        story: 'LLM 新故事',
        behavior_assertions: [{ assertion: '点击其他→列表新增一条记录', source: '其他' }],
        priority: 'P0',
      },
    ]
    const { requirements, stats } = mergeEnrichment(frozen, enriched, existing, ['要能刷新'])
    expect(requirements[0].story).toBe('已有故事')
    expect(requirements[0].behavior_assertions).toEqual(['点击刷新按钮→结余数字变化'])
    expect(requirements[0].priority).toBe('P1')
    // 既有断言存在 → 不加厚断言 → 无守卫丢弃/抑制
    expect(stats).toEqual({ formatDropped: 0, groundingDropped: 0, prioritySuppressed: 0 })
  })

  it('合并底：enriched 为 null（失败路径）→ 返回冻结+既有字段，不抛错', () => {
    const frozen = [{ id: 'F-001', description: '做一个家庭记账本' }]
    const existing: SketchRequirement[] = [
      {
        id: 'F-001',
        description: '做一个家庭记账本',
        story: '既有故事',
        behavior_assertions: ['点击保存按钮→列表新增一条记录'],
        priority: 'P1',
      },
    ]
    const { requirements, stats } = mergeEnrichment(frozen, null, existing, [])
    expect(requirements[0].story).toBe('既有故事')
    expect(requirements[0].behavior_assertions).toEqual(['点击保存按钮→列表新增一条记录'])
    expect(requirements[0].priority).toBe('P1')
    expect(stats).toEqual({ formatDropped: 0, groundingDropped: 0, prioritySuppressed: 0 })
  })

  it('合并底：mergeEnrichment 内部异常 → 回退合并底清单（不向外抛）', () => {
    const frozen = [{ id: 'F-001', description: '做一个家庭记账本' }]
    // 断言为数字 → guardBehaviorAssertions 内 parseBehaviorAssertion 对非 string .trim() 抛 TypeError
    const enriched = [
      { id: 'F-001', story: '将被回退', behavior_assertions: [{ assertion: 42 as unknown as string, source: 'x' }] },
    ]
    const { requirements } = mergeEnrichment(frozen, enriched, [], ['x'])
    expect(requirements[0].story).toBeUndefined()
    expect(requirements[0].behavior_assertions).toBeUndefined()
    expect(requirements[0].description).toBe('做一个家庭记账本')
  })

  it('id/数量不对应：以冻结清单为权威 id 集（enriched 多出的 id 丢弃、缺失的保持薄）', () => {
    const frozen = [
      { id: 'F-001', description: '做一个家庭记账本' },
      { id: 'F-002', description: '展示本月结余' },
    ]
    const enriched: EnrichedSketchRequirement[] = [
      {
        id: 'F-001',
        story: 'S1',
        behavior_assertions: [{ assertion: '点击保存按钮→列表新增一条记录', source: '要能记收入和支出' }],
        priority: 'P0',
      },
      { id: 'F-999', story: '幽灵项', behavior_assertions: [{ assertion: '点击其他→列表新增', source: '其他' }] },
    ]
    const { requirements } = mergeEnrichment(frozen, enriched, [], ['我要能记收入和支出'])
    expect(requirements.map((r) => r.id)).toEqual(['F-001', 'F-002'])
    expect(requirements[0].story).toBe('S1')
    expect(requirements[0].behavior_assertions).toEqual(['点击保存按钮→列表新增一条记录'])
    // F-002 无加厚结果：保持薄形态（无 story/断言，非 F-001 不补 priority）
    expect(requirements[1].story).toBeUndefined()
    expect(requirements[1].behavior_assertions).toBeUndefined()
    expect(requirements[1].priority).toBeUndefined()
  })

  it('非 F-001：LLM 标 P0 但断言全灭 → 抑制写入（薄形态，prioritySuppressed+1）', () => {
    const frozen = [{ id: 'F-002', description: '展示本月结余' }]
    const enriched: EnrichedSketchRequirement[] = [
      { id: 'F-002', priority: 'P0', behavior_assertions: [{ assertion: '用户手动测试功能正常', source: '要能正常' }] },
    ]
    const { requirements, stats } = mergeEnrichment(frozen, enriched, [], ['要能正常'])
    expect(requirements[0].priority).toBeUndefined()
    expect(requirements[0].behavior_assertions).toBeUndefined()
    expect(requirements[0].description).toBe('展示本月结余')
    expect(stats.prioritySuppressed).toBe(1)
    expect(stats.formatDropped).toBe(1)
  })

  it('非 F-001：断言存活 + LLM 标 P0 → P0 写入（降级不粘滞、可自愈）', () => {
    const frozen = [{ id: 'F-002', description: '展示本月结余' }]
    const enriched: EnrichedSketchRequirement[] = [
      { id: 'F-002', priority: 'P0', behavior_assertions: [{ assertion: '点击刷新按钮→结余数字变化', source: '要看结余数字' }] },
    ]
    const { requirements, stats } = mergeEnrichment(frozen, enriched, [], ['要看结余数字'])
    expect(requirements[0].priority).toBe('P0')
    expect(requirements[0].behavior_assertions).toEqual(['点击刷新按钮→结余数字变化'])
    expect(stats.prioritySuppressed).toBe(0)
  })

  it('F-001 已存在非 P0 priority 保留用户值不被覆盖（冲突分支）', () => {
    const frozen = [{ id: 'F-001', description: '做一个家庭记账本' }]
    const existing: SketchRequirement[] = [{ id: 'F-001', description: '做一个家庭记账本', priority: 'P1' }]
    const enriched: EnrichedSketchRequirement[] = [
      { id: 'F-001', priority: 'P0', behavior_assertions: [{ assertion: '点击保存按钮→列表新增一条记录', source: '要能记收入和支出' }] },
    ]
    const { requirements } = mergeEnrichment(frozen, enriched, existing, ['我要能记收入和支出'])
    expect(requirements[0].priority).toBe('P1')
    expect(requirements[0].behavior_assertions).toEqual(['点击保存按钮→列表新增一条记录'])
  })

  it('已有有效 priority 保留（LLM 标的不同值不覆盖）', () => {
    const frozen = [{ id: 'F-002', description: '展示本月结余' }]
    const existing: SketchRequirement[] = [{ id: 'F-002', description: '展示本月结余', priority: 'P2' }]
    const enriched: EnrichedSketchRequirement[] = [
      { id: 'F-002', priority: 'P0', behavior_assertions: [{ assertion: '点击刷新按钮→结余数字变化', source: '要看结余数字' }] },
    ]
    const { requirements } = mergeEnrichment(frozen, enriched, existing, ['要看结余数字'])
    expect(requirements[0].priority).toBe('P2')
  })

  it('非 F-001：无 LLM priority → 不写入（读取侧缺省 P2）', () => {
    const frozen = [{ id: 'F-002', description: '展示本月结余' }]
    const enriched: EnrichedSketchRequirement[] = [{ id: 'F-002', story: 'S2' }]
    const { requirements } = mergeEnrichment(frozen, enriched, [], [])
    expect(requirements[0].priority).toBeUndefined()
  })
})

describe('mergeEnrichment — 全灭保留薄形态 / 迁移重判', () => {
  it('断言全灭 → 不写入 behavior_assertions（保留薄形态，重跑仍可再加厚）', () => {
    const frozen = [{ id: 'F-002', description: '展示本月结余' }]
    const enriched: EnrichedSketchRequirement[] = [
      { id: 'F-002', priority: 'P1', behavior_assertions: [{ assertion: '用户手动测试功能正常', source: '要能正常' }] },
    ]
    const first = mergeEnrichment(frozen, enriched, [], ['要能正常'])
    // 薄形态 + P1（非 P0 不受抑制规则影响）→ 保留薄形态但写入 P1
    expect(first.requirements[0]).toEqual({ id: 'F-002', description: '展示本月结余', priority: 'P1' })
    expect(first.requirements[0].behavior_assertions).toBeUndefined()
    // 重跑可再加厚（同输入 → 同输出）
    const again = mergeEnrichment(frozen, enriched, [], ['要能正常'])
    expect(again.requirements).toEqual(first.requirements)
  })

  it('迁移重判：仅含默认存在性断言的既有项按「缺」处理，加厚并入', () => {
    const frozen = [{ id: 'F-001', description: '做一个家庭记账本' }]
    const existing = [{ id: 'F-001', description: '做一个家庭记账本', behavior_assertions: [DEFAULT_BEHAVIOR_ASSERTION] }]
    const enriched: EnrichedSketchRequirement[] = [
      { id: 'F-001', priority: 'P0', behavior_assertions: [{ assertion: '点击保存按钮→列表新增一条记录', source: '要能记收入和支出' }] },
    ]
    const { requirements } = mergeEnrichment(frozen, enriched, existing, ['我要能记收入和支出'])
    expect(requirements[0].behavior_assertions).toEqual(['点击保存按钮→列表新增一条记录'])
    expect(requirements[0].priority).toBe('P0')
  })
})

describe('enrichRequirementsLlm — LLM 提取', () => {
  it('成功路径：薄清单 + mock 对话 → 加厚清单（story/断言/优先级齐全，source 保留到合并层）', async () => {
    setup()
    seedSession('enr-session', '我想做一个家庭记账本，能记收入和支出，月底看结余')
    const valid = JSON.stringify({
      requirements: [
        {
          id: 'F-001',
          story: '作为用户，我想记录收支，以便月底看结余',
          behavior_assertions: [{ assertion: '点击保存按钮→列表新增一条记录', source: '能记收入和支出' }],
          priority: 'P0',
        },
      ],
    })
    const result = await enrichRequirementsLlm({
      session_id: 'enr-session',
      requirements: [{ id: 'F-001', description: '做一个家庭记账本' }],
      query: queryReturning(valid),
      env: { PATH: 'x' },
      maxTokens: 4096,
    })
    expect(result).not.toBeNull()
    expect(result![0]).toEqual({
      id: 'F-001',
      story: '作为用户，我想记录收支，以便月底看结余',
      behavior_assertions: [{ assertion: '点击保存按钮→列表新增一条记录', source: '能记收入和支出' }],
      priority: 'P0',
    })
  })

  it('无对话历史 → null（不调用 query）', async () => {
    setup()
    let called = false
    const query: SDKQuery = async function* (): AsyncGenerator<SDKMessage> {
      called = true
      yield { type: 'result', subtype: 'success' }
    }
    const result = await enrichRequirementsLlm({
      session_id: 'enr-none',
      requirements: [{ id: 'F-001', description: '做一个家庭记账本' }],
      query,
      env: { PATH: 'x' },
    })
    expect(result).toBeNull()
    expect(called).toBe(false)
  })

  it('无 query → null', async () => {
    setup()
    seedSession('enr-nq', '做一个家庭记账本')
    const result = await enrichRequirementsLlm({
      session_id: 'enr-nq',
      requirements: [{ id: 'F-001', description: '做一个家庭记账本' }],
      query: undefined as unknown as SDKQuery,
      env: { PATH: 'x' },
    })
    expect(result).toBeNull()
  })

  it('无 env → null', async () => {
    setup()
    seedSession('enr-ne', '做一个家庭记账本')
    const result = await enrichRequirementsLlm({
      session_id: 'enr-ne',
      requirements: [{ id: 'F-001', description: '做一个家庭记账本' }],
      query: queryReturning('{}'),
      env: undefined as unknown as Record<string, string>,
    })
    expect(result).toBeNull()
  })

  it('非 JSON → 预算耗尽 null（两次生成尝试，不重试第三次）', async () => {
    setup()
    seedSession('enr-bad', '做一个家庭记账本')
    const { query, calls } = recordingQuery(['not json at all', 'still not json'])
    const result = await enrichRequirementsLlm({
      session_id: 'enr-bad',
      requirements: [{ id: 'F-001', description: '做一个家庭记账本' }],
      query,
      env: { PATH: 'x' },
      maxTokens: 7000,
    })
    expect(result).toBeNull()
    expect(calls.length).toBe(2)
  })

  it('解析失败 → 带坏输出回灌重试（第二次用 feedback prompt，history 含 assistant 坏输出）', async () => {
    setup()
    seedSession('enr-retry', '我想做一个家庭记账本，要能记收入和支出')
    const valid = JSON.stringify({
      requirements: [
        { id: 'F-001', story: 'S1', behavior_assertions: [{ assertion: '点击保存按钮→列表新增一条记录', source: '要能记收入和支出' }], priority: 'P0' },
      ],
    })
    const { query, calls } = recordingQuery(['not json at all', valid])
    const result = await enrichRequirementsLlm({
      session_id: 'enr-retry',
      requirements: [{ id: 'F-001', description: '做一个家庭记账本' }],
      query,
      env: { PATH: 'x' },
      maxTokens: 7000,
    })
    expect(result).not.toBeNull()
    expect(calls.length).toBe(2)
    // 格式错误恢复：feedback prompt + 原完整 prompt（user）+ 坏输出（assistant）回灌
    expect(calls[1].prompt).toContain('无法被解析为有效 JSON')
    expect(calls[1].options.history?.length).toBe(3)
    expect(calls[1].options.history?.[1]).toEqual({ role: 'user', content: calls[0].prompt })
    expect(calls[1].options.history?.[2]).toEqual({ role: 'assistant', content: 'not json at all' })
  })

  it('截断 → 预算内升 maxTokens 重试成功（全新重生成，history 不加脏输出）', async () => {
    setup()
    seedSession('enr-trunc', '我想做一个家庭记账本，要能记收入和支出')
    const truncated = '{"requirements":[{"id":"F-001","story":"作为用户，我想记录收支'
    const valid = JSON.stringify({
      requirements: [
        { id: 'F-001', story: '作为用户，我想记录收支', behavior_assertions: [{ assertion: '点击保存按钮→列表新增一条记录', source: '要能记收入和支出' }], priority: 'P0' },
      ],
    })
    const { query, calls } = recordingQuery([truncated, valid])
    const result = await enrichRequirementsLlm({
      session_id: 'enr-trunc',
      requirements: [{ id: 'F-001', description: '做一个家庭记账本' }],
      query,
      env: { PATH: 'x' },
      maxTokens: 10000,
    })
    expect(result).not.toBeNull()
    expect(calls.length).toBe(2)
    // 1 项预算 = min(10000, 4096+600) = 4696；截断 → 升到 min(9392, 10000) = 9392
    expect(calls[0].options.maxTokens).toBe(4696)
    expect(calls[1].options.maxTokens).toBe(9392)
    // 截断走全新重生成：history 仅 system，不加脏输出
    expect(calls[1].options.history?.length).toBe(1)
  })

  it('组合失败反向：首轮解析失败 → 带反馈重试，重试轮截断 → 预算耗尽 null', async () => {
    setup()
    seedSession('enr-rcomb', '做一个家庭记账本')
    const { query, calls } = recordingQuery(['not json at all', '{"requirements":[{"id":"F-001","story":"未完'])
    const result = await enrichRequirementsLlm({
      session_id: 'enr-rcomb',
      requirements: [{ id: 'F-001', description: '做一个家庭记账本' }],
      query,
      env: { PATH: 'x' },
      maxTokens: 10000,
    })
    expect(result).toBeNull()
    expect(calls.length).toBe(2)
    // 首轮解析失败 → feedback prompt；重试轮截断 → 共享总预算（2 次）耗尽，无第三次
    expect(calls[1].prompt).toContain('无法被解析为有效 JSON')
  })

  it('非法 priority（P3/空串/其他）→ 解析层视为缺省丢弃', async () => {
    setup()
    seedSession('enr-invpri', '做一个家庭记账本')
    const valid = JSON.stringify({
      requirements: [
        { id: 'F-001', story: 'S1', behavior_assertions: [{ assertion: '点击保存按钮→列表新增一条记录', source: '能记收入和支出' }], priority: 'P3' },
      ],
    })
    const result = await enrichRequirementsLlm({
      session_id: 'enr-invpri',
      requirements: [{ id: 'F-001', description: '做一个家庭记账本' }],
      query: queryReturning(valid),
      env: { PATH: 'x' },
      maxTokens: 4096,
    })
    expect(result).not.toBeNull()
    expect(result![0].priority).toBeUndefined()
    expect(result![0].story).toBe('S1')
  })

  it('截断后重试又失败 → null（预算耗尽，不重试第三次）', async () => {
    setup()
    seedSession('enr-ccomb', '做一个家庭记账本')
    const truncated = '{"requirements":[{"id":"F-001","story":"未完'
    const { query, calls } = recordingQuery([truncated, 'not json at all'])
    const result = await enrichRequirementsLlm({
      session_id: 'enr-ccomb',
      requirements: [{ id: 'F-001', description: '做一个家庭记账本' }],
      query,
      env: { PATH: 'x' },
      maxTokens: 10000,
    })
    expect(result).toBeNull()
    expect(calls.length).toBe(2)
    // 截断重试走原 prompt（非 feedback），history 仅 system
    expect(calls[1].options.history?.length).toBe(1)
    expect(calls[1].options.maxTokens).toBe(9392)
  })

  it('渠道硬限：预算触上限仍截断 → 升 maxTokens 不可行 → null（不重试）', async () => {
    setup()
    seedSession('enr-cap', '做一个家庭记账本')
    const truncated = '{"requirements":[{"id":"F-001","story":"未完'
    const { query, calls } = recordingQuery([truncated])
    const result = await enrichRequirementsLlm({
      session_id: 'enr-cap',
      requirements: [{ id: 'F-001', description: '做一个家庭记账本' }],
      query,
      env: { PATH: 'x' },
      maxTokens: 4096,
    })
    expect(result).toBeNull()
    expect(calls.length).toBe(1)
    expect(calls[0].options.maxTokens).toBe(4096)
  })

  it('预算 = min(渠道上限, 4096 + 项数×600) 线性扩容', async () => {
    setup()
    seedSession('enr-budget', '做一个家庭记账本')
    const valid = JSON.stringify({ requirements: [{ id: 'F-001', story: 'S1' }] })
    let seen: SDKQueryOptions[] = []
    const query: SDKQuery = async function* (_prompt, options): AsyncGenerator<SDKMessage> {
      seen.push(options)
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: valid }] } }
      yield { type: 'result', subtype: 'success' }
    }
    const five = Array.from({ length: 5 }, (_, i) => ({ id: `F-00${i + 1}`, description: `项 ${i + 1}` }))
    // 5 项：min(7000, 4096+3000) = 7000
    await enrichRequirementsLlm({ session_id: 'enr-budget', requirements: five, query, env: { PATH: 'x' }, maxTokens: 7000 })
    expect(seen[0].maxTokens).toBe(7000)
    seen = []
    // 1 项：min(7000, 4096+600) = 4696
    await enrichRequirementsLlm({ session_id: 'enr-budget', requirements: [{ id: 'F-001', description: '做一个家庭记账本' }], query, env: { PATH: 'x' }, maxTokens: 7000 })
    expect(seen[0].maxTokens).toBe(4696)
    seen = []
    // 缺省（未传 maxTokens）→ 渠道上限 640000，预算 = min(640000, 4096+600) = 4696
    await enrichRequirementsLlm({ session_id: 'enr-budget', requirements: [{ id: 'F-001', description: '做一个家庭记账本' }], query, env: { PATH: 'x' } })
    expect(seen[0].maxTokens).toBe(4696)
  })

  it('signal 已 abort → null', async () => {
    setup()
    seedSession('enr-abort', '做一个家庭记账本')
    const controller = new AbortController()
    controller.abort()
    const { query } = recordingQuery(['{"requirements":[]}'])
    const result = await enrichRequirementsLlm({
      session_id: 'enr-abort',
      requirements: [{ id: 'F-001', description: '做一个家庭记账本' }],
      query,
      env: { PATH: 'x' },
      signal: controller.signal,
    })
    expect(result).toBeNull()
  })
})

describe('extractUserTexts — user 轮次切分', () => {
  it('只取「用户：」前缀片段并去前缀，跳过助手轮次', () => {
    const texts = extractUserTexts('用户：我想做一个家庭记账本\n助手：好的\n用户：要能记收入和支出\n')
    expect(texts).toEqual(['我想做一个家庭记账本', '要能记收入和支出'])
  })

  it('无 user 轮次 → 空数组', () => {
    expect(extractUserTexts('助手：好的\n')).toEqual([])
  })
})

describe('enrichRequirementsLlm — clarification_requests 追问通路（② 2026-09-03）', () => {
  it('输出带合法 clarification_requests → 成功时回调清洗后的请求（K-6：追问与加厚不互斥）', async () => {
    setup()
    seedSession('enr-clar', '我想做一个电子音乐合成器，能有不同的音色切换就行')
    const valid = JSON.stringify({
      requirements: [
        {
          id: 'F-001',
          story: '作为音乐爱好者，我想在电脑上弹奏并切换音色',
          behavior_assertions: [{ assertion: '点击音色切换控件→当前音色名称文本变化', source: '能有不同的音色切换就行' }],
          priority: 'P0',
        },
      ],
      clarification_requests: [
        { for: 'F-001', question: '音色切换用什么交互？', options: [{ id: 'dropdown', label: '下拉列表' }, { id: 'buttons', label: '按钮组' }] },
        { for: 'F-999', question: 'for 不在清单会被清洗丢弃', options: [{ id: 'a', label: '选项A' }] },
      ],
    })
    const requests: Array<Array<{ for: string; question: string; options?: Array<{ id: string; label: string }> }>> = []
    const result = await enrichRequirementsLlm(
      {
        session_id: 'enr-clar',
        requirements: [{ id: 'F-001', description: '做一个电子音乐合成器' }],
        query: queryReturning(valid),
        env: { PATH: 'x' },
        maxTokens: 4096,
      },
      (asked) => requests.push(asked),
    )
    expect(result).not.toBeNull()
    expect(requests).toEqual([[{ for: 'F-001', question: '音色切换用什么交互？', options: [{ id: 'dropdown', label: '下拉列表' }, { id: 'buttons', label: '按钮组' }] }]])
  })

  it('输出无 clarification_requests 字段 → 不回调（追问触发权在模型，K-2）', async () => {
    setup()
    seedSession('enr-noclar', '我想做一个家庭记账本')
    const valid = JSON.stringify({
      requirements: [
        { id: 'F-001', story: 'S1', behavior_assertions: [{ assertion: '点击保存按钮→列表新增一条记录', source: '记一笔账' }], priority: 'P0' },
      ],
    })
    let called = false
    const result = await enrichRequirementsLlm(
      {
        session_id: 'enr-noclar',
        requirements: [{ id: 'F-001', description: '做一个家庭记账本' }],
        query: queryReturning(valid),
        env: { PATH: 'x' },
        maxTokens: 4096,
      },
      () => {
        called = true
      },
    )
    expect(result).not.toBeNull()
    expect(called).toBe(false)
  })

  it('解析失败（预算耗尽 null）→ 不回调（失败轮的残留请求不可信）', async () => {
    setup()
    seedSession('enr-failclar', '做一个家庭记账本')
    const { query } = recordingQuery(['not json', 'still not json'])
    let called = false
    const result = await enrichRequirementsLlm(
      {
        session_id: 'enr-failclar',
        requirements: [{ id: 'F-001', description: '做一个家庭记账本' }],
        query,
        env: { PATH: 'x' },
        maxTokens: 7000,
      },
      () => {
        called = true
      },
    )
    expect(result).toBeNull()
    expect(called).toBe(false)
  })
})

describe('模板直写不物化 priority（全链路审查 P1-11，2026-10-02）', () => {
  it('无 priority 的落盘形态：buildPrdBackplane 不写缺省 P2 字段（读取侧 requirementPriority 兜底同值）', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-sticky-p2-'))
    const { createProject, findProject } = await import('../../main/project/project-service')
    const { buildPrdBackplane } = await import('../../main/project/prd-store')
    const { requirementPriority } = await import('../../main/model/prd-backplane')
    const project = createProject({ request_id: 'req-sticky', mode: 'quick' })
    // 薄冻结清单（模板直写场景：渠道抖动，enricher 未参与）
    const thin = [
      { id: 'F-001', description: '主题功能' },
      { id: 'F-002', description: '次功能' },
    ]
    const backplane = buildPrdBackplane(findProject(project.project_id), thin, 'sketch_confirmed')
    // 落盘形态：无 priority 字段（不物化缺省）
    expect(backplane.requirements[0].priority).toBeUndefined()
    expect(backplane.requirements[1].priority).toBeUndefined()
    // 读取侧兜底语义不变（F-001=P0、其余 P2）
    expect(requirementPriority(backplane.requirements[0])).toBe('P0')
    expect(requirementPriority(backplane.requirements[1])).toBe('P2')

    // 渠道恢复重跑：enricher 判 F-002 为 P1 → merge 后生效（旧物化形态下 existing P2 挡住升档）
    const enriched = [
      { id: 'F-002', story: '加厚故事', behavior_assertions: [{ assertion: '点击导出→文件生成', source: '对话' }], priority: 'P1' as const },
    ]
    const { requirements } = mergeEnrichment(
      [...thin.map((item) => ({ ...backplane.requirements.find((r) => r.id === item.id)! }))],
      enriched,
      backplane.requirements,
      ['要能导出'],
    )
    const f2 = requirements.find((item) => item.id === 'F-002')
    expect(f2?.priority).toBe('P1')
  })
})
