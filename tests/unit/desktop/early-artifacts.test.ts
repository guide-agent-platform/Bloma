import { describe, it, expect } from 'vitest'
import { organizedPrd } from '../../support/organized-prd'
import { architecturePlanIssues, earlyArtifactIssues } from '../../../main/desktop/early-artifacts'
import { prdScopeFingerprint } from '../../../main/project/requirement-contract'
import { finalizeDesktopDispatch } from '../../../main/desktop/dispatcher-finalize'
import { getDesktopPhase } from '../../../main/desktop/dispatcher-phases'
import { readFileSync } from 'node:fs'

function data() {
  const organized = organizedPrd([{ id: 'F-001', description: '计算材料用量' }], '各材料用量合计等于总量')
  organized.requirements_model.entities = [{ id: 'O-001', name: '配方', description: '批次与材料比例', attributes: ['批次量', '比例'] }]
  organized.requirements_model.rules = [{ id: 'BR-001', statement: '用量守恒', feature_ids: ['F-001'], source_ids: ['S-001'], origin: 'user' }]
  const prd = { project_id: 'p-early', name: '配方', positioning: '配方工具', requirements: organized.requirements, requirements_model: organized.requirements_model, acceptance: {}, assumptions: [], out_of_scope: [] }
  const plan = { version: 1, prd_fingerprint: prdScopeFingerprint(prd), modules: [{ path: 'core/domain.py', responsibility: '计算与校验', feature_ids: ['F-001'], rule_ids: ['BR-001'] }],
    data_boundaries: [{ entity_id: 'O-001', owner: 'core/domain.py', persistence: '本机持久保存', failure_policy: '失败保留旧数据且允许重试' }],
    validation: ['AC-001', 'AC-002', 'AC-003'].map(id => ({ scenario_id: id, module: 'core/domain.py', method: '使用固定输入核对结果、边界与失败副作用' })) }
  return { prd, plan }
}

describe('架构/骨架的前置内容检查', () => {
  it('合法模块、数据与验证关联可以通过，缺规则或场景不能通过', () => {
    const { prd, plan } = data()
    expect(architecturePlanIssues(plan, prd)).toEqual([])
    plan.modules[0]!.rule_ids = []
    plan.validation.pop()
    expect(architecturePlanIssues(plan, prd)).toContain('规则 未落实架构位置：BR-001')
    expect(architecturePlanIssues(plan, prd)).toContain('验收场景 未落实架构位置：AC-003')
  })
  it('需求变化、未知功能和越界模块路径均被拒绝', () => {
    const { prd, plan } = data()
    plan.modules[0]!.feature_ids.push('F-999')
    expect(architecturePlanIssues(plan, prd)).toContain('模块功能 引用未知编号：F-999')
    plan.modules[0]!.path = '..\\outside.py'
    expect(architecturePlanIssues(plan, prd)).toContain('模块路径或职责无效')
    prd.requirements_model.goal += ' changed'
    expect(architecturePlanIssues(plan, prd)[0]).toContain('未绑定当前 PRD')
  })
  it('格式正确的文件也必须说明真实环境字段与业务映射', () => {
    const { prd, plan } = data()
    const files: Record<string, string> = { '00_ARCH/architecture.md': '# 架构\n计算模块负责用量，失败时保留旧数据',
      '00_ARCH/env-checklist.json': JSON.stringify({ components: [{ name: 'Python', source: 'skeleton', evidence: 'documented' }] }),
      '00_ARCH/architecture.json': JSON.stringify(plan) }
    expect(earlyArtifactIssues('desktop-arch', path => files[path], prd)).toEqual([])
    files['00_ARCH/env-checklist.json'] = '{}'
    expect(earlyArtifactIssues('desktop-arch', path => files[path], prd).some(issue => issue.includes('components'))).toBe(true)
  })
  it('存在性通过后仍拒绝空架构、非法JSON，而不是放到实现后才发现', () => {
    const files: Record<string, string> = { '00_ARCH/architecture.md': '', '00_ARCH/env-checklist.json': 'not-json' }
    const node = getDesktopPhase('desktop-arch')!
    const result = finalizeDesktopDispatch(node, { projectId: 'missing-context', artifactExists: () => true, artifactRead: (path: string) => files[path], projectName: 'example' } as never,
      { flush: () => [[{ type: 'text', text: 'PHASE_ADVANCE: desktop-scaffold' }]] } as never)
    expect(result.advance.decision).toBe('reject')
    if (result.advance.decision !== 'reject') return
    expect(result.advance.education).toContain('架构文档为空')
    expect(result.advance.education).toContain('不是合法 JSON')
  })
  it('非法工程契约、空驱动在骨架阶段就被拒绝', () => {
    const files: Record<string, string> = { '00_SCAFFOLD/contract.json': 'not-json', '00_SCAFFOLD/driver-skeleton.py': '' }
    const result = finalizeDesktopDispatch(getDesktopPhase('desktop-scaffold')!, { projectId: 'missing-context', artifactExists: () => true, artifactRead: (path: string) => files[path], projectName: 'example' } as never,
      { flush: () => [[{ type: 'text', text: 'PHASE_ADVANCE: desktop-implement' }]] } as never)
    expect(result.advance.decision).toBe('reject')
    if (result.advance.decision !== 'reject') return
    expect(result.advance.education).toContain('工程契约无效')
    expect(result.advance.education).toContain('驱动骨架为空')
  })
  it('当前需求的全部功能须先登记，不能沿用旧契约或只登记骨架自检', () => {
    const { prd } = data()
    const more = organizedPrd([{ id: 'F-001', description: '计算' }, { id: 'F-002', description: '导出' }], '计算与导出')
    prd.requirements = more.requirements; prd.requirements_model = more.requirements_model
    const contract = JSON.parse(readFileSync('main/templates/skeletons/desktop-python/contract.json', 'utf8'))
    const files: Record<string, string> = { '00_SCAFFOLD/contract.json': JSON.stringify(contract), '00_SCAFFOLD/driver-skeleton.py': '# nonempty scaffold\n' }
    const missing = earlyArtifactIssues('desktop-scaffold', path => files[path], prd)
    expect(missing).toContain('工程契约未绑定当前需求范围版本')
    expect(missing).toContain('工程契约尚未登记已确认功能：F-002')
    contract.prd_fingerprint = prdScopeFingerprint(prd)
    contract.scenarios.push({ name: 'export', covers: ['F-002'] })
    files['00_SCAFFOLD/contract.json'] = JSON.stringify(contract)
    expect(earlyArtifactIssues('desktop-scaffold', path => files[path], prd)).toEqual([])
  })
})
