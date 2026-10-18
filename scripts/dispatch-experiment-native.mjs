// Native Electron driver for the experiment's prepare/run boundaries. It uses real
// renderer controls and the host CLI, never fabricates model turns or product code.
import { _electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { cancelExperimentProject } from './dispatch-experiment-native-control.mjs'
import { assertPreparationResume, preparationTokenCap, selectClarificationAnswer, selectPreparationChoice } from './dispatch-experiment-native-choices.mjs'
const [command, ...args] = process.argv.slice(2)
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] }
const home = resolve(option('home', ''))
const reportDir = resolve(option('report-dir', join(home, 'native-report')))
const noMonetaryLimit = args.includes('--no-monetary-limit')
const policyOption = option('monetary-policy', '')
const policy = policyOption ? resolve(policyOption) : ''
const stopFile = resolve(option('stop-file', join(reportDir, 'STOP')))
const resumePreparation = command === 'prepare' && args.includes('--resume-preparation')
const resumeAnswer = resumePreparation ? option('resume-answer', '') : ''
const preparationMaxTokens = preparationTokenCap(command, option('prepare-max-output-tokens'))
const glmPlan = option('glm-plan', 'regular')
if (!['regular', 'coding'].includes(glmPlan)) throw new Error('EXPERIMENT_INVALID_GLM_PLAN')
const clarificationAnswers = option('clarification-answers') ? JSON.parse(readFileSync(option('clarification-answers'), 'utf8')) : []
if (!Array.isArray(clarificationAnswers)) throw new Error('EXPERIMENT_INVALID_CLARIFICATION_ANSWERS')
if (!['prepare', 'run', 'seed'].includes(command) || !option('home') || (noMonetaryLimit === Boolean(policyOption))
  || home.toLowerCase() === join(homedir(), '.proma').toLowerCase()) throw new Error('EXPERIMENT_DRIVER_ARGUMENTS')
