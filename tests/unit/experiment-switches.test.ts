import { afterEach, describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KNOWN_EXPERIMENT_SWITCHES, readExperimentSwitches } from '../../main/platform/shell/experiment-switches'

/**
 * Phase 10 落地旅程（2026-09-16）：实验开关注册表——app:switch-state 白名单出口的
 * 唯一清单源。新增开关须同步登记（与开关矩阵文档对应）。
 */
describe('experiment-switches 注册表', () => {
  const originals = new Map<string, string | undefined>()

  afterEach(() => {
    for (const meta of KNOWN_EXPERIMENT_SWITCHES) {
      const prev = originals.get(meta.id)
      if (prev === undefined) delete process.env[meta.id]
      else process.env[meta.id] = prev
    }
  })

  it('注册表非空且 id 唯一、标签非空（新增开关登记完整性）', () => {
    expect(KNOWN_EXPERIMENT_SWITCHES.length).toBeGreaterThanOrEqual(5)
    const ids = KNOWN_EXPERIMENT_SWITCHES.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const meta of KNOWN_EXPERIMENT_SWITCHES) {
      expect(meta.id.startsWith('BLOMA_')).toBe(true)
      expect(meta.label.length).toBeGreaterThan(0)
      expect(meta.note.length).toBeGreaterThan(0)
    }
  })

  it('注册表↔源码活读取对账：白名单每一项必须在 main/shared 有 process.env 活读取（2026-10-01 三死条目事故根治；源码锚测试注意：迁移本测试须连带此扫描语义）', () => {
    const repoRoot = process.cwd()
    const files: string[] = []
    for (const dir of ['main', 'shared']) {
      const abs = join(repoRoot, dir)
      files.push(
        ...readdirSync(abs, { recursive: true })
          .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts') && !f.endsWith('.test.ts'))
          .map((f) => join(abs, f)),
      )
    }
    const allSource = files.map((f) => readFileSync(f, 'utf8')).join('\n')
    const dead = KNOWN_EXPERIMENT_SWITCHES
      .map((m) => m.id)
      .filter((id) => !new RegExp(`process\\.env\\.${id}\\b`).test(allSource))
    expect(
      dead,
      `白名单死条目（开关已转正/删除或改参数，须同步移出注册表——矩阵生命周期规则：转正即删开关）: ${dead.join(', ')}`,
    ).toEqual([])
  })

  it('实况读取：未设=关；1/on/true=开；其余值=关（只读白名单，不透传全量 env）', () => {
    for (const meta of KNOWN_EXPERIMENT_SWITCHES) originals.set(meta.id, process.env[meta.id])
    delete process.env.BLOMA_PROJECT_GIT
    process.env.BLOMA_CHANGE_CONTRACT = '1'
    process.env.BLOMA_ROLLBACK_CODE_ONLY = 'on'
    process.env.BLOMA_EXPORT_V2 = 'true'
    process.env.BLOMA_CONTEXT_PACK = '0'
    const switches = readExperimentSwitches()
    expect(switches.BLOMA_PROJECT_GIT).toBe(false)
    expect(switches.BLOMA_CHANGE_CONTRACT).toBe(true)
    expect(switches.BLOMA_ROLLBACK_CODE_ONLY).toBe(true)
    expect(switches.BLOMA_EXPORT_V2).toBe(true)
    expect(switches.BLOMA_CONTEXT_PACK).toBe(false)
    // 白名单外不出现（只回注册表项）
    expect(Object.keys(switches).every((k) => ids().includes(k))).toBe(true)
    function ids(): string[] {
      return KNOWN_EXPERIMENT_SWITCHES.map((m) => m.id)
    }
  })
})
