// One user-authorized complex generation; independent product validation follows separately.
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

if (!process.argv.includes('--authorized-credentials')) throw new Error('Use only for a user-authorized paid test')
const repo = resolve('.')
const runId = `generation-quality-complex-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`
const reportDir = join(repo, 'run-artifacts', runId)
const home = join(tmpdir(), `bloma-complex-${randomUUID().slice(0, 8)}`)
const requestPath = join(repo, 'tests/fixtures/generation-quality/complex-process-request.txt')
if (existsSync(reportDir) || existsSync(home)) throw new Error('Fresh isolated paths required')
mkdirSync(reportDir, { recursive: true })
const seeded = spawnSync(process.execPath, [join(repo, 'scripts/robustness-seed-home.mjs'), home, '--authorized-credentials'],
  { cwd: repo, windowsHide: true, encoding: 'utf8' })
if (seeded.status !== 0) throw new Error('Isolated encrypted channel setup failed; no credentials printed')
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const context = { run_id: runId, case_id: 'complex-process', mode: 'longterm', home, report_dir: reportDir,
  source_commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true }).stdout.trim(),
  request_sha256: sha(requestPath), main_bundle_sha256: sha(join(repo, 'dist-main/main/index.js')),
  encrypted_channels_sha256: sha(join(home, 'bloma-channels.json')), routing_sha256: sha(join(home, 'category-routing.json')),
  prompt_overrides: Object.fromEntries(['guide-system.md', 'prd-system.md'].map(name => [name, sha(join(home, 'prompts', name))])),
  timeout_minutes: 60, started_at: new Date().toISOString(), credentials_scope: 'user_authorized_single_complex_test',
  external_model_content_quality: 'not_yet_evaluated', hardware_microphone: 'not_run' }
writeFileSync(join(reportDir, 'request.txt'), readFileSync(requestPath))
writeFileSync(join(reportDir, 'case-context.json'), JSON.stringify(context, null, 2))
console.log(JSON.stringify({ run_id: runId, home, report_dir: reportDir, request_sha256: context.request_sha256 }))
const log = openSync(join(reportDir, 'driver.log'), 'a')
const child = spawn(process.execPath, [join(repo, 'scripts/dogfood-run.mjs'), '--request-file', join(reportDir, 'request.txt'),
  '--mode', 'longterm', '--timeout-min', '60', '--home', home, '--report-dir', reportDir, '--fixed-case'],
  { cwd: repo, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, BLOMA_DESKTOP_DISPATCH: '1' } })
child.once('error', () => { console.error('Complex test driver could not start'); process.exitCode = 2 })
child.once('exit', code => {
  writeFileSync(join(reportDir, 'driver-exit.json'), JSON.stringify({ checked_at: new Date().toISOString(), code }, null, 2))
  console.log(JSON.stringify({ run_id: runId, driver_exit: code }))
  process.exitCode = code ?? 2
})