mkdirSync(reportDir, { recursive: true })
const project = () => JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')).projects[0]
const config = id => JSON.parse(readFileSync(join(home, 'dispatch-experiments', `${id}.json`), 'utf8'))
const effectiveOutputLimit = command === 'run' ? config(project().project_id).limits?.max_output_tokens ?? 640000 : preparationMaxTokens
const credentialsPath = option('credentials', join(process.env.LOCALAPPDATA, 'Bloma', 'dispatch-experiment-20261013', 'credentials.dpapi.json'))
const electronEnv = { ...process.env, PROMA_HOME: home }
delete electronEnv.ELECTRON_RUN_AS_NODE
function seed() {
  const script = "$ErrorActionPreference='Stop';$s=Get-Content -LiteralPath $env:BEX_CREDENTIAL_STORE -Raw | ConvertFrom-Json;$r=@{};foreach($n in @('deepseek','glm')){$v=ConvertTo-SecureString $s.$n;$r[$n]=[System.Net.NetworkCredential]::new('', $v).Password};$r | ConvertTo-Json -Compress"
  const keys = JSON.parse(execFileSync('pwsh.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, BEX_CREDENTIAL_STORE: credentialsPath } }).replace(/^\uFEFF/, ''))
  if (!keys.deepseek || !keys.glm) throw new Error('EXPERIMENT_CREDENTIAL_DECRYPTION_FAILED')
  execFileSync(join(process.cwd(), 'node_modules/electron/dist/electron.exe'), ['scripts/seed-experiment-channels.cjs'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...electronEnv,
      BEX_DEEPSEEK_API_KEY: keys.deepseek, BEX_GLM_API_KEY: keys.glm,
      BEX_PREPARATION_MAX_TOKENS: String(effectiveOutputLimit), BEX_GLM_PLAN: glmPlan } })
}
seed()
if (command === 'seed') { console.log(JSON.stringify({ home, seeded: true })); process.exit(0) }
const sleep = ms => new Promise(done => setTimeout(done, ms))
const cli = (...params) => execFileSync(process.execPath, ['scripts/dispatch-experiment.mjs', ...params], { encoding: 'utf8', windowsHide: true }).trim()
let application, page
const report = { command, home, resume_preparation: resumePreparation, at: new Date().toISOString(), confirmations: [], outcome: 'running' }
report.glm_plan = glmPlan
report.monetary_mode = noMonetaryLimit ? 'unlimited-explicit-user-authorization' : 'policy'
report.host_output_ceiling = effectiveOutputLimit
if (command === 'prepare') report.preparation_max_output_tokens = preparationMaxTokens
const log = message => console.log(`[native-experiment] ${message}`)
try {
  application = await _electron.launch({ args: ['.', `--user-data-dir=${join(home, 'electron-user-data')}`],
    env: { ...electronEnv, BLOMA_DESKTOP_DISPATCH: '1',
      BLOMA_DISPATCH_EXPERIMENT: '1', BLOMA_MONETARY_POLICY: noMonetaryLimit ? '' : policy,
      BLOMA_EXPERIMENT_MAX_OUTPUT_TOKENS: String(effectiveOutputLimit) }, timeout: 60000 })
  for (const stream of [application.process().stdout, application.process().stderr]) stream?.on('data', bytes => appendFileSync(join(reportDir, 'main.log'), bytes))
  page = await application.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setBounds({ x: -15000, y: -15000, width: 1280, height: 860 }); window.webContents.setBackgroundThrottling(false) } })
  await page.waitForFunction(() => !!window.electronAPI, { timeout: 30000 })
  const upgrade = page.locator('[data-ai-id="upgrade-cancel"]')
  if (await upgrade.isVisible()) await upgrade.click()
  const history = page.getByRole('button', { name: '所有项目', exact: true })
  if (await history.isVisible()) await history.click()
  if (command === 'prepare' && !resumePreparation) {
    if (existsSync(join(home, 'projects.json')) && JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')).projects.length) throw new Error('EXPERIMENT_PREPARE_NOT_FRESH')
    const newProject = page.locator('[data-ai-id="new-project-button"]')
    if (await newProject.isVisible()) await newProject.click()
    await page.locator(`[data-ai-id="mode-card-${option('mode', 'quick')}"]`).click()
    const create = page.locator('[data-ai-id="create-project-button"]')
    if (await create.isVisible()) await create.click()
    await page.locator('textarea').waitFor()
    await sleep(1000)
    const current = project(); report.project_id = current.project_id
    log(cli('prepare', '--home', home, '--project', current.project_id, '--experiment', option('experiment', 'real-pilot')))
    await page.locator('textarea').fill(readFileSync(option('request-file'), 'utf8').trim())
  } else {
    const current = project(); report.project_id = current.project_id
    const original = config(current.project_id)
    if (resumePreparation) assertPreparationResume(current, original)
    else if (original.state !== 'running') throw new Error('EXPERIMENT_RUN_NOT_RESTORED')
    const projectsNav = page.getByRole('button', { name: '我的项目', exact: true })
    if (await projectsNav.isVisible()) await projectsNav.click()
    await page.locator('[data-ai-id="project-list-item"]').click()
    await page.locator('textarea').waitFor()
    if (!resumePreparation) {
      const continuation = option('continuation-file')
      const message = continuation ? readFileSync(continuation, 'utf8').trim() : '请继续完成已经确认的需求。'
      if (!message) throw new Error('EXPERIMENT_EMPTY_CONTINUATION')
      await page.locator('textarea').fill(message)
      if (continuation) report.continuation_file = resolve(continuation)
    }
    else if (resumeAnswer) {
      await page.locator('textarea').fill(resumeAnswer)
      report.resume_answer = resumeAnswer
    }
    report.run_id = original.run_id
  }
  if (!resumePreparation || resumeAnswer) await page.getByRole('button', { name: '发送消息', exact: true }).click()
  const deadline = Date.now() + Number(option('timeout-min', command === 'prepare' ? '40' : '32')) * 60000
  let lastAction = 0, lastStatus = ''
  while (Date.now() < deadline) {
    await sleep(2000)
    const current = project(), experiment = config(current.project_id)
    if (existsSync(stopFile)) {
      report.cancellation = await page.evaluate(cancelExperimentProject, { projectId: current.project_id, sessionId: experiment.parent_session_id ?? current.last_session_id })
      report.outcome = 'user-stopped'; break
    }
    const status = `${current.current_stage}/${current.desktop_phase ?? '-'}/${experiment.state}`
    if (status !== lastStatus) { log(status); lastStatus = status }
    if (command === 'prepare' && experiment.state === 'prepared') { report.outcome = 'prepared'; break }
    if (command === 'run') {
      const eventsPath = join(home, 'dispatch-experiments', 'events', `${experiment.run_id}.jsonl`)
      const events = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : []
      const terminal = events.find(event => event.event === 'run_finished')
      if (terminal) { report.outcome = 'machine-finished'; report.run_outcome = terminal.outcome; report.termination_reason = terminal.reason; break }
    }
    if (Date.now() - lastAction < 4000) continue
    let action
    for (const id of ['requirement-confirm-submit', 'prd-confirm-submit', 'card-option-ux_confirm_go', 'card-option-ux_delegate', 'review-choice-global-prd_review_delegate_all']) {
      const target = page.locator(`[data-ai-id="${id}"]`)
      if (await target.isVisible() && await target.isEnabled()) {
        if (id === 'requirement-confirm-submit') {
          const suggested = page.locator('[data-ai-id^="requirement-confirm-item-"]').filter({ has: page.locator('[data-ai-id^="requirement-confirm-origin-"]') }).locator('input[type="checkbox"]')
          const excluded = []
          for (let i = 0; i < await suggested.count(); i++) {
            const checkbox = suggested.nth(i)
            if (await checkbox.isChecked()) { excluded.push(await checkbox.locator('..').innerText()); await checkbox.uncheck() }
          }
          report.confirmations.push({ at: new Date().toISOString(), action: 'exclude-guide-suggestions', excluded })
        }
        await target.click(); action = id; break
      }
    }
    if (!action && command === 'prepare') {
      const custom = page.locator('[data-ai-id="clarification-custom-input"]')
      if (await custom.isVisible()) {
        const question = await page.locator('[data-ai-id="clarification-card-overlay"]').innerText()
        const currentAnswers = option('clarification-answers') ? JSON.parse(readFileSync(option('clarification-answers'), 'utf8')) : clarificationAnswers
        if (!Array.isArray(currentAnswers)) throw new Error('EXPERIMENT_INVALID_CLARIFICATION_ANSWERS')
        const answer = selectClarificationAnswer(question, currentAnswers)
        if (answer) {
          await custom.fill(answer)
          await page.locator('[data-ai-id="clarification-custom-submit"]').click()
          report.confirmations.push({ at: new Date().toISOString(), action: 'predefined-clarification-answer', question, answer })
          action = 'clarification-custom-submit'
        }
      }
    }
    if (!action && command === 'prepare') {
      const choices = await page.locator('[data-ai-id^="card-option-"],[data-ai-id^="clarification-option-"]').evaluateAll(nodes => nodes.map(node => ({
        id: node.getAttribute('data-ai-id'), text: node.textContent,
        visible: !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length), enabled: !node.disabled,
      })))
      const pick = selectPreparationChoice(choices)
      if (pick) { await page.locator(`[data-ai-id="${pick}"]`).click(); action = pick }
    }
    if (action) { lastAction = Date.now(); report.confirmations.push({ at: new Date().toISOString(), action }); log(action) }
  }
  if (report.outcome === 'running') report.outcome = 'timeout'
  report.project = project()
  report.end_screen_text = (await page.locator('body').innerText()).slice(-16000)
  await page.screenshot({ path: join(reportDir, 'terminal.png') })
  if (report.outcome === 'timeout') {
    const current = project(), experiment = config(current.project_id)
    report.cancellation = await page.evaluate(cancelExperimentProject, { projectId: current.project_id, sessionId: experiment.parent_session_id ?? current.last_session_id })
  }
} catch (error) {
  report.outcome = 'driver-error'; report.error = error.message; log(error.message)
  if (page) {
    await page.screenshot({ path: join(reportDir, 'driver-error.png') }).catch(() => {})
    report.driver_state = await page.locator('body').innerText().catch(() => '')
  }
}
finally {
  if (application) await application.close().catch(() => {})
  report.finished_at = new Date().toISOString()
  writeFileSync(join(reportDir, 'report.json'), JSON.stringify(report, null, 2))
}
if (!['prepared', 'machine-finished'].includes(report.outcome)) process.exitCode = 1
log(report.outcome)
