import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { executeSoftwareCommand, projectDirectory, softwareEnvironment, validateSoftwareCommand } from '../../../main/software/command-runtime'
import { startSoftwareProcess, softwareProcess, stopSoftwareSession } from '../../../main/software/process-manager'

let home: string, previous: string | undefined, project: ReturnType<typeof createProject>
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-software-exec-')); process.env.PROMA_HOME = home;
  project = createProject({ request_id: 'create', mode: 'quick' }, { workflowVersion: 'software-v1' }) })
afterEach(async () => { await stopSoftwareSession(project.project_id, 's'); if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous;
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
async function port() { const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
  if (!address || typeof address === 'string') throw Error('fixture'); await new Promise<void>(resolve => server.close(() => resolve())); return address.port }
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
  await expect(startSoftwareProcess({ root: project.root_path, projectId: project.project_id, sessionId: 's', command: ['node', 'server.cjs', String(p)], url })).rejects.toThrow('PORT_ALREADY_IN_USE')
  abort.abort(); await stopSoftwareSession(project.project_id, 's')
  expect(softwareProcess(project.project_id, service.id).state).toBe('stopped')
  await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
})
