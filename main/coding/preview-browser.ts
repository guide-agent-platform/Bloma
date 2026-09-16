/**
 * 预览浏览器工具族（Phase 10 W1，2026-09-16；同步自 Proma 上游 Browser* 工具库）。
 *
 * 解决什么：编程 Agent 此前只能通过 GWT 断言的文本结果间接了解产物，看不见也摸不着
 * 真实渲染出来的界面（B 站假绿/canvas 断言/死按钮类病灶的生成侧盲区）。本模块给主 loop
 * 一个持久 Playwright 会话：navigate/observe/click/fill/press/extract/screenshot/wait_for
 * 八件套，Agent 可以像用户一样驱动自己的产物并拿回可读证据。
 *
 * 设计要点（与 Proma 上游的差异均是有意适配）：
 * - **同源硬边界**（上游没有，Bloma 特有）：只允许访问 ctx.state.preview_url 的 origin——
 *   外网必须走 server/routes 同源代理（与 CSP/媒体纪律同口径），浏览器会话不做第二个
 *   网络出口（net-guard 的 SSRF 防线不经由本模块旁路）。
 * - **selector-first**（上游 Observe/Click 走 a11y ref）：Bloma 全链（GWT 探针/修复轮
 *   location）已统一 CSS selector 语汇，工具面沿用 selector + 可选 wait_for，与仓库
 *   约定一致且可单测。
 * - **持久会话**：page 句柄按 sessionId 缓存（run 级生命周期），loop finally 与 5 分钟
 *   闲置看门狗双保险关闭；全部串行（共享 page 天然互斥，不声明 parallelSafe）。
 * - **截图不回传图像块**：loop 工具结果通道是纯文本（无 image block），v1 截图落盘
 *   documents/preview-shots/ 并返回路径+尺寸+控制台错误摘要；视觉理解增强（接 V1
 *   视觉渠道转描述）列为后续可选。
 * - 开关 BLOMA_BROWSER_TOOLS（缺省 off = 工具不注册，字节级现状）。
 * - 只挂主 loop（role='parent'）；委派子 agent 不开放（review 只读三件套列为后续）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDocumentsDir } from '../../storage/config-paths'
import { findProject } from '../project-service'
import type { AgentLoopTool, ToolContext, ToolOutcome } from '../agent-loop'

/** 开关：off = buildAgentTools 不注册本工具族（字节级现状）。 */
export function browserToolsEnabled(): boolean {
  return process.env.BLOMA_BROWSER_TOOLS === '1' || process.env.BLOMA_BROWSER_TOOLS === 'true'
}

/** 闲置看门狗：5 分钟无工具调用即关闭会话（防句柄跨 run 泄漏的最后防线）。 */
const IDLE_WATCHDOG_MS = 5 * 60_000
/** observe/extract 返回上限（字符）——ACI 截断契约。 */
const EXTRACT_CHAR_LIMIT = 4_000
/** wait_for 超时上限（毫秒）。 */
const WAIT_TIMEOUT_LIMIT_MS = 10_000
/** 单次操作超时（毫秒）：page 动作默认超时收敛到本地秒级。 */
const PAGE_ACTION_TIMEOUT_MS = 15_000
/** 会话内保留的最近控制台错误条数（截图/observe 附证据用）。 */
const CONSOLE_ERROR_HISTORY = 20

/** Playwright Page 的最小结构面（测试可注入假实现；避免在类型层 import playwright）。 */
export interface PreviewPage {
  goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<{ url?: string }>
  title(): Promise<string>
  ariaSnapshot(options?: { timeout?: number }): Promise<string>
  click(selector: string, options?: { timeout?: number }): Promise<void>
  fill(selector: string, text: string, options?: { timeout?: number }): Promise<void>
  press(selector: string, key: string, options?: { timeout?: number }): Promise<void>
  innerText(selector: string, options?: { timeout?: number }): Promise<string>
  screenshot(options: { path?: string; fullPage?: boolean; type?: string }): Promise<Buffer>
  waitForSelector(selector: string, options?: { timeout?: number; state?: string }): Promise<unknown>
  waitForURL(pattern: string | RegExp, options?: { timeout?: number }): Promise<void>
  getByText(text: string, options?: { exact?: boolean }): { first(): { waitFor(options?: { timeout?: number; state?: string }): Promise<unknown> } }
  viewportSize(): { width: number; height: number } | null
  url(): string
  close(): Promise<void>
}

