import { describe, expect, it } from 'vitest'
import {
  DELEGATE_CAPABILITY_LINE,
  DELEGATE_ROLE_FACTS,
  LOCAL_FIRST_TEMPLATE_TYPES,
  renderDataPolicyClause,
  renderProductShapeSection,
  resolveCapabilityProfile,
} from '../../main/coding/capability-profile'
import { buildAgentTools } from '../../main/agent/tools/agent-tools'
import { buildDomainTools } from '../../main/coding/tool-handlers'
import { buildAgentLoopSystemPrompt } from '../../main/coding/stages/loop-prompt'
import type { PrdBackplane } from '../../main/coding/sketch-engine'

/**
 * 能力档案（2026-09-26 运行审计 P1-08）：总体能力承诺、品类能力和工具注册的单一真相源。
 * 三处审计矛盾各有锁定：产物形态按品类/构建能力条件化、数据策略与判定源同源、
 * 角色能力与工具注册面机器校验一致。
 */

const backplane = (overrides: Partial<PrdBackplane> = {}): PrdBackplane =>
  ({
    requirements: [{ id: 'F-001', description: '记录收入与支出', priority: 'P0', behavior_assertions: ['点击保存→列表新增一条记录'] }],
    out_of_scope: [],
    template_meta: { type: 'personal_tool', version: '1' },
    ...overrides,
  }) as unknown as PrdBackplane

describe('resolveCapabilityProfile（P1-08a）', () => {
  it('构建能力优先于品类：有工程骨架 = 模块化（本地优先品类亦然）', () => {
    expect(resolveCapabilityProfile({ templateType: 'personal_tool', skeletonMap: 'map' }).platform).toBe('web-modular')
    expect(resolveCapabilityProfile({ templateType: 'game', skeletonMap: 'map' }).platform).toBe('web-modular')
  })

  it('前后端分离渠道 → web-fullstack（优先于骨架）', () => {
    expect(resolveCapabilityProfile({ templateType: 'personal_tool', skeletonMap: 'map', realFullstack: true }).platform).toBe('web-fullstack')
  })

  it('无骨架按品类给形态：桌面/小游戏/AI/本地工具/纯静态', () => {
    expect(resolveCapabilityProfile({ templateType: 'desktop_tool' }).platform).toBe('desktop')
    expect(resolveCapabilityProfile({ templateType: 'game' }).platform).toBe('game-local')
    expect(resolveCapabilityProfile({ templateType: 'ai_app' }).platform).toBe('ai-local')
    expect(resolveCapabilityProfile({ templateType: 'personal_tool' }).platform).toBe('local-first')
    expect(resolveCapabilityProfile({ templateType: 'web_fullstack' as never }).platform).toBe('web-static')
  })

  it('数据策略由留存豁免单一源决定（不与品类判定分别手写）', () => {
    expect(resolveCapabilityProfile({ templateType: 'personal_tool', persistenceExempt: true }).dataPolicy).toBe('local-first-ok')
    expect(resolveCapabilityProfile({ templateType: 'personal_tool', persistenceExempt: false }).dataPolicy).toBe('server-required')
    expect(resolveCapabilityProfile({ templateType: 'web_fullstack' as never }).dataPolicy).toBe('server-required')
  })

  it('本地优先品类集合与 prd-backplane 判定源一致（防两处漂移）', async () => {
    const backplaneModule = await import('../../main/model/prd-backplane')
    // 两处各有一个私有/公开集合——用行为等价校验：四品类 + 无强后端信号 = 豁免
    for (const t of LOCAL_FIRST_TEMPLATE_TYPES) {
      expect(backplaneModule.localFirstPersistenceExempt(['保存记录'], t), t).toBe(true)
    }
    expect(backplaneModule.localFirstPersistenceExempt(['保存记录'], 'web_fullstack' as never)).toBe(false)
    expect(backplaneModule.localFirstPersistenceExempt(['多端同步保存记录'], 'personal_tool')).toBe(false)
  })
})

