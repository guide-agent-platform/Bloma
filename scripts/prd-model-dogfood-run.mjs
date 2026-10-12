// Isolated live PRD probe. Stops before user confirmation/UX/implementation; never resumes an old product.
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (!process.argv.includes('--authorized-credentials')) throw new Error('Use only for an authorized model/dogfood test')
const repo = resolve('.'), runId = `prd-model-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`
const reportDir = join(repo, 'run-artifacts', runId), home = join(tmpdir(), `bloma-prd-${randomUUID().slice(0, 8)}`)
if (existsSync(reportDir) || existsSync(home)) throw new Error('Fresh isolated paths required')
mkdirSync(reportDir, { recursive: true })
const seeded = spawnSync(process.execPath, [join(repo, 'scripts/robustness-seed-home.mjs'), home, '--authorized-credentials'], { cwd: repo, windowsHide: true, encoding: 'utf8' })
if (seeded.status !== 0) throw new Error('Encrypted channel setup failed; no credentials printed')
const request = join(repo, 'tests/fixtures/generation-quality/complex-process-request.txt')
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')
writeFileSync(join(reportDir, 'request.txt'), readFileSync(request))
writeFileSync(join(reportDir, 'case-context.json'), JSON.stringify({ run_id: runId, home, report_dir: reportDir, started_at: new Date().toISOString(),
  source_commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true, encoding: 'utf8' }).stdout.trim(),
  request_sha256: sha(request), main_bundle_sha256: sha(join(repo, 'dist-main/main/index.js')), stop_before_confirmation: true,
  mode: 'longterm', timeout_minutes: 15, scope: 'PRD model production and review, no implementation or delivered quality claim' }, null, 2))
console.log(JSON.stringify({ run_id: runId, home, report_dir: reportDir }))
const log = openSync(join(reportDir, 'driver.log'), 'a')
const child = spawn(process.execPath, [join(repo, 'scripts/dogfood-run.mjs'), '--request-file', join(reportDir, 'request.txt'), '--mode', 'longterm',
  '--timeout-min', '15', '--home', home, '--report-dir', reportDir, '--fixed-case', '--stop-after-prd'],
{ cwd: repo, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, BLOMA_DESKTOP_DISPATCH: '1' } })
child.once('error', () => { console.error('PRD probe driver could not start'); process.exitCode = 2 })
child.once('exit', code => {
  writeFileSync(join(reportDir, 'driver-exit.json'), JSON.stringify({ finished_at: new Date().toISOString(), code }, null, 2))
  console.log(JSON.stringify({ run_id: runId, driver_exit: code }))
  process.exitCode = code ?? 2
})
