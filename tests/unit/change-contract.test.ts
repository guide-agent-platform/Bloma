import { afterEach, describe, expect, it } from 'vitest'
import type { PrdBackplane } from '../../main/model/prd-backplane'
import {
  buildChangeContractBlock,
  changeContractEnabled,
  deriveChangeContract,
  renderChangeContractSection,
  roundAnchorFromChangeContract,
} from '../../main/coding/change-contract'

/**
 * Phase 10 W1-4（2026-09-16）：变更契约——RoundAnchor 一般化（三向验收+基线绑定）。
 * 关键语义：①开关缺省 off=buildChangeContractBlock 返回 ''（字节级零注入）；②负向
 * 断言从不变量词表确定性派生，无命中如实为空不编造；③契约→锚投影保 anchor 注入链
 * 兼容；④兼容约束=契约端点+既有数据。
 */
describe('change-contract 开关', () => {
  const originalSwitch = process.env.BLOMA_CHANGE_CONTRACT

  afterEach(() => {
    if (originalSwitch === undefined) delete process.env.BLOMA_CHANGE_CONTRACT
    else process.env.BLOMA_CHANGE_CONTRACT = originalSwitch
  })

  it('缺省 off；1/on/true 开；0/off/false 关', () => {
    delete process.env.BLOMA_CHANGE_CONTRACT
    expect(changeContractEnabled()).toBe(false)
    process.env.BLOMA_CHANGE_CONTRACT = '1'
    expect(changeContractEnabled()).toBe(true)
    process.env.BLOMA_CHANGE_CONTRACT = 'false'
    expect(changeContractEnabled()).toBe(false)
    process.env.BLOMA_CHANGE_CONTRACT = 'true'
    expect(changeContractEnabled()).toBe(true)
    process.env.BLOMA_CHANGE_CONTRACT = '0'
    expect(changeContractEnabled()).toBe(false)
  })

  it('off：buildChangeContractBlock 返回空串（字节级零注入）', () => {
    delete process.env.BLOMA_CHANGE_CONTRACT
    expect(buildChangeContractBlock(null)).toBe('')
    const contract = deriveChangeContract({ goal: 'g', backplane: baseBackplane(), baseline: null })
    expect(buildChangeContractBlock(contract)).toBe('')
  })
})

function baseBackplane(overrides?: Partial<PrdBackplane>): PrdBackplane {
  return {
    project_id: 'p1',
    name: '测试',
    positioning: '',
    requirements: [],
    acceptance: {},
    out_of_scope: [],
    assumptions: [],
    ...overrides,
  } as PrdBackplane
}

describe('deriveChangeContract 确定性派生', () => {
  it('空背板+空 query：goal 透传，各数组空态如实（negative 不编造）', () => {
    const c = deriveChangeContract({ goal: '改一下界面', backplane: baseBackplane(), baseline: null })
    expect(c.goal).toBe('改一下界面')
    expect(c.mustPreserve).toEqual([])
    expect(c.acceptance.negative).toEqual([])
    expect(c.acceptance.positive).toEqual([])
    expect(c.acceptance.compat).toEqual([])
    expect(c.baseline.testReportPresent).toBe(false)
  })

  it('不变量词表命中：非负/必填/唯一生成负向断言并引用功能项 id；无命中不出现', () => {
    const backplane = baseBackplane({
      requirements: [
        { id: 'F-001', description: '记账：金额不能为负数' },
        { id: 'F-002', description: '记录标题必填' },
        { id: 'F-003', description: '标签名唯一' },
        { id: 'F-004', description: '查看记录列表' },
      ] as PrdBackplane['requirements'],
    })
    const c = deriveChangeContract({ goal: 'g', backplane, baseline: null })
    expect(c.acceptance.negative.some((n) => n.includes('F-001') && n.includes('非负'))).toBe(true)
    expect(c.acceptance.negative.some((n) => n.includes('F-002') && n.includes('非空'))).toBe(true)
    expect(c.acceptance.negative.some((n) => n.includes('F-003') && n.includes('唯一'))).toBe(true)
    expect(c.acceptance.negative.some((n) => n.includes('F-004'))).toBe(false)
    expect(c.acceptance.negative.every((n) => n.includes('不得静默通过'))).toBe(true)
  })

  it('mustPreserve：契约端点保持行 + 既有数据行（≤4 条数据）', () => {
    const backplane = baseBackplane({
      interface_spec: [{ endpoint: '/api/notes', method: 'GET' }],
    })
    const c = deriveChangeContract({ goal: 'g', backplane, dataFiles: ['data/notes.json', 'data/extra.json'], baseline: null })
    expect(c.mustPreserve.some((m) => m.includes('GET /api/notes'))).toBe(true)
    expect(c.mustPreserve.some((m) => m.includes('data/notes.json') && m.includes('迁移'))).toBe(true)
    expect(c.acceptance.compat.some((m) => m.includes('404/5xx'))).toBe(true)
    expect(c.acceptance.compat.some((m) => m.includes('旧数据'))).toBe(true)
  })

  it('无 spec 无数据：compat 为空如实', () => {
    const c = deriveChangeContract({ goal: 'g', backplane: baseBackplane(), baseline: null })
    expect(c.acceptance.compat).toEqual([])
  })

  it('outOfScope：固定守卫第一条 + 背板范围外前 3 条', () => {
    const c = deriveChangeContract({
      goal: 'g',
      backplane: baseBackplane({ out_of_scope: ['不做登录', '不做多用户', '不做导出', '第四条不进'] }),
      baseline: null,
    })
    expect(c.outOfScope[0]).toContain('不顺手重构')
    expect(c.outOfScope).toContain('不做登录')
    expect(c.outOfScope).not.toContain('第四条不进')
  })

  it('baseline：有报告透传 passed/total；gitCommit 透传；无报告 present=false', () => {
    const withReport = deriveChangeContract({ goal: 'g', backplane: baseBackplane(), baseline: { passed: 7, total: 8 }, gitCommit: 'abc1234' })
    expect(withReport.baseline).toMatchObject({ testReportPresent: true, passed: 7, total: 8, gitCommit: 'abc1234' })
    const noReport = deriveChangeContract({ goal: 'g', backplane: baseBackplane(), baseline: null })
    expect(noReport.baseline.testReportPresent).toBe(false)
    expect(noReport.baseline.gitCommit).toBeUndefined()
  })

  it('正向验收：聚焦项的行为断言进入 positive（每项≤2 条）', () => {
    const backplane = baseBackplane({
      requirements: [
        { id: 'F-001', description: '主题', behavior_assertions: ['断言A', '断言B', '断言C'] },
        { id: 'F-002', description: '其他' },
      ] as PrdBackplane['requirements'],
    })
    const c = deriveChangeContract({ goal: 'g', backplane, focus: ['F-001'], baseline: null })
    expect(c.acceptance.positive).toEqual(['断言A', '断言B'])
  })
})

