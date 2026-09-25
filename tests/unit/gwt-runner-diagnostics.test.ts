import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import {
  attachPageDiagnostics,
  composeFailureReason,
  evaluateScenarioOutcome,
  newDiagnosticsSince,
  snapshotDiagnostics,
} from '../../main/verification/gwt-runner'
import type { ControlSnapshot } from '../../main/verification/gwt-runner'

/**
 * PR1（随感 39 诊断补盲）纯函数单测：pageerror / console / requestfailed 三路采集、
 * snapshot 差值归属、上限 20、长文本截断、诊断只附加不改判定。
 * 浏览器接线（executeScenarios）经 evaluateScenarioOutcome 锁定同款语义
 * （生产无 chromium 注入环境的直接路径，诚实标注而非声称另有回归）。
 */

/** fake page：EventEmitter + .on()，只实现诊断监听用到的事件面（Page 侧供类型、EventEmitter 侧供 emit） */
type FakePage = Page & EventEmitter

function createFakePage(): FakePage {
  return new EventEmitter() as unknown as FakePage
}

function consoleMessage(type: string, text: string): { type: () => string; text: () => string } {
  return { type: () => type, text: () => text }
}

function failedRequest(url: string, errorText?: string): {
  url: () => string
  failure: () => { errorText: string } | undefined
} {
  return { url: () => url, failure: () => (errorText === undefined ? undefined : { errorText }) }
}

