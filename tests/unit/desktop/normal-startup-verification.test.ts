import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runNormalStartupVerification, NORMAL_STARTUP_REPORT } from '../../../main/desktop/normal-startup-verification'
import type { DriverCommandRequest } from '../../../main/desktop/process-driver'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'normal-startup-test-')); mkdirSync(join(root, 'ui'))
  writeFileSync(join(root, 'ui/bridge.js'), '// bridge'); writeFileSync(join(root, 'app.py'), '# app')
  writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 1, command: ['python', 'app.py'] }))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
const sample = { normal_mode: true, document_ready: true, bridge_ready: true, app_present: true, startup_error: '' }
const response = (status: string, samples: unknown[]) => ({ code: 0, stdout: 'product stdout\nBLOMA_NORMAL_STARTUP:' + JSON.stringify({ probe_version: 1, status, samples }), stderr: '' })
describe('platform normal-startup evidence', () => {
  it('runs the native Python entry with isolated data, no drive port, and a source fingerprint', async () => {
    const spawn = vi.fn(async (request: DriverCommandRequest) => {
      expect(request.command.join(' ')).not.toContain('--drive-port')
      expect(request.command).toContain(join(root, 'app.py')); expect(request.timeoutMs).toBe(30000)
      expect(request.env.APP_DATA_DIR).not.toContain(root)
      return response('passed', [sample, sample])
    })
    const report = await runNormalStartupVerification(root, undefined, spawn)
    expect(report).toMatchObject({ status: 'passed', source_unchanged: true })
    expect(JSON.parse(readFileSync(join(root, NORMAL_STARTUP_REPORT), 'utf8'))).toEqual(report)
  })
  it.each([[], [sample], [sample, { ...sample, normal_mode: false }], [sample, { ...sample, bridge_ready: false }], [sample, { ...sample, startup_error: '加载失败' }]].map(samples => ({ samples })))('rejects a claimed pass with incomplete native observations ($samples)', async ({ samples }) => {
    const report = await runNormalStartupVerification(root, undefined, async () => response('passed', samples))
    expect(report).toMatchObject({ status: 'unverified', error: 'NORMAL_STARTUP_INCOMPLETE_OBSERVATION' })
  })
  it('retains observed UI failure rather than certifying a live window', async () => {
    expect(await runNormalStartupVerification(root, undefined, async () => response('failed', [{ ...sample, startup_error: '加载失败：桥未就绪' }]))).toMatchObject({ status: 'failed' })
  })
  it('invalidates a probe that changes source', async () => {
    const report = await runNormalStartupVerification(root, undefined, async () => { writeFileSync(join(root, 'app.py'), '# changed'); return response('passed', [sample, sample]) })
    expect(report).toMatchObject({ status: 'unverified', source_unchanged: false, error: 'NORMAL_STARTUP_SOURCE_CHANGED' })
  })
  it('does not infer a pass from timeout or non-JSON output', async () => {
    expect((await runNormalStartupVerification(root, undefined, async () => { throw Error('timeout') })).status).toBe('unverified')
    expect((await runNormalStartupVerification(root, undefined, async () => ({ code: 0, stdout: 'PASS', stderr: '' }))).status).toBe('unverified')
  })
  it('refuses an entry outside the registered project before spawning', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'normal-outside-test-'))
    try {
      const entry = join(outside, 'app.py'); writeFileSync(entry, '# outside')
      writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 1, command: ['python', entry] }))
      const spawn = vi.fn()
      expect(await runNormalStartupVerification(root, undefined, spawn)).toMatchObject({ status: 'unverified', error: 'NORMAL_STARTUP_ENTRY_OUTSIDE_PROJECT' })
      expect(spawn).not.toHaveBeenCalled()
    } finally { rmSync(outside, { recursive: true, force: true }) }
  })
})
