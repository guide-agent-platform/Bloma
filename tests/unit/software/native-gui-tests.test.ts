import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { createProject, updateProject } from '../../../main/project/project-service';
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store';
import { parseLeanBrief } from '../../../main/guide/lean-brief';
import { syncDocuments } from '../../../main/project/document-sync';
import { prdScopeFingerprint } from '../../../main/project/requirement-contract';
import { registerNativeGuiTests } from '../../../main/software/native-gui-registration';
import { guiSuitePath } from '../../../main/desktop/gui-acceptance';
import { verifySoftwareCandidate, recentSoftwareVerification } from '../../../main/software/verification';
import { closeAllDebugSessions } from '../../../main/software/debug-sessions';
import { buildSoftwareVerifyTool } from '../../../main/software/verification-tool';
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy';
import { createToolState } from '../../../main/agent/loop/agent-loop';
import { saveSoftwareRegressionBaseline } from '../../../main/software/regression-baseline';
let home: string, previous: string | undefined, project: ReturnType<typeof createProject>;
const script = `export default async({test,page,expect,assert,phase})=>{
 if(phase==='reopened'){await test('F-001 real reopen',async()=>{await page.goto('/');await expect(page.locator('#list')).toHaveText('Alice')});return;}
 await test('F-001 create Alice',async()=>{await page.goto('/');await page.locator('#name').focus();await page.keyboard.type('Alice');await page.locator('#save').click();await expect(page.locator('#list')).toHaveText('Alice')});
 await test('F-002 reject blank',async()=>{await page.locator('#name').fill('');await page.locator('#save').click();await expect(page.locator('#status')).toHaveText('required');assert.equal(await page.locator('#list').innerText(),'Alice')});
}`;
beforeEach(async () => {
    previous = process.env.PROMA_HOME;
    home = mkdtempSync(join(tmpdir(), 'bloma-native-gui-'));
    process.env.PROMA_HOME = home;
    project = createProject({ request_id: 'c', mode: 'longterm' }, { workflowVersion: 'software-v1' });
    const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: 'Names', ui: 'required', delivery: 'browser', requirements: [
            { description: '新增姓名并重开保留', expected: '保存Alice并关闭重开后仍显示Alice' }, { description: '拒绝空姓名', expected: '空姓名提示required，不改变已有Alice' }
        ] }), { projectId: project.project_id, sessionId: 's', source: 'Names', previous: readPrdBackplane(project.project_id), software: true })!;
    if (parsed.action !== 'brief')
        throw Error('fixture');
    parsed.brief.lean_brief!.preview = 'skip';
    syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, parsed.brief);
    const brief = markPrdUserConfirmed(project.project_id)!, scope = prdScopeFingerprint(brief);
    updateProject(project.project_id, { ux_confirmation: { prd_fingerprint: scope, design_hash: scope, html_hash: null } });
    const port = createServer();
    await new Promise<void>(done => port.listen(0, '127.0.0.1', done));
    const address = port.address();
    if (!address || typeof address === 'string')
        throw Error('port');
    await new Promise<void>(done => port.close(() => done()));
    writeFileSync(join(project.root_path, 'server.cjs'), `const fs=require('fs');require('http').createServer((q,s)=>{s.setHeader('Content-Type','text/html;charset=utf-8');s.end(fs.readFileSync('index.html'))}).listen(${address.port},'127.0.0.1')`);
    writeFileSync(join(project.root_path, 'index.html'), `<!doctype html><meta charset="utf-8"><h1>Names</h1><input id="name"><button id="save">Save</button><output id="status"></output><ul id="list"></ul><script>list.textContent=localStorage.getItem('name')||'';document.querySelector('#save').onclick=()=>{const v=document.querySelector('#name').value.trim();if(!v){document.querySelector('#status').textContent='required';return;}list.textContent=v;localStorage.setItem('name',v)}</script>`);
    writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, ui: 'browser', command: ['node', 'server.cjs'], url: `http://127.0.0.1:${address.port}` }));
    mkdirSync(join(project.root_path, 'tests'));
    writeFileSync(join(project.root_path, 'tests/acceptance.mjs'), script);
});
afterEach(async () => { await closeAllDebugSessions(); if (previous === undefined)
    delete process.env.PROMA_HOME;
else
    process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }, 30000);
