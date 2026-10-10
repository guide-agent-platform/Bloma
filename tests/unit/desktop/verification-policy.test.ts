import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runVerifyFinalize } from '../../../main/desktop/dispatcher-finalize'
import { AssistantTurnCollector, type DesktopDispatchRunInput } from '../../../main/desktop/dispatcher-loop'
import { DESKTOP_PHASES } from '../../../main/desktop/dispatcher-phases'

const audit = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../../../main/desktop/test-effectiveness', async (original) => ({
  ...await original<typeof import('../../../main/desktop/test-effectiveness')>(),
  runVerifyEffectivenessPhase: audit.run,
}))
vi.mock('../../../main/project/document-engine', async (original) => ({
  ...await original<typeof import('../../../main/project/document-engine')>(),
  readPrdBackplane: () => ({ requirements: [{ id: 'F-001', priority: 'P0', description: 'save' }] }),
}))
vi.mock('../../../main/desktop/phase-checkpoint', () => ({ recordPhaseCheckpoint: vi.fn(async () => ({ stage: 'desktop-verify' })) }))
vi.mock('../../../main/desktop/provider-qualification', () => ({ runProviderQualificationIfLlm: vi.fn(async () => undefined) }))

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks() })

function fixture(policy: 'standard' | 'strict', driverFails = false) {
  const root = mkdtempSync(join(tmpdir(), 'bloma-policy-'))
  roots.push(root)
  writeFileSync(join(root, 'app.py'), 'def main():\n    return 0\n')
  const reports = new Map<string, string>()
  const input: DesktopDispatchRunInput = {
    projectId: 'policy-project', sessionId: 'policy-session', requestId: 'policy-request', currentPhase: 'desktop-verify',
    task: '', query: async function* () {}, env: {}, maxTokens: 1024, signal: new AbortController().signal,
    publish: () => {}, projectName: 'policy', sandboxRoot: root, verificationPolicy: policy,
    artifactExists: () => true,
    readContract: () => JSON.stringify({ schema_version: 1, entry: 'app.py', driver: { command: ['python', 'driver.py'], timeout_ms: 5000, exit_code_semantics: { '0': 'pass', '1': 'fail', '2': 'blocked' }, assert_readback: 'stdout' }, env_whitelist: [], components: [], scenarios: [{ name: 'S1', covers: ['F-001'] }] }),
    driverSpawn: async () => ({ code: driverFails ? 1 : 0, stdout: `${driverFails ? 'FAIL' : 'PASS'} S1\nSUMMARY pass=${driverFails ? 0 : 1} fail=${driverFails ? 1 : 0}\n`, stderr: '' }),
    writeReport: (path, text) => { reports.set(path, text) },
  }
  const collector = new AssistantTurnCollector()
  collector.onPublish('message_delta', { text: 'PHASE_ADVANCE: delivered' })
  audit.run.mockResolvedValue({ mode: policy, audit: { passed: false, findings: [{ file: 'driver.py', line: 1, kind: 'alias-compare', state: 'reject', detail: 'suspected oracle' }], auditedFiles: [] }, faultKill: { entries: [], executed: 0, killed: 0, survived: 0, notApplicable: 0, notRun: 1, passed: true } })
  return { input, collector, reports }
}

describe('standard versus strict verification closeout', () => {
  it('standard diagnostics do not reject a passing business driver, findings remain in the report', async () => {
    const f = fixture('standard')
    const result = await runVerifyFinalize(DESKTOP_PHASES['desktop-verify'], f.input, f.collector)
    expect(result.advance.decision).toBe('advance')
    expect(JSON.parse(f.reports.get('00_VERIFY/fault-kill-report.json')!)).toMatchObject({ policy: 'standard', audit: { passed: false } })
    expect(audit.run).toHaveBeenCalledWith(expect.objectContaining({ policy: 'standard' }))
  })

  it('strict retains the static rejection and business requirements', async () => {
    const f = fixture('strict')
    const result = await runVerifyFinalize(DESKTOP_PHASES['desktop-verify'], f.input, f.collector)
    expect(result.advance).toMatchObject({ decision: 'reject', reason: 'test-invalid' })
  })

  it('a real driver failure still rejects in standard mode', async () => {
    const f = fixture('standard', true)
    const result = await runVerifyFinalize(DESKTOP_PHASES['desktop-verify'], f.input, f.collector)
    expect(result.advance).toMatchObject({ decision: 'reject', reason: 'driver-fail' })
    expect(audit.run).not.toHaveBeenCalled()
  })
})