describe('渲染与锚投影', () => {
  it('renderChangeContractSection：标题含目标；空段省略；基线两态', () => {
    const empty = deriveChangeContract({ goal: '改界面', backplane: baseBackplane(), baseline: null })
    const section = renderChangeContractSection(empty)
    expect(section).toContain('【变更契约')
    expect(section).toContain('目标：改界面')
    expect(section).not.toContain('必须保留：')
    expect(section).toContain('基线：无历史测试报告')
    const rich = deriveChangeContract({
      goal: 'g',
      backplane: baseBackplane({ interface_spec: [{ endpoint: '/api/notes' }] }),
      dataFiles: ['data/notes.json'],
      baseline: { passed: 3, total: 4 },
      gitCommit: 'abc1234',
    })
    const richSection = renderChangeContractSection(rich)
    expect(richSection).toContain('必须保留')
    expect(richSection).toContain('git abc1234')
    expect(richSection).toContain('不得低于该基线')
  })

  it('roundAnchorFromChangeContract：契约投影回锚（空 mustPreserve 回退默认行；完成证据含三向验收）', () => {
    const empty = deriveChangeContract({ goal: 'g', backplane: baseBackplane(), baseline: null })
    const anchorEmpty = roundAnchorFromChangeContract(empty)
    expect(anchorEmpty.must_preserve).toEqual(['全部 P0 功能项断言保持通过'])
    expect(anchorEmpty.completion_evidence).toContain('run_gwt_tests 全量不回退')

    const rich = deriveChangeContract({
      goal: 'g',
      backplane: baseBackplane({
        requirements: [{ id: 'F-001', description: '金额不能为负数' }] as PrdBackplane['requirements'],
        interface_spec: [{ endpoint: '/api/notes' }],
      }),
      baseline: { passed: 1, total: 2 },
    })
    const anchor = roundAnchorFromChangeContract(rich)
    expect(anchor.must_preserve.some((m) => m.includes('/api/notes'))).toBe(true)
    expect(anchor.completion_evidence.some((e) => e.includes('F-001') && e.includes('不得静默通过'))).toBe(true)
  })

  it('on：buildChangeContractBlock 返回前导空行+渲染段', () => {
    process.env.BLOMA_CHANGE_CONTRACT = '1'
    try {
      const c = deriveChangeContract({ goal: 'g', backplane: baseBackplane(), baseline: null })
      const block = buildChangeContractBlock(c)
      expect(block.startsWith('\n\n【变更契约')).toBe(true)
    } finally {
      delete process.env.BLOMA_CHANGE_CONTRACT
    }
  })
})
