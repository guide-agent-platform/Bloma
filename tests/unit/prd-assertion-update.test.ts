import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncDocuments, updatePrdAssertions } from '../../main/project/document-engine'
import { createProject, recordSketchGenerated } from '../../main/project/project-service'
import { getDocumentsDir } from '../../storage/config-paths'
import type { PrdBackplane, SketchRequirement } from "../../main/model/prd-backplane";

/**
 * updatePrdAssertions 写盘链路（2026-09-02 周计划 §5 P3：EARS 化回写；陷阱 42 口径）：
 * - 只替换既有 id 的 behavior_assertions；不新增/删除功能项（F-001 锚点不变式）
 * - 读-改-写保留全部字段（user_confirmed_at/template_meta 等——EARS 化在用户确认后发生，
 *   确认事实绝不能丢）
 * - 空断言数组拒绝写入（防把断言清空）；无变化不写盘；缺失/损坏 → null 不抛错
 */

const requirements: SketchRequirement[] = [
  { id: 'F-001', description: '做一个番茄钟', priority: 'P0', behavior_assertions: ['点击开始后计时启动'] },
  { id: 'F-002', description: '显示今日完成数', priority: 'P2' },
]

describe('updatePrdAssertions（document-engine，P3 EARS 化回写）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  function setupProject(): { projectId: string; prdPath: string } {
    const home = mkdtempSync(join(tmpdir(), 'proma-earsify-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, requirements)
    syncDocuments({ request_id: 'req-prd', project_id: project.project_id, session_id: 'session-1', checkpoint: 'sketch_confirmed' })
    const prdPath = join(getDocumentsDir(project.workspace_slug, project.project_id), 'prd.json')
    return { projectId: project.project_id, prdPath }
  }

  it('替换既有 id 的断言，功能项数量与 id 不变（不新增不删除）', () => {
    const { projectId, prdPath } = setupProject()
    const updated = updatePrdAssertions(projectId, {
      'F-001': ['WHEN 点击开始按钮 → 计时启动'],
      // 未知 id 与空断言不写入
      'F-999': ['WHEN 幻觉 → 写入'],
      'F-002': [],
    })
    expect(updated).not.toBeNull()
    const after = JSON.parse(readFileSync(prdPath, 'utf8')) as PrdBackplane
    expect(after.requirements).toHaveLength(2)
    expect(after.requirements[0].behavior_assertions).toEqual(['WHEN 点击开始按钮 → 计时启动'])
    expect(after.requirements[1].behavior_assertions).not.toEqual([]) // F-002 空断言被拒
    expect(after.requirements.some((item) => item.id === 'F-999')).toBe(false)
  })

  it('读-改-写保留 user_confirmed_at / description / template_meta 等全部字段', () => {
    const { projectId, prdPath } = setupProject()
    // 模拟 EARS 化时序：先落用户确认，再回写断言
    const before = JSON.parse(readFileSync(prdPath, 'utf8')) as PrdBackplane
    const confirmed: PrdBackplane = { ...before, user_confirmed_at: '2026-09-02T00:00:00.000Z' }
    writeFileSync(prdPath, `${JSON.stringify(confirmed, null, 2)}\n`, 'utf8')

    updatePrdAssertions(projectId, { 'F-001': ['WHEN 点击开始按钮 → 计时启动'] })

    const after = JSON.parse(readFileSync(prdPath, 'utf8')) as PrdBackplane
    expect(after.user_confirmed_at).toBe('2026-09-02T00:00:00.000Z') // 确认事实不丢（陷阱 19/42）
    expect(after.requirements[0].description).toBe('做一个番茄钟') // description 不动
    expect(after.requirements[0].priority).toBe('P0')
    expect(after.template_meta).toBeDefined() // P2 注入点①的字段保留
  })

  it('无匹配更新（空表/全未知 id）→ 原样返回不写盘', () => {
    const { projectId, prdPath } = setupProject()
    const before = readFileSync(prdPath, 'utf8')
    expect(updatePrdAssertions(projectId, {})).not.toBeNull()
    expect(updatePrdAssertions(projectId, { 'F-999': ['WHEN x → y'] })).not.toBeNull()
    expect(readFileSync(prdPath, 'utf8')).toBe(before)
  })

  it('prd.json 缺失/损坏 → null 不抛错（fail-closed）', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-earsify-broken-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-broken', mode: 'quick' })
    expect(updatePrdAssertions(project.project_id, { 'F-001': ['WHEN x → y'] })).toBeNull()

    const prdPath = join(getDocumentsDir(project.workspace_slug, project.project_id), 'prd.json')
    writeFileSync(prdPath, '{broken json', 'utf8')
    expect(updatePrdAssertions(project.project_id, { 'F-001': ['WHEN x → y'] })).toBeNull()
  })
})
