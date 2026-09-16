/**
 * 预览浏览器工具族测试（Phase 10 W1，2026-09-16，同步 Proma Browser* 工具库）。
 *
 * 三层：
 * 1. 纯函数：assertSameOrigin 同源守卫（Bloma 特有硬边界——浏览器会话不做第二个网络出口）；
 * 2. 假 page（setPageProviderForTests 注入）：工具注册/开关 off 字节锁/输出塑形/会话生命周期；
 * 3. 真浏览器集成（playwright 缺失整组跳过，沿用 gwt-probe-browser.test.ts 模式）：
 *    navigate→observe→fill→click→extract 链路 + 外域拒绝。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { restorePromaHome } from '../../support/proma-home-guard'
import { createProject, recordSketchGenerated } from '../../../main/project-service'
import { createToolState, type ToolContext } from '../../../main/agent-loop'
import { buildAgentTools } from '../../../main/coding/agent-tools'
import {
  assertSameOrigin,
  browserToolsEnabled,
  buildPreviewBrowserTools,
  closeAllPreviewBrowserSessionsForTests,
  closePreviewBrowserSession,
  previewBrowserSessionCount,
  setPageProviderForTests,
  type PreviewPage,
} from '../../../main/coding/preview-browser'

const ORIGINAL_BROWSER_TOOLS = process.env.BLOMA_BROWSER_TOOLS

function ctxFor(projectId: string, sessionId: string, previewUrl?: string): ToolContext {
  const state = createToolState()
  if (previewUrl) state.preview_url = previewUrl
  return {
    projectId,
    sessionId,
    requestId: 'req-preview-browser',
    signal: new AbortController().signal,
    state,
  }
}

function byName(name: string, projectId: string) {
  const tools = buildPreviewBrowserTools(projectId)
  const hit = tools.find((tool) => tool.name === name)
  if (!hit) throw new Error(`工具不存在：${name}`)
  return hit
}

describe('assertSameOrigin（同源守卫，纯函数）', () => {
  const origin = 'http://127.0.0.1:3789'

  it('相对路径按 origin 解析为同源绝对地址', () => {
    expect(assertSameOrigin('/', origin)).toEqual({ ok: true, url: 'http://127.0.0.1:3789/' })
    expect(assertSameOrigin('index.html', origin)).toEqual({ ok: true, url: 'http://127.0.0.1:3789/index.html' })
    expect(assertSameOrigin('/api/records', origin)).toEqual({ ok: true, url: 'http://127.0.0.1:3789/api/records' })
  })

  it('同源绝对地址放行', () => {
    expect(assertSameOrigin('http://127.0.0.1:3789/sub/page?x=1', origin).ok).toBe(true)
  })

  it('外域/跨端口/协议一律拒绝，且措辞指向同源代理', () => {
    for (const candidate of ['https://127.0.0.1:3789/', 'http://127.0.0.1:3790/', 'http://example.com/', 'http://localhost:3789/']) {
      const result = assertSameOrigin(candidate, origin)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('同源代理')
    }
  })

  it('非 http(s) 协议与空值拒绝', () => {
    expect(assertSameOrigin('file:///etc/passwd', origin).ok).toBe(false)
    expect(assertSameOrigin('javascript:alert(1)', origin).ok).toBe(false)
    expect(assertSameOrigin('', origin).ok).toBe(false)
    expect(assertSameOrigin('http://', origin).ok).toBe(false)
  })
})

describe('工具注册与开关（假 page）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-preview-browser-'))
    setPageProviderForTests(undefined)
  })
  afterEach(() => {
    void closeAllPreviewBrowserSessionsForTests()
    setPageProviderForTests(undefined)
    restorePromaHome(originalPromaHome)
    if (ORIGINAL_BROWSER_TOOLS === undefined) delete process.env.BLOMA_BROWSER_TOOLS
    else process.env.BLOMA_BROWSER_TOOLS = ORIGINAL_BROWSER_TOOLS
  })

  it('BLOMA_BROWSER_TOOLS 缺省 off：buildAgentTools 零注册（字节级现状锁）', () => {
    delete process.env.BLOMA_BROWSER_TOOLS
    expect(browserToolsEnabled()).toBe(false)
    const project = createProject({ request_id: 'req-pb-off', mode: 'quick' })
    const names = buildAgentTools({ projectId: project.project_id }).map((tool) => tool.name)
    expect(names.some((name) => name.startsWith('preview_'))).toBe(false)
    // find（W3 无条件只读件）在，浏览器族不在
    expect(names).toContain('find')
  })

  it('开关 on：主 loop 注册 8 件套；子角色（review/implement）不注册（v1 只挂主 loop）', () => {
    process.env.BLOMA_BROWSER_TOOLS = '1'
    const project = createProject({ request_id: 'req-pb-on', mode: 'quick' })
    const parent = buildAgentTools({ projectId: project.project_id }).map((tool) => tool.name)
    expect(parent.filter((name) => name.startsWith('preview_')).sort()).toEqual(
      ['preview_click', 'preview_extract', 'preview_fill', 'preview_navigate', 'preview_observe', 'preview_press', 'preview_screenshot', 'preview_wait_for'].sort(),
    )
    for (const role of ['review', 'implement', 'research'] as const) {
      const names = buildAgentTools({ projectId: project.project_id, role }).map((tool) => tool.name)
      expect(names.some((name) => name.startsWith('preview_'))).toBe(false)
    }
  })

  it('无 preview_url 时如实报「先 run_preview」', async () => {
    const project = createProject({ request_id: 'req-pb-nopreview', mode: 'quick' })
    const ctx = ctxFor(project.project_id, 'session-pb-nopreview')
    const outcome = await byName('preview_navigate', project.project_id).execute({ url: '/' }, ctx)
    expect(outcome.isError).toBe(true)
    expect(outcome.output).toContain('run_preview')
  })

  it('navigate 同源放行 + 外域拒绝（假 page）', async () => {
    const project = createProject({ request_id: 'req-pb-nav', mode: 'quick' })
    setPageProviderForTests(async () => fakePage())
    const ctx = ctxFor(project.project_id, 'session-pb-nav', 'http://127.0.0.1:3789')
    const ok = await byName('preview_navigate', project.project_id).execute({ url: '/index.html' }, ctx)
    expect(ok.isError).toBeUndefined()
    expect(ok.output).toContain('已打开')
    const denied = await byName('preview_navigate', project.project_id).execute({ url: 'http://example.com/' }, ctx)
    expect(denied.isError).toBe(true)
    expect(denied.output).toContain('同源代理')
  })

  it('observe 返回 aria 快照并附控制台错误；fill/click 输出塑形', async () => {
    const project = createProject({ request_id: 'req-pb-shape', mode: 'quick' })
    setPageProviderForTests(async (_url, onConsoleError) => {
      onConsoleError('[error] boom')
      return fakePage()
    })
    const ctx = ctxFor(project.project_id, 'session-pb-shape', 'http://127.0.0.1:3789')
    const observed = await byName('preview_observe', project.project_id).execute({}, ctx)
    expect(observed.output).toContain('button "开始"')
    expect(observed.output).toContain('[error] boom')
    const filled = await byName('preview_fill', project.project_id).execute({ selector: '#name', text: '你好 世界' }, ctx)
    expect(filled.output).toContain('填入 5 字符')
    const clicked = await byName('preview_click', project.project_id).execute({ selector: '#start', wait_for: 'text:游戏中' }, ctx)
    expect(clicked.output).toContain('已点击 #start')
    expect(clicked.output).toContain('已等到 text: 游戏中')
  })

  it('会话按 sessionId 复用；closePreviewBrowserSession 幂等清理', async () => {
    const project = createProject({ request_id: 'req-pb-sess', mode: 'quick' })
    let created = 0
    setPageProviderForTests(async () => {
      created += 1
      return fakePage()
    })
    const ctx = ctxFor(project.project_id, 'session-pb-sess', 'http://127.0.0.1:3789')
    await byName('preview_observe', project.project_id).execute({}, ctx)
    await byName('preview_observe', project.project_id).execute({}, ctx)
    expect(created).toBe(1)
    expect(previewBrowserSessionCount()).toBe(1)
    await closePreviewBrowserSession('session-pb-sess')
    await closePreviewBrowserSession('session-pb-sess')
    expect(previewBrowserSessionCount()).toBe(0)
    // 关闭后再用会重建（created 递增）
    await byName('preview_observe', project.project_id).execute({}, ctx)
    expect(created).toBe(2)
  })

  it('screenshot 落盘 documents/preview-shots 并返回路径', async () => {
    const project = createProject({ request_id: 'req-pb-shot', mode: 'quick' })
    setPageProviderForTests(async () => fakePage())
    const ctx = ctxFor(project.project_id, 'session-pb-shot', 'http://127.0.0.1:3789')
    const outcome = await byName('preview_screenshot', project.project_id).execute({}, ctx)
    expect(outcome.output).toContain('截图已保存')
    expect(outcome.output).toContain('1200×800')
  })
})

/** 假 page：固定返回可断言的快照/文本（控制台错误经 provider 的 onConsoleError 注入）。 */
function fakePage(): PreviewPage {
  return {
    url: () => 'http://127.0.0.1:3789/index.html',
    title: async () => '测试页',
    goto: async () => ({}),
    ariaSnapshot: async () => '- button "开始" [id=start]',
    click: async () => undefined,
    fill: async () => undefined,
    press: async () => undefined,
    innerText: async () => '分数：0\n状态：未开始',
    screenshot: async () => Buffer.from('png'),
    waitForSelector: async () => undefined,
    waitForURL: async () => undefined,
    getByText: () => ({ first: () => ({ waitFor: async () => undefined }) }),
    viewportSize: () => ({ width: 1200, height: 800 }),
    close: async () => undefined,
  }
}

