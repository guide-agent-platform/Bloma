/**
 * Phase 3 B3 round_anchor 三字段（2026-09-09，P1 稿 §3 M3）。
 *
 * 覆盖：开关语义、渲染段（三字段+语义头+空 spec 零注入）、修复轮/迭代轮确定性派生
 * （必须保留=P0；完成证据=失败断言原文/聚焦项断言；不许做=反顺手重构）。
 * 接线字节级保证：调用点仅开关 on 才传 spec，repair-loop 内部二次门控——off 时
 * system prompt 与现状逐字节一致（双重保险）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildIterationRoundAnchor,
  buildRepairRoundAnchor,
  renderRoundAnchorBlock,
  roundAnchorEnabled,
  type PrdBackplane,
} from '../../main/model/prd-backplane'

afterEach(() => {
  vi.unstubAllEnvs()
})

const backplane: PrdBackplane = {
  project_id: 'p1',
  name: '记账本',
  positioning: '记账本',
  requirements: [
    { id: 'F-001', description: '记录收支', priority: 'P0', behavior_assertions: ['新增记录后列表实时刷新'] },
    { id: 'F-002', description: '按月汇总', priority: 'P0', behavior_assertions: ['月末显示本月结余'] },
    { id: 'F-003', description: '导出 CSV', priority: 'P2' },
  ],
  acceptance: {},
  out_of_scope: ['不做登录'],
  assumptions: [],
}

describe('roundAnchorEnabled（BLOMA_ROUND_ANCHOR）', () => {
  it('缺省 off；on/off 变体', () => {
    expect(roundAnchorEnabled()).toBe(false)
    vi.stubEnv('BLOMA_ROUND_ANCHOR', '1')
    expect(roundAnchorEnabled()).toBe(true)
    vi.stubEnv('BLOMA_ROUND_ANCHOR', '0')
    expect(roundAnchorEnabled()).toBe(false)
  })
})

describe('renderRoundAnchorBlock', () => {
  it('含语义头与三字段；条目以分号连接', () => {
    const block = renderRoundAnchorBlock({
      must_preserve: ['F-001 记录收支'],
      out_of_scope: ['不顺手重构'],
      completion_evidence: ['失败断言 A', '全部 P0 断言重验通过'],
    })
    expect(block).toContain('【本轮锚（round_anchor）】只限定本轮范围，不改全局契约')
    expect(block).toContain('最近错误、修复建议或你先前的计划不自动构成需求变更')
    expect(block).toContain('必须保留（本轮不得破坏）：F-001 记录收支')
    expect(block).toContain('本轮不许做：不顺手重构')
    expect(block).toContain('完成证据（怎么算修好，行为级）：失败断言 A；全部 P0 断言重验通过')
  })
  it('全空 spec → 空串（零注入）', () => {
    expect(renderRoundAnchorBlock({ must_preserve: [], out_of_scope: [], completion_evidence: [] })).toBe('')
  })
})

describe('buildRepairRoundAnchor（修复轮确定性派生）', () => {
  it('必须保留=P0 功能项；完成证据=失败断言原文+全量重验；不许做含反顺手重构与范围外', () => {
    const spec = buildRepairRoundAnchor(backplane, ['F-001 WHEN 点击保存 → 列表出现新记录', '', 'F-002 空态显示 0'])
    expect(spec.must_preserve).toEqual(['F-001 记录收支', 'F-002 按月汇总'])
    expect(spec.completion_evidence).toContain('F-001 WHEN 点击保存 → 列表出现新记录')
    expect(spec.completion_evidence).not.toContain('')
    expect(spec.completion_evidence).toContain('全部 P0 断言重验通过（run_gwt_tests 全量）')
    expect(spec.out_of_scope.join()).toContain('不顺手重构')
    expect(spec.out_of_scope).toContain('不做登录')
  })
})

describe('buildIterationRoundAnchor（迭代轮确定性派生）', () => {
  it('聚焦 F-002：必须保留=其余 P0；完成证据=聚焦项断言+其余不回退', () => {
    const spec = buildIterationRoundAnchor(backplane, ['F-002'])
    expect(spec.must_preserve).toEqual(['F-001 记录收支'])
    expect(spec.completion_evidence).toContain('月末显示本月结余')
    expect(spec.completion_evidence).toContain('其余 P0 断言不回退（run_gwt_tests 全量）')
    expect(spec.out_of_scope.join()).toContain('聚焦项之外的功能不做改动')
  })
  it('全部 P0 都在聚焦内：必须保留回退为「全部断言保持通过」', () => {
    const spec = buildIterationRoundAnchor(backplane, ['F-001', 'F-002'])
    expect(spec.must_preserve).toEqual(['全部 P0 功能项断言保持通过'])
  })
})
