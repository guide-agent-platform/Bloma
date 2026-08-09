import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncDocuments } from '../../main/document-engine'
import { readGwtFeatureIds, runJudge } from '../../main/judge-engine'
import { createProject, recordSketchGenerated } from '../../main/project-service'

describe('JudgeEngine (A2-10)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  it('passes when PRD is present, every feature has a GWT scenario, and entries exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({ request_id: 'req-sync', session_id: 's', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
    writeFileSync(join(project.root_path, 'index.html'), '<p>记录收入与支出</p>', 'utf8')

    const verdict = runJudge({ project_id: project.project_id, mode: 'quick' })

    expect(verdict.verdict).toBe('pass')
    expect(verdict.repairable).toBe(false)
    expect(verdict.hard_constraints.every((item) => item.passed)).toBe(true)
    expect(verdict.user_visible_summary).toBeTruthy()
    expect(JSON.stringify(verdict)).not.toMatch(/node_modules|Error:|at /)
  })

  it('returns and marks missing GWT scenarios when a PRD feature has no feature file', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [
      { id: 'F-001', description: '记录收入与支出' },
      { id: 'F-002', description: '展示本月结余' },
    ])
    syncDocuments({ request_id: 'req-sync', session_id: 's', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
    // 手动删掉 F-002 的 feature，模拟 GWT 只覆盖部分功能项
    rmSync(join(home, 'agent-workspaces', project.workspace_slug, 'documents', project.project_id, 'features', 'F-002.feature'))

    const verdict = runJudge({ project_id: project.project_id, mode: 'quick' })

    expect(verdict.verdict).toBe('return')
    expect(verdict.repairable).toBe(true)
    const coverage = verdict.hard_constraints.find((item) => item.name === 'GWT 场景覆盖')
    expect(coverage?.passed).toBe(false)
    expect(coverage?.detail).toContain('F-002')
  })

  it('returns when the PRD has no confirmed core features', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })

    const verdict = runJudge({ project_id: project.project_id, mode: 'quick' })

    expect(verdict.verdict).toBe('return')
    expect(verdict.hard_constraints.find((item) => item.name === 'PRD 核心功能项')?.passed).toBe(false)
  })

  it('suggests (not returns) when only a soft consistency check fails', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({ request_id: 'req-sync', session_id: 's', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
    // 页面没有对应入口（软约束失败）
    writeFileSync(join(project.root_path, 'index.html'), '<p>其他内容</p>', 'utf8')

    const verdict = runJudge({ project_id: project.project_id, mode: 'quick' })

    expect(verdict.verdict).toBe('suggest')
    expect(verdict.repairable).toBe(false)
    expect(verdict.hard_constraints.every((item) => item.passed)).toBe(true)
  })

  it('exposes GWT feature ids via readGwtFeatureIds', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({ request_id: 'req-sync', session_id: 's', project_id: project.project_id, checkpoint: 'mvp_before_generation' })

    expect(readGwtFeatureIds(project.project_id)).toContain('F-001')
  })
})
