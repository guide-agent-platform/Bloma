/**
 * 批6 测试有效性反证单测（2026-10-06）：编排器纯注入面——审计三态、种子轮换、
 * 击杀/存活判定、预算、恢复顺序；survived 硬拒收口径、not_applicable 不阻塞（首版拍板）。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runTestEffectivenessGates, type TestEffectivenessDeps } from '../../../main/desktop/test-effectiveness'
import { parseProjectContract } from '../../../main/desktop/contract-schema'

function makeRoot(): { root: string; contract: ReturnType<typeof parseProjectContract> } {
  const root = mkdtempSync(join(tmpdir(), 'bloma-eff-'))
  writeFileSync(join(root, 'app.py'), 'def save(path):\n    open(path, "w").write("x")\n', 'utf8')
  writeFileSync(join(root, 'driver.py'), 'print("PASS S1")\n', 'utf8')
  const contract = parseProjectContract(JSON.stringify({
    schema_version: 1,
    entry: 'app.py',
    driver: { command: ['python', 'driver.py'], timeout_ms: 60000, exit_code_semantics: { '0': 'pass', '1': 'fail', '2': 'blocked' }, assert_readback: 'stdout 锚点' },
    env_whitelist: [],
    components: [],
    scenarios: [{ name: 'S1', covers: ['F-001'] }],
  }))
  return { root, contract }
}

function stubDeps(overrides: Partial<TestEffectivenessDeps> = {}): TestEffectivenessDeps & { order: string[] } {
  const order: string[] = []
  return {
    order,
    runAudit: async () => ({ findings: [] }),
    applySeed: async () => ({ applied: true, function: 'save', line: 1 }),
    restoreFile: async () => true,
    runDriver: async () => ({ routing: 'fail' }),
    ...overrides,
  }
}

describe('runTestEffectivenessGates（批6 编排）', () => {
  it('标准模式保留静态疑点，不注入源码或复跑驱动', async () => {
    const { root, contract } = makeRoot()
    const deps = stubDeps({ runAudit: async () => ({ findings: [{ file: 'driver.py', line: 1, kind: 'alias-compare', state: 'reject', detail: '疑点' }] }) })
    deps.applySeed = async () => { throw new Error('must not mutate') }
    deps.runDriver = async () => { throw new Error('must not rerun') }
    const result = await runTestEffectivenessGates({ rootPath: root, contract, p0Fids: ['F-001'], entryFile: 'app.py', deps, includeMutation: false })
    expect(result.mode).toBe('standard')
    expect(result.audit.passed).toBe(false)
    expect(result.faultKill).toMatchObject({ executed: 0, killed: 0, notRun: 1 })
  })

  it('严格模式的环境阻塞不记为种子击杀，仍恢复文件', async () => {
    const { root, contract } = makeRoot()
    let restored = false
    const deps = stubDeps({ runDriver: async () => ({ routing: 'blocked', routingReason: '解释器不可用' }), restoreFile: async () => { restored = true; return true } })
    const result = await runTestEffectivenessGates({ rootPath: root, contract, p0Fids: ['F-001'], entryFile: 'app.py', deps })
    expect(result.faultKill).toMatchObject({ executed: 0, killed: 0, notRun: 1 })
    expect(result.faultKill.entries[0].detail).toContain('解释器不可用')
    expect(restored).toBe(true)
  })

  it('入口恢复失败必须停止，并报告基础设施错误', async () => {
    const { root, contract } = makeRoot()
    const result = await runTestEffectivenessGates({ rootPath: root, contract, p0Fids: ['F-001', 'F-002'], entryFile: 'app.py', deps: stubDeps({ restoreFile: async () => false }) })
    expect(result.faultKill.passed).toBe(false)
    expect(result.faultKill.error).toContain('恢复失败')
    expect(result.faultKill.entries).toHaveLength(1)
  })
  it('全击杀 + 审计干净 → 双门通过；注入→复跑→恢复顺序完整', async () => {
    const { root, contract } = makeRoot()
    const deps = stubDeps()
    deps.applySeed = async (file, seed) => { deps.order.push(`apply:${seed}@${file.endsWith('app.py') ? 'entry' : file}`); return { applied: true, function: 'save', line: 1 } }
    deps.runDriver = async () => { deps.order.push('run'); return { routing: 'fail' } }
    deps.restoreFile = async (file) => { deps.order.push(`restore:${file.endsWith('app.py') ? 'entry' : file}`); return true }
    const outcome = await runTestEffectivenessGates({ rootPath: root, contract, p0Fids: ['F-001', 'F-002'], entryFile: 'app.py', deps })
    expect(outcome.audit.passed).toBe(true)
    expect(outcome.faultKill.passed).toBe(true)
    expect(outcome.faultKill.killed).toBe(2)
    expect(outcome.faultKill.survived).toBe(0)
    expect(deps.order).toEqual(['apply:FS-VALIDATION-REMOVE@entry', 'run', 'restore:entry', 'apply:FS-SAVE-NOP@entry', 'run', 'restore:entry'])
  })

  it('survived（注入已知坏后驱动仍全绿）→ 硬拒收口径：faultKill.passed=false', async () => {
    const { root, contract } = makeRoot()
    const deps = stubDeps({ runDriver: async () => ({ routing: 'pass' }) })
    const outcome = await runTestEffectivenessGates({ rootPath: root, contract, p0Fids: ['F-001'], entryFile: 'app.py', deps })
    expect(outcome.faultKill.passed).toBe(false)
    expect(outcome.faultKill.entries[0]).toMatchObject({ fid: 'F-001', result: 'survived' })
    expect(outcome.faultKill.entries[0]?.detail).toContain('相关性')
  })

  it('三个种子都定位不到（not_applicable）→ 呈现不阻塞（首版拍板口径）', async () => {
    const { root, contract } = makeRoot()
    const deps = stubDeps({ applySeed: async () => ({ applied: false, reason: 'not-applicable：未找到写文件函数' }) })
    const outcome = await runTestEffectivenessGates({ rootPath: root, contract, p0Fids: ['F-001'], entryFile: 'app.py', deps })
    expect(outcome.faultKill.entries[0]).toMatchObject({ result: 'not_applicable' })
    expect(outcome.faultKill.passed).toBe(true) // 不阻塞
    expect(outcome.faultKill.notApplicable).toBe(1)
  })

  it('审计 reject 发现 → audit.passed=false；审计器不可用 → 降级标注不判死', async () => {
    const { root, contract } = makeRoot()
    const rejectOutcome = await runTestEffectivenessGates({
      rootPath: root, contract, p0Fids: [], entryFile: 'app.py',
      deps: stubDeps({ runAudit: async () => ({ findings: [{ file: 'driver.py', line: 3, kind: 'assert-constant', state: 'reject', detail: 'assert 常量真值（永真断言）' }] }) }),
    })
    expect(rejectOutcome.audit.passed).toBe(false)
    const degradedOutcome = await runTestEffectivenessGates({
      rootPath: root, contract, p0Fids: [], entryFile: 'app.py',
      deps: stubDeps({ runAudit: async () => ({ findings: [], error: '审计器不可用：python 缺失' }) }),
    })
    expect(degradedOutcome.audit.passed).toBe(false)
    expect(degradedOutcome.audit.error).toContain('不可用')
  })

  it('预算耗尽 → 剩余点 not_run 如实记录（不伪装成通过）', async () => {
    const { root, contract } = makeRoot()
    const deps = stubDeps({ budgetMs: -1 }) // -1=已耗尽（0 在快机器同毫秒不触发 >0 判定，时钟竞态实锤 2026-10-08）
    const outcome = await runTestEffectivenessGates({ rootPath: root, contract, p0Fids: ['F-001'], entryFile: 'app.py', deps })
    expect(outcome.faultKill.entries[0]).toMatchObject({ result: 'not_run' })
    expect(outcome.faultKill.passed).toBe(true) // not_run 不阻塞（首版口径），但如实计数
  })

  it('种子确定性轮换：第 2 个 P0 点从 FS-SAVE-NOP 起步', async () => {
    const { root, contract } = makeRoot()
    const triedSeeds: string[] = []
    const deps = stubDeps({
      applySeed: async (_file, seed) => { triedSeeds.push(seed); return seed === 'FS-SAVE-NOP' ? { applied: true, function: 'save', line: 1 } : { applied: false, reason: 'no' } },
    })
    const outcome = await runTestEffectivenessGates({ rootPath: root, contract, p0Fids: ['F-001', 'F-002'], entryFile: 'app.py', deps })
    expect(triedSeeds).toEqual(['FS-VALIDATION-REMOVE', 'FS-SAVE-NOP', 'FS-SAVE-NOP'])
    expect(outcome.faultKill.killed).toBe(2)
  })
})
