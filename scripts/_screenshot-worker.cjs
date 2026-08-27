// _screenshot-worker.cjs — Playwright 截图 worker（供 bloma-vision-mcp.cjs 调用）
// 用法: node _screenshot-worker.cjs <url> <outPath> <viewportW> <viewportH>
const { chromium } = require('playwright')
const path = require('node:path')

async function main() {
  const [url, outPath, viewportW, viewportH] = process.argv.slice(2)
  if (!url) {
    console.error(JSON.stringify({ ok: false, error: '缺少 url' }))
    process.exit(1)
  }
  const finalOut = outPath || path.join(require('node:os').tmpdir(), `bloma-shot-${Date.now()}.png`)
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: Number(viewportW || 1440), height: Number(viewportH || 900) } })
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(1200)
    await page.screenshot({ path: finalOut, fullPage: false })
    console.log(JSON.stringify({ ok: true, url, path: finalOut }))
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }))
  process.exit(1)
})
