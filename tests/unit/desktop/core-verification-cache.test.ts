import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../main/project/prd-store', () => ({ readPrdBackplane: vi.fn() }))
vi.mock('../../../storage/json-store', async original => {
  const actual = await original<typeof import('../../../storage/json-store')>()
  return { ...actual, writeTextFileAtomic: vi.fn(actual.writeTextFileAtomic) }
})
import { readPrdBackplane } from '../../../main/project/prd-store'
import { writeTextFileAtomic } from '../../../storage/json-store'
import { coreCachePath, coreVerificationCacheKey, withCoreVerificationCache } from '../../../main/desktop/core-verification-cache'
import type { CoreVerificationResult } from '../../../main/desktop/core-verification'
import { runCoreVerification } from '../../../main/desktop/core-verification'
import { requirementEvidenceHash } from '../../../main/project/requirement-contract'
import { execFileSync } from 'node:child_process'
const pass = (): CoreVerificationResult => ({ status: 'passed', summary: 'fresh actual host check', checked_at: new Date().toISOString(), missing: [], evidence: [] })
beforeEach(() => vi.clearAllMocks())
describe('durable core verification reuse', () => {
  it('reuses unchanged complete evidence and executes again when its input key changes', async () => {
    let key = 'version-a'; const execute = vi.fn(async () => pass())
    const input = { projectId: 'reuse', key: () => key }
    await withCoreVerificationCache(input, execute)
    expect((await withCoreVerificationCache(input, execute)).reused).toBe(true)
    expect(execute).toHaveBeenCalledOnce()
    key = 'version-b'; await withCoreVerificationCache(input, execute)
    expect(execute).toHaveBeenCalledTimes(2)
  })
  it('invalidates old PASS before a forced run and cannot revive it after final persistence failure', async () => {
    const input = { projectId: 'write-failure', key: () => 'v' }
    await withCoreVerificationCache(input, async () => pass())
    const actual = await vi.importActual<typeof import('../../../storage/json-store')>('../../../storage/json-store')
    let writes = 0
    vi.mocked(writeTextFileAtomic).mockImplementation((...args) => {
      if (++writes === 2) throw Error('disk full')
      actual.writeTextFileAtomic(...args)
    })
    await expect(withCoreVerificationCache({ ...input, force: true }, async () => pass())).rejects.toThrow('disk full')
    expect(JSON.parse(readFileSync(coreCachePath(input.projectId), 'utf8')).state).toBe('running')
    vi.mocked(writeTextFileAtomic).mockImplementation(actual.writeTextFileAtomic)
    const execute = vi.fn(async () => pass())
    await withCoreVerificationCache(input, execute); expect(execute).toHaveBeenCalledOnce()
  })
  it.each(['failed', 'unverified', 'environment_blocked'] as const)('does not reuse %s or tampered evidence', async status => {
    const input = { projectId: `unknown-${status}`, key: () => 'v' }
    await withCoreVerificationCache(input, async () => ({ ...pass(), status }))
    const execute = vi.fn(async () => pass())
    await withCoreVerificationCache(input, execute)
    const file = coreCachePath(input.projectId), saved = JSON.parse(readFileSync(file, 'utf8'))
    saved.report.summary = 'tampered'; writeFileSync(file, JSON.stringify(saved))
    await withCoreVerificationCache(input, execute)
    expect(execute).toHaveBeenCalledTimes(2)
  })
  it('preserves unknown evidence after cancellation and refuses a second owner while verification is in flight', async () => {
    const input = { projectId: 'cancel', key: () => 'v' }, abort = new AbortController()
    let release!: () => void
    const pending = withCoreVerificationCache({ ...input, signal: abort.signal }, async () => { await new Promise<void>(r => { release = r }); return pass() })
    const duplicate = vi.fn(async () => pass())
    expect((await withCoreVerificationCache(input, duplicate)).status).toBe('environment_blocked')
    expect(duplicate).not.toHaveBeenCalled()
    abort.abort(); release()
    await expect(pending).rejects.toThrow()
    expect(JSON.parse(readFileSync(coreCachePath(input.projectId), 'utf8')).state).toBe('running')
  })
})
describe('actual verification input identity', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bloma-core-key-'))
    const python = join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin')
    mkdirSync(python, { recursive: true }); writeFileSync(join(python, process.platform === 'win32' ? 'python.exe' : 'python'), 'interpreter')
    writeFileSync(join(root, 'app.py'), '# current')
    vi.mocked(readPrdBackplane).mockReturnValue({ requirements: [{ id: 'F-001', description: 'save records' }] } as never)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  it.each(['source', 'manifest', 'requirements', 'dependencies'] as const)('invalidates a current proof after %s changes', mode => {
    const before = coreVerificationCacheKey('p', root)
    expect(before).toMatch(/^[a-f0-9]{64}$/)
    if (mode === 'source') writeFileSync(join(root, 'app.py'), '# changed')
    if (mode === 'manifest') writeFileSync(join(root, 'CORE_CHECK.json'), '{"version":2}')
    if (mode === 'requirements') vi.mocked(readPrdBackplane).mockReturnValue({ requirements: [{ id: 'F-001', description: 'different business behavior' }] } as never)
    if (mode === 'dependencies') writeFileSync(join(root, '.venv', 'pyvenv.cfg'), 'changed dependency metadata')
    expect(coreVerificationCacheKey('p', root)).not.toBe(before)
  })
  it('does not cache hardware-backed speech evidence', () => {
    vi.mocked(readPrdBackplane).mockReturnValue({ requirements: [{ id: 'F-001', description: '麦克风语音识别' }] } as never)
    expect(coreVerificationCacheKey('p', root)).toBeUndefined()
  })
  it('really executes one Python verification for two unchanged delivery checks, then reruns changed source', async () => {
    // Replace the metadata-only interpreter fixture with a real local venv.
    rmSync(join(root, '.venv'), { recursive: true, force: true })
    execFileSync('python', ['-m', 'venv', join(root, '.venv')], { windowsHide: true, timeout: 45000 })
    const counterRoot = mkdtempSync(join(tmpdir(), 'bloma-core-counter-')), counter = join(counterRoot, 'count.txt')
    try {
      const backplane = vi.mocked(readPrdBackplane).getMockImplementation()!('p')
      writeFileSync(join(root, 'core.py'), `from pathlib import Path\np=Path(${JSON.stringify(counter)})\np.write_text(str(int(p.read_text())+1) if p.exists() else '1')\nprint('PASS current case')\n`)
      writeFileSync(join(root, 'CORE_CHECK.json'), JSON.stringify({ schema_version: 2, command: ['python', 'core.py'],
        requirements: [{ id: 'F-001', implementation: 'implemented', requirement_hash: requirementEvidenceHash(backplane, backplane.requirements[0]) }],
        scenarios: [{ name: 'current case', covers: ['F-001'], input: 'gui' }] }))
      const options = { projectId: 'real-core', sandboxRoot: root, reuse: true }
      expect((await runCoreVerification(options)).status).toBe('passed')
      expect((await runCoreVerification(options)).reused).toBe(true)
      expect(readFileSync(counter, 'utf8')).toBe('1')
      writeFileSync(join(root, 'app.py'), '# changed product source')
      expect((await runCoreVerification(options)).status).toBe('passed')
      expect(readFileSync(counter, 'utf8')).toBe('2')
    } finally { rmSync(counterRoot, { recursive: true, force: true }) }
  }, 60000)
})
