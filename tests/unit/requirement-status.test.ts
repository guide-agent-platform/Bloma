import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { syncDocuments, markPrdUserConfirmed } from '../../main/project/document-engine'
import { createProject, recordSketchGenerated } from '../../main/project/project-service'
import { getDocumentsDir } from '../../storage/config-paths'
import type { PrdBackplane, SketchRequirement } from '../../main/coding/sketch-engine'

/**
 * 活背板裁剪版（2026-10-03 删留执行）：updateRequirementStatus 及其回写/重生成清除/
 * status 渲染共 4 例已删——该函数生产零调用（全仓 grep 反证，仅 prd-store.ts:164 定义，
 * 头注宣称的 evaluateOnce wiring 已不存在），status 渲染分支生产不可达（prd-defender
 * 反而剥离 status_note）。仅保留活路径 markPrdUserConfirmed（prd-confirm.ts:213 消费）
 * 的落盘契约；原 runJudge/resolveChannelEnv 两个桩随死用例一并移除。
 */

const requirements: SketchRequirement[] = [
  { id: 'F-001', description: '记录日常收支', priority: 'P0' },
  { id: 'F-002', description: '按月汇总统计', priority: 'P1' },
]

describe('markPrdUserConfirmed（document-engine 活路径）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  function setupProject(): { projectId: string; prdPath: string } {
    const home = mkdtempSync(join(tmpdir(), 'proma-req-status-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, requirements)
    // prd.json 由 requirement_confirmed / sketch_confirmed 检查点写盘（mvp_before_generation 只写 md+GWT 骨架）
    syncDocuments({ request_id: 'req-prd', project_id: project.project_id, session_id: 'session-1', checkpoint: 'sketch_confirmed' })
    const prdPath = join(getDocumentsDir(project.workspace_slug, project.project_id), 'prd.json')
    return { projectId: project.project_id, prdPath }
  }

  it('markPrdUserConfirmed：user_confirmed_at 落盘且其余字段原样保留；无 prd.json → null', () => {
    const { projectId, prdPath } = setupProject()
    const before = JSON.parse(readFileSync(prdPath, 'utf8')) as PrdBackplane
    const confirmed = markPrdUserConfirmed(projectId)

    expect(confirmed?.user_confirmed_at).toBeTruthy()
    const after = JSON.parse(readFileSync(prdPath, 'utf8')) as PrdBackplane
    expect(after.user_confirmed_at).toBe(confirmed?.user_confirmed_at)
    // 字段保留细节（本文件独占的断言面）：需求内容与定位不被确认动作触碰
    expect(after.requirements.find((item) => item.id === 'F-001')?.description).toBe('记录日常收支')
    expect(after.requirements).toHaveLength(before.requirements.length)
    expect(after.positioning).toBe(before.positioning)

    const home = mkdtempSync(join(tmpdir(), 'proma-req-status-noconfirm-'))
    process.env.PROMA_HOME = home
    const empty = createProject({ request_id: 'req-empty2', mode: 'quick' })
    expect(markPrdUserConfirmed(empty.project_id)).toBeNull()
  })
})
