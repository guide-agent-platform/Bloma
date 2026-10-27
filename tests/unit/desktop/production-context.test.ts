import { describe, expect, it } from 'vitest'
import type { PrdBackplane } from '../../../main/model/prd-backplane'
import { productionContext, inlineProductionContext } from '../../../main/desktop/production-context'
import { parseLaunchDeclaration } from '../../../main/desktop/launch-smoke'
import { bindAcceptance, requirementEvidenceHash } from '../../../main/project/requirement-contract'
import { productionGuide } from '../../../main/desktop/production-guide'


const fixture = () => bindAcceptance({ project_id: 'p', name: 'test', positioning: '离线待办',
  requirements: [{ id: 'F-001', description: '允许同名新增', behavior_assertions: ['空白不保存'] }, { id: 'F-002', description: '独立删除' }],
  acceptance: { 'F-001': '首尾去空格', 'F-002': '仅删指定ID' }, constraints: ['离线'], assumptions: ['按新增顺序'], out_of_scope: ['联网'],
  prd_document: '# 完整正文\n正文中的细节原样保留', requirements_model: { sources: [], entities: [{ id: 'O-001', name: '任务', description: '独立任务', attributes: ['id', 'title'] }],
    workflows: [{ id: 'W-001', feature_ids: ['F-001', 'F-002'], steps: ['新增', '删除'] }],
    rules: [{ id: 'BR-001', feature_ids: ['F-001', 'F-002'], statement: '同名互不影响' }],
    scenarios: [{ id: 'AC-001', feature_id: 'F-001', then: '两条不同ID' }, { id: 'AC-002', feature_id: 'F-002', then: '另一条保留' }],
  },
} as unknown as PrdBackplane)

describe('role-directed authoritative production context', () => {
  it('includes the confirmed delivery shape before the agent chooses an implementation',()=>{
    const prd=fixture();prd.lean_brief={version:1,ui:'required',delivery:'desktop',distribution:'local'} as PrdBackplane['lean_brief']
    expect(productionContext(prd,'overview')).toMatchObject({delivery:'desktop',distribution:'local',ui:'required'})
  })
  it('publishes executable launch wire examples, not ambiguous requirement ui booleans', () => {
    const protocol = (productionContext(fixture(), 'launch') as { protocol: string }).protocol
    const examples = [...protocol.matchAll(/\{"schema_version":2[^}]+\}/g)].map(m => JSON.parse(m[0]))
    expect(examples).toHaveLength(2)
    for (const example of examples) expect(parseLaunchDeclaration(JSON.stringify(example)).ok).toBe(true)
    expect(protocol).toContain('不能用true/false')
    expect(protocol).toContain('APP_DATA_DIR')
  })
  it('selects full feature obligations without losing shared rules, provenance or global constraints', () => {
    const prd = fixture(), original = structuredClone(prd)
    const view = productionContext(prd, 'features', ['F-002']) as Record<string, any>
    expect(view.requirements).toHaveLength(1)
    expect(view.requirements[0]).toMatchObject({ id: 'F-002', description: '独立删除', acceptance: '仅删指定ID', requirement_hash: requirementEvidenceHash(prd, prd.requirements[1]) })
    expect(view.requirements_model.rules[0].feature_ids).toEqual(['F-001', 'F-002'])
    expect(view.requirements_model.scenarios.map((s: any) => s.id)).toEqual(['AC-002'])
    expect(view.requirements_model.entities).toEqual(prd.requirements_model!.entities)
    expect(view.constraints).toEqual(['离线']); expect(view.out_of_scope).toEqual(['联网'])
    expect(prd).toEqual(original)
    expect(productionContext(prd, 'prd')).toMatchObject({ prd_document: original.prd_document })
  })
  it('keeps complete scope accessible and refuses unknown IDs rather than silently hiding requirements', () => {
    const prd = fixture()
    expect((productionContext(prd, 'features') as any).requirements).toHaveLength(2)
    expect(() => productionContext(prd, 'features', ['F-999'])).toThrow('UNKNOWN_FEATURE')
    expect((productionContext(prd, 'overview') as any).features.map((f: any) => f.id)).toEqual(['F-001', 'F-002'])
  })
  it('keeps obligations and verification identity inline while serving full provenance on demand', () => {
    const prd = fixture()
    const packet = inlineProductionContext(prd, ['F-001']) as any
    const full = productionContext(prd, 'features', ['F-001']) as any
    expect(packet.requirements).toEqual(full.requirements)
    expect(packet.requirements_model.rules).toEqual(full.requirements_model.rules)
    expect(packet.requirements_model.scenarios).toEqual(full.requirements_model.scenarios)
    expect(packet.requirements_model.sources).toBeUndefined()
    expect(full.requirements_model.sources).toEqual(prd.requirements_model!.sources)
  })
  it('derives resource guidance from the actual runtime rather than legacy default text', () => {
    const guide = productionGuide('executor', { script_runs: 64, install_calls: 8 })
    expect(guide).toContain('累计64次'); expect(guide).toContain('累计8次'); expect(guide).toContain('续接不清零')
  })
})
