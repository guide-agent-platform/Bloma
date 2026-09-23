/**
 * Phase 7 U1 H1 delivery_status 交付状态（2026-09-10，E1 咨询 H1 / P7 实施稿 §2）。
 *
 * 覆盖：开关语义（off=字节级现状）、规则计算全分支（verified/partial/unavailable、
 * 场景归属、API 契约失败不归属、preflight 从严）、B0 六样本重放验收
 * （bench/runs b0 档案真实失败清单——全部落 partial/unavailable，无一 verified，
 * 「错误放行在产品层清零」的规则层验收）、写入 helper（off 零行为）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../main/project/project-service', () => ({ updateProject: vi.fn() }))

import {
  buildDeliveryPresentation,
  buildFourPartFailure,
  computeDeliveryStatus,
  deliveryStatusEnabled,
  deliveryStatusLabel,
  featureIdFromScenario,
  recordDeliveryStatus,
  renderCircuitFailureNote,
  renderDeliveryBody,
  type DeliveryStatusComputationInput,
} from '../../main/coding/delivery-status'
import { updateProject } from '../../main/project/project-service'
import type { GwtFailureSummary, GwtTestResult } from '../../main/verification/gwt-service'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.mocked(updateProject).mockClear()
})

const failures = (...scenarios: string[]): Pick<GwtTestResult, 'failed_count' | 'failure_summary'> => ({
  failed_count: scenarios.length,
  failure_summary: scenarios.map((scenario) => ({ scenario, reason: '断言未通过' })),
})

const cleanResult: Pick<GwtTestResult, 'failed_count' | 'failure_summary'> = { failed_count: 0, failure_summary: [] }

const input = (overrides: Partial<DeliveryStatusComputationInput>): DeliveryStatusComputationInput => ({
  keyTasks: [],
  p0RequirementIds: ['F-001'],
  testResult: cleanResult,
  securityPassed: true,
  ...overrides,
})

describe('deliveryStatusEnabled（BLOMA_DELIVERY_STATUS）', () => {
  it('缺省 off；on 变体 1/on/true；off 变体 0/off/false/空串', () => {
    expect(deliveryStatusEnabled()).toBe(false)
    for (const value of ['1', 'on', 'true', 'ON']) {
      vi.stubEnv('BLOMA_DELIVERY_STATUS', value)
      expect(deliveryStatusEnabled(), value).toBe(true)
    }
    for (const value of ['0', 'off', 'false', '']) {
      vi.stubEnv('BLOMA_DELIVERY_STATUS', value)
      expect(deliveryStatusEnabled(), value).toBe(false)
    }
  })
})

describe('featureIdFromScenario（场景→功能项归属）', () => {
  it('GWT 场景名 F 前缀解析；API 契约失败不归属', () => {
    expect(featureIdFromScenario('F-001 WHEN 点击数字按钮 → 显示区显示对应数字')).toBe('F-001')
    expect(featureIdFromScenario('F-012 点击历史记录入口→按时间倒序显示')).toBe('F-012')
    expect(featureIdFromScenario('API 契约端点：GET /api/history')).toBeUndefined()
    expect(featureIdFromScenario('裸场景名无前缀')).toBeUndefined()
  })
})

describe('computeDeliveryStatus（规则全分支）', () => {
  it('全过+安全过+预检无未过项 → verified', () => {
    expect(computeDeliveryStatus(input({}))).toBe('verified')
  })

  it('安全未过 → unavailable（GWT 全过也不粉饰）', () => {
    expect(computeDeliveryStatus(input({ securityPassed: false }))).toBe('unavailable')
  })

  it('预览不可访问 → unavailable（不可启动）', () => {
    expect(
      computeDeliveryStatus(
        input({ testResult: { failed_count: 2, failure_summary: [{ scenario: 'F-001 入口', reason: '预览不可访问' }] } }),
      ),
    ).toBe('unavailable')
  })

  it('全过但 preflight_passed=false → partial（有未验证面，v0 从严）', () => {
    expect(computeDeliveryStatus(input({ preflightPassed: false }))).toBe('partial')
  })

  it('preflight undefined（未跑/开关 off）不影响 verified', () => {
    expect(computeDeliveryStatus(input({ preflightPassed: undefined }))).toBe('verified')
  })

  it('P0 全部关联失败 → unavailable（核心目标失败，即使 P2 有通过项）', () => {
    expect(
      computeDeliveryStatus(
        input({
          p0RequirementIds: ['F-001', 'F-002'],
          testResult: failures('F-001 点击数字', 'F-002 加法运算'),
        }),
      ),
    ).toBe('unavailable')
  })

  it('P0 部分失败 → partial（有独立可用任务）', () => {
    expect(
      computeDeliveryStatus(
        input({
          p0RequirementIds: ['F-001', 'F-002'],
          testResult: failures('F-002 加法运算'),
        }),
      ),
    ).toBe('partial')
  })

  it('key_tasks 优先：must_deliver=false 的任务失败不参与核心目标判定', () => {
    const status = computeDeliveryStatus(
      input({
        keyTasks: [
          { task_id: 'KT-01', label: '记账', feature_ids: ['F-001'], must_deliver: true },
          { task_id: 'KT-02', label: '导出（锦上添花）', feature_ids: ['F-009'], must_deliver: false },
        ],
        p0RequirementIds: ['F-001'],
        testResult: failures('F-009 导出 CSV'),
      }),
    )
    expect(status).toBe('partial')
  })

  it('key_tasks 必交任务全部失败 → unavailable（key_tasks 口径覆盖 P0 回退）', () => {
    const status = computeDeliveryStatus(
      input({
        keyTasks: [{ task_id: 'KT-01', label: '记账与结余', feature_ids: ['F-001', 'F-002'], must_deliver: true }],
        p0RequirementIds: ['F-003'], // 回退口径即使有别的内容也不生效
        testResult: failures('F-001 记账', 'F-002 结余'),
      }),
    )
    expect(status).toBe('unavailable')
  })

  it('key_tasks 必交任务有干净任务（另一任务部分功能败）→ partial', () => {
    const status = computeDeliveryStatus(
      input({
        keyTasks: [
          { task_id: 'KT-01', label: '玩游戏', feature_ids: ['F-001'], must_deliver: true },
          { task_id: 'KT-02', label: '保存分数', feature_ids: ['F-004'], must_deliver: true },
        ],
        testResult: failures('F-004 保存分数'),
      }),
    )
    expect(status).toBe('partial')
  })

  it('纯 API 契约失败（不可归属）→ partial：玩法可用、数据留存未验证', () => {
    expect(
      computeDeliveryStatus(
        input({
          p0RequirementIds: ['F-001'],
          testResult: failures('API 契约端点：GET /api/records'),
        }),
      ),
    ).toBe('partial')
  })

  it('无 P0 且无 key_tasks（理论不发生）→ 有失败落 partial', () => {
    expect(computeDeliveryStatus(input({ p0RequirementIds: [], testResult: failures('F-009 x') }))).toBe('partial')
  })
})

describe('B0 六样本重放验收（bench/runs b0 档案真实失败清单；验收=全部 partial/unavailable，无一 verified）', () => {
  // B0 错误放行实测：6 个 converged run 全带失败断言进 ready（放行路径 circuit_rollback）。
  // p0RequirementIds 按各 seed PRD 的核心功能假设口径（F-001 主题锚点恒 P0）。
  const cases: Array<{ name: string; p0: string[]; scenarios: string[]; expect: 'partial' | 'unavailable' }> = [
    {
      name: 'calculator b0-1（F-001/F-002 全败 8 项）',
      p0: ['F-001', 'F-002'],
      scenarios: [
        'F-001 WHEN 点击数字按钮 → 显示区显示对应数字',
        'F-002 输入第一个操作数并点击加号→再输入第二个操作数并点击等号→显示加法运算结果',
        'F-002 输入第一个操作数并点击减号→再输入第二个操作数并点击等号→显示减法运算结果',
        'F-002 输入第一个操作数并点击乘号→再输入第二个操作数并点击等号→显示乘法运算结果',
        'F-002 输入第一个操作数并点击除号→再输入第二个操作数并点击等号→显示除法运算结果',
        'F-002 得到一次运算结果后继续点击运算符并输入下一个操作数→基于当前结果继续运算（连续计算）',
        'F-004 点击退格按钮→显示区删除最后一个字符',
        'F-005 点击查看历史按钮→显示历史记录列表',
      ],
      expect: 'unavailable',
    },
    {
      name: 'calculator b0-2（F-001/F-002 败）',
      p0: ['F-001', 'F-002'],
      scenarios: ['F-001 WHEN 点击计算器按钮 → 显示计算器界面', 'F-002 输入数字和运算符后点击等号→显示计算结果', 'F-002 输入超长数字→正常显示且不溢出界面'],
      expect: 'unavailable',
    },
    {
      name: 'calculator b0-3（F-001/F-002 败 + API 契约失活）',
      p0: ['F-001', 'F-002'],
      scenarios: ['F-001 WHEN 点击数字按钮 → 输入区显示对应数字', 'F-002 WHEN 点击运算符按钮 → 输入区显示运算符', 'API 契约端点：GET /api/history'],
      expect: 'unavailable',
    },
    {
      name: 'ai-note b0-1（F-001/F-002 败 + API 契约失活）',
      p0: ['F-001', 'F-002'],
      scenarios: ['F-001 WHEN 点击AI随心记入口 → 显示AI随心记界面', 'F-002 点击随手记入口→显示记录输入界面', 'API 契约端点：GET /api/records'],
      expect: 'unavailable',
    },
    {
      name: 'ai-note b0-2（F-001~F-004 四项败）',
      p0: ['F-001', 'F-002'],
      scenarios: [
        'F-001 WHEN 点击开始按钮 → 显示AI随心记界面',
        'F-002 WHEN 输入碎片想法 → 显示AI整理后的内容',
        'F-003 WHEN 输入非空碎片想法 → 显示包含归类、润色后正文、摘要的结果',
        'F-004 点击历史记录入口→按时间倒序显示所有已保存记录',
      ],
      expect: 'unavailable',
    },
    {
      name: 'shmup b0-1（唯一失败=API 契约失活，玩法断言全过——B0 深挖实锤形态）',
      p0: ['F-001'],
      scenarios: ['API 契约端点：GET /api/records'],
      expect: 'partial',
    },
  ]

  for (const { name, p0, scenarios, expect: expected } of cases) {
    it(`${name} → ${expected}`, () => {
      const status = computeDeliveryStatus(input({ p0RequirementIds: p0, testResult: failures(...scenarios) }))
      expect(status).toBe(expected)
      expect(status).not.toBe('verified')
    })
  }

  it('六样本无一 verified（验收总断言：错误放行在规则层清零）', () => {
    for (const { p0, scenarios } of cases) {
      expect(computeDeliveryStatus(input({ p0RequirementIds: p0, testResult: failures(...scenarios) }))).not.toBe('verified')
    }
  })
})

describe('recordDeliveryStatus（写入 helper）', () => {
  it('开关 off → 零计算零写入（字节级现状）', () => {
    const result = recordDeliveryStatus('p1', input({}))
    expect(result).toBeUndefined()
    expect(updateProject).not.toHaveBeenCalled()
  })
  it('开关 on → 计算+写入 project（熔断回滚路径带失败 → partial）', () => {
    vi.stubEnv('BLOMA_DELIVERY_STATUS', '1')
    const result = recordDeliveryStatus('p1', input({ p0RequirementIds: ['F-001', 'F-002'], testResult: failures('F-002 x') }))
    expect(result).toBe('partial')
    expect(updateProject).toHaveBeenCalledWith('p1', { delivery_status: 'partial' })
  })
  it('写入异常不抛出（不阻断终验主链）', () => {
    vi.stubEnv('BLOMA_DELIVERY_STATUS', '1')
    vi.mocked(updateProject).mockImplementation(() => {
      throw new Error('boom')
    })
    expect(() => recordDeliveryStatus('p1', input({}))).not.toThrow()
  })
})

describe('标签与结论模板（H3 消费同源）', () => {
  it('三态中文标签', () => {
    expect(deliveryStatusLabel('verified')).toBe('已验证')
    expect(deliveryStatusLabel('partial')).toBe('部分可用')
    expect(deliveryStatusLabel('unavailable')).toBe('不可用')
  })
})

describe('H3 三层交付展示（buildDeliveryPresentation + renderDeliveryBody）', () => {
  it('partial：结论句拼任务名 + 任务分组 ✓×?；断言通过率数字不进正文', () => {
    const presentation = buildDeliveryPresentation({
      status: 'partial',
      keyTasks: [
        { task_id: 'KT-01', label: '记一笔账', feature_ids: ['F-001'], must_deliver: true },
        { task_id: 'KT-02', label: '自动总结', feature_ids: ['F-002'], must_deliver: true },
        { task_id: 'KT-03', label: '导出', feature_ids: ['F-003'], must_deliver: false },
      ],
      p0RequirementIds: [],
      testResult: failures('F-002 WHEN 输入碎片想法 → 显示AI整理后的内容'),
    })
    expect(presentation.conclusion).toBe('记一笔账可以使用，自动总结还没有做好。')
    expect(presentation.taskLines).toEqual(['✓ 记一笔账', '× 自动总结', '✓ 导出'])
    expect(renderDeliveryBody(presentation)).not.toMatch(/\d+\s*\/\s*\d+/)
  })

  it('未验证断言（unverified）→ 任务组标 ?（尚未完成验证）', () => {
    const presentation = buildDeliveryPresentation({
      status: 'verified',
      keyTasks: [],
      p0RequirementIds: ['F-001', 'F-002'],
      testResult: { failed_count: 0, failure_summary: [], unverified: ['F-002 图表区域应呈现月度分布'] },
    })
    expect(presentation.taskLines).toEqual(['✓ F-001', '? F-002'])
  })

  it('unavailable：结论句如实（关键任务没完成）；detailHint 带修复引导', () => {
    const presentation = buildDeliveryPresentation({
      status: 'unavailable',
      keyTasks: [],
      p0RequirementIds: ['F-001'],
      testResult: failures('F-001 WHEN 点击数字按钮 → 显示对应数字'),
    })
    expect(presentation.conclusion).toContain('不能当作可用版本')
    expect(presentation.detailHint).toContain('先修好没做好的')
  })

  it('featureLabelOf 拼 P0 功能项故事（回退口径展示不裸号）', () => {
    const presentation = buildDeliveryPresentation({
      status: 'verified',
      keyTasks: [],
      p0RequirementIds: ['F-001'],
      testResult: cleanResult,
      featureLabelOf: (id) => (id === 'F-001' ? '记录收入与支出' : undefined),
    })
    expect(presentation.taskLines).toEqual(['✓ 记录收入与支出'])
  })
})

describe('H4 四段式问题话术', () => {
  it('单条四段：功能去 id 前缀拼动作句；现象/影响/替代三句人话', () => {
    const four = buildFourPartFailure({ scenario: 'F-005 当在搜索框输入关键词时，历史列表应显示匹配的想法', reason: '断言未通过——触发状态：capture-input 未命中' })
    expect(four.feature).toBe('F-005 当在搜索框输入关键词时，历史列表应显示匹配的想法')
    expect(four.phenomenon).toBe('自动检查时，这一步没有得到预期结果')
    expect(four.impact).toContain('不能当作可用来依赖')
    expect(four.alternative).toContain('先修好这项')
  })

  it('验证工具异常 → 现象句分话术「验证工具没有完成这一项的检查，状态待确认」', () => {
    const four = buildFourPartFailure({ scenario: 'F-001 入口检查', reason: '预览不可访问' })
    expect(four.phenomenon).toContain('状态待确认')
  })

  it('清单默认展开 3 项（必交项已在前 3 内），其余折叠为计数行', () => {
    const note = renderCircuitFailureNote({
      failures: [1, 2, 3, 4, 5].map((n) => ({ scenario: `F-00${n} 场景${n}`, reason: '断言未通过' })),
      mustDeliverFeatureIds: ['F-001'],
    })
    expect(note).toContain('这一版有 5 项检查未通过')
    expect(note).toContain('【功能】')
    expect(note).toContain('F-003 场景3')
    expect(note).not.toContain('F-004 场景4')
    expect(note).toContain('还有 2 项未通过')
  })

  it('敏感类（数据丢失/金额）不折叠，即使排在第 4 项以后', () => {
    const note = renderCircuitFailureNote({
      failures: [
        { scenario: 'F-002 场景2', reason: '断言未通过' },
        { scenario: 'F-003 场景3', reason: '断言未通过' },
        { scenario: 'F-004 场景4', reason: '断言未通过' },
        { scenario: 'F-006 点击清空→数据丢失风险', reason: '断言未通过' },
      ],
      mustDeliverFeatureIds: ['F-001'],
    })
    expect(note).toContain('F-006 点击清空→数据丢失风险')
    expect(note).not.toContain('还有')
  })

  it('空失败清单 → 空串（调用方不附注）', () => {
    expect(renderCircuitFailureNote({ failures: [], mustDeliverFeatureIds: [] })).toBe('')
  })
})
