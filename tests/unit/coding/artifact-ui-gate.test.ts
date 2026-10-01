import { describe, it, expect, afterEach } from 'vitest'
import { analyzeUiProbe, uiProbeNotes, type UiProbeData } from '../../../main/coding/artifact-ui-gate'

/**
 * L0 产物 UI 完整性门禁——纯判定函数单测（Playwright 采集层是薄壳，判定逻辑全在这里）。
 * 案源：G-07dbf2c2「Proma 产品工作台」假界面（0 真控件 div 假按钮 + 验收断言印进页面）。
 */

function probe(over: Partial<UiProbeData> = {}): UiProbeData {
  return {
    title: 'ok app',
    bodyChars: 1200,
    realControls: 4,
    realByTag: { button: 2, input: 2 },
    pretendWidgets: [],
    deadClicks: [],
    leakedPatterns: [],
    placeholderPersona: false,
    consoleErrors: [],
    ...over,
  }
}

describe('analyzeUiProbe（L0 硬判定）', () => {
  it('健康产物：真控件>0、无伪装、无泄漏 → 零失败', () => {
    expect(analyzeUiProbe(probe())).toEqual([])
  })

  it('G-07dbf2c2 案：0 真控件 + div 伪装按钮 → 判失败且场景名以 UI-GATE 前缀', () => {
    const failures = analyzeUiProbe(probe({
      realControls: 0, realByTag: {},
      pretendWidgets: [
        { tag: 'div', cls: 'proma-btn', text: '生成 Proma' },
        { tag: 'div', cls: 'proma-btn secondary', text: '保存草稿' },
      ],
    }))
    expect(failures.length).toBeGreaterThanOrEqual(1)
    expect(failures[0].scenario.startsWith('UI-GATE ')).toBe(true)
    expect(failures[0].reason).toContain('生成 Proma')
  })

  it('0 真控件但页面近乎空（白屏：文本/控件/可点元素全缺）→ 白屏失败优先，不叠加控件失败', () => {
    const failures = analyzeUiProbe(probe({ bodyChars: 8, realControls: 0, realByTag: {} }))
    expect(failures.some((f) => f.scenario.includes('白屏'))).toBe(true)
    expect(failures.some((f) => f.scenario.includes('真交互控件'))).toBe(false)
  })

  it('短文本但有真控件（合法极简小工具）→ 不判白屏不误杀', () => {
    expect(analyzeUiProbe(probe({ bodyChars: 12 }))).toEqual([])
  })

  it('验收断言话术泄漏（可见且可交互 / F-001）→ 独立失败项', () => {
    const failures = analyzeUiProbe(probe({ leakedPatterns: ['assert-visible-interactive', 'feature-id-leak'] }))
    const leak = failures.find((f) => f.scenario.includes('验收断言'))
    expect(leak).toBeTruthy()
    expect(leak!.reason).toContain('assert-visible-interactive')
    expect(leak!.reason).toContain('feature-id-leak')
  })

  it('占位人设（J. Doe）不算验收泄漏失败（避免误杀模板文案）', () => {
    const failures = analyzeUiProbe(probe({ placeholderPersona: true }))
    expect(failures).toEqual([])
  })

  it('真控件 0 且按钮全部死点击 → 判败（假壳子铁证）', () => {
    const failures = analyzeUiProbe(probe({
      realControls: 0, realByTag: {},
      pretendWidgets: [{ tag: 'div', cls: 'proma-btn', text: '提交' }],
      deadClicks: [
        { text: '提交', clicked: true, domChanged: false },
      ],
    }))
    // 控件缺失失败 + 死点击失败至少各一条或合并命中
    expect(failures.length).toBeGreaterThanOrEqual(1)
    expect(failures.some((f) => f.scenario.includes('点击'))).toBe(true)
  })

  it('有真控件但点击全死 → 不判败（防误杀），但落 uiProbeNotes 提示位', () => {
    const p = probe({
      deadClicks: [
        { text: '提交', clicked: true, domChanged: false },
        { text: '新建', clicked: true, domChanged: false },
      ],
    })
    expect(analyzeUiProbe(p)).toEqual([])
    expect(uiProbeNotes(p).some((n) => n.includes('死点击'))).toBe(true)
  })

  it('部分点击有反应 → 无死点击提示', () => {
    const p = probe({
      deadClicks: [
        { text: '提交', clicked: true, domChanged: true },
        { text: '新建', clicked: true, domChanged: false },
      ],
    })
    expect(uiProbeNotes(p)).toEqual([])
  })

  it('console 错误只作信息不判败（外链 404 等噪声不误杀）', () => {
    expect(analyzeUiProbe(probe({ consoleErrors: ['Failed to load resource 404'] }))).toEqual([])
  })
})