describe('gwt-runner 页面诊断采集（PR1）', () => {
  it('采集 pageerror / console error+warning / requestfailed，忽略普通 console 输出', () => {
    const page = createFakePage()
    const diag = attachPageDiagnostics(page)

    page.emit('pageerror', new Error('boom'))
    page.emit('console', consoleMessage('error', 'Uncaught TypeError: x is not a function'))
    page.emit('console', consoleMessage('warning', 'React componentWillUpdate 已弃用'))
    page.emit('console', consoleMessage('log', '普通日志不采集'))
    page.emit('console', consoleMessage('info', 'info 也不采集'))
    page.emit('requestfailed', failedRequest('https://example.com/api/data', 'net::ERR_FAILED'))

    expect(diag.pageErrors).toEqual(['boom'])
    expect(diag.consoleErrors).toEqual([
      '[error] Uncaught TypeError: x is not a function',
      '[warning] React componentWillUpdate 已弃用',
    ])
    expect(diag.requestFailures).toEqual(['https://example.com/api/data（net::ERR_FAILED）'])
  })

  it('requestfailed 无 failure 信息时标注 failed', () => {
    const page = createFakePage()
    const diag = attachPageDiagnostics(page)

    page.emit('requestfailed', failedRequest('https://example.com/logo.png'))

    expect(diag.requestFailures).toEqual(['https://example.com/logo.png（failed）'])
  })

  it('snapshot 差值归属：newDiagnosticsSince 只返回快照之后新增的诊断，按 页面报错→控制台→资源失败 排序', () => {
    const page = createFakePage()
    const diag = attachPageDiagnostics(page)

    // 快照前已有诊断（归属上一场景，不应重复上报）
    page.emit('pageerror', new Error('before-error'))
    page.emit('console', consoleMessage('error', 'before-console'))
    page.emit('requestfailed', failedRequest('https://example.com/before.js', 'net::ERR_ABORTED'))
    const before = snapshotDiagnostics(diag)
    expect(before).toEqual({ pageErrors: 1, consoleErrors: 1, requestFailures: 1 })

    // 快照后：一条被忽略的普通日志 + 三路各一条新增
    page.emit('console', consoleMessage('log', '不采集'))
    page.emit('pageerror', new Error('after-error'))
    page.emit('console', consoleMessage('error', 'after-console'))
    page.emit('requestfailed', failedRequest('https://example.com/after.js', 'net::ERR_CONNECTION_RESET'))

    expect(newDiagnosticsSince(diag, before)).toEqual([
      '页面运行时报错：after-error',
      '控制台输出：[error] after-console',
      '资源加载失败：https://example.com/after.js（net::ERR_CONNECTION_RESET）',
    ])
  })

  it('每类诊断上限 20 条，先到先得（后到丢弃）', () => {
    const page = createFakePage()
    const diag = attachPageDiagnostics(page)

    for (let index = 1; index <= 25; index += 1) {
      page.emit('pageerror', new Error(`page-${index}`))
      page.emit('console', consoleMessage('error', `console-${index}`))
      page.emit('requestfailed', failedRequest(`https://example.com/${index}.js`, 'net::ERR_FAILED'))
    }

    expect(diag.pageErrors).toHaveLength(20)
    expect(diag.consoleErrors).toHaveLength(20)
    expect(diag.requestFailures).toHaveLength(20)
    // 留下的是第 1~20 条，不是最后 20 条
    expect(diag.pageErrors[0]).toBe('page-1')
    expect(diag.pageErrors[19]).toBe('page-20')
    expect(diag.consoleErrors[19]).toBe('[error] console-20')
    expect(diag.requestFailures[19]).toBe('https://example.com/20.js（net::ERR_FAILED）')
  })

  it('长文本截断：console 文本 200 字符、URL 120 字符', () => {
    const page = createFakePage()
    const diag = attachPageDiagnostics(page)

    page.emit('console', consoleMessage('error', 'E'.repeat(300)))
    page.emit('requestfailed', failedRequest(`https://example.com/${'u'.repeat(200)}.js`, 'net::ERR_FAILED'))

    expect(diag.consoleErrors[0]).toBe(`[error] ${'E'.repeat(200)}`)
    // URL 截 120 字符：前缀 20 字符 + 100 个 u = 120
    expect(diag.requestFailures[0]!.startsWith(`https://example.com/${'u'.repeat(100)}`)).toBe(true)
    expect(diag.requestFailures[0]!.length).toBeLessThanOrEqual(120 + '（net::ERR_FAILED）'.length)
  })

  it('composeFailureReason：诊断只附加不替换原失败原因，最多拼 3 条；无诊断时原样返回', () => {
    // 无诊断 → 原因一字不动（诊断不参与通过/失败判定的语义锚点）
    expect(composeFailureReason('断言未满足：按右方向键→车辆右移', [])).toBe(
      '断言未满足：按右方向键→车辆右移',
    )

    // 有诊断 → 原失败原因保持前缀，诊断追加且封顶 3 条
    const extra = ['页面运行时报错：e1', '控制台输出：[error] c1', '资源加载失败：r1（net::ERR_FAILED）', '页面运行时报错：e2']
    const composed = composeFailureReason('断言未满足：按右方向键→车辆右移', extra)
    expect(composed.startsWith('断言未满足：按右方向键→车辆右移\n附带诊断（最多 3 条）：\n')).toBe(true)
    expect(composed).toContain('- 页面运行时报错：e1')
    expect(composed).toContain('- 资源加载失败：r1（net::ERR_FAILED）')
    expect(composed).not.toContain('e2')
  })

  it('诊断读取为纯函数：snapshot / newDiagnosticsSince 不改变采集状态', () => {
    const page = createFakePage()
    const diag = attachPageDiagnostics(page)
    page.emit('pageerror', new Error('once'))
    const before = snapshotDiagnostics(diag)

    page.emit('console', consoleMessage('error', 'c-once'))
    const first = newDiagnosticsSince(diag, before)
    const second = newDiagnosticsSince(diag, before)
    expect(first).toEqual(['控制台输出：[error] c-once'])
    expect(second).toEqual(first)
    // 读取不产生副作用：采集内容与计数保持不变
    expect(diag.pageErrors).toEqual(['once'])
    expect(diag.consoleErrors).toEqual(['[error] c-once'])
    expect(snapshotDiagnostics(diag)).toEqual({ pageErrors: 1, consoleErrors: 1, requestFailures: 0 })
  })

  it('evaluateScenarioOutcome：通过的场景即使有诊断噪音也返回通过（防误杀锚点）', () => {
    const page = createFakePage()
    const diag = attachPageDiagnostics(page)
    const before = snapshotDiagnostics(diag)
    // 场景执行期间爆发 console 噪音 + 资源失败，但断言本身通过
    page.emit('console', consoleMessage('error', '统计脚本 404 噪音'))
    page.emit('requestfailed', failedRequest('https://example.com/analytics.js', 'net::ERR_FAILED'))

    expect(evaluateScenarioOutcome(undefined, diag, before)).toBeUndefined()
  })

  it('evaluateScenarioOutcome：失败场景拼装诊断（≤3 条），原因为前缀', () => {
    const page = createFakePage()
    const diag = attachPageDiagnostics(page)
    const before = snapshotDiagnostics(diag)
    page.emit('pageerror', new Error('boom'))
    page.emit('console', consoleMessage('error', 'e1'))
    page.emit('console', consoleMessage('error', 'e2'))
    page.emit('console', consoleMessage('error', 'e3'))
    page.emit('requestfailed', failedRequest('https://example.com/x.js', 'net::ERR_FAILED'))

    const reason = evaluateScenarioOutcome('断言未满足：按右方向键→高亮右移', diag, before)!
    expect(reason.startsWith('断言未满足：按右方向键→高亮右移\n附带诊断（最多 3 条）：')).toBe(true)
    expect(reason).not.toContain('x.js') // 第 4 条之后不拼
  })
})

