import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { runHostPrefixRenameProbe } from '../../../main/desktop/file-verification'
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bloma-file-probe-')); writeFileSync(join(root, 'app.py'), '# registered product') })
afterEach(() => rmSync(root, { recursive: true, force: true }))
const names = ['rename', 'changed_prefix', 'different_folder', 'escaped_source', 'escaped_target']
const positive = () => ({ probe_version: 1, status: 'passed', mode: 'argument_plan', tests: names.map(name => ({ name, passed: true })) })
it('requires the complete host counterexample set, not just a green exit', async () => {
  const result = await runHostPrefixRenameProbe(root, async request => {
    expect(request.command.some(p => p.endsWith('prefix_rename_probe.py'))).toBe(true)
    return { code: 0, stdout: JSON.stringify(positive()), stderr: '' }
  })
  expect(result.status).toBe('passed')
  const incomplete = positive(); incomplete.tests.pop()
  expect((await runHostPrefixRenameProbe(root, async () => ({ code: 0, stdout: JSON.stringify(incomplete), stderr: '' }))).status).toBe('environment_blocked')
})
it('preserves host failures and blocks malformed responses', async () => {
  expect((await runHostPrefixRenameProbe(root, async () => ({ code: 1, stdout: JSON.stringify({ probe_version: 1, status: 'failed', tests: [{ name: 'escaped_target', passed: false }] }), stderr: '' }))).status).toBe('failed')
  expect((await runHostPrefixRenameProbe(root, async () => ({ code: 0, stdout: 'PASS everything', stderr: '' }))).status).toBe('environment_blocked')
})
it('invalidates a successful response if product inputs changed during the probe', async () => {
  const result = await runHostPrefixRenameProbe(root, async () => {
    writeFileSync(join(root, 'app.py'), '# changed product')
    return { code: 0, stdout: JSON.stringify(positive()), stderr: '' }
  })
  expect(result.status).toBe('environment_blocked')
})
