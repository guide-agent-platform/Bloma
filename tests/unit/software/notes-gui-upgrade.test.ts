import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProject, updateProject } from '../../../main/project/project-service'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { syncDocuments } from '../../../main/project/document-sync'
import { prdScopeFingerprint } from '../../../main/project/requirement-contract'
import { buildLeanGuiTool } from '../../../main/desktop/lean-gui-tool'
import { runCoreVerification } from '../../../main/desktop/core-verification'
import { createToolState } from '../../../main/agent/loop/agent-loop'
import { parseGuiSuite, type GuiAcceptanceSuite } from '../../../main/desktop/gui-acceptance'
import { prepareSoftwareRelease, promoteSoftwareRelease } from '../../../main/software/release-store'
import { saveSoftwareRegressionBaseline } from '../../../main/software/regression-baseline'
import { prepareDataUpdate, softwareDataDirectory } from '../../../main/software/data-update'
import { observeSoftwareGui } from '../../../main/software/gui-observer'
import { executeSoftwareCommand } from '../../../main/software/command-runtime'

let home: string, previous: string | undefined, project: ReturnType<typeof createProject>
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-notes-ui-')); process.env.PROMA_HOME = home;
  project = createProject({ request_id: 'c', mode: 'longterm' }, { workflowVersion: 'software-v1' }) })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }) }, 30000)
const fill = (id: string, selector: string, value: string) => ({ id, kind: 'fill' as const, selector, value })
const click = (id: string, selector: string) => ({ id, kind: 'click' as const, selector })
const check = (id: string, selector: string, equals: string) => ({ id, kind: 'expect' as const, selector, equals })
const count = (id: string, equals: string) => ({ id, kind: 'expect' as const, selector: '#list .note', property: 'count' as const, equals })
const preserved: GuiAcceptanceSuite['steps'] = [fill('a', '#editor', 'Alpha'), click('save-a', '#save'), check('created-a', '#note-1 .content', 'Alpha'),
  fill('b', '#editor', 'Beta'), click('save-b', '#save'), check('created-b', '#note-2 .content', 'Beta'),
  click('edit-a', '#edit-1'), fill('edited', '#editor', 'Alpha edited'), click('save-edit', '#save'), check('saved-edit', '#note-1 .content', 'Alpha edited'), check('kept-b', '#note-2 .content', 'Beta'), count('two', '2'),
  { id: 'restart', kind: 'restart' }, check('reopened-a', '#note-1 .content', 'Alpha edited'), check('reopened-b', '#note-2 .content', 'Beta'), count('reopened-two', '2')]
