/** Real Electron/offline UI acceptance. No channel or model is configured. */
import { _electron } from 'playwright'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const root = resolve('.')
const folder = join(root, 'run-artifacts', 'workspace-ui-20261026')
mkdirSync(folder, { recursive: true })
const home = mkdtempSync(join(tmpdir(), 'blui-'))
const pid = randomUUID(), sid = randomUUID(), now = new Date().toISOString()
const projectRoot = join(home, 'agent-workspaces', 'default-software-builder', 'generated-projects', pid)
mkdirSync(join(projectRoot, '00_UX'), { recursive: true })
writeFileSync(join(projectRoot, '00_UX', 'confirmed.html'), `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;width:1280px;height:800px;box-sizing:border-box;font:18px/1.8 'Segoe UI',sans-serif;color:#525849;background:#fff}header{padding:20px 32px;border-bottom:1px solid #e4e9df}main{display:grid;grid-template-columns:190px 260px 1fr;height:700px}aside{padding:30px;background:#f3f5ef;border-right:1px solid #e5eadf}article{padding:35px}input,button{font:inherit;padding:8px;border:1px solid #d9e0d1;border-radius:6px}footer{height:20px;background:#78956f}h1{font-size:27px}</style></head><body><header>课程笔记 · 离线固定界面样例</header><main><aside>我的课程<br>组成原理<br>操作系统</aside><aside>最近笔记<br>虚拟存储器<br>指令流水线</aside><article><h1>虚拟存储器与地址转换</h1><p>这是平台布局验收固定草图，不是新模型产物。</p><input aria-label="草图输入" value="草图状态"><button id="count" onclick="this.textContent=++window.count">0</button></article></main><footer id="bottom"></footer><script>window.count=0;window.__fixtureReady=true</script></body></html>`)
writeFileSync(join(home, 'projects.json'), JSON.stringify({ version: 1, projects: [{ project_id: pid, workspace_slug: 'default-software-builder', name: '课程笔记 · 离线验收', mode: 'quick', template_type: 'desktop_tool', status: 'active', current_stage: 'blocked_for_user_decision', desktop_phase: 'desktop-verify', ux_confirmation: { prd_fingerprint: 'fixture', design_hash: 'fixture', html_hash: 'fixture' }, desktop_blocked: { reason: 'user-stop', at: now }, root_path: projectRoot, last_session_id: sid, created_at: now, updated_at: now }] }))
mkdirSync(join(home, 'agent-sessions'), { recursive: true })
writeFileSync(join(home, 'bloma-agent-sessions.json'), JSON.stringify({ version: 1, sessions: [{ session_id: sid, project_id: pid, status: 'completed', jsonl_path: join(home, 'agent-sessions', sid + '.jsonl'), created_at: now, updated_at: now }] }))
const messages = [
  { id: 'human-fixture', role: 'user', origin: 'human', content: [{ type: 'text', text: '想把课程笔记整理清楚。' }], timestamp: 1 },
  { id: 'reply-fixture', role: 'assistant', origin: 'agent', content: [{ type: 'text', text: '第一版界面已准备好。可以先看整体，细节放大再看。\n\n当前修改尚未完成验证。' }], timestamp: 2 },
]
writeFileSync(join(home, 'agent-sessions', sid + '.jsonl'), messages.map(message => JSON.stringify(message)).join('\n') + '\n')
const env = { ...process.env, PROMA_HOME: home, BLOMA_DESKTOP_DISPATCH: '0' }
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const report = { home, projectId: pid, checks: [], layouts: [], errors: [], scope: 'offline fixed project and fixture IPC stream events; real Electron, no model requests' }
let app
try {
  app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', `--user-data-dir=${join(home, 'profile')}`, '.'], cwd: root, env, timeout: 30000 })
  const page = await app.firstWindow()
  page.on('pageerror', error => report.errors.push(error.message))
  const resize = async (width, height) => {
    await app.evaluate(({ BrowserWindow, screen }, [width, height]) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(200, 200)
      window.webContents.setBackgroundThrottling(false)
      const edge = Math.max(...screen.getAllDisplays().map(display => display.bounds.x + display.bounds.width))
      window.setPosition(edge + 1000, 0); window.setContentSize(width, height); window.showInactive()
    }, [width, height])
    // Windows can apply the non-client frame/DPI adjustment after the native call.
    // Correct against the actual renderer viewport rather than claiming requested sizes.
    let requestedWidth = width, requestedHeight = height
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.waitForTimeout(140)
      const [actualWidth, actualHeight] = await page.evaluate(() => [innerWidth, innerHeight])
      if (Math.abs(actualWidth - width) <= 1 && Math.abs(actualHeight - height) <= 1) return
      requestedWidth += width - actualWidth; requestedHeight += height - actualHeight
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [requestedWidth, requestedHeight])
    }
    assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [width, height])
  }
  await resize(1366, 768)
  await page.waitForSelector('[data-ai-id="workspace-theatre"]')
  await page.waitForSelector('iframe[title="已确认的界面草图"]')
  const frame = page.frames().find(frame => frame.parentFrame())
  await frame.waitForFunction(() => window.__fixtureReady)
  await page.waitForFunction(() => document.querySelector('.conversation-reply-character img')?.naturalWidth > 0)
  const input = page.getByRole('textbox', { name: '消息输入' })
  await input.fill('等待确认的补充，不要发送')
  for (const [width, height] of [[1366, 768], [1440, 900], [1024, 768]]) {
    await resize(width, height)
    await page.waitForFunction(() => {
      const surface = document.querySelector('.sketch-surface').getBoundingClientRect(), paper = document.querySelector('.sketch-page').getBoundingClientRect()
      return paper.width > 20 && paper.right <= surface.right + 1 && paper.bottom <= surface.bottom + 1
    })
    const layout = await page.evaluate(() => {
      const app = document.querySelector('.workspace-theatre'), work = document.querySelector('.theatre-stage').getBoundingClientRect(), chat = document.querySelector('.theatre-conversation').getBoundingClientRect(), input = document.querySelector('textarea[aria-label="消息输入"]').getBoundingClientRect(), actor = document.querySelector('.conversation-reply-character').getBoundingClientRect()
      return { window: [innerWidth, innerHeight], preview: { left: work.left, right: work.right }, chat: { left: chat.left, right: chat.right }, input: { top: input.top, bottom: input.bottom }, actor: { left: actor.left, right: actor.right }, overflow: app.scrollWidth > app.clientWidth + 1 || app.scrollHeight > app.clientHeight + 1, fit: document.querySelector('.sketch-scale').textContent }
    })
    assert.equal(layout.overflow, false, JSON.stringify(layout)); assert.ok(layout.preview.right <= layout.chat.left, JSON.stringify(layout)); assert.ok(layout.input.bottom < layout.window[1], JSON.stringify(layout)); assert.ok(layout.actor.left >= layout.chat.left && layout.actor.right <= layout.chat.right, JSON.stringify(layout))
    report.layouts.push({ requested: [width, height], ...layout })
  }
  await resize(1366, 768)
  await page.screenshot({ path: join(folder, 'workspace.png') })
  const separator = page.getByRole('separator', { name: '调整会话栏宽度' })
  const originalWidth = Number(await separator.getAttribute('aria-valuenow'))
  await separator.focus(); await separator.press('ArrowLeft')
  assert.equal(Number(await separator.getAttribute('aria-valuenow')), originalWidth + 20)
  assert.equal(await input.inputValue(), '等待确认的补充，不要发送')
  await page.getByRole('button', { name: '专注预览', exact: true }).click()
  assert.equal(await page.locator('.theatre-conversation').isVisible(), false)
  await page.getByRole('button', { name: '退出专注预览', exact: true }).click()
  assert.equal(await input.inputValue(), '等待确认的补充，不要发送'); assert.equal(await frame.evaluate(() => window.count), 0)
  await page.getByRole('button', { name: '收起人物', exact: true }).click(); assert.equal(await page.locator('.conversation-reply-character').count(), 0)
  await page.getByRole('button', { name: '显示人物', exact: true }).click()
  const trigger = page.getByRole('button', { name: '验证：需处理', exact: true })
  await trigger.hover(); const panel = page.getByRole('dialog', { name: '验证阶段详情' }); await panel.waitFor()
  await panel.getByRole('img').evaluate(image => image.decode())
  await page.screenshot({ path: join(folder, 'stage-comic.png') })
  await panel.hover(); assert.equal(await panel.isVisible(), true)
  await panel.getByRole('button', { name: '放大阶段漫画' }).click()
  assert.equal(await panel.getAttribute('data-expanded'), 'true')
  await page.keyboard.press('Escape'); assert.equal(await panel.count(), 0)
  await trigger.click(); await page.getByRole('dialog').getByRole('button', { name: '工作记录' }).click(); assert.equal(await page.getByRole('dialog').count(), 0)
  await page.getByRole('button', { name: '关闭项目工具' }).click()
  await page.getByRole('button', { name: '文档', exact: true }).click(); assert.equal(await page.getByRole('complementary', { name: '项目资料面板' }).isVisible(), true)
  await page.getByRole('button', { name: '文档', exact: true }).click()
  for (const stage of ['requirements', 'design', 'build', 'verify', 'deliver']) {
    await page.locator(`[data-ai-id="progress-${stage}"]`).hover()
    await page.getByRole('dialog').getByRole('img').evaluate(image => image.decode())
  }
  await page.keyboard.press('Escape')
  const emit = (type, payload) => app.evaluate(({ BrowserWindow }, event) => BrowserWindow.getAllWindows()[0].webContents.send('agent:stream-event', event), { event_id: randomUUID(), project_id: pid, session_id: sid, type, payload, created_at: new Date().toISOString() })
  await emit('tool_call_started', { tool: 'read_file', tool_use_id: 'offline-read', input: { path: 'prd.md' } })
  await page.waitForFunction(() => document.querySelector('[data-ai-id="progress-verify"]').getAttribute('data-moving') === 'true')
  const animation = () => page.locator('[data-ai-id="progress-verify"] .workspace-progress-line').evaluate(element => getComputedStyle(element, '::after').animationName)
  assert.equal(await animation(), 'workspace-progress-flow')
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' })
  assert.equal(await animation(), 'none')
  await emit('completed', {})
  await page.waitForFunction(() => document.querySelector('[data-ai-id="progress-verify"]').getAttribute('data-state') === 'attention')
  assert.match(await page.locator('.workspace-theatre').evaluate(element => getComputedStyle(element).colorScheme), /light/)
  for (const [width, height] of [[736, 700], [390, 844]]) {
    await resize(width, height)
    await page.getByRole('button', { name: '对话', exact: true }).click(); assert.equal(await input.isVisible(), true)
    assert.equal(await input.inputValue(), '等待确认的补充，不要发送')
    await page.getByRole('button', { name: '草图与程序', exact: true }).click(); assert.equal(await page.locator('.theatre-stage').isVisible(), true)
    assert.equal(await page.locator('.workspace-theatre').evaluate(element => element.scrollWidth > element.clientWidth + 1), false)
  }
  report.checks.push('real desktop preview/conversation geometry', 'resizing direction and draft preservation', 'focus preserves iframe and input', 'real latest reply and quiet preference', 'hover comic, popup pointer transfer, expansion, Escape, click and work records', 'all five stage comics decoded', 'fixture IPC starts blue motion and terminal returns to stopped state', 'documents', 'narrow view switch', 'fixed light and reduced motion')
  assert.deepEqual(report.errors, [])
} finally {
  writeFileSync(join(folder, 'report.json'), JSON.stringify(report, null, 2))
  await app?.close()
}
console.log(JSON.stringify(report, null, 2))
