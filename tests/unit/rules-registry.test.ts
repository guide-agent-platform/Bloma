/**
 * 操作契约 ID 注册表（Phase 3 B2，2026-09-09，P1 稿 §3 M2）。
 *
 * 覆盖：开关语义、注册表结构完整性（ID 唯一/四段非空）、渲染单点性（每条规则
 * 只出现一次完整定义）、loop prompt 接线（off=内联原文字节级现状；on=内联让位、
 * 注册表段注入、防双源）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RULES_REGISTRY, renderRulesSection, rulesForTemplateType, rulesRegistryEnabled } from '../../main/agent/prompting/rules-registry'
import type { PrdBackplane } from '../../main/model/prd-backplane'

afterEach(() => {
  vi.unstubAllEnvs()
})

const backplane: PrdBackplane = {
  project_id: 'p1',
  name: '记账本',
  positioning: '记账本',
  requirements: [{ id: 'F-001', description: '记账' }],
  acceptance: {},
  out_of_scope: [],
  assumptions: [],
}

describe('rulesRegistryEnabled（BLOMA_RULES_REGISTRY）', () => {
  it('缺省 off；on/off 变体', () => {
    expect(rulesRegistryEnabled()).toBe(false)
    for (const value of ['1', 'on', 'true']) {
      vi.stubEnv('BLOMA_RULES_REGISTRY', value)
      expect(rulesRegistryEnabled(), value).toBe(true)
    }
    for (const value of ['0', 'off', 'false', '']) {
      vi.stubEnv('BLOMA_RULES_REGISTRY', value)
      expect(rulesRegistryEnabled(), value).toBe(false)
    }
  })
})

describe('注册表结构完整性（验收：引用完整性）', () => {
  it('首批三条；ID 唯一且符合 R-<域>-<序号>', () => {
    expect(RULES_REGISTRY.map((r) => r.id)).toEqual(['R-FILE-01', 'R-DATA-01', 'R-OUTPUT-01'])
  })
  it('每条四段+理由非空；kind 在枚举内', () => {
    for (const rule of RULES_REGISTRY) {
      for (const field of ['trigger', 'must', 'forbidden', 'blocked', 'reason', 'name'] as const) {
        expect(rule[field].trim().length, `${rule.id}.${field}`).toBeGreaterThan(4)
      }
      expect(['invariant', 'completion', 'preference']).toContain(rule.kind)
    }
  })
})

describe('renderRulesSection（验收：每条规则只出现一次完整定义）', () => {
  it('空表零注入；渲染段含四段式标记；每个 ID 恰好出现一次', () => {
    expect(renderRulesSection([])).toBe('')
    const section = renderRulesSection()
    for (const marker of ['触发：', '必须：', '禁止替代：', '受阻：', '（理由：']) {
      expect(section).toContain(marker)
    }
    for (const rule of RULES_REGISTRY) {
      const occurrences = section.split(rule.id).length - 1
      expect(occurrences, rule.id).toBe(1)
    }
  })
})

