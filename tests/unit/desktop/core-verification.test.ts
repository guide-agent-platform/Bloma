import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../main/project/document-engine', () => ({ readPrdBackplane: vi.fn() }))
vi.mock('../../../main/desktop/file-verification', () => ({ runHostPrefixRenameProbe: vi.fn() }))
vi.mock('../../../main/desktop/llm-verification', () => ({ runHostLlmProbe: vi.fn() }))
import { readPrdBackplane } from '../../../main/project/document-engine'
import { runCoreVerification, CORE_REPORT_REL } from '../../../main/desktop/core-verification'
import { runHostPrefixRenameProbe } from '../../../main/desktop/file-verification'
import { requirementEvidenceHash } from '../../../main/project/requirement-contract'
import { runHostLlmProbe } from '../../../main/desktop/llm-verification'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'core-check-'))
  writeFileSync(join(root, 'core_check.py'), '# test registered script')
  vi.mocked(readPrdBackplane).mockReturnValue({ requirements: [{ id: 'F-001', description: '新增记录', priority: 'P0' }] } as never)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
function manifest(input = 'gui') {
  writeManifest({ command: ['python', 'core_check.py'], scenarios: [{ name: 'actual input', covers: ['F-001'], input }] })
}
function writeManifest(data: Record<string, unknown>) {
  const backplane = vi.mocked(readPrdBackplane).getMockImplementation()!('p')
  writeFileSync(join(root, 'CORE_CHECK.json'), JSON.stringify({ schema_version: 2,
    requirements: backplane.requirements.map(item => ({ id: item.id, requirement_hash: requirementEvidenceHash(backplane, item), implementation: 'implemented' })), ...data }))
}
const run = (code = 0, stdout = 'PASS actual input') => runCoreVerification({ projectId: 'p', sandboxRoot: root,
  spawn: async () => ({ code, stdout, stderr: '' }) })

