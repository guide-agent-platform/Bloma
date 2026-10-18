// Prepare identical platform assets and dependencies without implementing business logic.
// Bundle beside dist-main/main/index.js so mainRootDir resolves the same templates.
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
const args = process.argv.slice(2)
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1] }
if (!option('home') || !option('report') || !option('python')) throw new Error('Explicit --home --report --python required')
process.env.PROMA_HOME = resolve(option('home')!)
const reportPath = resolve(option('report')!), python = resolve(option('python')!)
if (existsSync(reportPath)) throw new Error('PRESERVE_EXISTING_ENVIRONMENT_REPORT')
const index = JSON.parse(readFileSync(join(process.env.PROMA_HOME, 'projects.json'), 'utf8'))
if (index.projects.length !== 1) throw new Error('ENVIRONMENT_REQUIRES_ONE_PROJECT')
const project = index.projects[0], root = project.root_path
const { provisionDesktopSkeletonV2 } = await import('../main/desktop/skeleton-provision')
const { buildInstallPackagesTool } = await import('../main/desktop/install-packages-tool')
const { execFileDriverSpawn } = await import('../main/desktop/process-driver')
const { createToolState } = await import('../main/agent/loop/agent-loop')
const provision = provisionDesktopSkeletonV2(root, project.name, { includeScaffold: false })
if (provision.failed.length || provision.missing.length) throw new Error('PLATFORM_ASSETS_INCOMPLETE')
const expected = option('pins') ? JSON.parse(readFileSync(resolve(option('pins')!), 'utf8')) : undefined
const specs: string[] = expected ? expected.packages.map((p: { name: string; version: string }) => `${p.name}==${p.version}`) : ['pywebview', 'Pillow']
const calls: Array<{ executable: string; args: string[]; code: number }> = []
const install = buildInstallPackagesTool(project.project_id, { spawn: async request => {
  const command = [...request.command]
  if (command[0] === 'python') command[0] = python
  if (option('wheelhouse') && command[1] === '-m' && command[2] === 'pip' && command[3] === 'install') {
    command.splice(4, 0, '--no-index', '--find-links', resolve(option('wheelhouse')!))
  }
  const result = await execFileDriverSpawn({ ...request, command })
  calls.push({ executable: command[0], args: command.slice(1), code: result.code })
  return result
} })
const result = await install.execute({ packages: specs }, { projectId: project.project_id, sessionId: 'host-environment-preparation',
  requestId: randomUUID(), signal: AbortSignal.timeout(600000), state: createToolState(0) })
const venv = join(root, '.venv', 'Scripts', 'python.exe')
const runPython = (args: string[]) => execFileSync(venv, args, { cwd: root, encoding: 'utf8', windowsHide: true,
  timeout: 120000, env: { ...process.env, PYTHONUTF8: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
let packages: Array<{ name: string; version: string }> = [], interpreter, imports
if (!result.isError) {
  packages = JSON.parse(runPython(['-m', 'pip', 'list', '--format=json', '--disable-pip-version-check']))
    .map((p: { name: string; version: string }) => ({ name: p.name.toLowerCase().replace(/[-_.]+/g, '-'), version: p.version }))
    .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))
  interpreter = JSON.parse(runPython(['-c', 'import sys,platform,json;print(json.dumps(dict(version=sys.version,machine=platform.machine(),base_executable=sys._base_executable)))']))
  imports = runPython(['-c', 'import webview,PIL;print("webview/PIL imports OK")'])
}
const fingerprint = sha(JSON.stringify(packages))
let guiSmoke: { passed: boolean; pid?: number; evidence?: unknown; error?: string; output?: string } | undefined
if (args.includes('--smoke') && !result.isError) {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(done => server.close(() => done()))
  const child = spawn(venv, ['app.py', '--drive-port', String(port)], { cwd: root, windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', APP_DATA_DIR: join(dirname(reportPath), 'environment-smoke-data') }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', spawnError = ''
  child.on('error', error => { spawnError = error.message })
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', bytes => { output = (output + bytes).slice(-4000) })
  guiSmoke = { passed: false, pid: child.pid }
  try {
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null) throw new Error(spawnError || `Application exited ${child.exitCode}`)
      try {
        const response = await fetch(`http://127.0.0.1:${port}/eval`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ js: '({state:document.readyState,title:document.title,agent:navigator.userAgent})' }), signal: AbortSignal.timeout(2500) })
        const data = await response.json() as { ok?: boolean; result?: { state?: string } }
        if (data.ok && data.result?.state === 'complete') { guiSmoke.passed = true; guiSmoke.evidence = data.result; break }
      } catch { /* Own app may still be starting WebView2. */ }
      await new Promise(done => setTimeout(done, 500))
    }
    if (!guiSmoke.passed) guiSmoke.error = 'WEBVIEW_STARTUP_TIMEOUT'
  } catch (error) { guiSmoke.error = (error as Error).message }
  finally {
    if (child.pid && child.exitCode === null) {
      if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      else child.kill('SIGKILL')
    }
    guiSmoke.output = output
  }
}
const report = { at: new Date().toISOString(), home: process.env.PROMA_HOME, project_id: project.project_id,
  phase: 'host_platform_environment_preparation', product_quality: null, provision, calls, outcome: result.isError || guiSmoke?.passed === false ? 'failed' : 'ready', gui_smoke: guiSmoke,
  install_output: result.output, interpreter, interpreter_sha256: sha(readFileSync(python)), imports,
  packages, packages_sha256: fingerprint, pip_freeze: result.isError ? undefined : runPython(['-m', 'pip', 'freeze', '--all']),
  inherited_version_match: expected ? expected.packages_sha256 === fingerprint && expected.interpreter_sha256 === sha(readFileSync(python)) : null }
mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ report: reportPath, outcome: report.outcome, packages_sha256: fingerprint, inherited_version_match: report.inherited_version_match }))
if (report.outcome === 'failed' || report.inherited_version_match === false) process.exitCode = 1
