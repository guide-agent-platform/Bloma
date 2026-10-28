import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, realpathSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { mainRootDir } from '../../../main/platform/paths'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { executeSoftwareCommand, projectDirectory, resolveSoftwareCommand, softwareEnvironment, validateSoftwareCommand } from '../../../main/software/command-runtime'
import { startSoftwareProcess, softwareProcess, stopSoftwareSession } from '../../../main/software/process-manager'
import { buildSoftwareExecutionTools } from '../../../main/software/execution-tools'
import { createToolState } from '../../../main/agent/loop/agent-loop'

let home: string, previous: string | undefined, project: ReturnType<typeof createProject>
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-software-exec-')); process.env.PROMA_HOME = home;
  project = createProject({ request_id: 'create', mode: 'quick' }, { workflowVersion: 'software-v1' }) })
afterEach(async () => { await stopSoftwareSession(project.project_id, 's'); if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous;
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
async function port() { const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
  if (!address || typeof address === 'string') throw Error('fixture'); await new Promise<void>(resolve => server.close(() => resolve())); return address.port }
it('shares only verified Electron download cache while retaining per-project npm/data directories', () => {
  const a = softwareEnvironment(project.project_id), b = softwareEnvironment('another-project')
  expect(a.electron_config_cache).toBe(b.electron_config_cache)
  expect(a.electron_config_cache).toBe(join(home, 'software-runtimes', 'electron-cache'))
  expect(a.npm_config_cache).not.toBe(b.npm_config_cache); expect(a.APP_DATA_DIR).not.toBe(b.APP_DATA_DIR)
})
it('preserves timeout logs, redacts secrets and identifies a partial Electron download through the actual command tool', async () => {
  writeFileSync(join(project.root_path, 'package.json'), '{"devDependencies":{"electron":"32.3.3"}}')
  const dir = join(project.root_path, 'node_modules/electron'); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"electron","version":"32.3.3"}')
  writeFileSync(join(dir, 'install.js'), 'console.log("download started");console.error("ETIMEDOUT Authorization: Bearer PRIVATE_DOWNLOAD_TOKEN");setInterval(()=>{},1000)')
  const run = buildSoftwareExecutionTools(project.project_id).find(tool => tool.name === 'run_command')!
  const result = await run.execute({ command: ['node', 'node_modules/electron/install.js'], timeout_ms: 1500 }, {
    projectId: project.project_id, sessionId: 's', requestId: 'r', signal: new AbortController().signal, state: createToolState() })
  expect(result.isError).toBe(true); expect(result.output).not.toContain('PRIVATE_DOWNLOAD_TOKEN')
  expect(JSON.parse(result.output)).toMatchObject({ code: 'DEPENDENCY_DOWNLOAD_ERROR', stdout: expect.stringContaining('download started'),
    dependencies: { electron: { state: 'binary_missing' } }, input_version: expect.any(String) })
}, 15000)
it('installs a local package offline using the normal npm tool and reports metadata without claiming verification', async () => {
  const local = join(project.root_path, 'fixture-dependency'); mkdirSync(local)
  writeFileSync(join(local, 'package.json'), '{"name":"audit-local-package","version":"1.0.0"}')
  writeFileSync(join(project.root_path, 'package.json'), '{"name":"offline-install-check","dependencies":{"audit-local-package":"file:./fixture-dependency"}}')
  const run = buildSoftwareExecutionTools(project.project_id).find(tool => tool.name === 'run_command')!
  const result = await run.execute({ command: ['npm', 'install', '--offline', '--ignore-scripts'], timeout_ms: 30000 }, {
    projectId: project.project_id, sessionId: 's', requestId: 'r', signal: new AbortController().signal, state: createToolState() })
  expect(result.isError, result.output).toBe(false)
  expect(JSON.parse(result.output)).toMatchObject({ exit_code: 0, dependencies: { state: 'metadata_present_unverified', missing_count: 0 } })
}, 40000)
it('resolves bare Electron to a real executable, prefers the project runtime and removes Node mode',()=>{
  const environment={...softwareEnvironment(project.project_id),ELECTRON_RUN_AS_NODE:'1'}
  const bundled=resolveSoftwareCommand(project.root_path,['electron','main.cjs'],environment)
  expect(isAbsolute(bundled.command[0])).toBe(true);expect(existsSync(bundled.command[0])).toBe(true)
  expect(bundled.env.ELECTRON_RUN_AS_NODE).toBeUndefined();expect(bundled.command[1]).toBe('main.cjs')
  const name=process.platform==='win32'?'electron.exe':process.platform==='darwin'?'Electron.app/Contents/MacOS/Electron':'electron'
  const local=join(project.root_path,'node_modules/electron/dist',name);mkdirSync(join(local,'..'),{recursive:true});writeFileSync(local,'fixture executable')
  expect(resolveSoftwareCommand(project.root_path,['electron','main.cjs'],environment).command[0]).toBe(realpathSync(local))
  const alias = resolveSoftwareCommand(project.root_path, ['npx', 'electron', 'main.cjs'], environment)
  expect(alias.command).toEqual([realpathSync(local), 'main.cjs']); expect(alias.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
})
it('runs Node with literal arguments and real exit/output, without Python wrappers', async () => {
  const result = await executeSoftwareCommand({ projectId: project.project_id, root: project.root_path, command: ['node', '-e', 'require("fs").writeFileSync("actual file.txt",process.argv[1]);console.log("实际输出");process.exit(7)', 'literal & $(no command)'] })
  expect(result.code).toBe(7); expect(result.stdout).toContain('实际输出')
  expect(readFileSync(join(project.root_path, 'actual file.txt'), 'utf8')).toBe('literal & $(no command)')
})
it('really runs a local npm build and keeps the generated assets', async () => {
  writeFileSync(join(project.root_path, 'package.json'), JSON.stringify({ name: 'local-build-check', scripts: { build: 'node build.cjs' } }))
  writeFileSync(join(project.root_path, 'build.cjs'), 'const fs=require("fs");fs.mkdirSync("dist",{recursive:true});fs.writeFileSync("dist/index.html","<html>actual npm build</html>");console.log("built")')
  const result = await executeSoftwareCommand({ projectId: project.project_id, root: project.root_path, command: ['npm', 'run', 'build'], timeoutMs: 30000 })
  expect(result.code, result.stderr).toBe(0); expect(existsSync(join(project.root_path, 'dist/index.html'))).toBe(true)
})
it('rejects outside working directories, shell injection in the executable and system/publish actions; ordinary format scripts remain allowed', () => {
  expect(() => projectDirectory(project.root_path, '..')).toThrow('OUTSIDE_PROJECT')
  expect(() => validateSoftwareCommand(['node & echo bad'])).toThrow()
  expect(() => validateSoftwareCommand(['npm', 'publish'])).toThrow('SEPARATE_AUTHORIZATION')
  expect(() => validateSoftwareCommand(['npm', 'install', '--global', 'something'])).toThrow('SEPARATE_AUTHORIZATION')
  expect(validateSoftwareCommand(['npm', 'run', 'format'])).toEqual(['npm', 'run', 'format'])
  expect(softwareEnvironment(project.project_id)).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
  expect(softwareEnvironment(project.project_id)).not.toHaveProperty('OPENAI_API_KEY')
})
it('tracks an actual HTTP service, rejects another owner/occupied port, and cancels its process tree', async () => {
  const p = await port(), url = `http://127.0.0.1:${p}`, abort = new AbortController()
  writeFileSync(join(project.root_path, 'server.cjs'), 'require("http").createServer((q,s)=>s.end("real service")).listen(Number(process.argv[2]),"127.0.0.1")')
  const service = await startSoftwareProcess({ root: project.root_path, projectId: project.project_id, sessionId: 's', command: ['node', 'server.cjs', String(p)], url, signal: abort.signal })
  expect(service).toMatchObject({ state: 'running', ready: true })
  expect(await (await fetch(url)).text()).toBe('real service')
  expect(() => softwareProcess('another-project', service.id)).toThrow('OWNER_MISMATCH')
  expect((await startSoftwareProcess({ root: project.root_path, projectId: project.project_id, sessionId: 's', command: ['node', 'server.cjs', String(p)], url })).id).toBe(service.id)
  await expect(startSoftwareProcess({ root: project.root_path, projectId: project.project_id, sessionId: 'foreign', command: ['node', 'server.cjs', String(p)], url })).rejects.toThrow('PORT_ALREADY_IN_USE')
  writeFileSync(join(project.root_path, 'server.cjs'), 'require("http").createServer((q,s)=>s.end("changed")).listen(Number(process.argv[2]),"127.0.0.1")')
  await expect(startSoftwareProcess({ root: project.root_path, projectId: project.project_id, sessionId: 's', command: ['node', 'server.cjs', String(p)], url })).rejects.toThrow('PROCESS_SOURCE_CHANGED')
  abort.abort(); await stopSoftwareSession(project.project_id, 's')
  expect(softwareProcess(project.project_id, service.id).state).toBe('stopped')
  await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
})
it('supervisor loses its host pipe and reaps the actual server grandchild', async () => {
  const p = await port(), url = `http://127.0.0.1:${p}`
  writeFileSync(join(project.root_path, 'grandchild.cjs'), `require('http').createServer((q,s)=>s.end('grandchild')).listen(${p},'127.0.0.1')`)
  writeFileSync(join(project.root_path, 'parent.cjs'), 'require("child_process").spawn(process.execPath,["grandchild.cjs"],{stdio:"inherit"});setInterval(()=>{},1000)')
  const supervisor = spawn(process.execPath, [join(mainRootDir(), 'templates/tools/software_process_supervisor.cjs')], { cwd: project.root_path, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
  supervisor.stdin.write(JSON.stringify({ command: [process.execPath, 'parent.cjs'], cwd: project.root_path, env: softwareEnvironment(project.project_id) }) + '\n')
  const closed = new Promise<void>(resolve => supervisor.once('exit', () => resolve()))
  try {
    await expect.poll(async () => { try { return await (await fetch(url)).text() } catch { return '' } }, { timeout: 10000 }).toBe('grandchild')
    supervisor.stdin.end() // Exactly the EOF received when the parent host exits/crashes.
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(Error('supervisor did not exit')), 10000).unref())])
    await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
  } finally { supervisor.stdin.end() }
}, 30000)
