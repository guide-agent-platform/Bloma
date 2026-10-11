// Launch one frozen, isolated case. Credential copying requires the user's explicit scope.
import { spawnSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'

const [id, mode, authorization] = process.argv.slice(2)
const repo = resolve('.')
const matrix = JSON.parse(readFileSync(join(repo, 'tests/fixtures/robustness/cases.json'), 'utf8'))
const scenario = matrix.cases.find(c => c.id === id)
if (!scenario || !matrix.modes.includes(mode) || authorization !== '--authorized-credentials') {
  throw new Error('Usage: robustness-run-case.mjs voice|ledger|files quick|longterm --authorized-credentials')
}
const reportDir = join(repo, 'run-artifacts', `robustness-${id}-${mode}-fixed`)
if (existsSync(reportDir)) throw new Error('Case directory already exists; preserve the previous attempt')
mkdirSync(reportDir, { recursive: true })
const home = join(tmpdir(), `blr-${randomUUID().slice(0, 8)}`)
const seeded = spawnSync(process.execPath, [join(repo, 'scripts/robustness-seed-home.mjs'), home, authorization], { cwd: repo, windowsHide: true, encoding: 'utf8' })
if (seeded.status !== 0) throw new Error('Isolated seed failed; inspect setup without printing credentials')
writeFileSync(join(reportDir, 'request.txt'), scenario.request)
const fingerprint = file => createHash('sha256').update(readFileSync(file)).digest('hex')
writeFileSync(join(reportDir, 'case-context.json'), JSON.stringify({ case_id: id, mode, home,
  timeout_minutes: matrix.timeout_minutes[mode], max_targeted_repairs: matrix.max_targeted_repairs,
  fixture_sha256: fingerprint(join(repo, 'tests/fixtures/robustness/cases.json')),
  encrypted_channels_sha256: fingerprint(join(home, 'bloma-channels.json')),
  routing_sha256: fingerprint(join(home, 'category-routing.json')),
  guide_override_sha256: fingerprint(join(home, 'prompts/guide-system.md')),
  prd_override_sha256: fingerprint(join(home, 'prompts/prd-system.md')),
  main_bundle_sha256: fingerprint(join(repo, 'dist-main/main/index.js')),
  capture_mode: id === 'voice' ? 'fixed_audio_callback_real_model_no_physical_microphone' : 'not_applicable',
  started_at: new Date().toISOString(), credentials_scope: 'user_authorized_six_case_test',
}, null, 2))
console.log(JSON.stringify({ case_id: id, mode, home, report_dir: reportDir }))
const log = openSync(join(reportDir, 'driver.log'), 'a')
const voiceFixture = id === 'voice' ? join(repo, 'tests/fixtures/robustness/voice-golden.wav') : undefined
const guard = voiceFixture ? setInterval(() => {
  const projectsFile = join(home, 'projects.json')
  if (!existsSync(projectsFile)) return
  for (const project of JSON.parse(readFileSync(projectsFile, 'utf8')).projects ?? []) {
    const root = resolve(project.root_path)
    if (!root.startsWith(home + '\\') && !root.startsWith(home + '/')) throw new Error('Generated test root escaped home')
    if (!existsSync(join(root, '.venv/pyvenv.cfg'))) continue
    const site = join(root, '.venv/Lib/site-packages')
    mkdirSync(site, { recursive: true })
    const target = join(site, 'sitecustomize.py')
    if (existsSync(target)) {
      if (!readFileSync(target, 'utf8').includes('BLR_FIXED_AUDIO_ONLY')) throw new Error('Unknown test-site hook; stop instead of overwriting')
      continue
    }
    // Driver env filtering may omit the test variable. Bind this test-only site to its trusted fixture.
    writeFileSync(target, `import os\nos.environ.setdefault('BLR_FIXED_AUDIO_WAV', ${JSON.stringify(voiceFixture)})\n` +
      readFileSync(join(repo, 'tests/fixtures/robustness/voice-sitecustomize.py'), 'utf8'))
    console.log('Fixed-audio device hook installed in isolated test environment')
  }
}, 200) : undefined
const child = spawn(process.execPath, [join(repo, 'scripts/dogfood-run.mjs'), '--request-file', join(reportDir, 'request.txt'),
  '--mode', mode, '--timeout-min', String(matrix.timeout_minutes[mode]), '--home', home, '--report-dir', reportDir, '--fixed-case'],
  { cwd: repo, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, BLOMA_DESKTOP_DISPATCH: '1',
    BLOMA_SPEECH_MODEL_DIR: process.env.BLOMA_SPEECH_MODEL_DIR || join(process.env.USERPROFILE, '.proma/speech-models/sensevoice-int8'),
    ...(voiceFixture ? { BLR_FIXED_AUDIO_WAV: voiceFixture } : {}) } })
child.once('error', () => { if (guard) clearInterval(guard); console.error('Case driver could not start'); process.exitCode = 2 })
child.once('exit', code => { if (guard) clearInterval(guard); console.log(JSON.stringify({ case_id: id, mode, driver_exit: code })); process.exitCode = code ?? 2 })
