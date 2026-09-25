/**
 * 操作契约 ID 注册表（Phase 3 B2，2026-09-09，P1 稿 §3 M2）。
 *
 * 覆盖：开关语义、注册表结构完整性（ID 唯一/四段非空）、渲染单点性（每条规则
 * 只出现一次完整定义）、loop prompt 接线（off=内联原文字节级现状；on=内联让位、
 * 注册表段注入、防双源）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RULES_REGISTRY, renderRulesSection, rulesForTemplateType, rulesRegistryEnabled } from '../../main/agent/prompting/rules-registry'
import { buildAgentLoopSystemPrompt } from '../../main/coding/programming-orchestrator'
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

describe('loop prompt 接线（off=字节级现状 / on=单点定义防双源）', () => {
  it('off：内联原文保留，无注册表段与 R-* ID', () => {
    const prompt = buildAgentLoopSystemPrompt(backplane, 'diff')
    // R-FILE-01 内联原文
    expect(prompt).toContain('先用 read_file 读该文件当前内容再编辑')
    // R-DATA-01 内联原文
    expect(prompt).toContain('禁止 localStorage/sessionStorage 存业务数据')
    expect(prompt).toContain('不构成 localStorage 例外的理由')
    // 无注册表痕迹
    expect(prompt).not.toContain('R-FILE-01')
    expect(prompt).not.toContain('R-DATA-01')
    expect(prompt).not.toContain('R-OUTPUT-01')
    expect(prompt).not.toContain('【操作契约')
  })
  it('on：注册表段注入、四段式完整；内联原文让位（防双源）；护栏其余条款不受影响', () => {
    vi.stubEnv('BLOMA_RULES_REGISTRY', '1')
    const prompt = buildAgentLoopSystemPrompt(backplane, 'diff')
    expect(prompt).toContain('【操作契约（不变量')
    for (const rule of RULES_REGISTRY) {
      expect(prompt).toContain(rule.id)
      expect(prompt).toContain(rule.forbidden)
    }
    // 内联原文整段消失（不是两处并存）
    expect(prompt).not.toContain('先用 read_file 读该文件当前内容再编辑；')
    expect(prompt).not.toContain('禁止 localStorage/sessionStorage 存业务数据——PRD')
    // 护栏与工作方式的其余内容不受影响
    expect(prompt).toContain('路径限项目目录内')
    expect(prompt).toContain('out_of_scope 内的功能一律不做')
    expect(prompt).toContain('可用验证工具')
    // R-OUTPUT-01 此前无 prompt 条款（新增覆盖，正文冒充已执行禁令在表内）
    expect(prompt).toContain('冒充已执行')
  })
})

describe('C1b rulesForTemplateType（game 豁免 R-DATA-01 变体）', () => {
  const previousEnv = process.env.BLOMA_GAME_DERIVE_EXEMPT

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.BLOMA_GAME_DERIVE_EXEMPT
    else process.env.BLOMA_GAME_DERIVE_EXEMPT = previousEnv
  })

  it('off 或非 game → 原表字节级（R-DATA-01 禁 localStorage 原文不变）', () => {
    delete process.env.BLOMA_GAME_DERIVE_EXEMPT
    expect(rulesForTemplateType('game')).toBe(RULES_REGISTRY)
    process.env.BLOMA_GAME_DERIVE_EXEMPT = '1'
    expect(rulesForTemplateType('web_fullstack')).toBe(RULES_REGISTRY)
    expect(rulesForTemplateType(undefined)).toBe(RULES_REGISTRY)
  })

  it('on + game → 仅 R-DATA-01 变体（轻留存允许 localStorage、重数据仍后端），其余规则不动', () => {
    process.env.BLOMA_GAME_DERIVE_EXEMPT = '1'
    const rules = rulesForTemplateType('game')
    expect(rules).not.toBe(RULES_REGISTRY)
    const data = rules.find((r) => r.id === 'R-DATA-01')!
    expect(data.must).toContain('localStorage')
    expect(data.must).toContain('server/routes/')
    expect(data.forbidden).toContain('重业务数据')
    // 其余规则原样（R-FILE-01/R-OUTPUT-01 引用相等）
    expect(rules.find((r) => r.id === 'R-FILE-01')).toBe(RULES_REGISTRY.find((r) => r.id === 'R-FILE-01'))
    expect(rules.find((r) => r.id === 'R-OUTPUT-01')).toBe(RULES_REGISTRY.find((r) => r.id === 'R-OUTPUT-01'))
  })
})
