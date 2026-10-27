import { describe, expect, it } from 'vitest'
import { bindAcceptance, trustedAcceptance, reconcileAcceptanceRevision, requirementEvidenceHash, acceptanceAssociationIssues } from '../../main/project/requirement-contract'
import { parseLeanBrief } from '../../main/guide/lean-brief'
import type { PrdBackplane } from '../../main/model/prd-backplane'

function sample(): PrdBackplane {
  return bindAcceptance({ project_id: 'p', name: '工艺', positioning: '工艺', assumptions: [], out_of_scope: [],
    requirements: [{ id: 'F-001', description: '工艺方案' }, { id: 'F-004', description: '参数编辑', behavior_assertions: ['非法值保持原值'] }],
    acceptance: { 'F-004': '输入非法参数保持原值' }, prd_document: 'F-004 参数编辑通过' })
}
describe('requirement evidence identity', () => {
  it('rejects malformed acceptance before binding a current task sheet', () => {
    expect(parseLeanBrief(JSON.stringify({action:'brief',goal:'新目标',ui:'none',requirements:[{description:'新功能',expected:['不是文本']}]}),
      {projectId:'p',sessionId:'s',source:'新目标',previous:sample(),software:true})).toBeUndefined()
  })
  it('refuses stale acceptance after the audited F-004 meaning changes; historical input is untouched', () => {
    const original = sample()
    const revised = { ...original, requirements: [original.requirements[0]!, { id: 'F-004', description: '真实模型增强' }] }
    expect(trustedAcceptance(revised, revised.requirements[1]!)).toBeUndefined()
    expect(acceptanceAssociationIssues(revised)).toHaveLength(1)
    const result = reconcileAcceptanceRevision(original, revised)
    expect(result.acceptance['F-004']).toBeUndefined()
    expect(result.prd_document).toBeUndefined()
    expect(original.acceptance['F-004']).toContain('非法参数')
    expect(original.prd_document).toBe('F-004 参数编辑通过')
  })
  it('does not bless unbound legacy maps or edited acceptance, and survives array reorder', () => {
    const source = sample()
    const item = source.requirements[1]!
    expect(trustedAcceptance({ ...source, requirements: [...source.requirements].reverse() }, item)).toBe(source.acceptance[item.id])
    expect(trustedAcceptance({ ...source, acceptance_bindings: undefined }, item)).toBeUndefined()
    expect(trustedAcceptance({ ...source, acceptance: { [item.id]: 'mock 通过' } }, item)).toBeUndefined()
  })
  it('does not inherit old assertions or priority under a reused id', () => {
    const old = { id: 'F-004', description: '参数编辑', priority: 'P0' as const, behavior_assertions: ['非法参数保持原值'] }
    const fresh = { id: 'F-004', description: '真实模型增强' }
    const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'新目标',ui:'none',requirements:[{...fresh,expected:'返回真实增强结果'}]}),
      {projectId:'p',sessionId:'s',source:'新目标',previous:{...sample(),requirements:[old]},software:true})
    expect(parsed?.action).toBe('brief')
    if(parsed?.action==='brief')expect(parsed.brief.requirements[0].behavior_assertions).toEqual(['返回真实增强结果'])
  })
  it('changes evidence versions for behavior revisions but not priority scheduling or reordered peers', () => {
    const source = sample(), item = source.requirements[1]!
    expect(requirementEvidenceHash(source, { ...item, priority: 'P0' })).toBe(requirementEvidenceHash(source, item))
    expect(requirementEvidenceHash(source, { ...item, behavior_assertions: ['请求真实端点'] })).not.toBe(requirementEvidenceHash(source, item))
    const appended = reconcileAcceptanceRevision(source, { ...source, requirements: [...source.requirements, { id: 'F-005', description: '历史查看', behavior_assertions: ['打开历史显示保存项'] }] })
    expect(trustedAcceptance(appended, item)).toBe(source.acceptance[item.id])
    expect(trustedAcceptance(appended, appended.requirements[2]!)).toContain('显示保存项')
  })
})
