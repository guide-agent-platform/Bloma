import { afterEach, describe, expect, it } from 'vitest'
import type { GwtTestResult } from '../../../main/verification/gwt-service'
import type { BuildGateResult } from '../../../main/coding/build-gate'
import {
  buildRepairTasks,
  renderRepairTaskCard,
  resolveRepairBudget,
  resolveRepairMaxTurns,
  REPAIR_BUDGET_DEFAULTS,
  REPAIR_MAX_TURNS_DEFAULTS,
} from '../../../main/coding/repair-loop'

/**
 * P2 失败回流 · PR-A 纯函数地基：终验证据 → RepairTask 队列 → EARS 修复卡。
 * 关键锁定：unverified 不进任务（待评估不计失败）；卡片格式裸关键词断言
 * （修复卡是纯文本注入，非代码 JSON，不适用陷阱 7 截断重试）。
 */

function gwtResult(overrides?: Partial<GwtTestResult>): GwtTestResult {
  return {
    total_count: 10,
    passed_count: 9,
    failed_count: 1,
    failure_summary: [
      {
        scenario: 'F-005 当在搜索框输入关键词时，历史列表应显示匹配的想法',
        reason: '断言未通过——触发状态：capture-input 未命中；可见元素 12→12（无变化）；探针视角：[input.search, button.filter]',
      },
    ],
    ...overrides,
  }
}

function buildGate(status: 'passed' | 'failed' | 'skipped', detail?: string): BuildGateResult {
  return { status, ...(detail !== undefined ? { detail } : {}), durationMs: 123 }
}

describe('buildRepairTasks — 终验证据 → 修复任务队列', () => {
  it('GWT 失败逐条转换：claim=断言原文零改写 / location=场景锚点 / evidence=reason 原文', () => {
    const tasks = buildRepairTasks({ testResult: gwtResult() })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      id: 'r-1',
      source: 'gwt',
      claim: '当在搜索框输入关键词时，历史列表应显示匹配的想法',
      location: 'F-005 当在搜索框输入关键词时，历史列表应显示匹配的想法',
      evidence: '断言未通过——触发状态：capture-input 未命中；可见元素 12→12（无变化）；探针视角：[input.search, button.filter]',
    })
  })

  it('多条失败内部编号 r-1/r-2 顺序生成（陷阱 42：编号内部化不猜号）', () => {
    const tasks = buildRepairTasks({
      testResult: gwtResult({
        failed_count: 2,
        failure_summary: [
          { scenario: 'F-003 点击保存按钮后状态应显示已保存', reason: 'reason-3' },
          { scenario: 'F-005 当在搜索框输入关键词时列表应过滤', reason: 'reason-5' },
        ],
      }),
    })
    expect(tasks.map((t) => t.id)).toEqual(['r-1', 'r-2'])
    expect(tasks.map((t) => t.claim)).toEqual(['点击保存按钮后状态应显示已保存', '当在搜索框输入关键词时列表应过滤'])
  })

  it('unverified 是待评估不计失败：即使非空也不组装成修复任务（硬约束锁定）', () => {
    const tasks = buildRepairTasks({
      testResult: gwtResult({
        total_count: 10,
        passed_count: 8,
        failed_count: 0,
        failure_summary: [],
        unverified: ['F-009 图表区域应呈现月度分布', 'F-010 导出后应生成文件'],
      }),
    })
    expect(tasks).toEqual([])
  })

  it('场景名无空格异常形态兜底整串 claim，空场景名兜底占位文案，均不抛错', () => {
    const noSpace = buildRepairTasks({
      testResult: gwtResult({
        failure_summary: [{ scenario: 'F-005', reason: 'reason' }],
      }),
    })
    expect(noSpace[0].claim).toBe('F-005')
    expect(noSpace[0].location).toBe('F-005')

    const empty = buildRepairTasks({
      testResult: gwtResult({
        failure_summary: [{ scenario: '', reason: 'reason' }],
      }),
    })
    expect(empty[0].claim).toContain('断言未通过')
  })

  it('buildGate failed 追加 build 任务；passed/skipped 不追加', () => {
    const failed = buildRepairTasks({
      testResult: gwtResult({ failed_count: 0, failure_summary: [] }),
      buildGate: buildGate('failed', 'Could not resolve "./utils/format" (src/app.js:41)'),
    })
    expect(failed).toHaveLength(1)
    expect(failed[0].source).toBe('build')
    expect(failed[0].evidence).toContain('Could not resolve')
    expect(failed[0].location).toBeUndefined()

    for (const status of ['passed', 'skipped'] as const) {
      expect(
        buildRepairTasks({ testResult: gwtResult({ failed_count: 0, failure_summary: [] }), buildGate: buildGate(status, 'x') }),
      ).toEqual([])
    }
  })

  it('GWT + build 混合时编号连续，build 任务排尾部', () => {
    const tasks = buildRepairTasks({
      testResult: gwtResult(),
      buildGate: buildGate('failed', 'build error'),
    })
    expect(tasks.map((t) => [t.id, t.source])).toEqual([
      ['r-1', 'gwt'],
      ['r-2', 'build'],
    ])
  })

  it('buildGate failed 无 detail 时兜底文案不抛错', () => {
    const tasks = buildRepairTasks({ testResult: gwtResult({ failure_summary: [] }), buildGate: buildGate('failed') })
    expect(tasks[0].evidence).toContain('esbuild')
  })
})

