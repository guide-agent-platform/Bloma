export interface HtmlPreviewShot { png: Buffer; width: number; height: number; contentWidth: number; contentHeight: number }
export function canRenderHtmlPreview(): boolean { return Boolean(process.versions.electron) && process.env.ELECTRON_RUN_AS_NODE !== '1' }

/** A separate headless process contains renderer failures; never downloads a browser. */
export async function renderHtmlPreview(html: string, signal?: AbortSignal): Promise<HtmlPreviewShot[]> {
  if (!canRenderHtmlPreview()) throw new Error('VISUAL_RENDERER_UNAVAILABLE')
  const { chromium } = await import('playwright')
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let stopped = false
  const close = () => { stopped = true; void browser?.close().catch(() => undefined) }
  const timer = setTimeout(close, 15000)
  signal?.addEventListener('abort', close, { once: true })
  try {
    signal?.throwIfAborted()
    try { browser = await chromium.launch({ headless: true, timeout: 7000 }) }
    catch { if (stopped || signal?.aborted) throw new Error('VISUAL_RENDER_STOPPED'); browser = await chromium.launch({ headless: true, channel: 'msedge', timeout: 7000 }) }
    signal?.throwIfAborted()
    if (stopped) throw new Error('VISUAL_RENDER_TIMEOUT')
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false })
    await context.route('**/*', route => route.abort())
    const page = await context.newPage()
    const shots: HtmlPreviewShot[] = []
    for (const viewport of [{ width: 1100, height: 800 }, { width: 820, height: 700 }]) {
      signal?.throwIfAborted()
      await page.setViewportSize(viewport)
      await page.setContent(html, { waitUntil: 'load', timeout: 5000 })
      const metrics = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }))
      const png = await page.screenshot({ timeout: 5000 })
      signal?.throwIfAborted()
      if (!png.length) throw new Error('VISUAL_CAPTURE_EMPTY')
      shots.push({ png, ...viewport, contentWidth: metrics.width, contentHeight: metrics.height })
    }
    return shots
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', close); await browser?.close().catch(() => undefined) }
}
