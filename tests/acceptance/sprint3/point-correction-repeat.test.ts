import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { correctionRegionKey, createProject, submitCorrection } from '../../../main/project-service'
import type { CorrectionContext, PointCorrectionInput } from '../../../shared/types'

/**
 * S3-CORRECT-004 / R-CORR-07：同一区域连续纠错主动追问。
 * 向导 Agent 对同一元素/区域连续两次纠错后，第三次点击必须触发 should_follow_up，
 * 不再盲目自动修改；不同区域之间互相不累计。纯同步 service 测试，直接操作临时 PROMA_HOME。
 */

function withTmpHome<T>(fn: () => T): T {
  const originalHome = process.env.PROMA_HOME
  process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-correct-'))
  try {
    return fn()
  } finally {
    process.env.PROMA_HOME = originalHome
  }
}

/** 按 selector（精确命中）或 fallback 坐标（无 selector）构造合法 CorrectionContext。 */
function contextFor(selector: string | undefined, x = 0): CorrectionContext {
  return selector
    ? { element_selector: selector, bounding_rect: { x, y: 0, width: 100, height: 20 }, fallback_mode: false }
    : { bounding_rect: { x, y: 10, width: 100, height: 20 }, fallback_mode: true }
}

function correction(projectId: string, selector: string | undefined, x = 0, note = '改这里'): PointCorrectionInput {
  return {
    request_id: 'req',
    project_id: projectId,
    session_id: 'sess-1',
    mode: 'user_note',
    user_note: note,
    context: contextFor(selector, x),
  }
}

describe('Sprint 3 点选纠错重复追踪（S3-CORRECT-004）', () => {
  it('同一 selector 连续纠错：repeat_count 1→2→3，第三次 should_follow_up=true', () => {
    withTmpHome(() => {
      const project = createProject({ request_id: 'r1', mode: 'quick', initial_message: 'test' })
      const first = submitCorrection(correction(project.project_id, '.hero .title'))
      const second = submitCorrection(correction(project.project_id, '.hero .title'))
      const third = submitCorrection(correction(project.project_id, '.hero .title'))

      expect(first).toMatchObject({ accepted: true, repeat_count: 1, prior_count: 0, should_follow_up: false })
      expect(second).toMatchObject({ accepted: true, repeat_count: 2, prior_count: 1, should_follow_up: false })
      expect(third).toMatchObject({ accepted: true, repeat_count: 3, prior_count: 2, should_follow_up: true })
      expect(third.task_id).toBeTruthy()
    })
  })

  it('不同 selector 之间不累计：换区域后 repeat_count 回到 1', () => {
    withTmpHome(() => {
      const project = createProject({ request_id: 'r2', mode: 'quick', initial_message: 'test' })
      submitCorrection(correction(project.project_id, '.hero .title'))
      submitCorrection(correction(project.project_id, '.hero .title'))
      const switched = submitCorrection(correction(project.project_id, '.footer .link'))

      expect(switched.repeat_count).toBe(1)
      expect(switched.should_follow_up).toBe(false)
    })
  })

  it('fallback 包围盒坐标：四舍五入后同区域命中，累计追问', () => {
    withTmpHome(() => {
      const project = createProject({ request_id: 'r3', mode: 'quick', initial_message: 'test' })
      // fallback 模式（无 selector），x 取 12.1 / 12.4 / 12.3 均四舍五入到 12，判为同一区域
      submitCorrection(correction(project.project_id, undefined, 12.1))
      submitCorrection(correction(project.project_id, undefined, 12.4))
      const third = submitCorrection(correction(project.project_id, undefined, 12.3))

      expect(third.repeat_count).toBe(3)
      expect(third.should_follow_up).toBe(true)
    })
  })

  it('correctionRegionKey 优先 selector，退化为坐标键，缺失返回 undefined', () => {
    expect(correctionRegionKey({ element_selector: '.a .b', bounding_rect: { x: 0, y: 0, width: 0, height: 0 }, fallback_mode: false })).toBe('selector:.a .b')
    expect(correctionRegionKey({ bounding_rect: { x: 10.4, y: 5.6, width: 30, height: 40 }, fallback_mode: true })).toBe('rect:10,6,30,40')
    expect(correctionRegionKey(undefined)).toBeUndefined()
  })
})
