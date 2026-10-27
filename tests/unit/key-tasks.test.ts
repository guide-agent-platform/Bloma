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
