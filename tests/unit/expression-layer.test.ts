/**
 * Phase 3 B5 MVP：表达适配层（2026-09-09，P1 稿 §3 M5）。
 *
 * 覆盖：开关语义（off=字节级现状）、思考型适配段内容（明确即执行/终轮必出摘要/
 * 不写穷尽思考）、三层架构核心验收——**表达层 append-only，契约层构件字节不变**
 * （off 与 on 的 prompt 去掉表达段后逐字节相等）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { expressionLayerEnabled, renderExpressionSection, THINKING_EXPRESSION_SECTION } from '../../main/agent/prompting/prompt-expression'
import { buildAgentLoopSystemPrompt } from '../../main/coding/programming-orchestrator'
import type { PrdBackplane } from '../../main/model/prd-backplane'

afterEach(() => {
  vi.unstubAllEnvs()
})

const backplane: PrdBackplane = {
  project_id: 'p1',
  name: '记账本',
  positioning: '记账本',
  requirements: [{ id: 'F-001', description: '记账', priority: 'P0' }],
  acceptance: {},
  out_of_scope: [],
  assumptions: [],
}

describe('expressionLayerEnabled（BLOMA_EXPRESSION_LAYER）', () => {
  it('缺省 off（null）；thinking/standard 变体', () => {
    expect(expressionLayerEnabled()).toBeNull()
    vi.stubEnv('BLOMA_EXPRESSION_LAYER', 'thinking')
    expect(expressionLayerEnabled()).toBe('thinking')
    vi.stubEnv('BLOMA_EXPRESSION_LAYER', 'standard')
    expect(expressionLayerEnabled()).toBe('standard')
    vi.stubEnv('BLOMA_EXPRESSION_LAYER', '0')
    expect(expressionLayerEnabled()).toBeNull()
  })
})

describe('思考型适配段内容（P1 稿 M5 口径）', () => {
  it('含四条纪律：明确即执行/不输出内部推理/阻塞报告/终轮必出摘要；无「穷尽思考」类措辞', () => {
    expect(THINKING_EXPRESSION_SECTION).toContain('直接执行')
    expect(THINKING_EXPRESSION_SECTION).toContain('不输出内部推理')
    expect(THINKING_EXPRESSION_SECTION).toContain('阻塞及时报告')
    expect(THINKING_EXPRESSION_SECTION).toContain('绝不以空正文或纯思考收尾')
    expect(THINKING_EXPRESSION_SECTION).not.toMatch(/穷尽思考.{0,10}(要求|必须)/)
    expect(THINKING_EXPRESSION_SECTION).toContain('不追求「穷尽思考') // 负向纪律而非要求
  })
})

describe('三层架构核心验收：表达层 append-only，契约层字节不变', () => {
  it('off：无表达段（字节级现状）', () => {
    const prompt = buildAgentLoopSystemPrompt(backplane, 'diff')
    expect(prompt).not.toContain('【表达适配（思考型模型）】')
  })
  it('thinking：段落在尾部；去掉表达段后与 off 的 prompt 逐字节相等（契约层不变）', () => {
    const off = buildAgentLoopSystemPrompt(backplane, 'diff')
    vi.stubEnv('BLOMA_EXPRESSION_LAYER', 'thinking')
    const on = buildAgentLoopSystemPrompt(backplane, 'diff')
    expect(on.endsWith(THINKING_EXPRESSION_SECTION)).toBe(true)
    expect(on.slice(0, on.length - THINKING_EXPRESSION_SECTION.length - 2)).toBe(off)
  })
  it('微调纪律：表达段不含任何验收口径改写（无「建议读取」类降级措辞）', () => {
    expect(THINKING_EXPRESSION_SECTION).not.toMatch(/建议(读取|执行|使用)/)
    expect(THINKING_EXPRESSION_SECTION).not.toContain('可选')
  })
})