it('does not freeze a native draft before its application launch declaration is valid', async () => {
    const launchFile=join(project.root_path,'LAUNCH.json'),original=readFileSync(launchFile,'utf8')
    writeFileSync(launchFile,JSON.stringify({schema_version:2,command:'npm start',ui:true}))
    const tool=buildSoftwareVerifyTool(project.project_id,createSoftwareCollaborationPolicy(project.project_id,project.root_path,'s'))
    const result=await tool.execute({script:'tests/acceptance.mjs'},{projectId:project.project_id,sessionId:'s',requestId:'r',signal:new AbortController().signal,state:createToolState()})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('command 须为非空字符串数组')
    expect(existsSync(guiSuitePath(project.project_id))).toBe(false)
    writeFileSync(launchFile,original)
    writeFileSync(join(project.root_path,'tests/acceptance.mjs'),script.replace('create Alice','create Alice from repaired draft'))
    expect(()=>registerNativeGuiTests(project.project_id,'tests/acceptance.mjs')).not.toThrow()
})
it('verify_app directly freezes and actually runs node:test UI checks, including relative navigation and a real restart, without an action table', async () => {
    const tool = buildSoftwareVerifyTool(project.project_id, createSoftwareCollaborationPolicy(project.project_id, project.root_path, 's'));
    const result = await tool.execute({ script: 'tests/acceptance.mjs', restart: true }, { projectId: project.project_id, sessionId: 's', requestId: 'r', signal: AbortSignal.timeout(90000), state: createToolState() });
    expect(result.isError, result.output).not.toBe(true);
    const suite = JSON.parse(readFileSync(guiSuitePath(project.project_id), 'utf8'));
    expect(suite.steps).toEqual([]);
    expect(suite.native_tests.restart).toBe(true);
    const checked = await recentSoftwareVerification(project.project_id, 'r');
    expect(checked?.status).toBe('passed');
    expect(checked?.core?.host_gui?.method).toBe('node:test');
    expect(checked?.core?.host_gui?.native_evidence?.interactions).toBe(4)
    expect(checked?.core?.host_gui?.steps).toHaveLength(3);
    const workspaces=join(home,'software-debug-data',project.project_id)
    expect(readdirSync(workspaces).every(dir=>!existsSync(join(workspaces,dir,'formal-profile')))).toBe(true)
}, 120000);
it.skipIf(process.platform!=='win32'||!existsSync(resolve('node_modules/electron/dist/electron.exe')))('executes the same native suite through a real Electron entry and checks the normal window launch',async()=>{
 const root=project.root_path
 const brief=readPrdBackplane(project.project_id);brief.lean_brief!.delivery='desktop'
 syncDocuments({request_id:'desktop-test-scope',project_id:project.project_id,session_id:'s',checkpoint:'requirement_confirmed'},brief)
 const confirmed=markPrdUserConfirmed(project.project_id)!,scope=prdScopeFingerprint(confirmed);updateProject(project.project_id,{ux_confirmation:{prd_fingerprint:scope,design_hash:scope,html_hash:null}})
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'native-fixture',main:'main.cjs'}))
 writeFileSync(join(root,'main.cjs'),`const{app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1000,height:700}).loadFile('index.html'));app.on('window-all-closed',()=>app.quit())`)
 writeFileSync(join(root,'index.html'),'<title>Names native</title>'+readFileSync(join(root,'index.html'),'utf8'))
 writeFileSync(join(root,'LAUNCH.json'),JSON.stringify({schema_version:2,ui:'electron',command:['electron','.'],window_title:'Names native'}))
 writeFileSync(join(root,'tests/acceptance.mjs'),script.replaceAll("await page.goto('/');",''))
 registerNativeGuiTests(project.project_id,'tests/acceptance.mjs')
 const checked=await verifySoftwareCandidate(project.project_id,'electron-native',AbortSignal.timeout(120000))
 expect(checked.status,JSON.stringify({summary:checked.summary,gui:checked.core?.host_gui})).toBe('passed');expect(checked.core?.host_gui?.method).toBe('node:test');expect(checked.launch?.passed).toBe(true)
},150000)
it('allows locator repairs but freezes input, expected values and helper business logic', () => {
    const base = 'const positive=values=>values.filter(n=>n>0);\n' + script;
    writeFileSync(join(project.root_path, 'tests/acceptance.mjs'), base);
    const first = registerNativeGuiTests(project.project_id, 'tests/acceptance.mjs');
    writeFileSync(join(project.root_path, 'tests/acceptance.mjs'), base.replaceAll("'#list'", "'ul#list'"));
    expect(registerNativeGuiTests(project.project_id, 'tests/acceptance.mjs').native_tests?.contract).toBe(first.native_tests?.contract);
    writeFileSync(join(project.root_path, 'tests/acceptance.mjs'), base.replaceAll("'Alice'", "'Wrong'"));
    expect(() => registerNativeGuiTests(project.project_id, 'tests/acceptance.mjs')).toThrow('EXISTING_EXPECTATIONS_CHANGED');
    writeFileSync(join(project.root_path, 'tests/acceptance.mjs'), base.replace('n>0', 'n>=0'));
    expect(() => registerNativeGuiTests(project.project_id, 'tests/acceptance.mjs')).toThrow('EXISTING_EXPECTATIONS_CHANGED');
    writeFileSync(join(project.root_path, 'tests/acceptance.mjs'), base.replace("page.locator('#list')", "page.locator((()=>{throw Error('changed logic');return '#list'})())"));
    expect(() => registerNativeGuiTests(project.project_id, 'tests/acceptance.mjs')).toThrow('EXISTING_EXPECTATIONS_CHANGED');
});
it('rejects missing coverage before registration and rejects changed frozen tests before cached PASS reuse', async () => {
    writeFileSync(join(project.root_path, 'tests/acceptance.mjs'), script.replaceAll('F-002', 'F-099'));
    expect(() => registerNativeGuiTests(project.project_id, 'tests/acceptance.mjs')).toThrow('COVERAGE_REQUIRED');
    writeFileSync(join(project.root_path, 'tests/acceptance.mjs'), script);
    registerNativeGuiTests(project.project_id, 'tests/acceptance.mjs');
    const checked = await verifySoftwareCandidate(project.project_id, 'r', AbortSignal.timeout(90000));
    expect(checked.status, checked.summary).toBe('passed');
    const native = JSON.parse(readFileSync(guiSuitePath(project.project_id), 'utf8')).native_tests;
    writeFileSync(join(home, 'gui-native-tests', project.project_id, native.digest, native.entry), 'changed private test');
    expect(await recentSoftwareVerification(project.project_id, 'r')).toBeUndefined();
    const changed = await verifySoftwareCandidate(project.project_id, 'r');
    expect(changed.status).not.toBe('passed');
    expect(changed.summary).toContain('FROZEN_INPUT_CHANGED');
}, 120000);
it('a confirmed additional feature can append a case while retained cases and shared helpers stay fixed', () => {
    registerNativeGuiTests(project.project_id, 'tests/acceptance.mjs');
    saveSoftwareRegressionBaseline(project.project_id, 'fixture-baseline');
    const old = readPrdBackplane(project.project_id);
    const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: 'Names plus delete', ui: 'required', delivery: 'browser', requirements: [
            ...old.requirements.map(row => ({ description: row.description, expected: old.acceptance[row.id] })), { description: '删除姓名', expected: '点击删除后列表不再显示Alice' }
        ] }), { projectId: project.project_id, sessionId: 's', source: '用户新增删除，保留原有功能', previous: old, software: true })!;
    if (parsed.action !== 'brief')
        throw Error('fixture');
    parsed.brief.lean_brief!.preview = 'skip';
    syncDocuments({ request_id: 'new-scope', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, parsed.brief);
    const next = markPrdUserConfirmed(project.project_id)!, scope = prdScopeFingerprint(next);
    updateProject(project.project_id, { ux_confirmation: { prd_fingerprint: scope, design_hash: scope, html_hash: null } });
    const added = script.replace(/\n}$/, `\n await test('F-003 delete',async()=>{await page.locator('#delete').click();await expect(page.locator('#list')).toHaveText('')});\n}`);
    writeFileSync(join(project.root_path, 'tests/acceptance.mjs'), added);
    expect(registerNativeGuiTests(project.project_id, 'tests/acceptance.mjs').covers).toContain('F-003');
});
it('a real bad result fails the host checks rather than becoming a verifier success', async () => {
    registerNativeGuiTests(project.project_id, 'tests/acceptance.mjs');
    const html = readFileSync(join(project.root_path, 'index.html'), 'utf8');
    writeFileSync(join(project.root_path, 'index.html'), html.replace('list.textContent=v', 'list.textContent="Wrong"'));
    const failed = await verifySoftwareCandidate(project.project_id, 'r', AbortSignal.timeout(90000));
    expect(failed.status).not.toBe('passed');
    expect(failed.core?.host_gui?.status).toBe('failed');
    writeFileSync(join(project.root_path,'tests/acceptance.mjs'),script.replaceAll("'Alice'","'Wrong'"))
    expect(()=>registerNativeGuiTests(project.project_id,'tests/acceptance.mjs')).toThrow('EXISTING_EXPECTATIONS_CHANGED')
}, 120000);
it('returns the real application exception even when the native assertions themselves pass',async()=>{
  registerNativeGuiTests(project.project_id,'tests/acceptance.mjs')
  const file=join(project.root_path,'index.html');writeFileSync(file,readFileSync(file,'utf8')+'<script>setTimeout(()=>{throw Error("native real runtime failure")},0)</script>')
  const result=await verifySoftwareCandidate(project.project_id,'r',AbortSignal.timeout(90000))
  expect(result.status).toBe('failed');expect(result.core?.host_gui?.error).toContain('native real runtime failure')
  expect(result.core?.host_gui?.steps.some(step=>step.id==='native-runtime'&&!step.passed)).toBe(true)
},120000)
it.each(['empty', 'skip'])('does not accept %s tests or a console PASS as native application evidence', async (mode) => {
    const content = mode === 'empty' ? `export default async({test})=>{console.log('PASS');await test('F-001 empty',async()=>{});await test('F-002 empty',async()=>{});return{status:'passed'}}`
        : `export default async({test,page,expect})=>{await test('F-001 observed',async()=>{await page.locator('#name').fill('Alice');await page.locator('#save').click();await expect(page.locator('#list')).toHaveText('Alice')});await test.skip('F-002 skipped',async()=>{await page.locator('#name').fill('');await page.locator('#save').click();await expect(page.locator('#status')).toHaveText('required');await expect(page.locator('#list')).toHaveText('Alice')})}`;
    writeFileSync(join(project.root_path, 'tests/acceptance.mjs'), content);
    registerNativeGuiTests(project.project_id, 'tests/acceptance.mjs');
    const result = await verifySoftwareCandidate(project.project_id, 'r', AbortSignal.timeout(90000));
    expect(result.status).not.toBe('passed');
    if(mode==='empty'){
      expect(result.status).toBe('unverified')
      writeFileSync(join(project.root_path,'tests/acceptance.mjs'),script)
      expect(()=>registerNativeGuiTests(project.project_id,'tests/acceptance.mjs')).not.toThrow()
    }else{
      writeFileSync(join(project.root_path,'tests/acceptance.mjs'),content.replace('test.skip','test'))
      expect(()=>registerNativeGuiTests(project.project_id,'tests/acceptance.mjs')).not.toThrow()
    }
}, 120000);
