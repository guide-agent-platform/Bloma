import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runHostLlmProbe } from '../../../main/desktop/llm-verification'
import type { DriverCommandRequest } from '../../../main/desktop/process-driver'
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bloma-llm-contract-')); writeFileSync(join(root, 'app.py'), '# product') })
afterEach(() => rmSync(root, { recursive: true, force: true }))
const spec = { module: 'app', factory: 'Logic', method: 'enhance', covers: ['F-004'] }
describe('offline model entry evidence', () => {
  it('requires host request and error evidence; product PASS cannot substitute it', async () => {
    const names = ['real_request', 'auth_error', 'model_error', 'rate_limited', 'invalid_response', 'unconfigured']
    const response = { probe_version: 1, status: 'passed', request_count: 5, tests: names.map(name => ({ name, passed: true })) }
    const spawn = vi.fn(async (_input: DriverCommandRequest) => ({ code: 0, stdout: JSON.stringify(response), stderr: '' }))
    expect((await runHostLlmProbe(root, spec, spawn)).status).toBe('passed')
    expect(spawn.mock.calls[0]?.[0]?.command).toContain('-B')
    response.request_count = 0
    expect((await runHostLlmProbe(root, spec, spawn)).status).toBe('environment_blocked')
  })
  it('rejects unsafe entry names without launching code', async () => {
    const spawn = vi.fn()
    expect((await runHostLlmProbe(root, { ...spec, module: '../outside' }, spawn)).status).toBe('environment_blocked')
    expect(spawn).not.toHaveBeenCalled()
  })
})