describe('段落生成（P1-08b：消除三处矛盾）', () => {
  it('desktop：产物形态不再固定 index.html 入口，且含阻塞要求（不降格为网页变通）', () => {
    const profile = resolveCapabilityProfile({ templateType: 'desktop_tool' })
    const section = renderProductShapeSection(profile)
    expect(section).toContain('桌面形态产物')
    expect(section).not.toContain('入口 index.html，纯前端静态产物')
    expect(section).toContain('不得静默降格为局部 Web 修改')
  })

  it('数据条款：local-first-ok 允许 localStorage；server-required 禁止', () => {
    const localOk = renderDataPolicyClause(resolveCapabilityProfile({ templateType: 'personal_tool', persistenceExempt: true }))
    expect(localOk).toContain('localStorage')
    expect(localOk).not.toContain('禁止 localStorage')
    const server = renderDataPolicyClause(resolveCapabilityProfile({ templateType: 'personal_tool', persistenceExempt: false }))
    expect(server).toContain('禁止 localStorage/sessionStorage 存业务数据')
  })

  it('角色能力如实行：不再统一声称「完整读写与验证工具」', () => {
    expect(DELEGATE_CAPABILITY_LINE).not.toContain('子会话拥有同一项目的完整读写与验证工具')
    expect(DELEGATE_CAPABILITY_LINE).toContain('explore/research 子角色只读')
    expect(DELEGATE_CAPABILITY_LINE).toContain('review 子角色只读且不改产物')
  })

  it('提示词集成：desktop_tool 项目的 system 用桌面产物形态；personal_tool 无强后端信号时数据条款允许本地存储', () => {
    const desktop = buildAgentLoopSystemPrompt(backplane({ template_meta: { type: 'desktop_tool', version: '1' } } as never), 'diff', 'desktop_tool', null)
    expect(desktop).toContain('桌面形态产物')
    const personal = buildAgentLoopSystemPrompt(backplane(), 'diff', 'personal_tool', null)
    expect(personal).toContain('数据留存类需求（保存/历史/记录/收藏/刷新或重开后仍在）以本地持久化（localStorage）为合法一等实现')
  })
})

describe('角色能力事实 vs 工具注册面（P1-08 根因：分别手写 → 机器校验一致）', () => {
  const toolNames = (tools: Array<{ name: string }>) => tools.map((t) => t.name)
  const options = (role: 'parent' | 'review' | 'explore' | 'research' | 'custom') =>
    ({ projectId: 'p-cap', mode: 'quick', role, sessionId: 's', requestId: 'r' }) as never

  it('implement/custom：有写工具 + 有领域验证', () => {
    const general = toolNames(buildAgentTools(options('custom')))
    const domain = toolNames(buildDomainTools(options('custom')))
    expect(general).toContain('write_file')
    expect(general).toContain('edit_file')
    expect(domain).toContain('run_gwt_tests')
  })

  it('review：无写工具 + 有领域验证（只读审查，与话术一致）', () => {
    const general = toolNames(buildAgentTools(options('review')))
    const domain = toolNames(buildDomainTools(options('review')))
    expect(general).not.toContain('write_file')
    expect(general).not.toContain('edit_file')
    expect(domain).toContain('run_gwt_tests')
  })

  it('explore/research：无写工具 + 无领域验证（只读探索）', () => {
    const general = toolNames(buildAgentTools(options('explore')))
    const domain = toolNames(buildDomainTools(options('explore')))
    expect(general).not.toContain('write_file')
    expect(domain).toEqual([])
    expect(toolNames(buildAgentTools(options('research')))).not.toContain('write_file')
    expect(toolNames(buildDomainTools(options('research')))).toEqual([])
  })

  it('DELEGATE_ROLE_FACTS 与上表一致（事实常量不得与注册面漂移）', () => {
    const facts = new Map(DELEGATE_ROLE_FACTS.map((f) => [f.role, f]))
    expect(facts.get('implement/custom')).toEqual({ role: 'implement/custom', writable: true, domainVerification: true })
    expect(facts.get('review')).toEqual({ role: 'review', writable: false, domainVerification: true })
    expect(facts.get('explore/research')).toEqual({ role: 'explore/research', writable: false, domainVerification: false })
  })
})