describe('symbolSynonymMatches 符号同义词匹配（2026-09-25 随手计算器案修复）', () => {
  it('功能词 ↔ 符号键互认（随手计算器案：断言「运算符」匹配 ÷×−控件）', async () => {
    const { symbolSynonymMatches } = await import('../../main/verification/gwt-runner')
    expect(symbolSynonymMatches('运算符', '÷')).toBe(true)
    expect(symbolSynonymMatches('运算符', '×')).toBe(true)
    expect(symbolSynonymMatches('运算符', '−')).toBe(true)
    expect(symbolSynonymMatches('运算符', '+')).toBe(true)
    expect(symbolSynonymMatches('等号', '=')).toBe(true)
    expect(symbolSynonymMatches('清空', 'C')).toBe(true)
    expect(symbolSynonymMatches('清空', 'AC')).toBe(true)
    expect(symbolSynonymMatches('清空', 'ce')).toBe(true)
    expect(symbolSynonymMatches('退格', '⌫')).toBe(true)
    expect(symbolSynonymMatches('删除', 'DEL')).toBe(true)
    expect(symbolSynonymMatches('确认', 'ok')).toBe(true)
    expect(symbolSynonymMatches('发送', 'send')).toBe(true)
  })

  it('不误配：数字键/无关文本/空值', async () => {
    const { symbolSynonymMatches } = await import('../../main/verification/gwt-runner')
    expect(symbolSynonymMatches('运算符', '5')).toBe(false)
    expect(symbolSynonymMatches('数字', '5')).toBe(false) // 「数字」不在功能词表——原两维匹配仍兜底
    expect(symbolSynonymMatches('运算符', '清空面板')).toBe(false)
    expect(symbolSynonymMatches('', '5')).toBe(false)
    expect(symbolSynonymMatches('等号', '')).toBe(false)
  })

  it('target 含上下文词也命中（「点击运算符键」整句作 target 的宽容性）', async () => {
    const { symbolSynonymMatches } = await import('../../main/verification/gwt-runner')
    // 解析侧已抽出 target（「运算符」），但容错：带「键/按钮」后缀也认
    expect(symbolSynonymMatches('运算符键', '÷')).toBe(true)
  })
})

