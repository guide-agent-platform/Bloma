import { describe, expect, it } from 'vitest'
import { organizedPrd } from '../support/organized-prd'
import type { PrdBackplane } from '../../main/model/prd-backplane'
import { parseOrganizedRequirements, prdStructureIssues, projectRequirementsModel, validateRequirementsModel } from '../../main/model/requirements-model'
import { bindAcceptance, requirementEvidenceHash } from '../../main/project/requirement-contract'
import { validateDefenderDraft, buildWritePrdDraftTool } from '../../main/review/prd-defender'
import { buildPrdReviewTask, buildRecheckTask } from '../../main/review/prd/prd-review-prompts'

function processPrd(): PrdBackplane {
  const input = organizedPrd([
    { id: 'F-001', description: '计算材料用量' }, { id: 'F-002', description: '保存轮次' }, { id: 'F-003', description: '导入方案' },
  ], '材料用量总和等于批次量，导入后也必须一致。')
  input.requirements_model.entities = [
    { id: 'O-001', name: '方案', description: '拥有多个不可变轮次', attributes: ['名称'] },
    { id: 'O-002', name: '轮次', description: '保存当时的参数和计算结果', attributes: ['批次量', '材料比例', '用量'] },
  ]
  input.requirements_model.relations = [{ from: 'O-001', to: 'O-002', description: '一对多，轮次归属方案' }]
  input.requirements_model.rules = [{ id: 'BR-001', statement: '舍入后各材料用量总和等于批次量，导入需重新核算派生用量', feature_ids: ['F-001', 'F-002', 'F-003'], source_ids: ['S-001'], origin: 'user' }]
  input.requirements_model.coverage[0]!.rule_ids = ['BR-001']
  input.requirements_model.scenarios.forEach(row => { if (row.kind === 'normal') row.rule_ids = ['BR-001'] })
  input.requirements_model.scenarios[0] = { id: 'AC-001', feature_id: 'F-001', kind: 'normal', given: '批次0.03kg，材料A/B各50%', when: '计算用量', then: '两项用量合计0.03kg，不能各取0.02kg后得到0.04kg', rule_ids: ['BR-001'] }
  input.requirements_model.scenarios[6] = { id: 'AC-007', feature_id: 'F-003', kind: 'normal', given: '导入120kg、A/B=70/30，A派生用量被改为999', when: '导入方案', then: '拒绝不一致数据或重算为84/36，不保留999', rule_ids: ['BR-001'] }
  const parsed = parseOrganizedRequirements(input, input.requirements_model.sources)!
  return projectRequirementsModel(bindAcceptance({ project_id: 'process', name: '工艺轮次', positioning: '工艺人员管理方案与轮次', requirements: parsed.requirements,
    requirements_model: parsed.model, acceptance: Object.fromEntries(parsed.requirements.map(row => [row.id, row.behavior_assertions!.join('；')])), out_of_scope: [], assumptions: ['差额配平到最大占比材料'] }))
}

