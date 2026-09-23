/**
 * buildPrdDocumentFallback 单测（2026-09-03 长文本 PRD dual-form）。
 *
 * 验证机械拼装兜底：确定性投影（不编内容）——结构化字段进、长文本出；
 * 空数组/缺字段的合法形态（「无特殊约束」「本轮无明确排除项」「无」）；
 * 以及同源一致性（验收要点/断言逐字出现）。
 */
import { describe, expect, it } from 'vitest'
import { buildPrdDocumentFallback, requirementStory } from '../../main/coding/sketch-engine'
import type { SketchRequirement } from '../../main/coding/sketch-engine'

const items: SketchRequirement[] = [
  {
    id: 'F-001',
    description: '记录收入与支出',
    origin: 'user',
    story: '作为家庭成员，我想记录每笔收支，以便月底看清花销',
    behavior_assertions: ['点击保存按钮→列表新增一条记录'],
    priority: 'P0',
  },
]

describe('buildPrdDocumentFallback', () => {
  it('投影结构化字段为长文本（定位/故事/验收/断言逐字出现）', () => {
    const doc = buildPrdDocumentFallback({
      positioning: '家庭记账工具',
      requirements: items,
      acceptance: { 'F-001': '正常：新增后列表可见；边界：金额为空提示错误' },
      out_of_scope: ['多用户协作'],
      assumptions: ['金额单位为人民币元'],
      constraints: ['必须离线可用'],
    })
    expect(doc).toContain('# PRD：家庭记账工具')
    expect(doc).toContain('## 一、产品定位')
    expect(doc).toContain('### [F-001]（P0）' + requirementStory(items[0]))
    expect(doc).toContain('验收要点：正常：新增后列表可见；边界：金额为空提示错误')
    expect(doc).toContain('- 点击保存按钮→列表新增一条记录')
    expect(doc).toContain('- 必须离线可用')
    expect(doc).toContain('- 多用户协作')
    expect(doc).toContain('- 金额单位为人民币元')
  })

  it('空数组走合法缺省文案，不编内容', () => {
    const doc = buildPrdDocumentFallback({
      positioning: '番茄钟',
      requirements: items,
      out_of_scope: [],
      assumptions: [],
    })
    expect(doc).toContain('- 无特殊约束')
    expect(doc).toContain('- 本轮无明确排除项')
    expect(doc).toContain('- 无')
    expect(doc).toContain('机械拼装生成')
  })
})
