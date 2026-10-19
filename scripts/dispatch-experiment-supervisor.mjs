// Run as a separate hidden Windows process. The report belongs to the supervisor;
// it never invents SDK receipts or fills unknown token usage.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined } }
const lines = file => {
  const events = []; let malformed = 0
  if (fs.existsSync(file)) {
    try {
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        try { events.push(JSON.parse(line)) } catch { malformed++ }
      }
    } catch (error) { Object.defineProperty(events, 'read_error', { value: error.code ?? 'READ_FAILED' }) }
  }
  Object.defineProperty(events, 'malformed_lines', { value: malformed }); return events
}
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

export function supervisionState({ launcher_alive, driver_alive, electron_alive, terminal, heartbeat_at, now }) {
  if (!launcher_alive && !driver_alive && !electron_alive) return terminal ? 'finished' : 'process-lost'
  if (terminal) return 'stopping'
  if (heartbeat_at && now - Date.parse(heartbeat_at) > 45000) return 'heartbeat-stale'
  return heartbeat_at ? 'locally-running' : 'starting'
}

export function ledgerClosure(events) {
  const starts = events.filter(e => e.event === 'query_started')
  const ends = events.filter(e => e.event === 'query_finished')
  const orphaned = starts.filter(s => !ends.some(e => e.query_id === s.query_id))
  return { queries: starts.length, terminal_receipts: ends.length, malformed_lines: events.malformed_lines ?? 0, read_error: events.read_error ?? null,
    orphaned: orphaned.map(s => ({ query_id: s.query_id, model: s.model, usage: 'unknown', remote_outcome: 'unknown' })) }
}

function killOwned(pid, home) {
  if (!alive(pid)) return
  const script = "$p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$env:BEX_OWNED_PID);if(!$p -or !$p.CommandLine -or $p.CommandLine.Replace('/','\\').IndexOf($env:BEX_OWNED_HOME.Replace('/','\\'),[StringComparison]::OrdinalIgnoreCase) -lt 0){exit 3};exit 0"
  execFileSync('pwsh.exe', ['-NoProfile', '-Command', script], { windowsHide: true, stdio: 'ignore', env: { ...process.env, BEX_OWNED_PID: String(pid), BEX_OWNED_HOME: home } })
  execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 })
}

