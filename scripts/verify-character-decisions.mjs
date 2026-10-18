/** Isolated real Electron presentation and input, with offline IPC responses (no model run). */
import { _electron } from 'playwright'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const root = resolve('.')
const output = join(root, 'run-artifacts/character-decisions')
mkdirSync(output, { recursive: true })
const home = mkdtempSync(join(tmpdir(), 'bloma-character-'))
const projectId = randomUUID(), sessionId = randomUUID(), now = new Date().toISOString()
const projectRoot = join(home, 'agent-workspaces/default-software-builder/generated-projects', projectId)
mkdirSync(join(projectRoot, '00_UX'), { recursive: true })
writeFileSync(join(projectRoot, '00_UX/confirmed.html'), '<!doctype html><meta charset="utf-8"><body style="margin:0;width:1280px;height:800px;background:#f6f0e4;color:#42594c;font:20px sans-serif"><header style="padding:30px;background:#e9e0cd">智学伴 · 课程学习工作台</header><main style="padding:50px"><h1>教材、笔记与 AI 辅导</h1><p>这是隔离验收使用的界面样例。</p><button id="sample-action" onclick="this.textContent=\'已点击\'">原有操作可用</button></main></body>')
writeFileSync(join(home, 'projects.json'), JSON.stringify({ version: 1, projects: [{ project_id: projectId, workspace_slug: 'default-software-builder', name: '人物节点验收', mode: 'longterm', template_type: 'desktop_tool', status: 'active', current_stage: 'clarifying', root_path: projectRoot, last_session_id: sessionId, created_at: now, updated_at: now }] }))
mkdirSync(join(home, 'agent-sessions'), { recursive: true })
writeFileSync(join(home, 'bloma-agent-sessions.json'), JSON.stringify({ version: 1, sessions: [{ session_id: sessionId, project_id: projectId, status: 'completed', jsonl_path: join(home, 'agent-sessions', `${sessionId}.jsonl`), created_at: now, updated_at: now }] }))
writeFileSync(join(home, 'agent-sessions', `${sessionId}.jsonl`), JSON.stringify({ id: 'initial', role: 'assistant', origin: 'agent', timestamp: 1, content: [{ type: 'text', text: '先确定需求，再制作你的软件。' }] }) + '\n')
const env = { ...process.env, PROMA_HOME: home }
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const report = { home, checks: [], errors: [], screenshots: [], layouts: [] }
let app, page
try {
  app = await _electron.launch({ args: [`--user-data-dir=${join(home, 'user-data')}`, '.'], cwd: root, env, timeout: 30000 })
  page = await app.firstWindow()
  page.on('pageerror', error => report.errors.push(error.message))
  await app.evaluate(({ BrowserWindow, ipcMain, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setMinimumSize(200, 200); window.setContentSize(1440, 900)
    window.setPosition(Math.max(...screen.getAllDisplays().map(display => display.bounds.x + display.bounds.width)) + 1500, 0)
    window.webContents.setAudioMuted(true); window.showInactive()
    globalThis.__characterActions = []
    for (const channel of ['agent:send-message', 'agent:confirm-requirements']) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, input) => {
        globalThis.__characterActions.push({ channel, input })
        return { ok: true, request_id: input.request_id, data: channel === 'agent:confirm-requirements' ? { started: true, prd_written: true } : { accepted: true, session_id: input.session_id, stream_started: false } }
      })
    }
  })
  await page.getByText('先确定需求，再制作你的软件。', { exact: true }).waitFor()
  const emit = async (type, payload) => app.evaluate(({ BrowserWindow }, event) => BrowserWindow.getAllWindows()[0].webContents.send('agent:stream-event', event), { event_id: randomUUID(), session_id: sessionId, project_id: projectId, type, payload, created_at: new Date().toISOString() })
  const actions = () => app.evaluate(() => globalThis.__characterActions)
  const settle = async () => {
    await page.waitForFunction(() => [...document.querySelectorAll('.character-presenter-art,.character-presented-card')].every(element => element.getAnimations().every(animation => animation.playState === 'finished')))
    await page.locator('.character-presenter img').evaluateAll(images => Promise.all(images.map(image => image.decode())))
  }
  const screenshot = async name => { const path = join(output, name); await page.screenshot({ path }); report.screenshots.push(path) }
  await emit('user_decision_required', { kind: 'enrichment_clarification', title: '先确认资料范围', requests: [{ for: 'F-001', question: '你平时想导入哪些资料？', options: [{ id: 'pdf', label: 'PDF 与 Word' }, { id: 'scanned', label: '还需要图片与扫描件' }] }] })
  await page.locator('[data-ai-id="clarification-card"]').waitFor()
  await settle()
  assert.equal((await actions()).length, 0)
  assert.equal(await page.locator('.character-decision-stage').getAttribute('data-kind'), 'clarify')
  await screenshot('clarification.png')
  await page.locator('[data-ai-id="clarification-option-pdf"]').click()
  await page.locator('[data-ai-id="clarification-card"]').waitFor({ state: 'hidden' })
  assert.equal((await actions())[0].input.content, 'PDF 与 Word')
  report.checks.push('clarification presents actual options; nothing is sent before the user selects')

  await emit('user_decision_required', { kind: 'requirement_confirm', title: '确认你的需求', requirements: [{ id: 'F-001', description: '导入课程资料' }, { id: 'F-002', description: '课程全文搜索' }], ideas: [], research: { available: false, summary: '' } })
  await page.locator('[data-ai-id="requirement-confirm-dialog"]').waitFor()
  await settle()
  await page.locator('[data-ai-id="requirement-confirm-item-F-002"] input').uncheck()
  await screenshot('requirements.png')
  await page.locator('[data-ai-id="requirement-confirm-submit"]').click()
  await page.locator('[data-ai-id="requirement-confirm-dialog"]').waitFor({ state: 'hidden' })
  assert.deepEqual((await actions())[1].input.requirement_ids, ['F-001'])
  report.checks.push('requirement selection retains the exact checked subset and original confirm IPC')

  const prd = { kind: 'prd_confirm', title: '请确认这份 PRD', positioning: '课程资料、笔记与 AI 辅导', document: '# 智学伴\n\n' + '资料、笔记与学习记录在本地保存。\n\n'.repeat(35), requirements: [{ id: 'F-001', priority: 'P0', story: '导入并阅读课程资料', assertions: ['用户可选择文件导入', '按课程保存'] }], out_of_scope: ['云同步'], assumptions: ['资料本地保存'], constraints: [], ideas: [], expanded: false }
  await emit('user_decision_required', prd)
  await page.locator('[data-ai-id="prd-confirm-dialog"]').waitFor()
  await settle()
  await screenshot('prd.png')
  assert.equal((await actions()).length, 2)
  await page.locator('[data-ai-id="prd-confirm-disagree-F-001"]').click()
  await page.locator('[data-ai-id="prd-confirm-adjust-input"]').fill('还要保留原始资料的表格内容')
  assert.equal(await page.locator('[data-ai-id="prd-confirm-adjust-input"]').inputValue(), '还要保留原始资料的表格内容')
  await page.locator('[data-ai-id="prd-confirm-adjust-send"]').click()
  await page.locator('[data-ai-id="prd-confirm-dialog"]').waitFor({ state: 'hidden' })
  assert.match((await actions())[2].input.content, /原始资料的表格内容/)
  report.checks.push('real PRD, full text and adjustment pool remain available; animation never submits')

  await emit('ux_sketch_ready', { preview_url: `bloma-file://${projectId}/00_UX/confirmed.html` })
  await emit('stage_changed', { stage: 'blocked_for_user_decision' })
  await emit('user_decision_required', { kind: 'ux_confirm', questions: [{ id: 'ux_confirm_go', label: '确认草图' }, { id: 'ux_confirm_adjust', label: '想改一下' }] })
  // runAgent publishes its terminal event after runUxConfirmGate returns.
  await emit('completed', { subtype: 'success' })
  await page.locator('[data-ai-id="sketch-character-reminder"]').waitFor()
  await page.locator('[data-ai-id="sketch-character-reminder"] img').evaluate(image => image.decode())
  const iframe = page.locator('iframe').first()
  await iframe.waitFor()
  const originalPreview = await iframe.elementHandle()
  assert.equal(await page.locator('[data-ai-id="sketch-character-reminder"] button').count(), 1)
  assert.equal(await page.locator('[data-ai-id="sketch-character-reminder"]').evaluate(element => Boolean(element.closest('[role="dialog"]'))), false)
  const previewFrame = page.frameLocator('iframe').first()
  await previewFrame.locator('#sample-action').waitFor()
  const overlay = await page.locator('.sketch-character-art').boundingBox()
  const frameBox = await iframe.evaluate(frame => { const rect = frame.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, naturalWidth: frame.offsetWidth, naturalHeight: frame.offsetHeight } })
  const point = { x: (Math.max(overlay.x, frameBox.x) + Math.min(overlay.x + overlay.width, frameBox.x + frameBox.width)) / 2, y: (Math.max(overlay.y, frameBox.y) + Math.min(overlay.y + overlay.height, frameBox.y + frameBox.height)) / 2 }
  const hit = await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.tagName, point)
  assert.equal(hit, 'IFRAME')
  report.pointer = { point, hit, purpose: 'Character artwork lets pointer hit-testing reach the original preview frame' }
  await page.locator('[data-ai-id="confirm-sketch-button"]').click({ trial: true })
  await screenshot('sketch-reminder.png')
  assert.equal((await actions()).length, 3)
  await page.getByRole('button', { name: '收起角色提醒' }).click()
  assert.equal(await originalPreview.evaluate(element => element.isConnected), true)
  await page.locator('[data-ai-id="confirm-sketch-button"]').click()
  await page.waitForFunction(() => document.querySelector('[data-ai-id="sketch-character-reminder"]') === null)
  assert.equal((await actions())[3].input.metadata.selected_option_id, 'ux_confirm_go')
  report.checks.push('sketch cue contains only a character and one sentence; preview and original confirmation stay interactive')

  await emit('ux_sketch_closed', {})
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await emit('user_decision_required', prd)
  await page.locator('[data-ai-id="prd-confirm-dialog"]').waitFor()
  assert.equal(await page.locator('.character-presented-card').evaluate(element => element.getAnimations().length), 0)
  await page.getByText('完整 PRD 文档（长文本全文——确认即以此为准）', { exact: true }).click()
  for (const width of [800, 480]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 720), width)
    await page.waitForTimeout(100)
    const bounds = await page.locator('[data-ai-id="prd-confirm-dialog"]').evaluate(element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight, scrollable: element.scrollHeight > element.clientHeight } })
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height, JSON.stringify(bounds))
    assert.equal(bounds.scrollable, true)
    report.layouts.push(bounds)
  }
  await screenshot('narrow-prd.png')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 440))
  await page.waitForTimeout(100)
  const shortBounds = await page.locator('[data-ai-id="prd-confirm-dialog"]').boundingBox()
  const viewportHeight = await page.evaluate(() => innerHeight)
  assert.ok(shortBounds.y >= 0 && shortBounds.y + shortBounds.height <= viewportHeight)
  await page.locator('[data-ai-id="prd-confirm-dismiss"]').click()
  report.checks.push('reduced-motion presentation is static; long PRD and dismissal remain reachable at 800/480 widths and in a short window')
  assert.deepEqual(report.errors, [])
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  report.failure = String(error)
  if (page) {
    report.diagnostic = await page.evaluate(() => ({ text: document.body.innerText.slice(-5500), preview: [...document.querySelectorAll('iframe')].map(frame => frame.src), attributes: document.querySelector('.workspace-theatre')?.outerHTML.slice(0, 400) }))
    await page.screenshot({ path: join(output, 'initial-failure.png') })
  }
  throw error
} finally {
  writeFileSync(join(output, 'native-report.json'), JSON.stringify(report, null, 2))
  await app?.close()
}