interface PreviewSession {
  page: PreviewPage
  /** 本会话允许的唯一 origin（来自 run_preview 的 preview_url）。 */
  origin: string
  lastUsedAt: number
  watchdog: ReturnType<typeof setTimeout>
  consoleErrors: string[]
}

/** sessionId → 持久会话（run 级生命周期；看门狗兜底回收）。 */
const sessions = new Map<string, PreviewSession>()

/** 同源守卫（纯函数）：candidate 允许是同 origin 绝对 URL 或相对路径；外域一律拒绝。 */
export function assertSameOrigin(candidate: string, origin: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = String(candidate ?? '').trim()
  if (!trimmed) return { ok: false, error: '缺少 url/path 参数。' }
  try {
    const originParsed = new URL(origin)
    const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? new URL(trimmed) : new URL(trimmed, originParsed)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return { ok: false, error: `只允许 http/https 地址（收到 ${target.protocol}）。` }
    }
    if (target.origin !== originParsed.origin) {
      return {
        ok: false,
        error: `浏览器工具只允许访问预览源 ${originParsed.origin}（收到 ${target.origin}）。外部资源必须经 server/routes/ 同源代理转发，浏览器不直接出网。`,
      }
    }
    return { ok: true, url: target.toString() }
  } catch {
    return { ok: false, error: `无法解析目标地址：${trimmed.slice(0, 120)}` }
  }
}

/** 真实页面提供方：懒加载 playwright（沙箱/CI 缺浏览器时在启动处如实报错）。 */
async function realPageProvider(previewUrl: string, onConsoleError: (line: string) => void): Promise<PreviewPage> {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({
    headless: true,
    // 与 gwt-runner 同款媒体假设备：录音/摄像头类产物的健康探查口径一致
    args: ['--use-fake-device-for-media-stream'],
  })
  const page = await browser.newPage()
  page.setDefaultTimeout(PAGE_ACTION_TIMEOUT_MS)
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      onConsoleError(`[${msg.type()}] ${msg.text().slice(0, 200)}`)
    }
  })
  page.on('pageerror', (err) => {
    onConsoleError(`[pageerror] ${String(err && err.message ? err.message : err).slice(0, 200)}`)
  })
  // page 关闭时同步关浏览器（会话只持 page 句柄，浏览器随 page 生命周期）
  page.once('close', () => {
    void browser.close().catch(() => undefined)
  })
  return page as unknown as PreviewPage
}

export type PageProvider = (previewUrl: string, onConsoleError: (line: string) => void) => Promise<PreviewPage>

let pageProviderForTests: PageProvider | undefined

/** 测试 seam：注入假 page（避免单测依赖真实 chromium）。 */
export function setPageProviderForTests(provider?: PageProvider): void {
  pageProviderForTests = provider
}

/** 取/建会话并续期看门狗。 */
async function getSession(ctx: ToolContext): Promise<PreviewSession> {
  const existing = sessions.get(ctx.sessionId)
  if (existing) {
    existing.lastUsedAt = Date.now()
    return existing
  }
  const previewUrl = ctx.state.preview_url
  if (!previewUrl) {
    throw new ToolError('还没有可用的预览地址。请先调用 run_preview 启动预览，再使用浏览器工具。')
  }
  const origin = new URL(previewUrl).origin
  const consoleErrors: string[] = []
  const provider = pageProviderForTests ?? realPageProvider
  const page = await provider(previewUrl, (line) => {
    consoleErrors.push(line)
    if (consoleErrors.length > CONSOLE_ERROR_HISTORY) consoleErrors.shift()
  })
  const session: PreviewSession = {
    page,
    origin,
    lastUsedAt: Date.now(),
    consoleErrors,
    watchdog: setTimeout(() => {
      void closePreviewBrowserSession(ctx.sessionId)
    }, IDLE_WATCHDOG_MS),
  }
  session.watchdog.unref?.()
  sessions.set(ctx.sessionId, session)
  return session
}

