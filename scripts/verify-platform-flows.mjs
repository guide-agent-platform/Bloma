/** Actual built Bloma UI and real local product processes. Model output is a
 * bounded loopback fixture. No user home, real credentials or provider calls. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { _electron, chromium } from 'playwright';
import { startPlatformFlowModel } from '../tests/fixtures/platform-flow-model.mjs';
const root = path.resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url), stamp = Date.now().toString();
const out = path.join(path.resolve(process.env.BLOMA_VALIDATION_OUTPUT ?? path.join(root, 'run-artifacts/platform-flow-regression')), 'ui-' + stamp), home = fs.mkdtempSync(path.join(os.tmpdir(), 'blomaFullUI-'));
fs.mkdirSync(out, { recursive: true });
const report = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), working_tree: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean), bundle_sha256: createHash('sha256').update(fs.readFileSync(path.join(root, 'dist-main/main/index.js'))).digest('hex'), home, scope: 'actual application UI + real local products; controlled loopback model, native folder-dialog return stubbed; no real model quality/clean-machine claim', status: 'running', checks: [], errors: [] };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)), pass = (name, evidence = {}) => { report.checks.push({ name, ...evidence }); save(); console.log('PASS ' + name); };
let app, page, model, step = 'setup';
const productPages = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 90000) { const end = Date.now() + timeout; while (Date.now() < end) {
    const result = await fn();
    if (result)
        return result;
    await delay(100);
} throw Error('WAIT_TIMEOUT: ' + label); }
const projects = () => fs.existsSync(path.join(home, 'projects.json')) ? JSON.parse(fs.readFileSync(path.join(home, 'projects.json'), 'utf8')).projects : [];
const project = id => projects().find(row => row.project_id === id);
async function api(group, method, input = {}) { const result = await page.evaluate(async ({ group, method, input }) => window.electronAPI[group][method]({ request_id: crypto.randomUUID(), ...input }), { group, method, input }); assert.equal(result.ok, true, JSON.stringify(result)); return result.data; }
async function start() {
    const env = { PROMA_HOME: home };
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT'])
        if (process.env[key])
            env[key] = process.env[key];
    app = await _electron.launch({ executablePath: require('electron'), args: ['--user-data-dir=' + path.join(home, 'profile'), '.'], cwd: root, env, timeout: 30000 });
    page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    page.on('pageerror', e => report.errors.push(e.stack));
    await app.evaluate(({ BrowserWindow }) => { globalThis.__blockedExternalRequests = []; const original = globalThis.fetch; globalThis.fetch = (input, ...args) => { const url = new URL(typeof input === 'string' ? input : input.url ?? String(input)); if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        globalThis.__blockedExternalRequests.push(url.origin);
        throw Error('OFFLINE_ACCEPTANCE_BLOCKED_EXTERNAL');
    } ; return original(input, ...args); }; const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1360, 900); win.webContents.setBackgroundThrottling(false); win.webContents.setAudioMuted(true); });
    await page.waitForLoadState('domcontentloaded');
}
async function stop() { if (!app)
    return; report.blocked_external = [...(report.blocked_external ?? []), ...await app.evaluate(() => globalThis.__blockedExternalRequests)]; const instance = app; const exited = new Promise(resolve => instance.process().once('exit', resolve)); await instance.evaluate(({ app, BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows())
    w.removeAllListeners('close'); app.quit(); }).catch(() => { }); await Promise.race([exited, delay(10000).then(() => { throw Error('QUIT_TIMEOUT'); })]); app = undefined; }
async function homePage() { const button = page.getByRole('button', { name: '主页面', exact: true }); await button.first().click(); await page.getByRole('textbox', { name: '你的软件想法', exact: true }).waitFor(); }
async function newProject(mode, scenario, idea) {
    model.setScenario(scenario);
    await homePage();
    if (mode === 'longterm')
        await page.getByRole('button', { name: '长期型', exact: true }).click();
    const before = new Set(projects().map(p => p.project_id));
    await page.getByRole('textbox', { name: '你的软件想法', exact: true }).fill(idea);
    await page.locator('[data-ai-id=create-project-button]').click();
    const p = await until(() => projects().find(p => !before.has(p.project_id)), 'project persisted');
    await page.locator('[data-ai-id^="card-option-lean_confirm:"]').waitFor({ timeout: 30000 });
    return p.project_id;
}
async function confirmGoal() { await page.locator('[data-ai-id^="card-option-lean_confirm:"]').click(); }
async function completed(id) { return until(() => { const p = project(id), file = path.join(home, 'software-run-states', id + '.json'); if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).status === 'blocked')
    throw Error('HOST_BLOCKED: ' + p.desktop_blocked?.note); return p?.status === 'completed' && p.current_stage === 'completed' && p; }, 'host delivery ' + id, 180000); }
async function screenshot(name) { await page.screenshot({ path: path.join(out, name + '.png'), timeout: 20000 }); }
async function connectProduct(profile, startedAt) { const file = path.join(profile, 'DevToolsActivePort'); await until(() => fs.existsSync(file) && (!startedAt || fs.statSync(file).mtimeMs >= Date.parse(startedAt)), 'fresh product CDP'); const browser = await until(async () => { try {
    const port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]);
    return await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 1000 });
}
catch {
    return false;
} }, 'owned product CDP connection', 20000); const target = await until(() => browser.contexts()[0]?.pages()[0], 'product window'); productPages.push(target); target.on('pageerror',error=>report.errors.push(error.stack)); target.setDefaultTimeout(10000); await target.locator('#save').waitFor(); return target; }
try {
    model = await startPlatformFlowModel(require('electron'));
    await start();
    step = 'empty channel state';
    await page.locator('[data-ai-id=create-project-button]').click();
    await page.getByText('未配置 AI', { exact: true }).waitFor();
    assert.equal(model.observations.length, 0);
    pass('new workspace exposes missing model connection and does not call a provider');
    step = 'channel setup';
    await page.getByRole('button', { name: '设置（模型渠道）', exact: true }).click();
    await page.getByRole('button', { name: '添加第一个渠道', exact: true }).click();
    await page.getByPlaceholder('例如：我的 DeepSeek').fill('本机全流程验收');
    await page.locator('select:has(option[value="anthropic-compatible"])').selectOption('anthropic-compatible');
    await page.getByPlaceholder('自定义提供商请填写服务地址').fill(model.url);
    await page.getByPlaceholder('sk-…').fill('LOCAL_ONLY_NO_PROVIDER_CREDENTIAL');
    await page.getByLabel('手动添加模型', { exact: true }).fill('local-platform-model');
    await page.locator('[data-ai-id=channel-model-add]').click();
    await page.getByLabel('local-platform-model 上下文窗口', { exact: true }).fill('1000000');
    await page.getByRole('button', { name: '保存渠道', exact: true }).click();
    pass('native settings save local channel and 1M context');
    await stop();
    await start();
    await page.getByRole('button', { name: '设置（模型渠道）', exact: true }).click();
    await page.getByTitle('编辑渠道', { exact: true }).click();
    assert.equal(await page.getByLabel('local-platform-model 上下文窗口', { exact: true }).inputValue(), '1000000');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: /^返回/ }).first().click();
    pass('channel settings survive full process restart');
    step = 'clarification recovery';
    await homePage();
    model.setScenario('clarify');
    const beforeClarify = new Set(projects().map(p => p.project_id));
    await page.getByRole('textbox', { name: '你的软件想法', exact: true }).fill('帮我做个日常小工具');
    await page.locator('[data-ai-id=create-project-button]').click();
    const clarification = await until(() => projects().find(p => !beforeClarify.has(p.project_id)), 'clarification project');
    await page.getByText('主要通过什么方式使用？', { exact: false }).first().waitFor();
    const beforeReopen = model.observations.length;
    await stop();
    await start();
    await page.getByRole('button', { name: '所有项目', exact: true }).click();
    await page.getByText(clarification.name, { exact: true }).click();
    await page.getByText('主要通过什么方式使用？', { exact: false }).first().waitFor();
    assert.equal(model.observations.length, beforeReopen);
    await screenshot('clarification-restored');
    model.setScenario('clarified');
    await page.getByRole('textbox', { name: '消息输入', exact: true }).fill('用命令行，输出42');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.locator('[data-ai-id^="card-option-lean_confirm:"]').waitFor();
    await page.locator('[data-ai-id=card-option-lean_pause]').click();
    assert.notEqual(project(clarification.project_id).status, 'completed');
    pass('clarification survives a full restart and answering it returns to an unconfirmed task sheet');
    step = 'GUI goal and sketch';
    const gui = await newProject('quick', 'gui', '做一个本地记事本，输入文字后保存，关闭重开仍能看到记录。');
    report.gui_project = gui;
    await confirmGoal();
    await page.locator('[data-ai-id=confirm-sketch-button]').waitFor({ timeout: 45000 });
    assert.notEqual(project(gui).status, 'completed');
    await screenshot('sketch-confirmation');
    pass('goal confirmation leads to actual static sketch and waits for user');
    await page.locator('[data-ai-id=confirm-sketch-button]').click();
    step = 'GUI production';
    await completed(gui);
    await screenshot('gui-delivered');
    const ledger = JSON.parse(fs.readFileSync(path.join(home, 'software-quality', gui + '.json'), 'utf8'));
    assert.ok(ledger.reviews.some(r => r.kind === 'code' && r.status === 'complete'));
    assert.ok(ledger.reviews.some(r => r.kind === 'visual' && r.status === 'complete'));
    pass('real Pi writes GUI app and host C/V plus native checks deliver it', { project_id: gui });
    step = 'normal product persistence';
    const userMarker = path.join(home, 'software-user-instances', gui + '.json');
    const userProcess = () => { if (!fs.existsSync(userMarker))
        return; const id = JSON.parse(fs.readFileSync(userMarker, 'utf8')).processId, file = path.join(home, 'software-processes', id + '.json'); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined; };
    await page.getByRole('button', { name: '启动程序', exact: true }).click();
    let userRun = await until(() => { const p = userProcess(); return p?.state === 'running' && p; }, 'normal product running');
    const userData = userRun.data_dir;
    let productPage = await connectProduct(path.join(userData, 'electron-profile'), userRun.startedAt);
    await productPage.locator('#note').fill('ordinary user record');
    await productPage.locator('#save').click();
    await until(() => fs.existsSync(path.join(userData, 'notes.json')), 'user notes persisted');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, 'notes.json'), 'utf8')), ['ordinary user record']);
    await productPage.close();
    await until(() => ['exited', 'failed'].includes(userProcess()?.state), 'normal product exited');
    const oldProcess = userRun.id;
    await page.getByRole('button', { name: '启动程序', exact: true }).click();
    userRun = await until(() => { const p = userProcess(); return p?.id !== oldProcess && p?.state === 'running' && p; }, 'normal product relaunched');
    assert.equal(userRun.data_dir, userData);
    productPage = await connectProduct(path.join(userData, 'electron-profile'), userRun.startedAt);
    await until(async () => (await productPage.locator('#items').innerText()).includes('ordinary user record'), 'normal product reopened data');
    await productPage.close();
    await until(() => ['exited', 'failed'].includes(userProcess()?.state), 'normal product closed');
    pass('normal launch, real save and process reopen preserve user data');
    step = 'isolated trial';
    await page.locator('[data-ai-id=software-trial-launch]').click();
    let details = await until(async () => { const d = await api('projectDeliverables', 'get', { project_id: gui }); return d.trial?.state === 'running' && d; }, 'trial running');
    let trial = details.trial;
    assert.notEqual(trial.data_dir, userData);
    productPage = await connectProduct(path.join(trial.data_dir, 'electron-profile'));
    await productPage.locator('#note').fill('trial-only record');
    await productPage.locator('#save').click();
    await until(() => fs.existsSync(path.join(trial.data_dir, 'notes.json')), 'trial data');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, 'notes.json'), 'utf8')), ['ordinary user record']);
    pass('independent trial uses separate data and leaves the normal program data unchanged');
    step = 'point correction';
    await page.locator('[data-ai-id=delivery-point-correction]').click();
    await page.locator('[data-ai-id=correction-start-button]').click();
    const correctionRoot = path.join(home, 'software-corrections', gui);
    const dir = await until(() => fs.existsSync(correctionRoot) && fs.readdirSync(correctionRoot).map(n => path.join(correctionRoot, n)).find(p => fs.existsSync(path.join(p, 'profile', 'DevToolsActivePort'))), 'correction instance');
    const correction = await connectProduct(path.join(dir, 'profile'));
    await correction.locator('#bloma-correction-host').waitFor();
    await correction.locator('#save').click();
    assert.equal(await correction.locator('#status').innerText(), '');
    await correction.getByLabel('修改意见').fill('把保存按钮改为紫色，文字和行为保持不变。');
    await correction.getByRole('button', { name: '记录这处修改', exact: true }).click();
    await correction.getByRole('button', { name: '完成点选', exact: true }).click();
    await until(async () => /1 处/.test(await page.locator('[data-ai-id=correction-apply-button]').innerText()), 'one correction received');
    const before = model.observations.length;
    await page.locator('[data-ai-id=correction-apply-button]').click();
    await until(() => model.observations.length > before, 'correction dispatched');
    await completed(gui);
    assert.ok(fs.readFileSync(path.join(project(gui).root_path, 'theme.css'), 'utf8').includes('#6b21a8'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, 'notes.json'), 'utf8')), ['ordinary user record']);
    pass('real point selection reaches Pi repair and reverification without changing user data');
    const oldTrial = trial;
    await page.locator('[data-ai-id=software-trial-update]').click();
    details = await until(async () => { const d = await api('projectDeliverables', 'get', { project_id: gui }); return d.trial?.release_id !== oldTrial.release_id && d.trial?.state === 'running' && d; }, 'explicit trial update');
    trial = details.trial;
    productPage = await connectProduct(path.join(trial.data_dir, 'electron-profile'));
    assert.equal(await productPage.locator('#save').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(107, 33, 168)');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(oldTrial.data_dir, 'notes.json'), 'utf8')), ['trial-only record']);
    pass('explicit trial switch shows the repaired purple button and preserves old test data');
    await api('projectDeliverables', 'launch', { project_id: gui, trial: true, trial_version: trial.release_id, stop_trial: true });
    step = 'verified release fallback';
    for (const [label, color] of [['启动上一可用版本', 'rgb(52, 87, 177)'], ['启动程序', 'rgb(107, 33, 168)']]) {
        const previousProcess = userProcess()?.id;
        await page.getByRole('button', { name: label, exact: true }).click();
        const opened = await until(() => { const value = userProcess(); return value?.id !== previousProcess && value?.state === 'running' && value; }, label);
        productPage = await connectProduct(path.join(opened.data_dir, 'electron-profile'), opened.startedAt);
        assert.equal(await productPage.locator('#save').evaluate(e => getComputedStyle(e).backgroundColor), color);
        await until(async () => (await productPage.locator('#items').innerText()).includes('ordinary user record'), 'version switch data readback');
        if(label==='启动程序')await productPage.screenshot({path:path.join(out,'product-current.png')});
        await productPage.close();
        await until(() => ['exited', 'failed'].includes(userProcess()?.state), 'version window closed');
    }
    pass('previous verified release and current release both launch through the UI with user data preserved');
    step = 'cancel and resume';
    model.setHold(true);
    const cli = await newProject('quick', 'cli', '做一个命令行工具，运行后输出42。');
    await confirmGoal();
    await until(() => model.heldCount() > 0, 'held local request');
    await page.getByRole('button', { name: '停止本轮制作', exact: true }).click();
    await until(() => model.cancelled() > 0, 'cancel reached HTTP');
    assert.notEqual(project(cli).status, 'completed');
    model.setHold(false);
    const attachment = path.join(out, 'expected-output.txt');
    fs.writeFileSync(attachment, '正常运行时显示42。');
    await page.locator('input[type=file]').setInputFiles(attachment);
    await page.getByRole('textbox', { name: '消息输入', exact: true }).fill('继续制作');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await completed(cli);
    const receipts = fs.readdirSync(path.join(home, 'bloma-composer', 'inbox')).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(home, 'bloma-composer', 'inbox', name), 'utf8')));
    assert.ok(receipts.some(row => row.input.project_id === cli && row.input.attachment_refs.length === 1 && row.receipt.status === 'completed'));
    pass('attachment selection is retained in the completed persistent message receipt');
    pass('stop cancels the active HTTP request; normal chat resumes persistent Pi state', { project_id: cli });
    step = 'longterm milestone';
    const longterm = await newProject('longterm', 'longterm', '做一个命令行工具，当前阶段运行后输出42。');
    await confirmGoal();
    await page.locator('[data-ai-id=longterm-confirm]').waitFor({ timeout: 120000 });
    const pending = await api('projectDeliverables', 'get', { project_id: longterm });
    assert.equal(pending.longterm.milestones[0].status, 'awaiting_confirmation');
    assert.equal(pending.stable_release, undefined);
    const requestsBeforeConfirm = model.observations.length;
    await page.locator('[data-ai-id=longterm-confirm]').click();
    await page.getByText('本阶段已交付', { exact: true }).first().waitFor({ timeout: 90000 });
    assert.equal(model.observations.length, requestsBeforeConfirm);
    pass('longterm completion waits for actual milestone confirmation and publishes without another model');
    step = 'project history';
    await page.getByRole('button', { name: '所有项目', exact: true }).click();
    let row = page.locator('[data-ai-id=project-list-item]').filter({ hasText: '本机命令工具' });
    await row.getByRole('button', { name: '重命名', exact: true }).click();
    await page.getByLabel('项目新名称', { exact: true }).fill('重命名后的命令工具');
    await page.locator('[data-ai-id=project-rename-submit]').click();
    await until(() => project(cli).name === '重命名后的命令工具', 'rename persisted');
    row = page.locator('[data-ai-id=project-list-item]').filter({ hasText: '重命名后的命令工具' });
    await row.getByRole('button', { name: '归档', exact: true }).click();
    await until(() => project(cli).status === 'archived', 'archive persisted');
    await page.getByRole('button', { name: '已归档', exact: true }).click();
    row = page.locator('[data-ai-id=project-list-item]').filter({ hasText: '重命名后的命令工具' });
    await row.getByRole('button', { name: '恢复', exact: true }).click();
    await until(() => project(cli).status !== 'archived', 'unarchive persisted');
    pass('project rename, archive and restore through actual history UI');
    step = 'export';
    await page.getByRole('button', { name: '进行中', exact: true }).click();
    row = page.locator('[data-ai-id=project-list-item]').filter({ hasText: '重命名后的命令工具' });
    const exportRoot = path.join(out, 'exports');
    fs.mkdirSync(exportRoot, { recursive: true });
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, exportRoot);
    await row.getByRole('button', { name: '导出', exact: true }).click();
    await page.locator('[data-ai-id=project-export-notice]').waitFor();
    assert.ok(fs.readdirSync(exportRoot).length > 0);
    pass('real export UI creates a handoff in the selected isolated directory');
    step = 'import and delete';
    await homePage();
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'blomaFullSource-'));
    fs.writeFileSync(path.join(source, 'app.cjs'), 'console.log("existing user source")');
    fs.writeFileSync(path.join(source, 'README.md'), 'Existing project, preserve original files.');
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, source);
    const ids = new Set(projects().map(p => p.project_id)), requestsBeforeImport = model.observations.length;
    await page.getByRole('button', { name: '打开已有工程', exact: true }).click();
    const imported = await until(() => projects().find(p => !ids.has(p.project_id)), 'imported project');
    assert.notEqual(imported.root_path, source);
    assert.equal(fs.readFileSync(path.join(imported.root_path, 'app.cjs'), 'utf8'), 'console.log("existing user source")');
    assert.equal(model.observations.length, requestsBeforeImport);
    await page.getByRole('button', { name: '所有项目', exact: true }).click();
    row = page.locator('[data-ai-id=project-list-item]').filter({ hasText: imported.name });
    await row.getByRole('button', { name: '删除', exact: true }).click();
    await page.locator('[data-ai-id=project-delete-confirm-button]').click();
    await until(() => !project(imported.project_id), 'imported clone deleted');
    assert.equal(fs.readFileSync(path.join(source, 'app.cjs'), 'utf8'), 'console.log("existing user source")');
    report.import_source = source;
    pass('import copies an existing project and deleting the clone leaves original files intact');
    step = 'restart recovery';
    const count = model.observations.length;
    await stop();
    await start();
    await page.getByRole('button', { name: '所有项目', exact: true }).click();
    await page.getByText('重命名后的命令工具', { exact: true }).waitFor();
    assert.equal(model.observations.length, count);
    assert.equal(project(gui).status, 'completed');
    pass('full application restart retains project history without automatic model execution');
    assert.deepEqual(report.errors, []);
    assert.ok(model.observations.some(r => r.has_image));
    assert.ok(model.observations.some(r => r.response_tools?.includes('read_skill')));
    report.status = 'passed';
}
catch (error) {
    report.status = 'failed';
    report.failed_step = step;
    report.error = error.stack;
    process.exitCode = 1;
    if (page && !page.isClosed()) {
        report.visible_text = await page.locator('body').innerText().catch(() => '');
        await screenshot('failure').catch(() => { });
    }
}
finally {
    for (const product of productPages)
        if (!product.isClosed())
            await product.close().catch(() => { });
    if (app)
        await stop().catch(error => { report.errors.push(String(error)); report.status = 'failed'; process.exitCode = 1; });
    if (model) {
        report.model_requests = model.observations;
        await model.close();
    }
    if(report.blocked_external?.length||report.errors.length){report.status='failed';process.exitCode=1;}
    save();
    console.log(JSON.stringify({ status: report.status, failed_step: report.failed_step, error: report.error, report: path.join(out, 'report.json') }));
}
