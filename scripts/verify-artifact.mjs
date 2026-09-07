#!/usr/bin/env node
/**
 * .verify-artifact.cjs — 灰度产物独立可用性检验（L1 健康检查 + 截图供视觉审判）
 *
 * 不信任流水线 verdict，第三方视角重新验证 ready 产物：
 *   1. 起真 HTTP 静态服务（自带 MIME）
 *   2. Playwright chromium 真加载：console/pageerror 收集、DOM 非空、可见文字、
 *      交互控件存在性、通用点击冒烟（点前 3 个 button 观察是否引发未捕获错误）
 *   3. 全页截图 PNG（供 bloma-vision vision_diagnose 对照样本意图审判）
 * 用法: node .verify-artifact.cjs <产物目录> <输出前缀>
 * 退出码: 0=健康; 2=有 JS 错误或空页面; 3=加载失败
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { chromium } from 'playwright'

const [dir, outPrefix = 'artifact'] = process.argv.slice(2)
if (!dir || !existsSync(join(dir, 'index.html'))) {
  console.error('用法: node .verify-artifact.cjs <产物目录(含index.html)> <前缀>')
  process.exit(3)
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' }
const server = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '').replace(/\/$/, '') || 'index.html'
  for (const cand of [join(dir, rel), join(dir, rel + '.html'), join(dir, rel, 'index.html')]) {
    if (existsSync(cand) && !cand.endsWith('\\') && extname(cand)) {
      try {
        res.writeHead(200, { 'content-type': MIME[extname(cand)] || 'application/octet-stream' })
        res.end(readFileSync(cand))
        return
      } catch {}
    }
  }
  res.writeHead(404).end('nf')
})
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()))
let loadOk = true
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 15_000 })
  await page.waitForTimeout(1200) // 等首帧脚本渲染
} catch (e) {
  loadOk = false
  errors.push('load: ' + e.message)
}
const report = { dir, loadOk, errors, checks: {} }
if (loadOk) {
  const dom = await page.evaluate(() => ({
    nodes: document.body ? document.body.querySelectorAll('*').length : 0,
    textLen: document.body ? document.body.innerText.trim().length : 0,
    buttons: document.querySelectorAll('button, [role=button], input[type=button], input[type=submit]').length,
    inputs: document.querySelectorAll('input, textarea, select').length,
  }))
  report.checks = dom
  // 通用点击冒烟：前 3 个可点控件点击后不得出现未捕获错误
  const btns = page.locator('button, input[type=button], input[type=submit]')
  const n = Math.min(await btns.count(), 3)
  const errBefore = errors.length
  for (let i = 0; i < n; i++) {
    try { await btns.nth(i).click({ timeout: 2500 }) } catch {}
    await page.waitForTimeout(400)
  }
  report.checks.clickSmoke = { clicked: n, newErrors: errors.length - errBefore }
  await page.screenshot({ path: `${outPrefix}.png`, fullPage: true })
  report.screenshot = `${outPrefix}.png`
}
report.verdict = !loadOk ? 'BROKEN'
  : errors.length > 0 ? 'JS_ERRORS'
  : report.checks.nodes < 5 || report.checks.textLen < 10 ? 'EMPTY_PAGE'
  : report.checks.clickSmoke?.newErrors > 0 ? 'CLICK_ERRORS'
  : report.checks.buttons + report.checks.inputs === 0 ? 'NO_INTERACTION'
  : 'HEALTHY'
console.log(JSON.stringify(report, null, 1))
await browser.close()
server.close()
process.exit(report.verdict === 'HEALTHY' ? 0 : 2)
