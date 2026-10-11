import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../main/project/document-engine', () => ({ readPrdBackplane: vi.fn() }))
import { readPrdBackplane } from '../../../main/project/document-engine'
import { runCoreVerification, CORE_REPORT_REL } from '../../../main/desktop/core-verification'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'core-check-'))
  writeFileSync(join(root, 'core_check.py'), '# test registered script')
  vi.mocked(readPrdBackplane).mockReturnValue({ requirements: [{ id: 'F-001', description: '新增记录', priority: 'P0' }] } as never)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
function manifest(input = 'gui') {
  writeFileSync(join(root, 'CORE_CHECK.json'), JSON.stringify({ schema_version: 1, command: ['python', 'core_check.py'],
    scenarios: [{ name: 'actual input', covers: ['F-001'], input }] }))
}
const run = (code = 0, stdout = 'PASS actual input') => runCoreVerification({ projectId: 'p', sandboxRoot: root,
  spawn: async () => ({ code, stdout, stderr: '' }) })

describe('shared core delivery', () => {
  it('missing execution evidence is unverified, never green', async () => {
    expect((await run()).status).toBe('unverified')
    expect(JSON.parse(readFileSync(join(root, CORE_REPORT_REL), 'utf8')).status).toBe('unverified')
  })
  it('reads actual failure/environment states and refuses empty or mock coverage', async () => {
    manifest()
    const positive = await run()
    expect(positive.status, JSON.stringify(positive)).toBe('passed')
    expect((await run(1, 'FAIL actual input')).status).toBe('failed')
    expect((await run(2, 'BLOCKED actual input')).status).toBe('environment_blocked')
    expect((await run(0, '')).status).toBe('unverified')
    manifest('mock')
    expect((await run()).status).toBe('unverified')
  })
  it('audio self labels and text simulation cannot cover real ASR or capture', async () => {
    vi.mocked(readPrdBackplane).mockReturnValue({ requirements: [{ id: 'F-001', description: '语音录入', priority: 'P0' }] } as never)
    for (const input of ['gui', 'audio', 'microphone', 'mock']) {
      manifest(input)
      expect((await run()).status).toBe('unverified')
    }
  })
  it('rejects undeclared feature ids and scripts outside the project', async () => {
    manifest()
    const data = JSON.parse(readFileSync(join(root, 'CORE_CHECK.json'), 'utf8'))
    data.command[1] = '../outside.py'
    writeFileSync(join(root, 'CORE_CHECK.json'), JSON.stringify(data))
    expect((await run()).status).toBe('unverified')
  })
})