describe('真浏览器集成（无 chromium 整组跳过）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let serverUrl = ''
  let closeServer: (() => Promise<void>) | undefined

  beforeEach(async () => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-preview-browser-e2e-'))
    process.env.BLOMA_BROWSER_TOOLS = '1'
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<!DOCTYPE html><html><head><style>body{color:#333}</style><title>集成页</title></head>' +
          '<body><input id="name" /><button id="start">开始</button><div id="state">未开始</div>' +
          '<script>document.getElementById("start").addEventListener("click",function(){document.getElementById("state").textContent="游戏中"})</script>' +
          '</body></html>',
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    serverUrl = `http://127.0.0.1:${address.port}`
    closeServer = () => new Promise<void>((resolve) => server.close(() => resolve()))
  })

  afterEach(async () => {
    await closeAllPreviewBrowserSessionsForTests()
    await closeServer?.()
    restorePromaHome(originalPromaHome)
    if (ORIGINAL_BROWSER_TOOLS === undefined) delete process.env.BLOMA_BROWSER_TOOLS
    else process.env.BLOMA_BROWSER_TOOLS = ORIGINAL_BROWSER_TOOLS
  })

  async function playwrightAvailable(): Promise<boolean> {
    try {
      const { chromium } = await import('playwright')
      const browser = await chromium.launch({ headless: true })
      await browser.close()
      return true
    } catch {
      return false
    }
  }

  it('navigate→observe→fill→click(wait_for)→extract 全链路 + 外域拒绝', async () => {
    if (!(await playwrightAvailable())) return
    const project = createProject({ request_id: 'req-pb-e2e', mode: 'quick' })
    recordSketchGenerated(project.project_id, [])
    const ctx = ctxFor(project.project_id, 'session-pb-e2e', serverUrl)
    const nav = await byName('preview_navigate', project.project_id).execute({ url: '/' }, ctx)
    expect(nav.isError).toBeUndefined()
    expect(nav.output).toContain('集成页')
    const observed = await byName('preview_observe', project.project_id).execute({}, ctx)
    expect(observed.output).toContain('开始')
    await byName('preview_fill', project.project_id).execute({ selector: '#name', text: '玩家一' }, ctx)
    const clicked = await byName('preview_click', project.project_id).execute({ selector: '#start', wait_for: 'text:游戏中' }, ctx)
    expect(clicked.output).toContain('已点击 #start')
    const extracted = await byName('preview_extract', project.project_id).execute({ selector: '#state' }, ctx)
    expect(extracted.output).toContain('游戏中')
    const denied = await byName('preview_navigate', project.project_id).execute({ url: 'http://example.com/' }, ctx)
    expect(denied.isError).toBe(true)
    expect(denied.output).toContain('同源代理')
    // 循环结束清理（同 loop finally 语义）
    await closePreviewBrowserSession('session-pb-e2e')
    expect(previewBrowserSessionCount()).toBe(0)
  })
})
