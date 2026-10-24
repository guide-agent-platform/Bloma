import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { activeSoftwareRelease, prepareSoftwareRelease, promoteSoftwareRelease, validateSoftwareRelease, runtimeInventory } from '../../../main/software/release-store'
import { launchSoftwareForUser } from '../../../main/software/user-launch'
import { listSoftwareDataSnapshots, softwareDataDirectory } from '../../../main/software/data-update'
import { stopSoftwareSession } from '../../../main/software/process-manager'
import { executeSoftwareCommand } from '../../../main/software/command-runtime'

let home: string, previous: string | undefined, project: ReturnType<typeof createProject>
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-release-')); process.env.PROMA_HOME = home;
  project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }) })
afterEach(async () => { await stopSoftwareSession(project.project_id, 'user-launch'); if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous;
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }, 30000)
async function promote() { const release = await prepareSoftwareRelease(project.project_id, project.root_path); await promoteSoftwareRelease(release, { version: 'actual-test-evidence', scope: 'test-scope', at: new Date().toISOString() }); return release }
async function port() { const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const a = server.address(); if (!a || typeof a === 'string') throw Error('port'); await new Promise<void>(done => server.close(() => done())); return a.port }

it('serves a stable release while working assets change, reuses dependency bytes, and invalidates changed binary/cache evidence', async () => {
  const root = project.root_path, url = `http://127.0.0.1:${await port()}`
  mkdirSync(join(root, 'node_modules/data'), { recursive: true }); writeFileSync(join(root, 'node_modules/data/asset.json'), '{"value":1}')
  writeFileSync(join(root, 'app.cjs'), `require('http').createServer((q,s)=>s.end(require('fs').readFileSync('index.html'))).listen(${new URL(url).port},'127.0.0.1')`)
  writeFileSync(join(root, 'index.html'), 'usable-v1')
  const launch = { schema_version: 2 as const, ui: 'browser' as const, command: ['node', 'app.cjs'], url }
  writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify(launch))
  const first = await promote()
  expect((await launchSoftwareForUser(project.project_id, root, launch, async () => {})).started).toBe(true)
  writeFileSync(join(root, 'index.html'), 'half-edited-working-assets')
  expect(await (await fetch(url)).text()).toBe('usable-v1')
  // Even direct launch requests keep the last qualified release until promotion.
  expect((await launchSoftwareForUser(project.project_id, root, launch, async () => {})).started).toBe(true)
  writeFileSync(join(root, 'index.html'), 'usable-v2')
  const second = await promote()
  expect(second.dependencies).toEqual(first.dependencies)
  expect(readdirSync(join(home, 'software-dependency-snapshots')).filter(name => !name.endsWith('.json'))).toHaveLength(1)
  expect(await launchSoftwareForUser(project.project_id, root, launch, async () => {})).toMatchObject({ needs_restart: true })
  expect((await launchSoftwareForUser(project.project_id, root, launch, async () => {}, true)).started).toBe(true)
  expect(await (await fetch(url)).text()).toBe('usable-v2')
  writeFileSync(join(second.dependencies.node_modules, 'data/asset.json'), '{"value":999}')
  await expect(activeSoftwareRelease(project.project_id)).rejects.toThrow('RELEASE_BYTES_CHANGED')
  expect((await launchSoftwareForUser(project.project_id, root, launch, async () => {})).started).toBe(false)
  // Streaming hashes cover large executable artifacts outside the old 32MiB source budget.
  const binaryRoot = join(home, 'large-runtime'); mkdirSync(binaryRoot); const file = join(binaryRoot, 'product.exe')
  writeFileSync(file, Buffer.alloc(33 * 1024 * 1024, 7)); const before = await runtimeInventory(binaryRoot)
  writeFileSync(file, Buffer.alloc(33 * 1024 * 1024, 8)); expect((await runtimeInventory(binaryRoot)).digest).not.toBe(before.digest)
}, 90000)

