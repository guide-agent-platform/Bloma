import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetExperienceIndexForTests } from '../../../main/experience/experience-service'
import { appendExperienceEvent, readExperienceEvents } from '../../../main/experience/event-log'
import {
  buildRuleInjectionMap,
  deriveCapabilitiesFromBackplane,
  EXP_API_001_TAG,
  matchRules,
  recordRuleActionObserved,
  registerSeedRules,
  renderRuleInjection,
  ruleInjectEnabled,
} from '../../../main/experience/rule-injection'

/**
 * Phase 10 W2-2/W3（F 系列 Wave 3 承接）：单点消费闭环——种子登记/受控词表匹配/
 * 条件—动作—证据渲染/action_observed 观测/data_migration_failed 事件接线（模块级）。
 * W5 负例：纯本地任务必须排除 EXP-API-001（硬过滤验证，咨询 F 验收线）。
 */

const originalHome = process.env.PROMA_HOME
const originalInject = process.env.BLOMA_EXP_RULE_INJECT

beforeEach(() => {
  process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-ri-'))
  resetExperienceIndexForTests()
})
afterEach(() => {
  if (originalHome === undefined) delete process.env.PROMA_HOME
  else process.env.PROMA_HOME = originalHome
  if (originalInject === undefined) delete process.env.BLOMA_EXP_RULE_INJECT
  else process.env.BLOMA_EXP_RULE_INJECT = originalInject
  resetExperienceIndexForTests()
})

describe('rule-injection 开关', () => {
  it('BLOMA_EXP_RULE_INJECT 缺省 off；on 时注入入口产出', async () => {
    delete process.env.BLOMA_EXP_RULE_INJECT
    expect(ruleInjectEnabled()).toBe(false)
    expect(await buildRuleInjectionMap({ stage: 'implement', templateType: 'web_fullstack', capabilities: ['backend_data'] })).toBeNull()
    process.env.BLOMA_EXP_RULE_INJECT = '1'
    await registerSeedRules()
    const map = await buildRuleInjectionMap({ stage: 'implement', templateType: 'web_fullstack', capabilities: ['backend_data'] })
    expect(map).toContain('【行动规则')
    expect(map).toContain(EXP_API_001_TAG)
  })
})

describe('种子与匹配（受控词表硬过滤）', () => {
  it('registerSeedRules 幂等：两次登记只一张卡且 verified', async () => {
    await registerSeedRules()
    await registerSeedRules()
    const rules = await matchRules({ stage: 'implement', templateType: 'web_fullstack', capabilities: ['backend_data'] })
    expect(rules).toHaveLength(1)
    expect(rules[0].tag).toBe(EXP_API_001_TAG)
    expect(rules[0].status).toBe('verified')
  })

  it('能力面命中：ai_proxy / external_service / media_proxy 任一匹配', async () => {
    await registerSeedRules()
    for (const cap of ['ai_proxy', 'external_service', 'media_proxy']) {
      const rules = await matchRules({ stage: 'implement', templateType: 'web_fullstack', capabilities: [cap] })
      expect(rules.some((r) => r.tag === EXP_API_001_TAG)).toBe(true)
    }
  })

  it('W5 负例：纯本地任务（无能力面/personal_tool 类型）必须排除 EXP-API-001', async () => {
    await registerSeedRules()
    const noCaps = await matchRules({ stage: 'implement', templateType: 'web_fullstack', capabilities: [] })
    expect(noCaps).toHaveLength(0)
    const wrongType = await matchRules({ stage: 'implement', templateType: 'personal_tool', capabilities: ['backend_data'] })
    expect(wrongType).toHaveLength(0)
  })

  it('渲染：条件—动作—证据结构（适用头/风险/现在执行/完成证据/不适用）', async () => {
    await registerSeedRules()
    const rules = await matchRules({ stage: 'implement', templateType: 'web_fullstack', capabilities: ['backend_data'] })
    const rendered = renderRuleInjection(rules)
    expect(rendered).toContain('[阶段=implement')
    expect(rendered).toContain('风险：')
    expect(rendered).toContain('现在执行 1.')
    expect(rendered).toContain('完成证据：run_api_contract_tests')
    expect(rendered).toContain('不适用：纯本地')
    expect(rendered).toContain('hypothesis')
  })

  it('deriveCapabilitiesFromBackplane：interface_spec→backend_data、ai_capabilities→ai_proxy、双空→空', () => {
    expect(deriveCapabilitiesFromBackplane({ interface_spec: [{ endpoint: '/api/notes' }] })).toEqual(['backend_data'])
    expect(deriveCapabilitiesFromBackplane({ ai_capabilities: [{ task: '总结' }] })).toEqual(['ai_proxy'])
    expect(deriveCapabilitiesFromBackplane({})).toEqual([])
  })
})

describe('action_observed 与 data_migration_failed 事件', () => {
  it('注入项目 loop 调过 run_api_contract_tests → exposure action_observed 落 analytics', async () => {
    process.env.BLOMA_EXP_RULE_INJECT = '1'
    await registerSeedRules()
    await buildRuleInjectionMap({ projectId: 'proj-obs', stage: 'implement', templateType: 'web_fullstack', capabilities: ['backend_data'] })
    recordRuleActionObserved('proj-obs', ['run_gwt_tests', 'run_api_contract_tests'])
    const analyticsPath = join(process.env.PROMA_HOME!, 'agent-workspaces', 'default-software-builder', 'analytics.jsonl')
    const lines = readFileSync(analyticsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { event_type: string; payload?: { level?: string; tool?: string } })
    const observed = lines.filter((l) => l.event_type === 'experience_exposure' && l.payload?.level === 'action_observed')
    expect(observed).toHaveLength(1)
    expect(observed[0].payload?.tool).toBe('run_api_contract_tests')
    // 观测一次性：二次调用不再落
    recordRuleActionObserved('proj-obs', ['run_api_contract_tests'])
    const again = readFileSync(analyticsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { event_type: string; payload?: { level?: string } })
    expect(again.filter((l) => l.event_type === 'experience_exposure' && l.payload?.level === 'action_observed')).toHaveLength(1)
  })

  it('未注入项目/未调工具 → 零事件；data_migration_failed 事件行落账本（终验接线口径）', () => {
    recordRuleActionObserved('proj-none', ['run_api_contract_tests'])
    appendExperienceEvent({ projectId: 'p-mig', runId: 'r-1', eventType: 'data_migration_failed', stage: 'testing', observations: ['数据迁移演练：版本到位：迁移后 schema-version 应为 2，实际为「1」'] })
    const events = readExperienceEvents()
    expect(events.some((e) => e.event_type === 'data_migration_failed' && e.observations[0].includes('schema-version'))).toBe(true)
  })
})