describe('shared core delivery', () => {
  it('diagnoses unsupported GUI scenario fields before running scripts', async () => {
    writeManifest({ command: ['python', 'core_check.py'], scenarios: [{ name: 'actual input', covers: ['F-001'], input: 'logic' }], gui_scenarios: [] })
    const spawn = vi.fn()
    const result = await runCoreVerification({ projectId: 'p', sandboxRoot: root, spawn })
    expect(result.status).toBe('unverified')
    expect(result.missing.join(' ')).toContain('将界面场景合并到 scenarios')
    expect(spawn).not.toHaveBeenCalled()
  })
  it('shows mismatched actual names without treating a similarly named test as passed', async () => {
    writeManifest({ command: ['python', 'core_check.py'], scenarios: [{ name: '空标题["   "]', covers: ['F-001'], input: 'gui' }] })
    const result = await run(0, "PASS 空标题['   ']")
    expect(result.status).toBe('unverified')
    expect(result.missing.join(' ')).toContain('脚本实际输出的场景名')
    expect(result.evidence[0].outcome).toBe('unverified')
  })
  it('rechecks requirements stored outside the product root after scripts execute', async () => {
    manifest()
    const result = await runCoreVerification({ projectId: 'p', sandboxRoot: root, spawn: async () => {
      vi.mocked(readPrdBackplane).mockReturnValue({ requirements: [{ id: 'F-001', description: '新需求内容' }] } as never)
      return { code: 0, stdout: 'PASS actual input', stderr: '' }
    } })
    expect(result.status).toBe('unverified')
    expect(result.missing.join(' ')).toContain('需求契约变化')
    expect(result.requirements?.[0]?.verification).toBe('unverified')
  })
  it('refuses fixed network_error behind product-authored green model scenarios', async () => {
    vi.mocked(readPrdBackplane).mockReturnValue({ requirements: [{ id: 'F-004', description: '用户 Key 真实模型增强', priority: 'P1' }] } as never)
    const data = { command: ['python', 'core_check.py'], scenarios: [{ name: 'actual input', covers: ['F-004'], input: 'gui' }] }
    writeManifest(data)
    expect((await run()).status).toBe('unverified')
    writeManifest({ ...data, llm: { module: 'app', factory: 'Logic', method: 'enhance', covers: ['F-004'] } })
    vi.mocked(runHostLlmProbe).mockResolvedValue({ probe_version: 1, status: 'failed', request_count: 0, tests: [{ name: 'real_request', passed: false }] })
    const failed = await run()
    expect(failed.status).toBe('failed')
    expect(failed.requirements?.[0]?.verification).toBe('failed')
    vi.mocked(runHostLlmProbe).mockResolvedValue({ probe_version: 1, status: 'passed' })
    expect((await run()).status).toBe('passed')
  })
  it('requires every confirmed feature independently of priority, and distinguishes partial implementation from green tests', async () => {
    vi.mocked(readPrdBackplane).mockReturnValue({ requirements: [{ id: 'F-001', description: '主功能', priority: 'P0' }, { id: 'F-004', description: '增强' }] } as never)
    writeManifest({ command: ['python', 'core_check.py'], scenarios: [{ name: 'actual input', covers: ['F-001'], input: 'gui' }] })
    expect((await run()).missing).toContain('F-004')
    const data = JSON.parse(readFileSync(join(root, 'CORE_CHECK.json'), 'utf8'))
    data.scenarios[0].covers.push('F-004')
    data.requirements[1].implementation = 'partial'
    writeFileSync(join(root, 'CORE_CHECK.json'), JSON.stringify(data))
    const result = await run()
    expect(result.status).toBe('unverified')
    expect(result.requirements?.[1]).toMatchObject({ implementation: 'partial', verification: 'passed' })
  })
  it('explains the scenario limit before spawning validation scripts', async () => {
    writeManifest({ command: ['python', 'core_check.py'], scenarios: Array.from({ length: 66 }, (_, i) => ({
      name: `case ${i}`, covers: ['F-001'], input: 'logic',
    })) })
    const spawn = vi.fn()
    const result = await runCoreVerification({ projectId: 'p', sandboxRoot: root, spawn })
    expect(result.status).toBe('unverified')
    expect(result.missing.join(' ')).toContain('场景数量 66 超过上限 64')
    expect(spawn).not.toHaveBeenCalled()
  })
  it('refuses stale registration before execution, and old passing manifests stay diagnostic', async () => {
    manifest()
    const declared = JSON.parse(readFileSync(join(root, 'CORE_CHECK.json'), 'utf8')).requirements[0].requirement_hash
    vi.mocked(readPrdBackplane).mockReturnValue({ requirements: [{ id: 'F-001', description: '已改变的功能' }] } as never)
    const current = requirementEvidenceHash(readPrdBackplane('p'), readPrdBackplane('p').requirements[0])
    const spawn = vi.fn(async () => ({ code: 0, stdout: 'PASS actual input', stderr: '' }))
    const stale = await runCoreVerification({ projectId: 'p', sandboxRoot: root, spawn })
    expect(stale.status).toBe('unverified')
    expect(stale.missing.join(' ')).toContain('需求版本不一致')
    expect(stale.missing.join(' ')).toContain(`声明指纹 ${declared}；当前指纹 ${current}`)
    expect(stale.missing.join(' ')).toContain('只改场景名称不能修正指纹')
    expect(spawn).not.toHaveBeenCalled()
    writeFileSync(join(root, 'CORE_CHECK.json'), JSON.stringify({ schema_version: 1, command: ['python', 'core_check.py'], scenarios: [{ name: 'actual input', covers: ['F-001'], input: 'gui' }] }))
    const legacy = await run()
    expect(legacy.status).toBe('unverified')
    expect(legacy.missing.join(' ')).toContain('缺少逐项实现声明')
  })
  it('host filesystem counterexamples override product-authored passing assertions', async () => {
    vi.mocked(readPrdBackplane).mockReturnValue({ requirements: [{ id: 'F-001', description: '文件前缀改名', priority: 'P0' }] } as never)
    manifest()
    vi.mocked(runHostPrefixRenameProbe).mockResolvedValue({ probe_version: 1, status: 'failed', tests: [{ name: 'escaped_target', passed: false }] })
    expect((await run()).status).toBe('failed')
    vi.mocked(runHostPrefixRenameProbe).mockResolvedValue({ probe_version: 1, status: 'environment_blocked', error: 'unsupported interface' })
    expect((await run()).status).toBe('environment_blocked')
    vi.mocked(runHostPrefixRenameProbe).mockResolvedValue({ probe_version: 1, status: 'passed' })
    expect((await run()).status).toBe('passed')
  })
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
      const result = await run()
      expect(result.status).toBe('unverified')
      expect(result.missing.some(m => m.includes('ASR 入口登记'))).toBe(true)
      expect(result.missing.some(m => m.includes('采集链路待授权'))).toBe(false)
    }
  })
  it('rejects undeclared feature ids and scripts outside the project', async () => {
    manifest()
    const data = JSON.parse(readFileSync(join(root, 'CORE_CHECK.json'), 'utf8'))
    data.command[1] = '../outside.py'
    writeManifest(data)
    expect((await run()).status).toBe('unverified')
  })
  it('reuses separately registered GUI tests without borrowing their evidence from logic output', async () => {
    writeFileSync(join(root, 'test_ui.py'), '# existing GUI test')
    const data = { schema_version: 1, command: ['python', 'core_check.py'], gui_command: ['python', 'test_ui.py'],
      scenarios: [{ name: 'logic case', covers: ['F-001'], input: 'logic' }, { name: 'GUI case', covers: ['F-001'], input: 'gui' }] }
    writeManifest(data)
    const calls: Array<readonly string[]> = []
    let guiOutput = 'PASS GUI case'
    const execute = () => runCoreVerification({ projectId: 'p', sandboxRoot: root, spawn: async ({ command }) => {
      calls.push(command)
      return { code: 0, stdout: command.includes('test_ui.py') ? guiOutput : 'PASS logic case\nPASS GUI case', stderr: '' }
    } })
    expect((await execute()).status).toBe('passed')
    expect(calls).toHaveLength(2)
    guiOutput = 'PASS unrelated case'
    const missing = await execute()
    expect(missing.status).toBe('unverified')
    expect(missing.evidence.find(e => e.input === 'gui')?.outcome).toBe('unverified')
    guiOutput = 'FAIL GUI case'
    expect((await execute()).status).toBe('failed')
    data.gui_command[1] = '../test_ui.py'
    writeManifest(data)
    expect((await execute()).status).toBe('unverified')
  })
  it('does not discard an unverified registered scenario just because another covers the same feature', async () => {
    writeManifest({ command: ['python', 'core_check.py'],
      scenarios: [{ name: 'positive GUI', covers: ['F-001'], input: 'gui' }, { name: 'write failure recovery', covers: ['F-001'], input: 'logic' }] })
    const result = await run(0, 'PASS positive GUI')
    expect(result.status).toBe('unverified')
    expect(result.missing.some(m => m.includes('write failure recovery'))).toBe(true)
  })
  it('records an explicitly registered GUI execution without requiring duplicate feature mapping', async () => {
    writeFileSync(join(root, 'gui_check.py'), '# existing GUI test')
    writeManifest({ command: ['python', 'core_check.py'],
      gui_command: ['python', 'gui_check.py'], scenarios: [{ name: 'core feature', covers: ['F-001'], input: 'logic' }] })
    const execute = (output: string) => runCoreVerification({ projectId: 'p', sandboxRoot: root, spawn: async ({ command }) => ({
      code: 0, stdout: command.includes('gui_check.py') ? output : 'PASS core feature', stderr: '',
    }) })
    const result = await execute('PASS actual GUI interaction')
    expect(result.status).toBe('passed')
    expect(result.gui_execution?.scenarios[0]?.outcome).toBe('pass')
    expect(result.evidence.every(e => e.input === 'logic')).toBe(true)
    expect((await execute('FAIL actual GUI interaction')).status).toBe('failed')
    expect((await execute('')).status).toBe('unverified')
  })
})
