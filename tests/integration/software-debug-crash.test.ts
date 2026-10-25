import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it.skipIf(process.platform !== 'win32' || !existsSync(resolve('node_modules/electron/dist/electron.exe')))('recovers actual debug data and browser storage after killing the Electron host, without taking over its process', async () => {
  const root = process.cwd(), home = mkdtempSync(join(tmpdir(), 'bloma-debug-crash-')), runtime = join(root, 'dist-main/main/software-debug-crash-fixture.mjs')
  await build({ stdin: { contents: "export {main} from './tests/fixtures/software-recovery/debug-worker'", resolveDir: root }, outfile: runtime, platform: 'node', bundle: true, format: 'esm', packages: 'external' })
  const probe = createServer(); await new Promise<void>(done => probe.listen(0, '127.0.0.1', done)); const address = probe.address(); if (!address || typeof address === 'string') throw Error('port')
  const port = address.port; await new Promise<void>(done => probe.close(() => done()))
  let child: ChildProcess | undefined, exit: Promise<number | null> | undefined, errors = ''
  const start = (phase: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, SOFTWARE_CRASH_HOME: home, SOFTWARE_CRASH_PHASE: phase, SOFTWARE_CRASH_PORT: String(port), SOFTWARE_CRASH_RUNTIME: runtime }; delete env.ELECTRON_RUN_AS_NODE
    child = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [join(root, 'tests/fixtures/software-recovery/launch.mjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr?.on('data', bytes => { errors = (errors + String(bytes)).slice(-6000) }); exit = new Promise(done => child!.once('exit', done))
  }
  try {
    start('before'); await expect.poll(() => existsSync(join(home, 'ready.json')), { timeout: 60000 }).toBe(true)
    const old = JSON.parse(readFileSync(join(home, 'ready.json'), 'utf8')), pid = child!.pid!
    expect(readFileSync(join(old.data_dir, 'count'), 'utf8')).toBe('1')
    expect(child!.exitCode, errors).toBeNull()
    expect(child!.kill('SIGKILL')).toBe(true); await exit
    await expect.poll(async () => { try { await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }); return false } catch { return true } }, { timeout: 15000 }).toBe(true)
    start('after'); expect(await exit, errors).toBe(0)
    const resumed = JSON.parse(readFileSync(join(home, 'resumed.json'), 'utf8'))
    expect(resumed.status).toBe('passed'); expect(resumed.pid).not.toBe(pid); expect(resumed.new_id).not.toBe(resumed.old_id)
    expect(readFileSync(join(old.data_dir, 'count'), 'utf8')).toBe('1')
    writeFileSync(join(root, 'run-artifacts/software-debug-crash-result.json'), JSON.stringify({ ...resumed, before_pid: pid, owned_port_released: true,
      boundary: '真实宿主强杀、后端数据和浏览器localStorage跨进程恢复；无供应商请求，不是用户成品验收或OS沙箱证明。' }, null, 2))
  } finally {
    if (child && child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await exit }
    const target = realpathSync(home); if (dirname(target) !== realpathSync(tmpdir()) || !target.includes('bloma-debug-crash-')) throw Error('unsafe fixture cleanup')
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
  }
}, 150000)