function confirm(expanded: boolean) {
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '本地记事本', ui: 'required', delivery: 'browser', requirements: [
    { description: '新增编辑保存笔记', expected: '新增两条、修改第一条，保存重开后两条内容仍正确' },
    ...(expanded ? [{ description: '搜索笔记', expected: '搜索Alpha只显示第一条，清空搜索恢复两条' }, { description: '笔记标签', expected: '第一条标记study，重开仍保留标签' }] : [])] }),
    { projectId: project.project_id, sessionId: 's', source: '测试用户确认新增功能，保留原笔记功能', previous: readPrdBackplane(project.project_id), software: true })!
  if (parsed.action !== 'brief') throw Error('fixture'); parsed.brief.lean_brief!.preview = 'skip'
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, parsed.brief)
  const brief = markPrdUserConfirmed(project.project_id)!, scope = prdScopeFingerprint(brief)
  updateProject(project.project_id, { ux_confirmation: { prd_fingerprint: scope, design_hash: scope, html_hash: null } }); return scope
}
function sources(root: string, expanded: boolean, port: number) {
  writeFileSync(join(root, 'store.cjs'), `const{DatabaseSync}=require('node:sqlite'),path=require('path');const db=new DatabaseSync(path.join(process.env.APP_DATA_DIR,'notes.sqlite'));
db.exec('CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY AUTOINCREMENT,content TEXT NOT NULL${expanded ? ',tags TEXT DEFAULT ""' : ''})');
exports.list=()=>db.prepare('SELECT * FROM notes ORDER BY id').all();exports.save=(id,content,tags='')=>id?db.prepare('UPDATE notes SET content=?${expanded ? ',tags=?' : ''} WHERE id=?').run(content,${expanded ? 'tags,' : ''}id):db.prepare('INSERT INTO notes(content${expanded ? ',tags' : ''}) VALUES (?${expanded ? ',?' : ''})').run(content${expanded ? ',tags' : ''});
if(process.argv[2]==='migrate'){db.exec('ALTER TABLE notes ADD COLUMN tags TEXT DEFAULT ""');db.close()}else if(process.argv[2]==='verify'){const rows=exports.list();if(rows.some(r=>!Number.isInteger(r.id)||typeof r.content!=='string'))process.exitCode=2;console.log(JSON.stringify(rows));db.close()}`)
  writeFileSync(join(root, 'server.cjs'), `const http=require('http'),fs=require('fs'),store=require('./store.cjs');http.createServer((q,s)=>{if(q.url.startsWith('/api/notes')){if(q.method==='POST'){let body='';q.on('data',b=>body+=b);q.on('end',()=>{const v=JSON.parse(body);store.save(v.id,v.content,v.tags);s.end('ok')})}else{s.setHeader('content-type','application/json');s.end(JSON.stringify(store.list()))}}else{s.setHeader('content-type','text/html; charset=utf-8');s.end(fs.readFileSync('index.html'))}}).listen(Number(process.argv[2]),'127.0.0.1')`)
  writeFileSync(join(root, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Notes</title><h1>Notes</h1><button id="new">New</button><textarea id="editor"></textarea>${expanded ? '<input id="tags" aria-label="Tags"><input id="search" aria-label="Search">' : ''}<button id="save">Save</button><ul id="list"></ul><script>
let selected=null;const editor=document.querySelector('#editor'),list=document.querySelector('#list'),tags=document.querySelector('#tags'),search=document.querySelector('#search');
async function load(){const rows=await(await fetch('/api/notes')).json();list.replaceChildren();for(const row of rows){if(search&&!row.content.includes(search.value))continue;const li=document.createElement('li'),content=document.createElement('span'),edit=document.createElement('button');li.className='note';li.id='note-'+row.id;content.className='content';content.textContent=row.content;edit.id='edit-'+row.id;edit.textContent='Edit';edit.onclick=()=>{selected=row.id;editor.value=row.content;if(tags)tags.value=row.tags||''};li.append(content,edit);if(tags){const label=document.createElement('span');label.className='tags';label.textContent=row.tags||'';li.append(label)}list.append(li)}}
document.querySelector('#new').onclick=()=>{selected=null;editor.value='';if(tags)tags.value=''};document.querySelector('#save').onclick=async()=>{await fetch('/api/notes',{method:'POST',body:JSON.stringify({id:selected,content:editor.value,tags:tags?.value||''})});selected=null;editor.value='';if(tags)tags.value='';await load()};if(search)search.oninput=load;load()</script>`)
  writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, ui: 'browser', command: ['node', 'server.cjs', String(port)], url: `http://127.0.0.1:${port}` }))
  writeFileSync(join(root, 'DATA_UPDATE.json'), JSON.stringify({ schema_version: 1, schema: expanded ? 'v2' : 'v1', verify: ['node', 'store.cjs', 'verify'],
    ...(expanded ? { migrations: { v1: ['node', 'store.cjs', 'migrate'] } } : {}) }))
}
it('adds search/tags to a notes GUI while retaining create/edit/save/reopen behavior and existing SQLite identities', async () => {
  const root = project.root_path, server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw Error('port'); const port = address.port; await new Promise<void>(done => server.close(() => done()))
  const ctx = { projectId: project.project_id, sessionId: 's', requestId: 'r', signal: AbortSignal.timeout(150000), state: createToolState() }
  async function qualify(steps: GuiAcceptanceSuite['steps'], refs: Record<string, string[]>) {
    const registered = await buildLeanGuiTool(project.project_id).execute({ steps, acceptance_refs: refs }, ctx)
    expect(registered.isError, registered.output).not.toBe(true)
    const release = await prepareSoftwareRelease(project.project_id, root), result = await runCoreVerification({ projectId: project.project_id, sandboxRoot: release.root, signal: ctx.signal })
    expect(result.status, JSON.stringify(result)).toBe('passed')
    await promoteSoftwareRelease(release, { scope: prdScopeFingerprint(readPrdBackplane(project.project_id)), version: release.runtime.digest, at: new Date().toISOString() })
    saveSoftwareRegressionBaseline(project.project_id, release.runtime.digest); return release
  }
  const refs = Object.fromEntries(preserved.filter(step => step.kind === 'expect').map(step => [step.id, ['F-001']]))
  sources(root, false, port); const oldScope = confirm(false), first = await qualify(preserved, refs)
  const original = await prepareDataUpdate(project.project_id, first.root, first.id, undefined, first.id)
  const operate = (release: typeof first, data: string, steps: GuiAcceptanceSuite['steps']) => observeSoftwareGui({ projectId: project.project_id, root: release.root, launch: release.launch,
    suite: parseGuiSuite({ version: 1, scope_hash: oldScope, covers: ['F-001'], steps }), temporary: dirname(data), signal: ctx.signal })
  expect((await operate(first, original.dataDir, preserved)).status).toBe('passed'); original.commit()
  const read = (release: typeof first) => executeSoftwareCommand({ projectId: project.project_id, root: release.root, command: ['node', 'store.cjs', 'verify'], dataDir: softwareDataDirectory(project.project_id) })
  const before = JSON.parse((await read(first)).stdout); expect(before.map((row: { id: number }) => row.id)).toEqual([1, 2])
  sources(root, true, port); confirm(true)
  const extra: GuiAcceptanceSuite['steps'] = [fill('search', '#search', 'Alpha'), count('filtered', '1'), fill('clear-search', '#search', ''), count('all', '2'), click('tag-edit', '#edit-1'), fill('tag', '#tags', 'study'), click('tag-save', '#save'), check('tagged', '#note-1 .tags', 'study'),
    { id: 'reopen-tag', kind: 'restart' }, check('tag-kept', '#note-1 .tags', 'study'), check('still-a', '#note-1 .content', 'Alpha edited'), check('still-b', '#note-2 .content', 'Beta')]
  const next = await qualify([...preserved, ...extra], { ...refs, filtered: ['F-002'], all: ['F-002'], tagged: ['F-003'], 'tag-kept': ['F-003'], 'still-a': ['F-001'], 'still-b': ['F-001'] })
  const update = await prepareDataUpdate(project.project_id, next.root, next.id, undefined, next.id)
  expect((await operate(next, update.dataDir, [check('original-a', '#note-1 .content', 'Alpha edited'), check('original-b', '#note-2 .content', 'Beta'), ...extra])).status).toBe('passed'); update.commit()
  const after = JSON.parse((await read(next)).stdout)
  expect(after.map(({ id, content }: { id: number; content: string }) => ({ id, content }))).toEqual(before.map(({ id, content }: { id: number; content: string }) => ({ id, content })))
  expect(after[0].tags).toBe('study')
  writeFileSync(join(root, 'store.cjs'), readFileSync(join(root, 'store.cjs'), 'utf8').replace("db.prepare('SELECT * FROM notes ORDER BY id').all()", "db.prepare('SELECT * FROM notes WHERE id=1').all()"))
  const broken = await runCoreVerification({ projectId: project.project_id, sandboxRoot: root, signal: ctx.signal })
  expect(broken.status).not.toBe('passed'); expect(broken.host_gui?.status).toBe('failed')
}, 180000)
