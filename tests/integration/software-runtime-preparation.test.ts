import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProject } from '../../main/project/project-service'
import { prepareSoftwareRuntime } from '../../main/software/runtime-manager'
import { executeSoftwareCommand } from '../../main/software/command-runtime'
import { managedRuntime } from '../../main/software/runtime-bindings'

const enabled = process.env.SOFTWARE_RUNTIME_DOWNLOAD_TEST === '1' && process.platform === 'win32' && process.arch === 'x64'
let home: string, oldHome: string | undefined, oldPath: string | undefined, project: ReturnType<typeof createProject>
beforeEach(() => { oldHome = process.env.PROMA_HOME; oldPath = process.env.PATH; home = mkdtempSync(join(tmpdir(), 'bloma-managed-')); process.env.PROMA_HOME = home
  project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }); process.env.PATH = join(process.env.SystemRoot ?? 'C:/Windows', 'System32') })
afterEach(() => { if (oldHome === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = oldHome; process.env.PATH = oldPath
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }) }, 30000)
it.skipIf(!enabled)('prepares genuine Node/Python with development PATH removed, reuses bindings and executes package/venv/native standard-library paths', async () => {
  const root = project.root_path, signal = AbortSignal.timeout(480000)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'managed-runtime-test', engines: { node: '>=22 <23' }, scripts: { build: 'node -e "console.log(process.execPath)"' } }))
  writeFileSync(join(root, '.python-version'), '3.13')
  const node = await prepareSoftwareRuntime(project.project_id, root, 'node', undefined, signal)
  expect(node.executable).toContain(home); expect(node.version).toMatch(/^22\./); expect(node.archive_sha256).toMatch(/^[a-f0-9]{64}$/)
  const built = await executeSoftwareCommand({ projectId: project.project_id, root, command: ['npm', 'run', 'build'], signal })
  expect(built.code, built.stderr).toBe(0); expect(built.stdout).toContain(node.executable)
  expect((await prepareSoftwareRuntime(project.project_id, root, 'node', undefined, signal)).reused).toBe(true)
  const python = await prepareSoftwareRuntime(project.project_id, root, 'python', undefined, signal)
  expect(python.version).toMatch(/^3\.13\./); expect(python.executable).toContain(home)
  const native = await executeSoftwareCommand({ projectId: project.project_id, root, command: ['python', '-I', '-c', 'import sys,sqlite3,ctypes,ssl;print(sys.executable);print(sqlite3.connect(":memory:").execute("select 42").fetchone()[0])'], signal })
  expect(native.code, native.stderr).toBe(0); expect(native.stdout).toContain(python.executable); expect(native.stdout).toContain('42')
  const venv = await executeSoftwareCommand({ projectId: project.project_id, root, command: ['python', '-m', 'venv', '.venv'], timeoutMs: 120000, signal })
  expect(venv.code, venv.stderr).toBe(0); expect(existsSync(join(root, '.venv/Scripts/python.exe'))).toBe(true)
  const envProbe = await executeSoftwareCommand({ projectId: project.project_id, root, command: ['python', '-c', 'import sys;print(sys.prefix)'], signal })
  expect(envProbe.code, envProbe.stderr).toBe(0); expect(envProbe.stdout).toContain('.venv')
  expect((await prepareSoftwareRuntime(project.project_id, root, 'python', undefined, signal)).reused).toBe(true)
  // Executable tampering is an explicit error, not a switch back to system PATH.
  const original = readFileSync(node.executable); writeFileSync(node.executable, 'broken executable')
  expect(() => managedRuntime(project.project_id, 'node')).toThrow('MANAGED_RUNTIME_CHANGED')
  writeFileSync(node.executable, original)
}, 540000)
