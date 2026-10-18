import { _electron } from 'playwright'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const root = resolve('.')
const output = join(root, 'run-artifacts', 'project-recovery-layout')
mkdirSync(output, { recursive: true })
const home = mkdtempSync(join(tmpdir(), 'bloma-recovery-'))
const projectId = randomUUID(), early = randomUUID(), latest = randomUUID(), child = randomUUID()
const projectRoot = join(home, 'agent-workspaces/default-software-builder/generated-projects', projectId)
mkdirSync(join(projectRoot, '00_UX'), { recursive: true })
const sourceSketch = process.env.BLOMA_LAYOUT_SKETCH
writeFileSync(join(projectRoot, '00_UX/confirmed.html'), sourceSketch ? readFileSync(sourceSketch) : '<!doctype html><html><meta charset="utf-8"><body style="margin:0;width:1280px;height:800px;background:#f5f2e9;font:24px sans-serif"><header style="padding:28px">课程学习工作台</header><main style="display:grid;grid-template-columns:240px 1fr 300px;gap:24px;padding:28px"><aside>课程与章节</aside><article>教材正文与笔记</article><aside>AI 辅导与原文引用</aside></main></body></html>')
const now = new Date().toISOString()
const project = { project_id: projectId, workspace_slug: 'default-software-builder', name: '会话恢复与布局验证', mode: 'longterm', template_type: 'desktop_tool', status: 'active', current_stage: 'blocked_for_user_decision', desktop_phase: 'desktop-verify', desktop_blocked: { reason: 'user-stop', at: now }, root_path: projectRoot, last_session_id: latest, created_at: now, updated_at: now }
writeFileSync(join(home, 'projects.json'), JSON.stringify({ version: 1, projects: [project] }))
mkdirSync(join(home, 'agent-sessions'), { recursive: true })
const records = [early, latest, child].map(id => ({ session_id: id, project_id: projectId, status: 'completed', jsonl_path: join(home, 'agent-sessions', `${id}.jsonl`), created_at: now, updated_at: now, ...(id === child ? { parent_session_id: early, source_delegation_id: 'restored-delegation' } : {}) }))
writeFileSync(join(home, 'bloma-agent-sessions.json'), JSON.stringify({ version: 1, sessions: records }))
const message = (id, role, text, timestamp, origin = 'user') => ({ id, role, origin, timestamp, content: [{ type: 'text', text }] })
const oldMessages = [message('initial', 'user', '原始需求：把教材、笔记与 AI 辅导整合起来。', 1), message('old-answer', 'assistant', '已确认需求，正在制作学习软件。', 2, 'agent'), ...Array.from({ length: 220 }, (_, i) => message(`record-${i}`, 'user', `执行记录 ${i}`, i + 3, 'system'))]
writeFileSync(join(home, 'agent-sessions', `${early}.jsonl`), oldMessages.map(JSON.stringify).join('\n') + '\n')
writeFileSync(join(home, 'agent-sessions', `${latest}.jsonl`), JSON.stringify(message('latest-answer', 'assistant', '本轮执行已停止。此前的需求、协作与工作记录可以回看。', 500, 'agent')) + '\n')
writeFileSync(join(home, 'agent-sessions', `${child}.jsonl`), [message('child-task', 'user', '协作子任务（role=implement）：\n恢复的资料导入协作', 3), { delegation_settle: 'cancelled' }].map(JSON.stringify).join('\n') + '\n')
const env = { ...process.env, PROMA_HOME: home }
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const report = { home, checks: [], layouts: [], errors: [], screenshots: [] }
let app
try {
  app = await _electron.launch({ args: [`--user-data-dir=${join(home, 'user-data')}`, '.'], cwd: root, env, timeout: 30000 })
  const page = await app.firstWindow()
  page.on('pageerror', error => report.errors.push(error.message))
  await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(200, 200); w.setContentSize(1600, 1000)
    w.setPosition(Math.max(...screen.getAllDisplays().map(d => d.bounds.x + d.bounds.width)) + 1500, 0); w.showInactive()
  })
  await page.getByText('原始需求：把教材、笔记与 AI 辅导整合起来。', { exact: true }).waitFor()
  report.checks.push('cold restore includes earlier main conversation beyond 200 records')
  const separator = page.getByRole('separator', { name: '调整会话栏宽度' })
  const initialWidth = Number(await separator.getAttribute('aria-valuenow'))
  const handle = await separator.boundingBox()
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 + 80, handle.y + handle.height / 2, { steps: 10 })
  await page.mouse.up()
  assert.equal(Number(await separator.getAttribute('aria-valuenow')), initialWidth + 80)
  await page.reload()
  await page.getByText('原始需求：把教材、笔记与 AI 辅导整合起来。', { exact: true }).waitFor()
  assert.equal(Number(await separator.getAttribute('aria-valuenow')), initialWidth + 80)
  await separator.dblclick()
  assert.equal(Number(await separator.getAttribute('aria-valuenow')), 370)
  report.checks.push('pointer resize survives renderer reload; double click restores the default width')
  await page.locator('[data-ai-id="collaboration-button"]').click()
  await page.getByText('恢复的资料导入协作', { exact: true }).waitFor()
  await page.getByRole('button', { name: '关闭协作面板' }).click()
  await page.getByRole('button', { name: '工作记录', exact: true }).click()
  assert.ok(await page.locator('.studio-work-records details').count() > 200)
  await page.getByRole('button', { name: '关闭项目工具' }).click()
  report.checks.push('persisted collaboration and full work records are restored')
  await page.getByRole('button', { name: '我的项目', exact: true }).click()
  await page.getByText('会话恢复与布局验证', { exact: true }).click()
  await page.getByText('原始需求：把教材、笔记与 AI 辅导整合起来。', { exact: true }).waitFor()
  report.checks.push('leaving project list and returning preserves original conversation')
  for (const [width, height] of [[1600, 1000], [1366, 768], [1024, 768]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height])
    await page.waitForTimeout(250)
    if (width < 1100) await page.getByRole('button', { name: '草图与程序', exact: true }).click()
    const layout = await page.evaluate(() => {
      const box = selector => { const e = document.querySelector(selector); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, display: getComputedStyle(e).display } }
      return { width: innerWidth, height: innerHeight, conversation: box('.theatre-conversation'), preview: box('.theatre-stage'), messages: box('.theatre-messages'), overflow: document.documentElement.scrollWidth - innerWidth }
    })
    assert.ok(layout.overflow <= 1, JSON.stringify(layout))
    if (width >= 1100) { assert.ok(layout.conversation.x < layout.preview.x); assert.ok(layout.messages.height > 350, JSON.stringify(layout)); assert.ok(layout.preview.height > 500, JSON.stringify(layout)) }
    else { assert.equal(layout.conversation.display, 'none'); assert.ok(layout.preview.height > 400) }
    report.layouts.push(layout)
    const screenshot = join(output, `workspace-${width}.png`)
    await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot)
  }
  await page.getByRole('button', { name: '对话', exact: true }).click()
  assert.ok(await page.getByText('原始需求：把教材、笔记与 AI 辅导整合起来。', { exact: true }).isVisible())
  report.checks.push('desktop has independent full-height conversation/preview; narrow window switches views without dropping history')
  assert.deepEqual(report.errors, [])
  console.log(JSON.stringify(report, null, 2))
} finally {
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
  await app?.close()
}
