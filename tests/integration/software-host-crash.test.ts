import {cpSync} from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it.skipIf(process.platform !== 'win32' || !existsSync(resolve('node_modules/electron/dist/electron.exe')))('kills a real Electron host, reaps its owned service and resumes durable Pi state in a new host without replay or stale PASS', async () => {
  const root = process.cwd(), home = mkdtempSync(join(tmpdir(), 'bloma-crash-host-')), runtime = join(root, 'run-artifacts/compiled-fixtures/main/software-crash-fixture.mjs')
  mkdirSync(dirname(runtime),{recursive:true});cpSync(join(root,'main/templates'),join(dirname(runtime),'templates'),{recursive:true,filter:p=>!p.includes('__pycache__')})
  await build({ stdin: { contents: "export {main} from './tests/fixtures/software-recovery/worker'", resolveDir: root }, outfile: runtime, platform: 'node', bundle: true, format: 'esm', packages: 'external' })
  const { createServer } = await import('node:net'), portProbe = createServer(); await new Promise<void>(done => portProbe.listen(0, '127.0.0.1', done)); const address = portProbe.address(); if (!address || typeof address === 'string') throw Error('port'); const port = address.port; await new Promise<void>(done => portProbe.close(() => done()))
  let child: ChildProcess | undefined, exit: Promise<number | null> | undefined, errors = ''
  const start = (phase: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, SOFTWARE_CRASH_HOME: home, SOFTWARE_CRASH_PHASE: phase, SOFTWARE_CRASH_PORT: String(port), SOFTWARE_CRASH_RUNTIME: runtime }; delete env.ELECTRON_RUN_AS_NODE
    child = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [join(root, 'tests/fixtures/software-recovery/launch.mjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr?.on('data', bytes => { errors = (errors + String(bytes)).slice(-6000) }); exit = new Promise(done => child!.once('exit', done))
  }
  try {
    start('before')
    await expect.poll(() => existsSync(join(home, 'ready.json')), { timeout: 60000 }).toBe(true)
    const ready = JSON.parse(readFileSync(join(home, 'ready.json'), 'utf8')), identity = JSON.parse(readFileSync(join(home, 'identity.json'), 'utf8'))
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('owned-child')
    const sideEffect = readFileSync(join(identity.root, 'side-effect.txt'), 'utf8'); expect(sideEffect).toBe('once\n')
    const deadPid = child!.pid!; child!.kill('SIGKILL'); await exit
    await expect.poll(async () => { try { await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }); return false } catch { return true } }, { timeout: 15000 }).toBe(true)
    // A presentation file cannot authorize a new version after a crash.
    mkdirSync(join(identity.root, '00_VERIFY'), { recursive: true }); writeFileSync(join(identity.root, '00_VERIFY/core-verification.json'), JSON.stringify({ status: 'passed', forged_presentation: true }))
    start('after'); expect(await exit, errors).toBe(0)
    const resumed = JSON.parse(readFileSync(join(home, 'resumed.json'), 'utf8'))
    expect(resumed.pid).not.toBe(deadPid); expect(resumed.historyRestored).toBe(true); expect(resumed.project.status).toBe('completed')
    expect(resumed.budget.file).toBe(ready.budget.file); expect(resumed.budget.requests).toBeGreaterThan(ready.budget.requests)
    expect(resumed.budget.output).toBeGreaterThanOrEqual(ready.budget.output); expect(readFileSync(join(identity.root, 'side-effect.txt'), 'utf8')).toBe(sideEffect)
    expect(resumed.core).toMatchObject({ status: 'passed', host_cli: { cases: [{ passed: true }] } }); expect(resumed.core.forged_presentation).toBeUndefined()
    const releases = join(home, 'software-releases', identity.projectId), results = readdirSync(releases).flatMap(id => { const file = join(releases, id, 'app/00_VERIFY/core-verification.json'); return existsSync(file) ? [JSON.parse(readFileSync(file, 'utf8'))] : [] })
    expect(results.some(result => result.host_cli?.cases.some((c: { actual: string }) => c.actual.trim() === '999'))).toBe(true)
    writeFileSync(join(root, 'run-artifacts/software-followup-crash-result.json'), JSON.stringify({ status: 'passed', before_pid: deadPid, after_pid: resumed.pid, requests_before: ready.budget.requests, requests_after: resumed.budget.requests,
      side_effect_replayed: false, owned_port_released: true, old_presentation_rejected: true, boundary: '真实Electron宿主强杀和跨进程Pi恢复；固定SDK回放，不证明真实供应商流中断恢复或任意外部副作用恰好一次。' }, null, 2))
  } finally {
    if (child && child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await exit }
    const target = realpathSync(home); if (dirname(target) !== realpathSync(tmpdir()) || !target.includes('bloma-crash-host-')) throw Error('unsafe fixture cleanup')
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
  }
}, 150000)
