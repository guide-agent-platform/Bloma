import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ruleGateReview } from '../../main/review/prd-review'
import { syncDocuments } from '../../main/project/document-engine'
import { createProject, recordSketchGenerated } from '../../main/project/project-service'
import type { PrdBackplane, SketchRequirement } from "../../main/model/prd-backplane";

/** 注入点④内审变体 + ⑧judge 版本一致性（P6，最后做——消费前面所有产物）。 */

vi.mock('../../main/project/decision-log', () => ({ recordDecision: vi.fn() }))

const requirements: SketchRequirement[] = [
  { id: 'F-001', description: '做一个番茄钟', priority: 'P0', behavior_assertions: ['点击开始按钮 → 系统优雅处理计时'] },
]

function makeBackplane(overrides: Partial<PrdBackplane> = {}): PrdBackplane {
  return {
    project_id: 'p1',
    name: '番茄钟',
    positioning: '专注计时工具',
    requirements,
    acceptance: {},
    out_of_scope: [],
    assumptions: [],
    template_meta: { type: 'personal_tool', level: 'loose', version: 1 },
    ...overrides,
  }
}

describe('注入点④内审变体（章节完备性 + EARS 可测性）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-p6-'))
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  describe('规则门确定性检查（LLM 不可用降级同享模板体系）', () => {
    it('quick：必填章节缺失 → major issue（G 维，附人话问题与选项）', () => {
      const backplane = makeBackplane({ positioning: '' })
      const outcome = ruleGateReview(backplane, 'quick')
      const missing = outcome.issues.find((issue) => issue.location === 'positioning')
      expect(missing).toBeDefined()
      expect(missing?.severity).toBe('major')
      expect(missing?.dimension).toBe('G')
      expect(missing?.plain_question).toContain('产品定位')
      expect(outcome.verdict).toBe('needs_revision')
    })

    it('longterm：宽松模板攻出 personas/glossary；标准模板再攻出 interface_spec（12.4 矩阵）', () => {
      const looseOutcome = ruleGateReview(makeBackplane(), 'longterm')
      const missingIds = looseOutcome.issues.map((issue) => issue.location)
      expect(missingIds).toContain('personas')
      expect(missingIds).toContain('glossary')
      expect(missingIds).not.toContain('interface_spec') // 12.4 宽松列无 API Spec 要求

      const standardBackplane = makeBackplane({ template_meta: { type: 'web_fullstack', level: 'standard', version: 1 } })
      const standardOutcome = ruleGateReview(standardBackplane, 'longterm')
      expect(standardOutcome.issues.map((issue) => issue.location)).toContain('interface_spec')
    })

    it('longterm：断言禁词直查 → major（禁词表三处同源）', () => {
      const outcome = ruleGateReview(
        makeBackplane({
          personas: ['学生'],
          glossary: [{ term: '番茄钟', definition: '专注单元' }],
          interface_spec: [],
          requirements: [
            { id: 'F-001', description: '番茄钟', priority: 'P0', behavior_assertions: ['点击开始 → 系统合理处理'] },
          ],
        }),
        'longterm',
      )
      const forbidden = outcome.issues.find((issue) => issue.claim.includes('不可测措辞'))
      expect(forbidden).toBeDefined()
      expect(forbidden?.severity).toBe('major')
      expect(forbidden?.location).toBe('F-001')
    })

    it('quick：禁词不在规则门检查范围（longterm 专属 EARS 可测性维度）', () => {
      const outcome = ruleGateReview(makeBackplane(), 'quick')
      expect(outcome.issues.some((issue) => issue.claim.includes('不可测措辞'))).toBe(false)
    })

    it('章节齐全时规则门不追加模板 issue（宁松勿严，不强行找茬）', () => {
      const full = makeBackplane({
        requirements: [{ id: 'F-001', description: '番茄钟', priority: 'P0', behavior_assertions: ['点击开始按钮 → 计时启动'] }],
      })
      const outcome = ruleGateReview(full, 'quick')
      expect(outcome.issues.filter((issue) => issue.claim.includes('必填章节'))).toHaveLength(0)
    })
  })
})
