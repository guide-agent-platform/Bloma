/** Offline Electron regression: fitting, long documents, interaction and studio motion. */
import { _electron } from 'playwright'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const root = resolve('.')
const folder = join(root, 'run-artifacts', 'sketch-viewport-native')
mkdirSync(folder, { recursive: true })
const home = mkdtempSync(join(folder, 'home-'))
const pid = randomUUID(), sid = randomUUID()
const projectRoot = join(home, 'agent-workspaces', 'default-software-builder', 'generated-projects', pid)
mkdirSync(join(projectRoot, '00_UX'), { recursive: true })
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body>
<header>长草图适应画布</header><main><h1>完整内容预览</h1><input value="保留交互状态" aria-label="草图输入"><button onclick="document.querySelector('#counter').textContent=++window.count">点击计数</button><span id="counter">0</span><p>原尺寸可放大阅读，适应画布可查看全貌。</p></main><footer id="bottom">草图最底部 · 完整可见</footer>
<script>window.count=0;window.__fixtureReady=true;</script></body></html>`
const style = 'body{margin:0;font:16px/1.7 "Segoe UI","Microsoft YaHei",sans-serif;color:#26332b;width:1440px}header{height:70px;padding:16px 28px;box-sizing:border-box;border-bottom:1px solid #eee;background:#f0f5f1}main{height:2100px;box-sizing:border-box;padding:34px;background:linear-gradient(#fff,#eaf3ed)}footer{height:70px;box-sizing:border-box;padding:16px 28px;background:#346e58;color:white}input,button{padding:10px;margin:10px;border:1px solid #ddd;border-radius:8px}'
writeFileSync(join(projectRoot, '00_UX', 'confirmed.html'), html)
writeFileSync(join(projectRoot, '00_UX', 'fixture.css'), style)
writeFileSync(join(home, 'projects.json'), JSON.stringify({ version: 1, projects: [{ project_id: pid, workspace_slug: 'default-software-builder', name: '画布与动态验证', mode: 'longterm', template_type: 'desktop_tool', status: 'active', current_stage: 'blocked_for_user_decision', desktop_phase: 'desktop-verify', desktop_blocked: { reason: 'user-stop', at: new Date().toISOString() }, root_path: projectRoot, last_session_id: sid, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] }))
mkdirSync(join(home, 'agent-sessions'), { recursive: true })
writeFileSync(join(home, 'bloma-agent-sessions.json'), JSON.stringify({ version: 1, sessions: [{ session_id: sid, project_id: pid, status: 'completed', jsonl_path: join(home, 'agent-sessions', sid + '.jsonl'), created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] }))
writeFileSync(join(home, 'agent-sessions', sid + '.jsonl'), JSON.stringify({ role: 'assistant', origin: 'agent', content: [{ type: 'text', text: '界面已准备好，可以查看完整草图。' }], timestamp: 1 }) + '\n')
const env = { ...process.env, PROMA_HOME: home }
delete env.ELECTRON_RUN_AS_NODE
delete env.VITE_DEV_SERVER_URL
const report = { home, checks: [], errors: [], layouts: [] }
let app
try {
  app = await _electron.launch({ args: ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', `--user-data-dir=${join(home, 'user-data')}`, '.'], cwd: root, env, timeout: 30000 })
  const page = await app.firstWindow()
  page.on('pageerror', error => report.errors.push(error.message))
  await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.webContents.setBackgroundThrottling(false)
    const right = Math.max(...screen.getAllDisplays().map(d => d.bounds.x + d.bounds.width))
    w.setMinimumSize(200, 200); w.setContentSize(1440, 900); w.setPosition(right + 1500, 0); w.showInactive()
  })
  await page.waitForSelector('iframe[title="已确认的界面草图"]')
  const frame = page.frames().find(f => f.parentFrame())
  await frame.waitForFunction(() => window.__fixtureReady)
  await page.waitForFunction(() => parseFloat(document.querySelector('.sketch-page iframe').style.height) >= 2240)
  assert.equal(await frame.evaluate(() => typeof window.electronAPI), 'undefined')
  assert.equal(await frame.evaluate(() => document.compatMode), 'CSS1Compat')
  assert.equal(await frame.evaluate(() => getComputedStyle(document.querySelector('footer')).backgroundColor), 'rgb(52, 110, 88)')
  const assertFits = async () => {
    await page.waitForTimeout(300)
    const layout = await page.evaluate(() => {
      const surface = document.querySelector('.sketch-surface'), paper = document.querySelector('.sketch-page')
      const a = surface.getBoundingClientRect(), b = paper.getBoundingClientRect()
      return { window: [innerWidth, innerHeight], surface: { left: a.left, top: a.top, right: a.right, bottom: a.bottom }, paper: { left: b.left, top: b.top, right: b.right, bottom: b.bottom }, scroll: [surface.scrollWidth - surface.clientWidth, surface.scrollHeight - surface.clientHeight], percent: document.querySelector('.sketch-scale').textContent }
    })
    assert.ok(layout.paper.left >= layout.surface.left && layout.paper.top >= layout.surface.top, JSON.stringify(layout))
    assert.ok(layout.paper.right <= layout.surface.right + 1 && layout.paper.bottom <= layout.surface.bottom + 1, JSON.stringify(layout))
    assert.ok(layout.scroll.every(value => value <= 1), JSON.stringify(layout))
    // Child-frame boundingBox() reports unscaled coordinates in Electron; project its DOM rect ourselves.
    const bottom = await frame.locator('#bottom').evaluate(e => { const r = e.getBoundingClientRect(); return { right: r.right, bottom: r.bottom } })
    const geometry = await page.locator('.sketch-page iframe').evaluate(e => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, scale: r.width / parseFloat(e.style.width) } })
    assert.ok(geometry.top + bottom.bottom * geometry.scale <= layout.surface.bottom + 1, JSON.stringify({ bottom, geometry, layout }))
    assert.ok(geometry.left + bottom.right * geometry.scale <= layout.surface.right + 1, JSON.stringify({ bottom, geometry, layout }))
    report.layouts.push(layout)
  }
  for (const [width, height] of [[1920, 1080], [1366, 768], [1024, 700], [800, 600]]) {
    await app.evaluate(({ BrowserWindow }, { width, height }) => BrowserWindow.getAllWindows()[0].setContentSize(width, height), { width, height })
    await assertFits()
  }
  report.checks.push('full 1440x2240 document and bottom marker fit without canvas scroll at four window sizes; relative CSS and opaque sandbox retained')
  await page.screenshot({ path: join(folder, 'fit-small.png') })
  await page.getByRole('button', { name: '原尺寸', exact: true }).click()
  await page.locator('.sketch-surface').hover({ position: { x: 40, y: 30 } })
  await page.mouse.wheel(0, 2400)
  await page.waitForFunction(() => document.querySelector('.sketch-surface').scrollTop > 0)
  await page.getByRole('button', { name: '适应画布', exact: true }).click()
  await assertFits()
  await frame.getByRole('textbox', { name: '草图输入' }).fill('缩放后仍保留')
  const clickTarget = await frame.getByRole('button', { name: '点击计数' }).evaluate(e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
  const clickFrame = await page.locator('.sketch-page iframe').evaluate(e => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, scale: r.width / parseFloat(e.style.width) } })
  await page.mouse.click(clickFrame.left + clickTarget.x * clickFrame.scale, clickFrame.top + clickTarget.y * clickFrame.scale)
  await frame.waitForFunction(() => document.querySelector('#counter').textContent === '1')
  await page.getByRole('button', { name: '放大草图' }).click()
  await page.getByRole('button', { name: '缩小草图' }).click()
  assert.equal(await frame.getByRole('textbox', { name: '草图输入' }).inputValue(), '缩放后仍保留')
  assert.equal(await frame.locator('#counter').textContent(), '1')
  await page.getByRole('button', { name: '适应画布', exact: true }).click()
  report.checks.push('original-size wheel scrolling, fit reset and manual zoom preserve live iframe input and click state')
  await frame.evaluate(() => { document.querySelector('main').style.height = '2600px' })
  await page.waitForFunction(() => parseFloat(document.querySelector('.sketch-page iframe').style.height) >= 2740)
  await assertFits()
  await frame.evaluate(() => { document.querySelector('main').style.height = '400px' })
  await page.waitForFunction(() => parseFloat(document.querySelector('.sketch-page iframe').style.height) === 800)
  await assertFits()
  await frame.evaluate(() => { document.querySelector('main').style.height = '2100px' })
  await page.waitForFunction(() => parseFloat(document.querySelector('.sketch-page iframe').style.height) >= 2240)
  report.checks.push('dynamic content growth and shrink refit; expanded iframe height does not leave stale whitespace')
  const input = page.getByRole('textbox', { name: '消息输入' })
  await input.fill('切换页面前的草稿')
  await page.getByRole('button', { name: '专注预览', exact: true }).click()
  await assertFits()
  await page.screenshot({ path: join(folder, 'focused.png') })
  await page.getByRole('button', { name: '退出专注预览', exact: true }).click()
  assert.equal(await input.inputValue(), '切换页面前的草稿')
  await page.locator('[data-ai-id="materials-button"]').hover()
  await page.waitForTimeout(200)
  const hover = await page.locator('[data-ai-id="materials-button"] svg').evaluate(e => getComputedStyle(e).transform)
  assert.notEqual(hover, 'none')
  await page.locator('[data-ai-id="materials-button"]').click()
  assert.equal(await page.locator('.theatre-sidepanel').evaluate(e => getComputedStyle(e).animationName), 'studio-panel-enter')
  await page.locator('[data-ai-id="materials-button"]').click()
  report.checks.push('focus automatically refits and preserves drafts; icon hover and sidepanel entrance are active')
  await page.getByRole('button', { name: '设置（模型渠道）' }).click()
  await page.waitForSelector('[data-ai-id="settings-page"]')
  await page.locator('[data-ai-id="settings-tab-sound"]').click()
  assert.equal(await page.locator('.studio-settings-content').evaluate(e => getComputedStyle(e).animationName), 'studio-page-enter')
  await page.screenshot({ path: join(folder, 'settings.png') })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await page.locator('.studio-settings-content').evaluate(e => getComputedStyle(e).animationName), 'none')
  await page.getByRole('button', { name: '返回工作区', exact: true }).click()
  await page.waitForSelector('[data-ai-id="workspace-theatre"]')
  assert.equal(await page.locator('.workspace-theatre').evaluate(e => getComputedStyle(e).animationName), 'none')
  assert.equal(await input.inputValue(), '切换页面前的草稿')
  report.checks.push('settings tab transitions and reduced-motion preference verified; route return preserves draft')
  assert.equal(readFileSync(join(projectRoot, '00_UX', 'confirmed.html'), 'utf8'), html)
  assert.deepEqual(report.errors, [])
} catch (error) { report.failure = String(error); throw error }
finally {
  if (app) await app.close()
  writeFileSync(join(folder, 'report.json'), JSON.stringify(report, null, 2))
}
console.log(JSON.stringify({ checks: report.checks, layouts: report.layouts, errors: report.errors }, null, 2))
