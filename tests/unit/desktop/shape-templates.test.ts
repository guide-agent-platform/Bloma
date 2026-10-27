/**
 * 批9 形状体系单测（2026-10-07）：
 * - parseProductShape 白名单解析与降级（prd-engine-llm）；
 * - evaluateShapeGate 确定性拦截规则（open questions 铁律/结构缺口/空候选）；
 * - renderShapeDigest / renderUxDigest 九态（requirement-digest）；
 * - shape-templates 表完整性校验 + renderShapeBrief/renderShapeVerifyBrief 条件求值。
 */
import { describe, expect, it } from 'vitest'

import { renderShapeDigest, renderUxDigest } from '../../../main/desktop/requirement-digest'
import {
  SHAPE_TEMPLATES,
  validateShapeTemplateTable,
  evalShapeCondition,
  renderShapeBrief,
  renderShapeVerifyBrief,
  listShapeDefaults,
} from '../../../main/desktop/shape-templates'
import type { ProductShape } from '../../../main/model/prd-backplane'

/** 合法最小 shape 原始对象（record_manager）。 */
function validShapeRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host_template: 'record_manager',
    modules: [],
    primary_loop: '打开→记一笔→列表可见',
    fact_source: '每笔记录',
    needs_resident: false,
    needs_network: false,
    task_duration: 'instant',
    destructive_ops: [],
    llm_role: 'none',
    job_policy: { cancellable: true, progress: true, close_policy: 'wait_or_confirm' },
    candidates: [{ template: 'record_manager', reasons: ['事实来源是记录'] }],
    architecture_open_questions: [],
    ...overrides,
  }
}






describe('shape-templates 表完整性（批9 工件2）', () => {
  it('四模板表校验通过（conditional 带 condition/invariant+forbidden 最小骨架/九态白名单）', () => {
    const validation = validateShapeTemplateTable()
    expect(validation.violations).toEqual([])
    expect(validation.valid).toBe(true)
  })

  it('缺模板/坏规则被校验捕获', () => {
    const broken = { ...SHAPE_TEMPLATES } as Record<string, typeof SHAPE_TEMPLATES.record_manager>
    delete broken.instant_utility
    const validation = validateShapeTemplateTable(broken)
    expect(validation.violations.some((v) => v.includes('缺模板 instant_utility'))).toBe(true)

    const badRule = {
      ...SHAPE_TEMPLATES.record_manager,
      rules: [{ kind: 'conditional', requirement: '无条件的条件规则' } as never],
    }
    const validation2 = validateShapeTemplateTable({ ...SHAPE_TEMPLATES, record_manager: badRule })
    expect(validation2.violations.some((v) => v.includes('conditional 规则缺 condition'))).toBe(true)
  })

  it('listShapeDefaults 返回 default 规则子集', () => {
    const defaults = listShapeDefaults('job_runner')
    expect(defaults.length).toBeGreaterThan(0)
    expect(defaults.every((rule) => rule.kind === 'default')).toBe(true)
  })
})