/** 工具级错误（带用户可读措辞，不炸 loop）。 */
class ToolError extends Error {}

/** 立即关闭并清理某会话的浏览器句柄（幂等；loop finally 与看门狗共用）。 */
export async function closePreviewBrowserSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) return
  sessions.delete(sessionId)
  clearTimeout(session.watchdog)
  await session.page.close().catch(() => undefined)
}

/** 供测试检查会话数（防句柄泄漏断言）。 */
export function previewBrowserSessionCount(): number {
  return sessions.size
}

/** 测试辅助：清空全部会话。 */
export async function closeAllPreviewBrowserSessionsForTests(): Promise<void> {
  for (const id of [...sessions.keys()]) await closePreviewBrowserSession(id)
}

function recentConsoleErrors(ctx: ToolContext, limit = 5): string {
  const session = sessions.get(ctx.sessionId)
  if (!session || session.consoleErrors.length === 0) return ''
  const lines = session.consoleErrors.slice(-limit).map((line) => `- ${line}`).join('\n')
  return `\n最近控制台错误/警告：\n${lines}`
}

function withPage<T>(ctx: ToolContext, fn: (session: PreviewSession) => Promise<T>): Promise<T | ToolOutcome> {
  return getSession(ctx)
    .then(fn)
    .catch((error: unknown) => {
      if (error instanceof ToolError) return { output: error.message, isError: true } satisfies ToolOutcome
      return { output: `浏览器工具执行失败：${error instanceof Error ? error.message : String(error)}`, isError: true } satisfies ToolOutcome
    }) as Promise<T | ToolOutcome>
}

function resolveTarget(ctx: ToolContext, pathOrUrl: string): { ok: true; url: string } | { ok: false; error: string } {
  const previewUrl = ctx.state.preview_url
  if (!previewUrl) return { ok: false, error: '还没有可用的预览地址。请先调用 run_preview 启动预览，再使用浏览器工具。' }
  return assertSameOrigin(pathOrUrl, previewUrl)
}

