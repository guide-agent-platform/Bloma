import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveRepairBudget,
  resolveRepairMaxTurns,
  REPAIR_BUDGET_DEFAULTS,
  REPAIR_MAX_TURNS_DEFAULTS,
  repairStrategyForRound,
  buildRepairModeSection,
} from '../../../main/coding/repair-loop'

/** web 线拆除刀3 重写：只测保留的品类无关修复机制（预算/轮次/策略轮换）；web 修复执行体随线退役。 */
describe('预算与轮次解析（D6 + BLOMA_REPAIR_* 覆盖）', () => {
  const keys = ['BLOMA_REPAIR_BUDGET', 'BLOMA_REPAIR_TURNS'] as const
  const original: Record<string, string | undefined> = {}
  for (const key of keys) original[key] = process.env[key]

  afterEach(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
  })

  it('缺省：quick=2 / longterm=3（2026-09-25 对齐拍板）；修复轮 quick=12 / longterm=16', () => {
    expect(REPAIR_BUDGET_DEFAULTS).toEqual({ quick: 2, longterm: 3 })
    expect(REPAIR_MAX_TURNS_DEFAULTS).toEqual({ quick: 12, longterm: 16 })
    expect(resolveRepairBudget('quick')).toBe(2)
    expect(resolveRepairBudget('longterm')).toBe(3)
    expect(resolveRepairMaxTurns('quick')).toBe(12)
    expect(resolveRepairMaxTurns('longterm')).toBe(16)
  })

  it('BLOMA_REPAIR_BUDGET / BLOMA_REPAIR_TURNS 覆盖生效（不分模式单值覆盖）', () => {
    process.env.BLOMA_REPAIR_BUDGET = '4'
    process.env.BLOMA_REPAIR_TURNS = '8'
    expect(resolveRepairBudget('quick')).toBe(4)
    expect(resolveRepairBudget('longterm')).toBe(4)
    expect(resolveRepairMaxTurns('quick')).toBe(8)
    expect(resolveRepairMaxTurns('longterm')).toBe(8)
  })

  it('非法值（非数字/≤0/小数）回退缺省；先取整再校验不许 floor 成 0', () => {
    process.env.BLOMA_REPAIR_BUDGET = 'abc'
    expect(resolveRepairBudget('quick')).toBe(2)
    process.env.BLOMA_REPAIR_BUDGET = '0'
    expect(resolveRepairBudget('longterm')).toBe(3)
    process.env.BLOMA_REPAIR_BUDGET = '-2'
    expect(resolveRepairBudget('quick')).toBe(2)
    process.env.BLOMA_REPAIR_TURNS = '0.5'
    expect(resolveRepairMaxTurns('quick')).toBe(12)
    process.env.BLOMA_REPAIR_TURNS = ' '
    expect(resolveRepairMaxTurns('longterm')).toBe(16)
  })
})


describe('修复策略轮换（2026-09-25 对齐 Proma-Easy：每轮换策略堵空转漂移）', () => {
  it('repairStrategyForRound：1→direct-fix / 2→re-read-design / 3+→alternate-approach（循环取尾）', async () => {
    const { repairStrategyForRound } = await import('../../../main/coding/repair-loop')
    expect(repairStrategyForRound(1)).toBe('direct-fix')
    expect(repairStrategyForRound(2)).toBe('re-read-design')
    expect(repairStrategyForRound(3)).toBe('alternate-approach')
    expect(repairStrategyForRound(4)).toBe('alternate-approach') // 超序列取尾
    expect(repairStrategyForRound(0)).toBe('direct-fix') // 防御
  })

  it('buildRepairModeSection：三策略段文案各异 + 零编辑守卫逐轮注入', async () => {
    const { buildRepairModeSection } = await import('../../../main/coding/repair-loop')
    const s1 = buildRepairModeSection(1)
    const s2 = buildRepairModeSection(2)
    const s3 = buildRepairModeSection(3)
    expect(s1).toContain('策略一：定向修复')
    expect(s2).toContain('策略二：重读设计')
    expect(s2).toContain('设计要求 vs 当前实现')
    expect(s3).toContain('策略三：换实现路径')
    expect(s3).toContain('换一种实现路径')
    for (const section of [s1, s2, s3]) {
      expect(section).toContain('不要重新生成整个项目')
      expect(section).toContain('至少一次 write_file/edit_file') // 零编辑守卫（空转对治）
    }
  })

  it('预算口径对齐：quick=2 / longterm=3（3 轮容得下两种策略）', async () => {
    const { resolveRepairBudget, REPAIR_STRATEGY_SEQUENCE } = await import('../../../main/coding/repair-loop')
    expect(resolveRepairBudget('quick')).toBe(2)
    expect(resolveRepairBudget('longterm')).toBe(3)
    expect(REPAIR_STRATEGY_SEQUENCE).toEqual(['direct-fix', 're-read-design', 'alternate-approach'])
  })
})