describe('renderRepairTaskCard — EARS 修复卡渲染（纯文本注入）', () => {
  it('空任务返回空串（组装器幂等）', () => {
    expect(renderRepairTaskCard([])).toBe('')
  })

  it('卡片格式锁定：任务头 / 场景标题 / 期望-实际-定位 / 卡尾三约束（裸关键词断言）', () => {
    const card = renderRepairTaskCard(buildRepairTasks({ testResult: gwtResult() }))
    expect(card).toContain('## 修复任务')
    expect(card).toContain('共 1 项')
    expect(card).toContain('### [r-1] F-005 当在搜索框输入关键词时，历史列表应显示匹配的想法')
    expect(card).toContain('- 期望：当在搜索框输入关键词时，历史列表应显示匹配的想法')
    expect(card).toContain('- 实际：断言未通过——触发状态：capture-input 未命中')
    expect(card).toContain('断言锚点 = F-005')
    // 卡尾三约束（D5：写卡尾而非 system）
    expect(card).toContain('只修复上面列出的项')
    expect(card).toContain('run_preview')
    expect(card).toContain('禁止重构')
    // 修复卡是纯文本不是 JSON：不应出现 JSON 包装
    expect(card).not.toContain('```')
    expect(card.startsWith('## 修复任务')).toBe(true)
  })

  it('build 任务块：构建失败标题 + esbuild 证据 + 定位行', () => {
    const card = renderRepairTaskCard(
      buildRepairTasks({ testResult: gwtResult({ failure_summary: [] }), buildGate: buildGate('failed', 'Could not resolve "./utils/format"') }),
    )
    expect(card).toContain('构建失败（esbuild 打包校验未通过）')
    expect(card).toContain('- 实际：Could not resolve "./utils/format"')
    expect(card).toContain('定位 import 引用')
    expect(card).not.toContain('断言锚点')
  })

  it('混合任务卡含全部编号与两处定位行', () => {
    const card = renderRepairTaskCard(
      buildRepairTasks({ testResult: gwtResult(), buildGate: buildGate('failed', 'boom') }),
    )
    expect(card).toContain('### [r-1]')
    expect(card).toContain('### [r-2]')
    expect(card).toContain('共 2 项')
  })
})

describe('预算与轮次解析（D6 + BLOMA_REPAIR_* 覆盖）', () => {
  const keys = ['BLOMA_REPAIR_BUDGET', 'BLOMA_REPAIR_TURNS'] as const
  const original: Record<string, string | undefined> = {}
  for (const key of keys) original[key] = process.env[key]

  afterEach(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
  })

  it('缺省：quick=1 / longterm=2；修复轮 quick=12 / longterm=16', () => {
    expect(REPAIR_BUDGET_DEFAULTS).toEqual({ quick: 1, longterm: 2 })
    expect(REPAIR_MAX_TURNS_DEFAULTS).toEqual({ quick: 12, longterm: 16 })
    expect(resolveRepairBudget('quick')).toBe(1)
    expect(resolveRepairBudget('longterm')).toBe(2)
    expect(resolveRepairMaxTurns('quick')).toBe(12)
    expect(resolveRepairMaxTurns('longterm')).toBe(16)
  })

  it('BLOMA_REPAIR_BUDGET / BLOMA_REPAIR_TURNS 覆盖生效（不分模式单值覆盖）', () => {
    process.env.BLOMA_REPAIR_BUDGET = '3'
    process.env.BLOMA_REPAIR_TURNS = '8'
    expect(resolveRepairBudget('quick')).toBe(3)
    expect(resolveRepairBudget('longterm')).toBe(3)
    expect(resolveRepairMaxTurns('quick')).toBe(8)
    expect(resolveRepairMaxTurns('longterm')).toBe(8)
  })

  it('非法值（非数字/≤0/小数）回退缺省；先取整再校验不许 floor 成 0', () => {
    process.env.BLOMA_REPAIR_BUDGET = 'abc'
    expect(resolveRepairBudget('quick')).toBe(1)
    process.env.BLOMA_REPAIR_BUDGET = '0'
    expect(resolveRepairBudget('longterm')).toBe(2)
    process.env.BLOMA_REPAIR_BUDGET = '-2'
    expect(resolveRepairBudget('quick')).toBe(1)
    process.env.BLOMA_REPAIR_TURNS = '0.5'
    expect(resolveRepairMaxTurns('quick')).toBe(12)
    process.env.BLOMA_REPAIR_TURNS = ' '
    expect(resolveRepairMaxTurns('longterm')).toBe(16)
  })
})

describe('W4-F5：诊断升级段渲染（连续 ≥2 轮零修复由宿主判定）', () => {
  it('escalation=diagnosis 时修复卡注入换假设/区分性检查/只读独立诊断指引', () => {
    const attempt = {
      round: 1,
      at: new Date().toISOString(),
      task_locations: ['F-005'],
      files_touched: ['src/app.js'],
      outcome: { resolved: [], persistent: ['F-005'], new_failures: [], converged: false },
    }
    const card = renderRepairTaskCard(buildRepairTasks({ testResult: gwtResult() }), {
      attempts: [attempt, { ...attempt, round: 2 }],
      escalation: 'diagnosis',
    })
    expect(card).toContain('诊断升级')
    expect(card).toContain('区分性检查')
    expect(card).toContain('role=research')
    expect(card).toContain('report_blocker')
    // 无升级态（有修复进展）不注入
    const calm = renderRepairTaskCard(buildRepairTasks({ testResult: gwtResult() }), {
      attempts: [{ ...attempt, outcome: { resolved: ['F-005'], persistent: [], new_failures: [], converged: true } }],
    })
    expect(calm).not.toContain('诊断升级')
  })
})