function truncate(text: string, limit = EXTRACT_CHAR_LIMIT): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit)}\n…（截断，共 ${trimmed.length} 字符；可用 selector 缩小范围）`
}

function stringOr(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** 构建八件套（仅 BLOMA_BROWSER_TOOLS=on 时由 buildAgentTools 注册）。 */
export function buildPreviewBrowserTools(projectId: string): AgentLoopTool[] {
  const preview_navigate: AgentLoopTool = {
    name: 'preview_navigate',
    description:
      '在预览浏览器里打开一个页面（同源限制：只能访问预览源内地址）。参数：url（相对路径如 / 或 /index.html，或同源绝对地址）。返回最终 URL、页面标题与最近控制台错误。',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: '相对路径（如 /）或同源绝对地址' } },
      required: ['url'],
    },
    execute: async (toolInput, ctx) =>
      withPage(ctx, async (session) => {
        const target = resolveTarget(ctx, stringOr(toolInput.url, '/'))
        if (!target.ok) return { output: target.error, isError: true } satisfies ToolOutcome
        const response = await session.page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: PAGE_ACTION_TIMEOUT_MS })
        const title = await session.page.title().catch(() => '')
        void response
        return {
          output: `已打开 ${session.page.url()}（标题：${title || '（无）'}）${recentConsoleErrors(ctx)}`,
          detail: { url: session.page.url(), title },
        } satisfies ToolOutcome
      }),
  }

  const preview_observe: AgentLoopTool = {
    name: 'preview_observe',
    description:
      '获取当前页面的可访问性快照（aria snapshot 文本，展示按钮/输入框/链接等可交互元素与层级）。适合在点击/填写前先了解页面结构。无参数；返回上限 4000 字符。',
    input_schema: { type: 'object', properties: {} },
    execute: async (_toolInput, ctx) =>
      withPage(ctx, async (session) => {
        const snapshot = await session.page.ariaSnapshot({ timeout: PAGE_ACTION_TIMEOUT_MS })
        return { output: `${truncate(snapshot)}${recentConsoleErrors(ctx)}`, detail: { chars: snapshot.length } } satisfies ToolOutcome
      }),
  }

  const preview_click: AgentLoopTool = {
    name: 'preview_click',
    description:
      '点击页面元素。参数：selector（CSS 选择器，如 #start-btn、button.primary）；wait_for（可选，点击后等待条件，格式 "text:文案" / "selector:CSS" / "url:片段"）。返回点击结果与最新控制台错误。',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器' },
        wait_for: { type: 'string', description: '点击后等待：text:xxx / selector:xxx / url:xxx' },
      },
      required: ['selector'],
    },
    execute: async (toolInput, ctx) =>
      withPage(ctx, async (session) => {
        const selector = stringOr(toolInput.selector).trim()
        if (!selector) return { output: '缺少 selector 参数。', isError: true } satisfies ToolOutcome
        await session.page.click(selector, { timeout: PAGE_ACTION_TIMEOUT_MS })
        let waited = ''
        const waitRaw = stringOr(toolInput.wait_for).trim()
        if (waitRaw) {
          waited = await applyWait(session, waitRaw)
        }
        return {
          output: `已点击 ${selector}${waited ? `；${waited}` : ''}${recentConsoleErrors(ctx)}`,
          detail: { selector },
        } satisfies ToolOutcome
      }),
  }

  const preview_fill: AgentLoopTool = {
    name: 'preview_fill',
    description: '向输入框/文本域整体填入文本（替换现有值）。参数：selector（CSS 选择器）、text（要填入的完整文本）。返回填写结果。',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器（input/textarea）' },
        text: { type: 'string', description: '要填入的完整文本（含空格/标点，整体替换）' },
      },
      required: ['selector', 'text'],
    },
    execute: async (toolInput, ctx) =>
      withPage(ctx, async (session) => {
        const selector = stringOr(toolInput.selector).trim()
        const text = stringOr(toolInput.text)
        if (!selector) return { output: '缺少 selector 参数。', isError: true } satisfies ToolOutcome
        await session.page.fill(selector, text, { timeout: PAGE_ACTION_TIMEOUT_MS })
        return { output: `已在 ${selector} 填入 ${text.length} 字符。`, detail: { selector, chars: text.length } } satisfies ToolOutcome
      }),
  }

  const preview_press: AgentLoopTool = {
    name: 'preview_press',
    description: '在指定元素上按键盘键（Enter/ArrowLeft/Escape 等导航键，也可传完整文本逐字键入）。参数：selector（CSS 选择器）、key（键名或文本）。',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器（聚焦目标）' },
        key: { type: 'string', description: '键名（如 Enter）或要键入的文本' },
      },
      required: ['selector', 'key'],
    },
    execute: async (toolInput, ctx) =>
      withPage(ctx, async (session) => {
        const selector = stringOr(toolInput.selector).trim()
        const key = stringOr(toolInput.key)
        if (!selector || !key) return { output: '缺少 selector 或 key 参数。', isError: true } satisfies ToolOutcome
        await session.page.press(selector, key, { timeout: PAGE_ACTION_TIMEOUT_MS })
        return { output: `已在 ${selector} 按下「${key.slice(0, 40)}」。`, detail: { selector, key } } satisfies ToolOutcome
      }),
  }

  const preview_extract: AgentLoopTool = {
    name: 'preview_extract',
    description:
      '提取页面文本内容（默认整页；建议传 selector 限定到列表/正文区域降噪）。参数：selector（可选，CSS 选择器）、max_chars（可选，默认 4000）。',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '限定提取范围的 CSS 选择器（缺省整页 body）' },
        max_chars: { type: 'number', description: '返回上限字符数（默认 4000）' },
      },
    },
    execute: async (toolInput, ctx) =>
      withPage(ctx, async (session) => {
        const selector = stringOr(toolInput.selector).trim() || 'body'
        const maxChars = typeof toolInput.max_chars === 'number' && Number.isFinite(toolInput.max_chars)
          ? Math.min(Math.max(Math.trunc(toolInput.max_chars), 100), EXTRACT_CHAR_LIMIT)
          : EXTRACT_CHAR_LIMIT
        const text = await session.page.innerText(selector, { timeout: PAGE_ACTION_TIMEOUT_MS }).catch((error: unknown) => {
          throw new ToolError(`提取失败（${selector}）：${error instanceof Error ? error.message : String(error)}`)
        })
        return { output: `${truncate(text, maxChars)}${recentConsoleErrors(ctx)}`, detail: { selector, chars: text.length } } satisfies ToolOutcome
      }),
  }

  const preview_screenshot: AgentLoopTool = {
    name: 'preview_screenshot',
    description:
      '截图保存到项目 documents/preview-shots/（返回文件路径+视口尺寸+控制台错误摘要；不返回图像本身）。参数：full_page（可选，截整页）。',
    input_schema: {
      type: 'object',
      properties: { full_page: { type: 'boolean', description: '是否截取整页（默认视口）' } },
    },
    execute: async (toolInput, ctx) =>
      withPage(ctx, async (session) => {
        const project = findProject(projectId)
        const dir = join(getDocumentsDir(project.workspace_slug, projectId), 'preview-shots')
        mkdirSync(dir, { recursive: true })
        const name = `shot-${Date.now()}.png`
        const path = join(dir, name)
        await session.page.screenshot({ path, fullPage: toolInput.full_page === true, type: 'png' })
        const viewport = session.page.viewportSize()
        return {
          output:
            `截图已保存：${name}（${viewport ? `${viewport.width}×${viewport.height}` : '未知尺寸'}）。` +
            `文本视角可先用 preview_observe 看可交互结构。${recentConsoleErrors(ctx)}`,
          detail: { path, width: viewport?.width, height: viewport?.height },
        } satisfies ToolOutcome
      }),
  }

  const preview_wait_for: AgentLoopTool = {
    name: 'preview_wait_for',
    description:
      '等待页面条件成立（页面动态渲染后取证据前用）。参数：kind（text/selector/url）、value（对应值）、timeout_ms（可选，默认 5000，上限 10000）。超时如实返回失败不判崩。',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'text / selector / url' },
        value: { type: 'string', description: '对应条件的值（文案/CSS 选择器/URL 片段）' },
        timeout_ms: { type: 'number', description: '超时毫秒（默认 5000）' },
      },
      required: ['kind', 'value'],
    },
    execute: async (toolInput, ctx) =>
      withPage(ctx, async (session) => {
        const kind = stringOr(toolInput.kind).trim()
        const value = stringOr(toolInput.value).trim()
        if (!value) return { output: '缺少 value 参数。', isError: true } satisfies ToolOutcome
        const timeout = Math.min(
          typeof toolInput.timeout_ms === 'number' && Number.isFinite(toolInput.timeout_ms) ? Math.trunc(toolInput.timeout_ms) : 5_000,
          WAIT_TIMEOUT_LIMIT_MS,
        )
        try {
          await applyWaitKind(session, kind, value, timeout)
          return { output: `条件已成立（${kind}: ${value.slice(0, 80)}）。` } satisfies ToolOutcome
        } catch (error) {
          return {
            output: `等待超时或失败（${kind}: ${value.slice(0, 80)}，${timeout}ms）：${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          } satisfies ToolOutcome
        }
      }),
  }

  return [preview_navigate, preview_observe, preview_click, preview_fill, preview_press, preview_extract, preview_screenshot, preview_wait_for]
}

/** wait_for 语法（text:/selector:/url: 前缀，无前缀按 text 处理）。 */
async function applyWait(session: PreviewSession, raw: string): Promise<string> {
  const kind = raw.includes(':') ? raw.slice(0, raw.indexOf(':')) : 'text'
  const value = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw
  await applyWaitKind(session, kind, value, 5_000)
  return `已等到 ${kind}: ${value.slice(0, 60)}`
}

async function applyWaitKind(session: PreviewSession, kind: string, value: string, timeout: number): Promise<void> {
  if (kind === 'selector') {
    await session.page.waitForSelector(value, { timeout, state: 'visible' })
    return
  }
  if (kind === 'url') {
    await session.page.waitForURL(value, { timeout })
    return
  }
  // 缺省按 text 处理（与 wait_for 主口径一致）
  await session.page.getByText(value).first().waitFor({ timeout, state: 'visible' })
}
