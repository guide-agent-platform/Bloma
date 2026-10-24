import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProject, updateProject } from '../../../main/project/project-service'
import { startCorrectionSession, readCorrectionPicks, finishCorrectionSession, settleCorrectionTeardown } from '../../../main/desktop/correction-session'
import { activeSoftwareCorrectionPage } from '../../../main/software/correction-runtime'
import { readCorrectionSubmission } from '../../../main/desktop/correction-outbox'
import { verificationFingerprint } from '../../../main/desktop/verification-fingerprint'

let home: string, previous: string | undefined, project: ReturnType<typeof createProject>
const electron = resolve('node_modules/electron/dist/electron.exe')
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-correction-electron-')); process.env.PROMA_HOME = home;
  project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }); updateProject(project.project_id, { status: 'completed', current_stage: 'completed' }) })
afterEach(async () => { finishCorrectionSession({ projectId: project.project_id, discard: true }); await settleCorrectionTeardown(project.project_id);
  if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous;
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }, 30000)
it.skipIf(process.platform !== 'win32' || !existsSync(electron))('host overlays a normal Electron app, actual click records feedback, business clicks/data stay isolated and the outbox survives finish', async () => {
  const root = project.root_path, userData = join(home, 'software-app-data', project.project_id, 'data')
  mkdirSync(userData, { recursive: true }); writeFileSync(join(userData, 'record.txt'), 'real user data')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'correction-fixture', main: 'main.cjs' }))
  writeFileSync(join(root, 'main.cjs'), 'const{app,BrowserWindow}=require("electron"),fs=require("fs"),path=require("path");fs.writeFileSync(path.join(process.env.APP_DATA_DIR,"record.txt"),"preview only");app.whenReady().then(()=>new BrowserWindow({webPreferences:{contextIsolation:true,nodeIntegration:false}}).loadFile("index.html"));app.on("window-all-closed",()=>app.quit())')
  writeFileSync(join(root, 'index.html'), '<html><body><h1>My app</h1><button id="save" onclick="this.textContent=\'BUSINESS CLICK RAN\'">Save</button></body></html>')
  writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, command: [electron, '.'], ui: 'electron', window_title: 'My app' }))
  const fingerprint = verificationFingerprint(root), started = await startCorrectionSession({ projectId: project.project_id })
  expect(started.ok, JSON.stringify(started)).toBe(true)
  const page = activeSoftwareCorrectionPage(project.project_id)!
  await page.locator('#save').click()
  expect(await page.locator('#save').innerText()).toBe('Save')
  await page.getByLabel('修改意见').fill('把这个按钮改为紫色')
  await page.getByRole('button', { name: '记录这处修改' }).click()
  await expect.poll(() => readCorrectionPicks({ projectId: project.project_id }).picks.length).toBe(1)
  await page.getByRole('button', { name: '完成点选' }).click()
  await expect.poll(() => readCorrectionPicks({ projectId: project.project_id }).done).toBe(true)
  await page.screenshot({ path: resolve('run-artifacts/software-correction-electron.png') })
  const finished = finishCorrectionSession({ projectId: project.project_id }); await settleCorrectionTeardown(project.project_id)
  expect(finished).toMatchObject({ ok: true, pickCount: 1 })
  expect(finished.feedback).toContain('#save'); expect(finished.feedback).toContain('紫色')
  expect(readCorrectionSubmission(project.project_id)?.id).toBe(finished.feedback_id)
  expect(readFileSync(join(userData, 'record.txt'), 'utf8')).toBe('real user data')
  expect(verificationFingerprint(root)).toBe(fingerprint)
}, 90000)