describe('C3 死按钮判活（BLOMA_UI_GATE_LIVENESS，2026-09-11 审计案 35c1a633：7 个无 JS 死按钮照样 passed）', () => {
  const previousEnv = process.env.BLOMA_UI_GATE_LIVENESS

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.BLOMA_UI_GATE_LIVENESS
    else process.env.BLOMA_UI_GATE_LIVENESS = previousEnv
  })

  /** 审计案形态：7 个真按钮全部无 JS 死点击 */
  function deadButtonProbe(over: Partial<UiProbeData> = {}): UiProbeData {
    return probe({
      realControls: 7,
      realByTag: { button: 7 },
      deadClicks: [
        { text: '开始游戏', clicked: true, domChanged: false, tag: 'button' },
        { text: '暂停', clicked: true, domChanged: false, tag: 'button' },
        { text: '投币', clicked: true, domChanged: false, tag: 'button' },
        { text: '重开', clicked: true, domChanged: false, tag: 'button' },
        { text: '设置', clicked: true, domChanged: false, tag: 'button' },
      ],
      ...over,
    })
  }

  it('开关 on：真按钮类死亡占比 ≥80% 且 realControls ≥3 → failed 附死按钮清单', () => {
    process.env.BLOMA_UI_GATE_LIVENESS = '1'
    const failures = analyzeUiProbe(deadButtonProbe())
    expect(failures).toHaveLength(1)
    expect(failures[0].scenario).toContain('按钮类控件大面积无响应')
    expect(failures[0].reason).toContain('5 个中 5 个')
    expect(failures[0].reason).toContain('开始游戏')
  })

  it('防误杀①：锚点/外链死点击不进分母（仅按钮类统计）', () => {
    // 2 个死按钮 + 3 个死锚点：按钮占比 100% 但样本 <3 → 不判；锚点从不进分母
    const failures = analyzeUiProbe(deadButtonProbe({
      deadClicks: [
        { text: '开始', clicked: true, domChanged: false, tag: 'button' },
        { text: '暂停', clicked: true, domChanged: false, tag: 'button' },
        { text: '文档', clicked: true, domChanged: false, tag: 'a' },
        { text: '关于', clicked: true, domChanged: false, tag: 'a' },
        { text: '外链', clicked: true, domChanged: false, tag: 'a' },
      ],
    }))
    expect(failures).toEqual([])
  })

  it('防误杀②：多数按钮有活性（≥1/5 命中 → 占比 80% 不到）或样本不足 → 不判', () => {
    // 5 个中 1 个有反应（80% 边界内不触发：dead 4/5=80% 恰好触发？——4/5=0.8>=0.8 触发；用 2 个活性）
    const alive = analyzeUiProbe(deadButtonProbe({
      deadClicks: [
        { text: '开始游戏', clicked: true, domChanged: false, tag: 'button' },
        { text: '暂停', clicked: true, domChanged: false, tag: 'button' },
        { text: '投币', clicked: true, domChanged: false, tag: 'button' },
        { text: '音效', clicked: true, domChanged: true, tag: 'button' },
        { text: '帮助', clicked: true, domChanged: true, tag: 'button' },
      ],
    }))
    expect(alive).toEqual([])
    // realControls <3（小页面）不判
    const small = analyzeUiProbe(deadButtonProbe({ realControls: 2 }))
    expect(small).toEqual([])
  })
})
