import { describe, expect, it } from 'vitest'
import { requirementCapabilities } from '../../main/model/requirement-capabilities'
import { deriveAiCapabilities, type PrdBackplane } from '../../main/model/prd-backplane'
import { requirementEvidenceHash } from '../../main/project/requirement-contract'
import { parseOrganizedRequirements } from '../../main/model/requirements-model'
import { organizedPrd } from '../support/organized-prd'
import { applyNormalization } from '../../main/guide/requirement-normalizer'

describe('confirmed verification capabilities', () => {
  it('does not turn ordinary organization, negated requirements or contact renaming into provider/filesystem work', () => {
    for (const description of ['按日期整理本地文件', '不需要语音识别', '不需要真实模型调用', '联系人按编号前缀筛选并支持给联系人改名']) {
      expect([...requirementCapabilities({ id: 'F-001', description })], description).toEqual([])
      expect(deriveAiCapabilities([{ id: 'F-001', description }])).toBeUndefined()
    }
  })
  it('uses explicit declarations and required implications instead of vocabulary guesses', () => {
    expect([...requirementCapabilities({ id: 'F-001', description: '语音模型简介', capabilities: [] })]).toEqual([])
    expect(requirementCapabilities({ id: 'F-001', description: '通过硬件输入', capabilities: ['microphone'] }).has('speech')).toBe(true)
    expect(requirementCapabilities({ id: 'F-001', description: '撤销刚才的文件操作', capabilities: ['rename_undo'] }).has('prefix_rename')).toBe(true)
    expect(() => requirementCapabilities({ id: 'F-001', description: '旧文档', capabilities: ['invented'] as never })).toThrow('INVALID_REQUIREMENT_CAPABILITIES')
  })
  it('invalidates verification when confirmed capabilities change, without changing legacy versions for absent metadata', () => {
    const item = { id: 'F-001', description: '处理输入' }
    const bp = { requirements: [item] } as PrdBackplane
    const original = requirementEvidenceHash(bp, item)
    expect(requirementEvidenceHash(bp, { ...item, capabilities: undefined })).toBe(original)
    expect(requirementEvidenceHash(bp, { ...item, capabilities: [] })).not.toBe(original)
    expect(requirementEvidenceHash(bp, { ...item, capabilities: ['llm'] })).not.toBe(requirementEvidenceHash(bp, { ...item, capabilities: [] }))
  })
  it('preserves capability declarations in structured PRD parsing and rejects unknown adapters', () => {
    const raw = organizedPrd([{ id: 'F-001', description: '本地管理', capabilities: [] }], '本地管理')
    expect(parseOrganizedRequirements(raw, raw.requirements_model.sources)?.requirements[0].capabilities).toEqual([])
    raw.requirements[0].capabilities = ['invented'] as never
    expect(parseOrganizedRequirements(raw, raw.requirements_model.sources)).toBeUndefined()
  })
  it('does not carry an old adapter declaration across a normalized behavior revision', () => {
    const revised = applyNormalization([{ id: 'F-002', description: '模型增强', capabilities: ['llm'] }],
      { action: 'revise', reviseId: 'F-002', description: '按日期整理文件', via: 'llm' }, 'F-003')
    expect(revised[0].capabilities).toBeUndefined()
    expect([...requirementCapabilities(revised[0])]).toEqual([])
  })
})