describe('matchesClickableControl / findClickableIndex 控件寻址纯函数（2026-09-25 挂账①采集-判定分离）', () => {
  it('随手计算器案端到端语义：快照（符号控件）× target（功能词断言）经同义词命中', async () => {
    const { findClickableIndex } = await import('../../main/verification/gwt-runner')
    const page: ControlSnapshot[] = [
      { index: 0, visible: true, text: '7', className: 'btn num', hints: '' },
      { index: 1, visible: true, text: '÷', className: 'btn op', hints: '' },
      { index: 2, visible: true, text: '×', className: 'btn op', hints: '' },
      { index: 3, visible: true, text: '=', className: 'btn op', hints: '' },
      { index: 4, visible: true, text: 'C', className: 'btn fn', hints: '' },
      { index: 5, visible: false, text: '隐藏的运算符', className: '', hints: '' }, // 不可见不参与（P0-1）
    ]
    expect(findClickableIndex(page, '运算符')).toBe(1) // 首个命中：÷
    expect(findClickableIndex(page, '等号')).toBe(3)
    expect(findClickableIndex(page, '清空')).toBe(4)
    expect(findClickableIndex(page, '不存在的控件')).toBe(-1)
  })

  it('多信号：textContent/className/hints 各自独立命中', async () => {
    const { matchesClickableControl } = await import('../../main/verification/gwt-runner')
    const base: ControlSnapshot = { index: 0, visible: true, text: '', className: '', hints: '' }
    expect(matchesClickableControl({ ...base, text: '开始游戏' }, '开始')).toBe(true)
    expect(matchesClickableControl({ ...base, className: 'pause-btn' }, 'pause')).toBe(true)
    expect(matchesClickableControl({ ...base, hints: 'aria-label 提交表单 title=submit data-ai-id=send-btn' }, 'submit')).toBe(true)
    expect(matchesClickableControl({ ...base, text: '确认' }, '无关词')).toBe(false)
  })

  it('hints 兜底标签走符号同义词（text 空时取 hints 首词）', async () => {
    const { matchesClickableControl } = await import('../../main/verification/gwt-runner')
    const iconOnly: ControlSnapshot = { index: 0, visible: true, text: '', className: 'icon-btn', hints: 'del' }
    expect(matchesClickableControl(iconOnly, '退格')).toBe(true) // hints 首词「del」↔ 退格同组
    const iconCn = { ...iconOnly, hints: '删除' }
    expect(matchesClickableControl(iconCn, '退格')).toBe(true) // 中文别名同样命中（title="删除" 的图标按钮）
  })

  it('不可见控件永远不命中（P0-1 隐藏 overlay 不抢跑）', async () => {
    const { matchesClickableControl, findClickableIndex } = await import('../../main/verification/gwt-runner')
    const hidden: ControlSnapshot = { index: 0, visible: false, text: '运算符', className: '', hints: '' }
    expect(matchesClickableControl(hidden, '运算符')).toBe(false)
    expect(findClickableIndex([hidden], '运算符')).toBe(-1)
  })

  it('visibleControlInventory：去重/限长/上限（失败回喂清单）', async () => {
    const { visibleControlInventory } = await import('../../main/verification/gwt-runner')
    const many = Array.from({ length: 40 }, (_, i) => ({ index: i, visible: true, text: `按钮${i}`, className: '', hints: '' })) as ControlSnapshot[]
    const inventory = visibleControlInventory(many)
    expect(inventory).toHaveLength(24)
    expect(inventory[0]).toBe('按钮0')
    const dedup: ControlSnapshot[] = [
      { index: 0, visible: true, text: '÷', className: '', hints: '' },
      { index: 1, visible: true, text: '÷', className: '', hints: '' },
      { index: 2, visible: false, text: '隐藏', className: '', hints: '' },
      { index: 3, visible: true, text: '', className: '', hints: '等号' },
    ]
    expect(visibleControlInventory(dedup)).toEqual(['÷', '等号'])
  })
})
