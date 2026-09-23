import type { WebContents } from 'electron'
import type { DomCollectContextResult, DomScrollPreviewResult } from '../../shared/types'

/**
 * U8：点选纠错 DOM 上下文收集（对齐 api-spec §12.8 `collect_dom_context`）。
 *
 * 渲染进程的预览 iframe 是跨域子帧（file:// 主窗 / Vite dev server vs localhost 沙箱），
 * 渲染端无法 `contentDocument` 直接读取；但主进程拥有 BrowserWindow 的 WebContents，
 * 可通过 `webContents.mainFrame.frames` 枚举子帧并用 `executeJavaScript` 越过同源限制，
 * 在预览页里执行 `document.elementFromPoint` 拿到点击处的元素信息。
 *
 * 拿到元素后返回 selector + 文本 + 真实包围盒；拿不到（无子帧/点击处无元素/脚本失败）
 * 则回退 `fallback_mode: true`，上层保留纯坐标模式。
 */

const PREVIEW_FRAME_URL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//

const fallback = (click: { x: number; y: number }): DomCollectContextResult => ({
  bounding_rect: { x: click.x, y: click.y, width: 0, height: 0 },
  fallback_mode: true,
})

function clampCoordinate(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0
}

/**
 * 找到承载预览 iframe 的子帧（加载自 localhost 且非主帧）。
 * 主窗本身在 dev 下也是 localhost（Vite），故必须排除 mainFrame。
 */
function findPreviewFrame(webContents: WebContents) {
  const mainFrame = webContents.mainFrame
  if (!mainFrame) return undefined
  const frames = mainFrame.frames ?? []
  for (const frame of frames) {
    if (frame === mainFrame) continue
    try {
      if (PREVIEW_FRAME_URL.test(frame.url)) return frame
    } catch {
      // 帧可能已 disposed，忽略继续找
    }
  }
  return undefined
}

/** 在预览子帧内收集点击处的元素上下文；失败/无元素时回退纯坐标。 */
export async function collectDomContext(
  webContents: WebContents,
  click: { x: number; y: number },
): Promise<DomCollectContextResult> {
  const frame = findPreviewFrame(webContents)
  if (!frame) return fallback(click)

  const x = clampCoordinate(click.x)
  const y = clampCoordinate(click.y)

  const script = `(() => {
  const el = document.elementFromPoint(${x}, ${y})
  if (!el || el === document.documentElement || el === document.body) return null
  const rect = el.getBoundingClientRect()
  const tag = el.tagName ? el.tagName.toLowerCase() : ''
  const id = el.id ? '#' + el.id : ''
  let cls = ''
  if (typeof el.className === 'string' && el.className.trim()) {
    cls = '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
  }
  const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200)
  return {
    selector: tag + id + cls,
    text,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
  }
})()`

  try {
    const result = (await frame.executeJavaScript(script, true)) as
      | { selector: string; text: string; rect: { x: number; y: number; width: number; height: number } }
      | null
      | undefined

    if (!result || !result.selector || !(result.rect?.width > 0)) return fallback(click)

    return {
      element_selector: result.selector,
      text_content: result.text || undefined,
      bounding_rect: {
        x: clampCoordinate(result.rect.x),
        y: clampCoordinate(result.rect.y),
        width: clampCoordinate(result.rect.width),
        height: clampCoordinate(result.rect.height),
      },
      fallback_mode: false,
    }
  } catch {
    return fallback(click)
  }
}

/**
 * 点选纠错滚动转发：把渲染端捕获层收到的滚轮/中键拖拽增量滚到跨域预览 iframe。
 * 渲染端无法 contentWindow.scrollBy（跨域），主进程经 frame.executeJavaScript
 * 越过同源限制执行 window.scrollBy。滚动后读取 window.scrollX/scrollY 返回，
 * 供渲染端精确计算弹窗/标记的跟随偏移（避免用滚轮 delta 猜测导致边界漂移）。
 * 找不到预览子帧时返回 scrolled:false，前端静默忽略。
 */
export async function scrollPreview(
  webContents: WebContents,
  deltaX: number,
  deltaY: number,
): Promise<DomScrollPreviewResult> {
  const frame = findPreviewFrame(webContents)
  if (!frame) return { scrolled: false, scroll_x: 0, scroll_y: 0 }

  const dx = Number.isFinite(deltaX) ? deltaX : 0
  const dy = Number.isFinite(deltaY) ? deltaY : 0

  try {
    await frame.executeJavaScript(`window.scrollBy(${dx}, ${dy})`, true)
    const pos = (await frame.executeJavaScript(
      `({ x: window.scrollX || 0, y: window.scrollY || 0 })`,
      true,
    )) as { x: number; y: number }
    return {
      scrolled: true,
      scroll_x: Math.round(pos?.x ?? 0),
      scroll_y: Math.round(pos?.y ?? 0),
    }
  } catch {
    return { scrolled: false, scroll_x: 0, scroll_y: 0 }
  }
}
