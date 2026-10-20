/**
 * Phase 7 U1 H2 关键任务块 key_tasks（2026-09-10，E1 咨询 H2 / P7 实施稿 §2）。
 *
 * 覆盖：开关语义（off=字节级现状：背板无 key_tasks 键）、形状级解析清洗
 * （label 必填/feature_ids 去重/must_deliver 归一）、定稿（白名单过滤/P0 补齐
 * 不变式/重编号/截断）、背板挂载（LLM 优先→漏报 P0 兜底）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  backplaneKeyTasks,
  finalizeKeyTasks,
  keyTasksEnabled,
  type KeyTask,
  type PrdBackplane,
  type SketchRequirement,
} from '../../main/model/prd-backplane'
import { KEY_TASKS_PROMPT_ADDENDUM, buildBackplaneFromParsed, parseKeyTasks } from '../../main/guide/prd-engine-llm'

afterEach(() => {
  vi.unstubAllEnvs()
})

const req = (id: string, description: string, priority?: 'P0' | 'P1' | 'P2'): SketchRequirement => ({
  id,
  description,
  ...(priority ? { priority } : {}),
})

const minimalBackplane = (requirements: SketchRequirement[], keyTasks?: KeyTask[]): PrdBackplane => ({
  project_id: 'p1',
  name: 't',
  positioning: '定位',
  requirements,
  acceptance: {},
  out_of_scope: [],
  assumptions: [],
  ...(keyTasks ? { key_tasks: keyTasks } : {}),
})

const baseParsed = {
  document: '# PRD',
  positioning: '定位',
  acceptance: {},
  out_of_scope: [],
  assumptions: [],
}

describe('keyTasksEnabled（BLOMA_KEY_TASKS）', () => {
  it('缺省 off（不设 env）', () => {
    expect(keyTasksEnabled()).toBe(false)
  })
  it('on 变体：1 / on / true（大小写不敏感）', () => {
    for (const value of ['1', 'on', 'true', 'ON']) {
      vi.stubEnv('BLOMA_KEY_TASKS', value)
      expect(keyTasksEnabled(), value).toBe(true)
    }
  })
  it('off 变体：0 / off / false / 空串', () => {
    for (const value of ['0', 'off', 'false', '']) {
      vi.stubEnv('BLOMA_KEY_TASKS', value)
      expect(keyTasksEnabled(), value).toBe(false)
    }
  })
})

describe('parseKeyTasks（形状级清洗）', () => {
  it('label 必填：缺失/空白弃条', () => {
    expect(
      parseKeyTasks([
        { task_id: 'KT-01', label: '', feature_ids: ['F-001'] },
        { task_id: 'KT-02', feature_ids: ['F-001'] },
        'not-a-record',
      ]),
    ).toEqual([])
  })
  it('feature_ids 过滤非字符串并去重；无有效 id 弃条（悬空任务不进背板）', () => {
    const out = parseKeyTasks([
      { task_id: 'KT-01', label: '记一笔账', feature_ids: ['F-001', 'F-001', 42, 'F-002'] },
      { task_id: 'KT-02', label: '悬空任务', feature_ids: [99, null] },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].feature_ids).toEqual(['F-001', 'F-002'])
  })
  it('must_deliver 非 false 一律归 true（保守缺省）', () => {
    const out = parseKeyTasks([
      { task_id: 'KT-01', label: 'A', feature_ids: ['F-001'] },
      { task_id: 'KT-02', label: 'B', feature_ids: ['F-002'], must_deliver: false },
      { task_id: 'KT-03', label: 'C', feature_ids: ['F-003'], must_deliver: 'yes' },
    ])
    expect(out.map((t) => t.must_deliver)).toEqual([true, false, true])
  })
  it('retains all task declarations before scope validation', () => {
    const raw = [1, 2, 3, 4, 5, 6].map((n) => ({ task_id: `KT-0${n}`, label: `任务${n}`, feature_ids: ['F-001'] }))
    expect(parseKeyTasks(raw)).toHaveLength(6)
  })
  it('非数组输入 → []', () => {
    expect(parseKeyTasks(undefined)).toEqual([])
    expect(parseKeyTasks('oops')).toEqual([])
  })
})

describe('finalizeKeyTasks（白名单 + P0 补齐 + 重编号）', () => {
  it('LLM 空产出 → 全 P0 项各自成任务（must_deliver=true）', () => {
    const out = finalizeKeyTasks(
      [],
      [req('F-001', '记账', 'P0'), req('F-002', '结余', 'P0'), req('F-003', '导出', 'P2')],
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ task_id: 'KT-01', label: '记账', feature_ids: ['F-001'], must_deliver: true })
    expect(out[1]).toMatchObject({ task_id: 'KT-02', feature_ids: ['F-002'] })
  })
  it('feature_ids 白名单过滤：悬空 id 剔除，全悬空弃条', () => {
    const out = finalizeKeyTasks(
      [
        { task_id: 'KT-01', label: '任务A', feature_ids: ['F-001', 'F-099'], must_deliver: true },
        { task_id: 'KT-02', label: '悬空', feature_ids: ['F-099'], must_deliver: true },
      ],
      [req('F-001', '记账', 'P0')],
    )
    expect(out).toHaveLength(1)
    expect(out[0].feature_ids).toEqual(['F-001'])
  })
  it('P0 已被 LLM 覆盖则不重复补齐；未覆盖的逐条补', () => {
    const out = finalizeKeyTasks(
      [{ task_id: '', label: '记账与结余', feature_ids: ['F-001', 'F-002'], must_deliver: true }],
      [req('F-001', '记账', 'P0'), req('F-002', '结余', 'P0'), req('F-003', '语音', 'P0')],
    )
    expect(out).toHaveLength(2)
    expect(out[0].label).toBe('记账与结余')
    expect(out[1]).toMatchObject({ feature_ids: ['F-003'], must_deliver: true })
  })
  it('task_id 统一重编号 KT-01..（追加后不跳号）', () => {
    const out = finalizeKeyTasks(
      [{ task_id: 'LLM-X9', label: '任务A', feature_ids: ['F-001'], must_deliver: true }],
      [req('F-001', '记账', 'P0'), req('F-002', '语音', 'P0')],
    )
    expect(out.map((t) => t.task_id)).toEqual(['KT-01', 'KT-02'])
  })
  it('deduplicates repeated tasks and covers every P0 beyond six items', () => {
    const llm = [1, 2, 3, 4].map((n) => ({ task_id: '', label: `任务${n}`, feature_ids: ['F-001'], must_deliver: true }))
    const p0 = Array.from({ length: 9 }, (_, i) => req(`F-${String(i + 1).padStart(3, '0')}`, `功能${i}`, 'P0'))
    const tasks = finalizeKeyTasks(llm, p0)
    expect(tasks).toHaveLength(9)
    expect(new Set(tasks.filter(task => task.must_deliver).flatMap(task => task.feature_ids))).toEqual(new Set(p0.map(item => item.id)))
    expect(parseKeyTasks([{ label: '全部功能', feature_ids: p0.map(item => item.id) }])[0].feature_ids).toHaveLength(9)
  })
})

describe('buildBackplaneFromParsed（挂载口径）', () => {
  it('开关 off → 背板无 key_tasks 键（字节级现状）', () => {
    const bp = buildBackplaneFromParsed(
      { ...baseParsed, key_tasks: [{ task_id: 'KT-01', label: '记一笔账', feature_ids: ['F-001'], must_deliver: true }] },
      [req('F-001', '记账', 'P0')],
      'p1',
    )
    expect('key_tasks' in bp).toBe(false)
  })
  it('开关 on + LLM 产出 → 清洗后挂载', () => {
    vi.stubEnv('BLOMA_KEY_TASKS', '1')
    const bp = buildBackplaneFromParsed(
      {
        ...baseParsed,
        key_tasks: [{ task_id: 'LLM-1', label: '记一笔账，月底看到结余', feature_ids: ['F-001', 'F-002'], must_deliver: true }],
      },
      [req('F-001', '记账', 'P0'), req('F-002', '结余', 'P0')],
      'p1',
    )
    expect(bp.key_tasks).toEqual([
      { task_id: 'KT-01', label: '记一笔账，月底看到结余', feature_ids: ['F-001', 'F-002'], must_deliver: true },
    ])
  })
  it('开关 on + LLM 漏报 → P0 补齐兜底（随心记负样本口径：AI 任务入关键任务且必交）', () => {
    vi.stubEnv('BLOMA_KEY_TASKS', '1')
    const bp = buildBackplaneFromParsed(baseParsed, [req('F-001', 'AI 总结笔记', 'P0')], 'p1')
    expect(bp.key_tasks).toEqual([{ task_id: 'KT-01', label: 'AI 总结笔记', feature_ids: ['F-001'], must_deliver: true }])
  })
})

describe('backplaneKeyTasks（读取侧）', () => {
  it('过滤缺 label 残条；缺省 []（旧 prd.json 零迁移）', () => {
    expect(backplaneKeyTasks(minimalBackplane([]))).toEqual([])
    const bp = minimalBackplane([req('F-001', '记账', 'P0')], [
      { task_id: 'KT-01', label: '记一笔账', feature_ids: ['F-001'], must_deliver: true },
      { task_id: 'KT-02', label: '  ', feature_ids: ['F-001'], must_deliver: true },
    ])
    expect(backplaneKeyTasks(bp)).toHaveLength(1)
  })
})

describe('KEY_TASKS_PROMPT_ADDENDUM（产出指令）', () => {
  it('包含 schema 行与 P0 硬约束（同 CAP addendum 模式）', () => {
    expect(KEY_TASKS_PROMPT_ADDENDUM).toContain('"key_tasks"')
    expect(KEY_TASKS_PROMPT_ADDENDUM).toContain('每个 P0 功能项必须落入至少一个任务')
    expect(KEY_TASKS_PROMPT_ADDENDUM).toContain('must_deliver')
  })
})
