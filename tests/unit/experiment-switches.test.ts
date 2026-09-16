import { afterEach, describe, expect, it } from 'vitest'
import { KNOWN_EXPERIMENT_SWITCHES, readExperimentSwitches } from '../../main/experiment-switches'

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
    expect(KNOWN_EXPERIMENT_SWITCHES.length).toBeGreaterThanOrEqual(10)
    const ids = KNOWN_EXPERIMENT_SWITCHES.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const meta of KNOWN_EXPERIMENT_SWITCHES) {
      expect(meta.id.startsWith('BLOMA_')).toBe(true)
      expect(meta.label.length).toBeGreaterThan(0)
      expect(meta.note.length).toBeGreaterThan(0)
    }
  })

  it('实况读取：未设=关；1/on/true=开；其余值=关（只读白名单，不透传全量 env）', () => {
    for (const meta of KNOWN_EXPERIMENT_SWITCHES) originals.set(meta.id, process.env[meta.id])
    delete process.env.BLOMA_PROJECT_GIT
    process.env.BLOMA_FEEDBACK_CARD = '1'
    process.env.BLOMA_ROLLBACK_CODE_ONLY = 'on'
    process.env.BLOMA_EXPORT_V2 = 'true'
    process.env.BLOMA_CONTEXT_PACK = '0'
    const switches = readExperimentSwitches()
    expect(switches.BLOMA_PROJECT_GIT).toBe(false)
    expect(switches.BLOMA_FEEDBACK_CARD).toBe(true)
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