export async function supervise(jobPath) {
  const job = read(jobPath)
  if (!job || !['qualify', 'run'].includes(job.mode) || !job.home || !job.runtime_root || !job.output_dir || !job.report_dir) throw Error('SUPERVISOR_INVALID_JOB')
  if (path.resolve(job.home).toLowerCase() === path.join(process.env.USERPROFILE, '.proma').toLowerCase()) throw Error('SUPERVISOR_REQUIRES_ISOLATED_HOME')
  fs.mkdirSync(job.output_dir, { recursive: true })
  const receiptPath = path.join(job.output_dir, 'supervisor-receipt.json')
  fs.writeFileSync(receiptPath, JSON.stringify({ at: new Date().toISOString(), supervisor_pid: process.pid,
    parent_pid: process.ppid, mode: job.mode, home: job.home, job_sha256: hash(jobPath), script_sha256: hash(fileURLToPath(import.meta.url)) }, null, 2), { flag: 'wx' })
  if (job.mode === 'run') {
    const release = path.join(job.cohort, 'readiness-release.json')
    if (hash(release) !== job.readiness_sha256 || !read(release)?.passed) throw Error('SUPERVISOR_READINESS_CHANGED')
    if (job.predecessor_certificate) {
      const certificate = read(job.predecessor_certificate)
      if (!certificate?.local_predecessor_quiescent || certificate.run_id !== job.predecessor_run) throw Error('SUPERVISOR_PREDECESSOR_NOT_QUIESCENT')
    }
  }
  const project = read(path.join(job.home, 'projects.json')).projects[0]
  const configPath = path.join(job.home, 'dispatch-experiments', `${project.project_id}.json`)
  const initialConfig = read(configPath)
  if (initialConfig?.started_at) throw Error('SUPERVISOR_REQUIRES_FRESH_RUN')
  const eventsPath = path.join(job.home, 'dispatch-experiments/events', `${initialConfig.run_id}.jsonl`)
  const ledgerPath = path.join(job.home, 'usage-ledger', `${project.project_id}.jsonl`)
  const args = job.mode === 'qualify'
    ? ['scripts/dispatch-experiment-native.mjs', 'qualify', '--home', job.home, '--report-dir', job.report_dir,
      '--no-monetary-limit', '--glm-plan', 'coding', '--credentials', job.credentials_path,
      '--qualify-wait-ms', String(job.qualify_wait_ms ?? 15000)]
    : [job.launcher_script, job.cohort, job.group]
  const stdout = fs.openSync(path.join(job.output_dir, 'launcher.stdout.log'), 'wx')
  const stderr = fs.openSync(path.join(job.output_dir, 'launcher.stderr.log'), 'wx')
  const child = spawn(process.execPath, args, { cwd: job.runtime_root, windowsHide: true,
    env: { ...process.env, BLOMA_DELEGATION_WORKTREE: '0' }, stdio: ['ignore', stdout, stderr] })
  fs.closeSync(stdout); fs.closeSync(stderr)
  let exited = false, exitCode, exitSignal, spawnError
  child.on('error', error => { spawnError = error.message; exited = true })
  child.on('exit', (code, signal) => { exited = true; exitCode = code; exitSignal = signal })
  fs.writeFileSync(path.join(job.output_dir, 'launcher-process.json'), JSON.stringify({ at: new Date().toISOString(), pid: child.pid ?? null }, null, 2))
  const launchedAt = Date.now(), hardLimit = job.mode === 'qualify' ? 120000 : (initialConfig.limits?.wall_ms ?? 3600000) + 120000
  let stoppingAt, stopReason, forced = false, latest
  for (;;) {
    const receipt = read(path.join(job.report_dir, 'process-receipt.json'))
    const heartbeat = read(path.join(job.report_dir, 'heartbeat.json'))
    const config = read(configPath)
    const terminal = lines(eventsPath).find(e => e.event === 'run_finished')
    const owned = { launcher_alive: alive(child.pid), driver_alive: alive(receipt?.driver_pid), electron_alive: alive(receipt?.electron_pid) }
    latest = { at: new Date().toISOString(), supervisor_pid: process.pid, launcher_pid: child.pid ?? null,
      driver_pid: receipt?.driver_pid ?? null, electron_pid: receipt?.electron_pid ?? null, ...owned,
      state: supervisionState({ ...owned, terminal, heartbeat_at: heartbeat?.at, now: Date.now() }),
      heartbeat_at: heartbeat?.at ?? null, terminal: terminal ?? null,
      unclosed_query_receipts: ledgerClosure(lines(ledgerPath)).orphaned.length }
    fs.writeFileSync(path.join(job.output_dir, 'heartbeat.json'), JSON.stringify(latest, null, 2))
    if (!owned.launcher_alive && !owned.driver_alive && !owned.electron_alive && exited) break
    const runDeadline = config?.started_at ? Date.parse(config.started_at) + config.limits.wall_ms + 15000 : launchedAt + hardLimit
    if (!stoppingAt && (Date.now() >= Math.min(runDeadline, launchedAt + hardLimit)
      || fs.existsSync(path.join(job.output_dir, 'STOP')) || exited || terminal && job.mode === 'run')) {
      stoppingAt = Date.now()
      stopReason = exited ? 'launcher-exited-with-owned-children' : terminal ? 'terminal-cleanup' : fs.existsSync(path.join(job.output_dir, 'STOP')) ? 'operator-stop' : 'supervisor-deadline'
      fs.mkdirSync(job.report_dir, { recursive: true })
      fs.writeFileSync(path.join(job.report_dir, 'STOP'), `Supervisor requests owned run cleanup: ${stopReason}\n`)
    }
    if (stoppingAt && Date.now() - stoppingAt > 30000 && !forced) {
      forced = true
      if (owned.launcher_alive) {
        // This direct child is still held by its ChildProcess handle; use its tree only.
        execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 })
      } else {
        for (const pid of [receipt?.driver_pid, receipt?.electron_pid]) if (pid !== child.pid) killOwned(pid, job.home)
      }
    }
    if (stoppingAt && Date.now() - stoppingAt > 45000) throw Error('SUPERVISOR_OWNED_PROCESSES_NOT_SETTLED')
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  let terminal = lines(eventsPath).find(e => e.event === 'run_finished')
  const closure = ledgerClosure(lines(ledgerPath)), nativeReport = read(path.join(job.report_dir, 'report.json'))
  if (job.mode === 'run' && !terminal) {
    const outcome = stopReason === 'supervisor-deadline' ? 'timeout' : 'interrupted'
    execFileSync(process.execPath, ['scripts/dispatch-experiment.mjs', 'finish', '--home', job.home,
      '--project', project.project_id, '--outcome', outcome, '--reason', 'SUPERVISOR_CONFIRMED_OWNED_PROCESS_EXIT'],
    { cwd: job.runtime_root, windowsHide: true, stdio: 'ignore', timeout: 30000 })
    terminal = lines(eventsPath).find(e => e.event === 'run_finished')
  }
  const result = { at: new Date().toISOString(), mode: job.mode, local_processes_settled: true,
    exit_code: exitCode ?? null, exit_signal: exitSignal ?? null, spawn_error: spawnError ?? null,
    forced_cleanup: forced, stop_reason: stopReason ?? null, native_outcome: nativeReport?.outcome ?? null,
    terminal: terminal ?? null, ledger: closure, product_quality: null,
    qualified: job.mode === 'qualify' && nativeReport?.outcome === 'qualified' && closure.queries === 0 }
  fs.writeFileSync(path.join(job.output_dir, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' })
  fs.writeFileSync(path.join(job.output_dir, 'heartbeat.json'), JSON.stringify({ ...latest, at: result.at,
    state: job.mode === 'qualify' && result.qualified ? 'qualified' : terminal ? 'finished' : 'process-lost', terminal: terminal ?? null }, null, 2))
  if (job.mode === 'run' && job.cohort) {
    const registryPath = path.join(job.cohort, 'registry.json'), registry = read(registryPath)
    if (registry?.matrix?.some(row => path.resolve(row.home) === path.resolve(job.home))) {
      Object.assign(registry, { status: 'awaiting-review', active_group: null, last_finished_group: job.group,
        supervisor_result: path.join(job.output_dir, 'result.json') })
      fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2))
    }
  }
  console.log(JSON.stringify(result))
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  supervise(process.argv[2]).then(result => { if (result.mode === 'qualify' && !result.qualified) process.exitCode = 1 }, error => {
    console.error(error.message); process.exitCode = 1
    const job = read(process.argv[2]); if (job?.output_dir) fs.writeFileSync(path.join(job.output_dir, 'supervisor-error.json'), JSON.stringify({ at: new Date().toISOString(), error: error.message }, null, 2))
  })
}