const notes = `const fs=require('fs'),path=require('path'),{DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(path.join(process.env.APP_DATA_DIR,'notes.sqlite')),action=process.argv[2]||'list';
db.exec('CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY,content TEXT NOT NULL)');
if(action==='seed'){for(let id=0;id<100;id++)db.prepare('INSERT OR IGNORE INTO notes(id,content) VALUES (?,?)').run(id,'note-'+id)}
if(action==='fail'){db.exec("UPDATE notes SET content='damaged-on-copy'");db.close();process.exit(1)}
if(action==='migrate')db.exec('ALTER TABLE notes ADD COLUMN tags TEXT DEFAULT ""');
if(action==='edit')db.exec("UPDATE notes SET content='edited-latest' WHERE id=42");
if(action==='tag')db.exec("UPDATE notes SET tags='study' WHERE id=42");
const rows=db.prepare('SELECT id,content FROM notes ORDER BY id').all();
if(action==='verify' && (rows.length!==100||rows.some((r,i)=>r.id!==i||r.content!=='note-'+i)))process.exitCode=2;
console.log(JSON.stringify(action==='search'?db.prepare("SELECT id,content,tags FROM notes WHERE content LIKE '%42%'").all():rows));db.close();`
it('preserves 100 actual SQLite records through a failed migration, schema update, search/tags and real backup restore', async () => {
  const root = project.root_path, launch = { schema_version: 2 as const, mode: 'command' as const, command: ['node', 'notes.cjs', 'seed'] }
  writeFileSync(join(root, 'notes.cjs'), notes); writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify(launch))
  const policy = (schema: string, migration?: string) => writeFileSync(join(root, 'DATA_UPDATE.json'), JSON.stringify({ schema_version: 1, schema,
    verify: ['node', 'notes.cjs', schema === 'v1' ? 'list' : 'verify'], ...(migration ? { migrations: { v1: ['node', 'notes.cjs', migration] } } : {}) }))
  policy('v1'); const original = await promote()
  const opened = await launchSoftwareForUser(project.project_id, root, launch, async () => {})
  expect(opened.started, opened.detail).toBe(true)
  const initialRead = await executeSoftwareCommand({ projectId: project.project_id, root, command: ['node', 'notes.cjs', 'list'], dataDir: softwareDataDirectory(project.project_id) })
  expect(JSON.parse(initialRead.stdout)).toHaveLength(100)
  const initialData = softwareDataDirectory(project.project_id), before = await runtimeInventory(initialData, undefined, {}, false)
  policy('v2', 'fail'); await promote()
  const failed = await launchSoftwareForUser(project.project_id, root, launch, async () => {})
  expect(failed).toMatchObject({ started: false }); expect(failed.detail).toContain('DATA_MIGRATION_FAILED')
  expect(softwareDataDirectory(project.project_id)).toBe(initialData)
  expect((await runtimeInventory(initialData, undefined, {}, false)).digest).toBe(before.digest)
  const fallback = await launchSoftwareForUser(project.project_id, root, launch, async () => {}, true, undefined, true)
  expect(fallback.started, fallback.detail).toBe(true)
  expect(softwareDataDirectory(project.project_id)).toBe(initialData)
  expect(readFileSync(join(original.root, 'DATA_UPDATE.json'), 'utf8')).toContain('v1')
  policy('v2', 'migrate'); const updated = await promote()
  const result = await launchSoftwareForUser(project.project_id, root, launch, async () => {})
  expect(result.started, result.detail).toBe(true); const data = softwareDataDirectory(project.project_id)
  expect(data).not.toBe(initialData)
  const run = (action: string) => executeSoftwareCommand({ projectId: project.project_id, root: updated.root, command: ['node', 'notes.cjs', action], dataDir: data })
  expect((await run('verify')).code).toBe(0); expect((await run('tag')).code).toBe(0)
  expect(JSON.parse((await run('search')).stdout)).toEqual([{ id: 42, content: 'note-42', tags: 'study' }])
  await run('edit')
  const old = listSoftwareDataSnapshots(project.project_id).find(snapshot => snapshot.schema === 'v1')!
  expect(old).toBeDefined()
  const restored = await launchSoftwareForUser(project.project_id, root, launch, async () => {}, true, old.id)
  expect(restored.started, restored.detail).toBe(true)
  const readback = await executeSoftwareCommand({ projectId: project.project_id, root: updated.root, command: ['node', 'notes.cjs', 'verify'], dataDir: softwareDataDirectory(project.project_id) })
  expect(readback.code, readback.stderr).toBe(0); expect(JSON.parse(readback.stdout)).toHaveLength(100)
  const latest = listSoftwareDataSnapshots(project.project_id).find(snapshot => snapshot.schema === 'v2')!
  const backup = join(home, 'software-app-data', project.project_id, 'backups', latest.id, 'data')
  expect(existsSync(join(backup, 'notes.sqlite'))).toBe(true)
  const savedLatest = await executeSoftwareCommand({ projectId: project.project_id, root: updated.root, command: ['node', 'notes.cjs', 'list'], dataDir: backup })
  expect(JSON.parse(savedLatest.stdout)[42].content).toBe('edited-latest')
  writeFileSync(join(backup, 'notes.sqlite'), 'corrupt backup')
  expect((await launchSoftwareForUser(project.project_id, root, launch, async () => {}, true, latest.id)).detail).toContain('DATA_RESTORE_SNAPSHOT_CHANGED')
  await validateSoftwareRelease(project.project_id, updated)
}, 90000)
