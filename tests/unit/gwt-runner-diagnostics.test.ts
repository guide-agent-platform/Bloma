import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import {
  attachPageDiagnostics,
  composeFailureReason,
  newDiagnosticsSince,
  snapshotDiagnostics,
} from '../../main/gwt-runner'

/**
 * PR1（随感 39 诊断补盲）纯函数单测：pageerror / console / requestfailed 三路采集、
 * snapshot 差值归属、上限 20、长文本截断、诊断只附加不改判定。
 * executeScenarios 的浏览器接线由 gwt-service/behavior-gate 既有用例回归（均走静态兜底 seam）。
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
})