describe('业务需求模型与同源正文', () => {
  it('目标、对象、流程和共享规则通过关联进入验收；保留固定数值反例', () => {
    const prd = processPrd()
    expect(prdStructureIssues(prd)).toEqual([])
    expect(prd.prd_document).toContain('O-001 → O-002')
    expect(prd.prd_document).toContain('0.03kg')
    expect(prd.prd_document).toContain('84/36')
    expect(prd.prd_document).toContain('F-001、F-002、F-003')
  })

  it('跨功能规则只测试计算、未测试导入时不能算覆盖', () => {
    const prd = processPrd()
    prd.requirements_model!.scenarios[6]!.rule_ids = []
    expect(validateRequirementsModel(prd.requirements_model, prd.requirements)).toContain('BR-001 未在关联功能 F-003 的验收中覆盖')
  })

  it('从已有场景引用生成反向规则关联，不发明场景或吞掉未知编号', () => {
    const prd = processPrd(), input = { requirements: prd.requirements, requirements_model: structuredClone(prd.requirements_model!) }
    input.requirements_model.rules[0]!.feature_ids = ['F-001']
    const parsed = parseOrganizedRequirements(input, input.requirements_model.sources)!
    expect(parsed.model.rules[0]!.feature_ids).toEqual(['F-001', 'F-002', 'F-003'])
    expect(parsed.link_notes).toHaveLength(2)
    expect(parsed.model.scenarios).toEqual(input.requirements_model.scenarios)
    expect(input.requirements_model.rules[0]!.feature_ids).toEqual(['F-001'])
    input.requirements_model.scenarios[0]!.rule_ids.push('BR-999')
    expect(parseOrganizedRequirements(input, input.requirements_model.sources)).toBeUndefined()
  })

  it('拦截遗漏来源、未知编号、缺少异常路径和伪造豁免', () => {
    const prd = processPrd(), model = prd.requirements_model!
    model.coverage = []
    model.workflows[0]!.feature_ids.push('F-999')
    model.scenarios = model.scenarios.filter(row => row.id !== 'AC-003')
    model.scenarios[0]!.not_applicable = '这个正常路径不需要测试所以跳过它。'
    const issues = validateRequirementsModel(model, prd.requirements)
    expect(issues).toContain('原始来源未说明处理方式：S-001')
    expect(issues).toContain('W-001 功能 引用不存在：F-999')
    expect(issues).toContain('F-001 缺少 exception 验收场景或明确豁免')
    expect(issues.some(row => row.includes('普通路径不可豁免'))).toBe(true)
  })

  it('仅在示例中提及编号不会产生功能，真正的正文编号分裂则被拦截', () => {
    const prd = processPrd()
    prd.assumptions.push('US-99 仅为外部编号示例')
    const projected = projectRequirementsModel(prd)
    expect(prdStructureIssues(projected)).toEqual([])
    expect(projected.requirements).toHaveLength(3)
    expect(prdStructureIssues({ ...projected, prd_document: projected.prd_document + '\n### [F-012] 非清单能力' })).toContain('PRD 正文与功能清单编号不一致')
  })

  it('审查和复核实际拿到完整模型、正文、验收与假设', () => {
    const prd = processPrd()
    for (const task of [buildPrdReviewTask(prd, prd.requirements), buildRecheckTask(prd, [], [])]) {
      expect(task).toContain('requirements_model')
      expect(task).toContain('prd_document')
      expect(task).toContain('acceptance')
      expect(task).toContain('差额配平到最大占比材料')
    }
  })

  it('规则或假设变化使旧验收哈希失效，即使功能描述未变', () => {
    const prd = processPrd(), original = requirementEvidenceHash(prd, prd.requirements[0]!)
    const revised = structuredClone(prd)
    revised.requirements_model!.rules[0]!.statement = '配平差额由另一材料承担'
    expect(requirementEvidenceHash(revised, revised.requirements[0]!)).not.toBe(original)
    revised.requirements_model = prd.requirements_model
    revised.assumptions = ['另一项假设']
    expect(requirementEvidenceHash(revised, revised.requirements[0]!)).not.toBe(original)
  })

  it('修订保留合法假设和场景修改，重建正文与验收，不继承确认状态', () => {
    const prd = processPrd(); prd.user_confirmed_at = 'old'
    const draft = structuredClone(prd)
    draft.assumptions.push('保存失败时旧轮次保持不变')
    draft.requirements_model!.scenarios[0]!.then = '用量合计0.03kg，差额归最大占比材料'
    const result = validateDefenderDraft(prd, draft)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.draft.backplane.assumptions).toContain('保存失败时旧轮次保持不变')
    expect(result.draft.backplane.acceptance['F-001']).toContain('差额归最大占比材料')
    expect(result.draft.backplane.prd_document).toContain('差额归最大占比材料')
    expect(result.draft.backplane.user_confirmed_at).toBeUndefined()
    expect(prdStructureIssues(result.draft.backplane)).toEqual([])
  })

  it('工具即时拒绝伪造用户来源，允许随后提交修好的草稿并报告字段处理', async () => {
    const prd = processPrd(), drafts: unknown[] = []
    const writer = buildWritePrdDraftTool(draft => drafts.push(draft), prd)
    const context = { projectId: 'process', sessionId: 'review', requestId: 'r', signal: new AbortController().signal, state: {} as never }
    const draft = structuredClone(prd)
    draft.requirements_model!.sources[0]!.text = '用户要求其他功能'
    const rejected = await writer.tool.execute({ backplane: draft, dispositions: [] }, context)
    expect(rejected.isError).toBe(true)
    expect(writer.hasDraft()).toBe(false)
    const accepted = await writer.tool.execute({ backplane: prd, dispositions: [] }, context)
    expect(accepted.output).toContain('字段处理')
    expect(drafts).toHaveLength(1)
  })
})
