import type { SketchRequirement } from '../../main/model/prd-backplane'
import type { RequirementsModel } from '../../main/model/requirements-model'

/** Valid small model for existing routing/name tests; business regression cases use explicit scenarios. */
export function organizedPrd(requirements: SketchRequirement[], sourceText: string) {
  const model: RequirementsModel = {
    version: 1, goal: '帮助用户完成指定任务', target_users: ['个人用户'], sources: [{ id: 'S-001', text: sourceText }],
    entities: [], relations: [], rules: [],
    workflows: [{ id: 'W-001', name: '完成任务', steps: ['输入任务内容', '执行操作', '查看结果'], feature_ids: requirements.map(row => row.id) }],
    scenarios: requirements.flatMap((feature, index) => [
      { id: `AC-${String(index * 3 + 1).padStart(3, '0')}`, feature_id: feature.id, kind: 'normal' as const, given: '有效输入', when: '执行操作', then: '显示操作结果', rule_ids: [] },
      { id: `AC-${String(index * 3 + 2).padStart(3, '0')}`, feature_id: feature.id, kind: 'boundary' as const, given: '没有输入', when: '执行操作', then: '提示输入内容且不提交结果', rule_ids: [] },
      { id: `AC-${String(index * 3 + 3).padStart(3, '0')}`, feature_id: feature.id, kind: 'exception' as const, given: '操作失败', when: '执行操作', then: '显示原因并允许重试', rule_ids: [] },
    ]),
    coverage: [{ source_id: 'S-001', feature_ids: requirements.map(row => row.id), rule_ids: [], disposition: 'included', reason: '主任务进入操作流程和验收' }], open_questions: [],
  }
  return { requirements: requirements.map(row => ({ ...row, priority: row.priority ?? 'P0' })), requirements_model: model }
}
