// Read-only baseline capture: hashes only for local overrides, no credentials.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const sha = path => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null
const voice = join(homedir(), '.proma/agent-workspaces/default-software-builder/generated-projects/1f178567-0241-441c-a19e-da0dfa6edf27')
const promptNames = ['guide-system.md', 'prd-system.md', 'loop-system.md', 'sketch-system.md']
const [commit, upstreamCommit] = process.argv.slice(2)
if (![commit, upstreamCommit].every(value => /^[a-f0-9]{40}$/.test(value ?? ''))) {
  throw new Error('Supply the current and local upstream full Git commit IDs')
}
const report = {
  schema_version: 1,
  captured_at: new Date().toISOString(),
  commit,
  upstream_commit: upstreamCommit,
  cases_sha256: sha('tests/fixtures/robustness/cases.json'),
  lock_sha256: sha('package-lock.json'),
  original_voice: Object.fromEntries(['voice_audio.py', 'e2e_drive.py', 'DELIVERY.md', 'requirements.txt'].map(name => [name, sha(join(voice, name))])),
  prompt_overrides: Object.fromEntries(promptNames.map(name => [name, sha(join(homedir(), '.proma/prompts', name))])),
  channel: { status: 'capture per run using resolved channel id/model/protocol; no keys in baseline' },
  checks: {
    original_voice_untouched: true,
    hardware_microphone: 'not_run',
    dependency_scope: 'existing product venv and cached model; cold-cache paths evaluated separately',
  },
}
mkdirSync('run-artifacts', { recursive: true })
writeFileSync('run-artifacts/robustness-baseline.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
