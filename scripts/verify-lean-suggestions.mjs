/** Offline Electron UI/IPC fixture. Backend admission is covered by lean-suggestions.test.ts. */
import { _electron } from 'playwright'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const root = resolve('.'), folder = join(root, 'run-artifacts', 'lean-suggestions-20261027')
mkdirSync(folder, { recursive: true })
const home = mkdtempSync(join(tmpdir(), 'blideas-')), helper = join(folder, 'fixture.mjs')
const env = { ...process.env, PROMA_HOME: home, BLOMA_DESKTOP_DISPATCH: '0' }
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
await build({ stdin: { resolveDir: root, sourcefile: 'suggestion-ui-fixture.ts', contents: `
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createProject, updateProject } from './main/project/project-service';
import { readPrdBackplane } from './main/project/prd-store';
import { parseLeanBrief } from './main/guide/lean-brief';
import { stageLeanScope, leanScopeDecision } from './main/guide/lean-scope';
import { readGuideConfirmation } from './main/guide/confirmation-journal';
import { adoptLeanSuggestions, parseLeanSuggestions } from './main/guide/lean-suggestions';
let project, sid, next, suggestions;
if (process.argv[2] === 'adopt') {
  const input = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  project = { project_id: input.project_id }; sid = input.session_id;
  const prior = readPrdBackplane(project.project_id), saved = readGuideConfirmation('prd', project.project_id);
  const ideas = parseLeanSuggestions(saved.data.suggestions), ids = input.metadata.selected_suggestion_ids;
  next = adoptLeanSuggestions(prior, ideas, ids); suggestions = ideas.filter(idea => !ids.includes(idea.id));
  stageLeanScope(project.project_id, sid, 'fixture-adopt', prior, next, () => {}, { suggestions });
} else {
  project = createProject({ request_id: 'fixture-create', mode: 'quick', initial_message: '课程笔记' }, { workflowVersion: 'software-v1' });
  sid = randomUUID(); updateProject(project.project_id, { last_session_id: sid });
  const prior = readPrdBackplane(project.project_id);
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '离线保存与查看课程笔记', ui: 'required', delivery: 'desktop',
    requirements: [{ description: '保存课程笔记', expected: '关闭重开后仍可看到笔记' }], constraints: ['本地使用，无需联网'], out_of_scope: ['账号与云同步'],
    suggestions: [{ title: '按关键词查找', description: '在已保存笔记中查找关键词', benefit: '笔记多了也能快速找到内容', expected: '输入关键词后只显示匹配的笔记' },
      { title: '导出备份', description: '将笔记导出为本地备份', benefit: '换电脑时可以带走笔记', expected: '导出文件包含已保存的笔记' }] }),
    { projectId: project.project_id, sessionId: sid, source: '课程笔记', previous: prior, software: true });
  if (!parsed || parsed.action !== 'brief') throw Error('fixture invalid');
  next = parsed.brief; suggestions = parsed.suggestions;
  stageLeanScope(project.project_id, sid, 'fixture-scope', prior, next, () => {}, { suggestions });
}
console.log(JSON.stringify({ projectId: project.project_id, sessionId: sid, payload: leanScopeDecision(next, suggestions) }));
` }, outfile: helper, bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'silent' })
const runHelper = args => {
  const result = spawnSync(process.execPath, [helper, ...args], { cwd: root, env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  return JSON.parse(result.stdout.trim().split('\n').at(-1))
}
const fixture = runHelper([]), pid = fixture.projectId, sid = fixture.sessionId, now = new Date().toISOString()
mkdirSync(join(home, 'agent-sessions'), { recursive: true })
writeFileSync(join(home, 'bloma-agent-sessions.json'), JSON.stringify({ version: 1, sessions: [{ session_id: sid, project_id: pid, status: 'active', jsonl_path: join(home, 'agent-sessions', sid + '.jsonl'), created_at: now, updated_at: now }] }))
writeFileSync(join(home, 'agent-sessions', sid + '.jsonl'), JSON.stringify({ role: 'user', origin: 'human', content: [{ type: 'text', text: '想做一个本地课程笔记工具。' }], timestamp: Date.now() }) + '\n')
const report = { home, projectId: pid, checks: [], layouts: [], errors: [], scope: 'offline native UI, persisted scope restoration, renderer/preload IPC payload; fixture adoption uses real scope functions; no model or product generation' }
let app
try {
  app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: [`--user-data-dir=${join(home, 'profile')}`, '.'], cwd: root, env, timeout: 30000 })
  const page = await app.firstWindow()
  page.on('pageerror', error => report.errors.push(error.message))
  await app.evaluate(({ BrowserWindow, ipcMain, session }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setMinimumSize(200, 200); window.setContentSize(1366, 768); window.setPosition(-5000, 0); window.webContents.setBackgroundThrottling(false)
    globalThis.__suggestionUiInputs = []
    ipcMain.removeHandler('agent:send-message')
    ipcMain.handle('agent:send-message', (_event, input) => { globalThis.__suggestionUiInputs.push(input); return { ok: true, request_id: input.request_id, data: { accepted: true, session_id: input.session_id, stream_started: false } } })
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { callback({ cancel: true }) })
  })
  await page.getByRole('heading', { name: 'AI 灵感建议' }).waitFor()
  const find = page.getByRole('checkbox', { name: '按关键词查找' })
  assert.equal(await find.isChecked(), false)
  assert.equal(await page.getByRole('checkbox', { name: '导出备份' }).isChecked(), false)
  await page.reload()
  await page.getByRole('heading', { name: 'AI 灵感建议' }).waitFor()
  assert.equal(await find.isChecked(), false)
  await find.focus(); await find.press('Space')
  assert.equal(await find.isChecked(), true)
  await page.locator('.scope-suggestions').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(folder, 'suggestions-desktop.png') })
  await page.getByRole('button', { name: /采纳 1 条建议，更新任务单/ }).click()
  const sent = await app.evaluate(() => globalThis.__suggestionUiInputs)
  assert.equal(sent.length, 1); assert.equal(sent[0].metadata.selected_option_id.startsWith('lean_adopt:'), true)
  assert.deepEqual(sent[0].metadata.selected_suggestion_ids, [fixture.payload.scope.suggestions[0].id])
  assert.equal(sent[0].session_id, sid); assert.equal(sent[0].project_id, pid)
  const captured = join(folder, 'captured-adoption.json'); writeFileSync(captured, JSON.stringify(sent[0]))
  const updated = runHelper(['adopt', captured])
  const emit = (type, payload) => app.evaluate(({ BrowserWindow }, event) => BrowserWindow.getAllWindows()[0].webContents.send('agent:stream-event', event), { event_id: randomUUID(), project_id: pid, session_id: sid, type, payload, created_at: new Date().toISOString() })
  await emit('user_decision_required', updated.payload); await emit('completed', {})
  await page.getByText('在已保存笔记中查找关键词', { exact: true }).waitFor()
  assert.equal(await page.getByRole('checkbox', { name: '按关键词查找' }).count(), 0)
  assert.equal(await page.getByRole('checkbox', { name: '导出备份' }).isChecked(), false)
  await page.reload()
  await page.getByText('在已保存笔记中查找关键词', { exact: true }).waitFor()
  const confirm = page.getByRole('button', { name: /按这份做/ })
  assert.equal(await confirm.isEnabled(), true)
  await confirm.click()
  const inputs = await app.evaluate(() => globalThis.__suggestionUiInputs)
  assert.equal(inputs.length, 2); assert.equal(inputs[1].metadata.selected_option_id.startsWith('lean_confirm:'), true)
  assert.equal(inputs[1].metadata.selected_suggestion_ids, undefined)
  await emit('user_decision_required', updated.payload); await emit('completed', {})
  for (const width of [1024, 390]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 844), width)
    await page.waitForTimeout(200)
    const switcher = page.getByRole('button', { name: '草图与程序', exact: true })
    if (await switcher.isVisible()) await switcher.click()
    await page.locator('.scope-suggestions').scrollIntoViewIfNeeded()
    assert.equal(await page.locator('.scope-confirmation').evaluate(element => element.scrollWidth > element.clientWidth + 1), false)
    assert.equal(await page.getByRole('button', { name: /按这份做/ }).isVisible(), true)
    assert.equal(await page.getByRole('checkbox', { name: '导出备份' }).isEnabled(), true)
    report.layouts.push(await page.evaluate(() => ({ viewport: [innerWidth, innerHeight], panel: document.querySelector('.scope-confirmation').getBoundingClientRect().toJSON() })))
    await page.screenshot({ path: join(folder, `suggestions-${width}.png`) })
  }
  report.checks.push('saved optional suggestions restore without model work', 'unchecked defaults and keyboard selection', 'actual preload IPC includes only selected ids and current scope', 'real scope merge renders adopted feature', 'reload restores adopted feature and remaining optional idea', 'final confirmation contains no implicit suggestion picks', '1024 and narrow layouts preserve scrolling and footer')
  assert.deepEqual(report.errors, [])
} finally {
  writeFileSync(join(folder, 'report.json'), JSON.stringify(report, null, 2))
  if (app) {
    // Closing a window can hide Bloma in the tray. Exit only this test instance.
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app.close().catch(() => {})
  }
}
console.log(JSON.stringify(report, null, 2))
