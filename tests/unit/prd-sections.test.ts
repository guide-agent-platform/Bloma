import { describe, expect, it } from 'vitest'
import {
  PRD_SECTIONS,
  PRD_SECTIONS_SCHEMA_VERSION,
  checkSectionCompleteness,
  clarifyGapSections,
  renderDocumentSectionSpec,
  requiredSections,
} from '../../main/prd-sections'
import {
  backplaneGlossary,
  backplanePages,
  backplanePersonas,
  backplaneTemplateMeta,
  defaultConstraintLevel,
  TEMPLATE_META_VERSION,
  type PrdBackplane,
} from '../../main/sketch-engine'

function makeBackplane(overrides: Partial<PrdBackplane> = {}): PrdBackplane {
  return {
    project_id: 'p1',
    name: '番茄钟',
    positioning: '给个人的专注计时工具',
    requirements: [
      { id: 'F-001', description: '做一个番茄钟计时器', priority: 'P0', behavior_assertions: ['点击开始 → 计时启动'] },
    ],
    acceptance: {},
    out_of_scope: [],
    assumptions: [],
    ...overrides,
  }
}

describe('prd-sections（P1：章节 schema + 必填矩阵）', () => {
  it('章节 schema 带版本字段且 id 唯一', () => {
    expect(PRD_SECTIONS_SCHEMA_VERSION).toBe(1)
    const ids = PRD_SECTIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('quick×loose = 五必填（定位/功能/页面/断言/GWT/范围外，方案 §二）', () => {
    const ids = requiredSections('quick', 'loose').map((s) => s.id)
    expect(ids).toContain('positioning')
    expect(ids).toContain('requirements')
    expect(ids).toContain('pages')
    expect(ids).toContain('assertions')
    expect(ids).toContain('gwt')
    expect(ids).toContain('out_of_scope')
    expect(ids).not.toContain('personas')
    expect(ids).not.toContain('interface_spec')
  })

  it('longterm×standard = +personas/glossary/interface_spec（12.4 标准级行）', () => {
    const ids = requiredSections('longterm', 'standard').map((s) => s.id)
    expect(ids).toContain('personas')
    expect(ids).toContain('glossary')
    expect(ids).toContain('interface_spec')
  })

  it('interface_spec 标准级起必填（loose 级不要求）', () => {
    expect(requiredSections('longterm', 'loose').map((s) => s.id)).not.toContain('interface_spec')
    expect(requiredSections('longterm', 'standard').map((s) => s.id)).toContain('interface_spec')
  })

  it('quick 不含 longterm 专属章节（模式切片，模板永不整本进上下文）', () => {
    for (const section of requiredSections('quick', 'standard')) {
      expect(section.quickRequired).toBe(true)
    }
  })

  describe('checkSectionCompleteness（完备性只标记，不编造）', () => {
    it('标准 quick 背板全绿', () => {
      const result = checkSectionCompleteness(makeBackplane(), 'quick', 'loose')
      expect(result.missing).toHaveLength(0)
      expect(result.present).toContain('assertions')
    })

    it('positioning 空 → missing（reason 如实）', () => {
      const result = checkSectionCompleteness(makeBackplane({ positioning: '' }), 'quick', 'loose')
      expect(result.missing.map((m) => m.section.id)).toContain('positioning')
    })

    it('宽松级：至少一个 P0 项有断言即过（quick 现状兼容——enricher 可选）', () => {
      const result = checkSectionCompleteness(makeBackplane(), 'quick', 'loose')
      expect(result.missing).toHaveLength(0)
    })

    it('宽松级：无任何断言 → assertions missing', () => {
      const noAssertion = makeBackplane({
        requirements: [{ id: 'F-001', description: '做一个番茄钟', priority: 'P0' }],
      })
      const result = checkSectionCompleteness(noAssertion, 'quick', 'loose')
      expect(result.missing.map((m) => m.section.id)).toContain('assertions')
    })

    it('标准级：每个 P0 项都需断言（升级口径）', () => {
      const result = checkSectionCompleteness(makeBackplane(), 'longterm', 'standard')
      // 标准级还要求 personas/glossary/interface_spec
      const missingIds = result.missing.map((m) => m.section.id)
      expect(missingIds).toContain('personas')
      expect(missingIds).toContain('glossary')
    })

    it('longterm 全字段补齐后全绿', () => {
      const full = makeBackplane({
        personas: ['学生'],
        glossary: [{ term: '番茄钟', definition: '25 分钟专注单元' }],
        interface_spec: [],
      })
      const result = checkSectionCompleteness(full, 'longterm', 'standard')
      expect(result.missing).toHaveLength(0)
    })

    it('out_of_scope 空数组合法（「用户没拒绝任何东西」是事实不是缺失）', () => {
      const result = checkSectionCompleteness(makeBackplane({ out_of_scope: [] }), 'quick', 'loose')
      expect(result.missing.map((m) => m.section.id)).not.toContain('out_of_scope')
    })
  })

  describe('clarifyGapSections（注入点②：只问缺口，Spec Kit 上限 3 纪律）', () => {
    it('无缺口 → 空数组（不为已完备章节发问）', () => {
      expect(clarifyGapSections('quick', 'loose', checkSectionCompleteness(makeBackplane(), 'quick', 'loose'))).toEqual([])
    })

    it('有缺口 → 缺口文案（≤3 条）', () => {
      const result = checkSectionCompleteness(makeBackplane({ positioning: '' }), 'quick', 'loose')
      const gaps = clarifyGapSections('quick', 'loose', result)
      expect(gaps).toHaveLength(1)
      expect(gaps[0]).toContain('产品定位')
    })
  })
})

describe('PrdBackplane P1 扩展字段读取兜底（旧 prd.json 零迁移）', () => {
  it('backplanePages：显式 pages 优先，quick 截断 ≤3', () => {
    const bp = makeBackplane({
      pages: [
        { name: '计时页', purpose: '主界面' },
        { name: '统计页' },
        { name: '设置页' },
        { name: '第四页' },
      ],
    })
    expect(backplanePages(bp, 'quick')).toHaveLength(3)
    expect(backplanePages(bp, 'longterm')).toHaveLength(4)
  })

  it('backplanePages：无 pages 从 requirements 前 3 项派生（兼容旧背板）', () => {
    const pages = backplanePages(makeBackplane(), 'quick')
    expect(pages).toHaveLength(1)
    expect(pages[0].name).toContain('番茄钟')
  })

  it('backplaneGlossary/Personas：缺省空数组', () => {
    expect(backplaneGlossary(makeBackplane())).toEqual([])
    expect(backplanePersonas(makeBackplane())).toEqual([])
  })

  it('defaultConstraintLevel：personal_tool=loose，其余 standard（PRD 12.3）', () => {
    expect(defaultConstraintLevel('personal_tool')).toBe('loose')
    expect(defaultConstraintLevel('web_fullstack')).toBe('standard')
    expect(defaultConstraintLevel('desktop_tool')).toBe('standard')
  })

  it('backplaneTemplateMeta：缺省按项目类型兜底构造，不回写', () => {
    const bp = makeBackplane()
    const meta = backplaneTemplateMeta(bp, 'personal_tool')
    expect(meta).toEqual({ type: 'personal_tool', level: 'loose', version: TEMPLATE_META_VERSION })
    expect(bp.template_meta).toBeUndefined()
  })
})

describe('P2-10：document 章节由 schema 驱动（renderDocumentSectionSpec）', () => {
  it('章节由 PRD_SECTIONS 渲染（含新增 constraints/assumptions/gdd），单一来源', () => {
    const spec = renderDocumentSectionSpec()
    expect(spec).toContain('产品定位')
    expect(spec).toContain('功能清单')
    expect(spec).toContain('范围外')
    expect(spec).toContain('用户约束') // P2-10 新增（原 document 八节「用户约束」的 schema 化）
    expect(spec).toContain('后台假设') // P2-10 新增
    expect(spec).toContain('设计文档（GDD）') // P1-7 新增
    // 不含 prd_document 自身（全文不是章节）
    expect(spec).not.toContain('PRD 全文')
  })

  it('章节顺序与 PRD_SECTIONS 一致（加章节自动同步，不再硬编码）', () => {
    const spec = renderDocumentSectionSpec()
    expect(spec.indexOf('设计文档（GDD）')).toBeGreaterThan(spec.indexOf('API Spec'))
    expect(spec.indexOf('用户约束')).toBeGreaterThan(spec.indexOf('范围外'))
  })
})
