import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncDocuments } from '../../main/document-engine'
import { createProject, recordSketchGenerated } from '../../main/project-service'
import { getDocumentsDir } from '../../storage/config-paths'

describe('DocumentEngine (A2-05)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  it('writes a PRD draft with core features on sketch_confirmed', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-doc-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])

    const result = syncDocuments({
      request_id: 'req-sync',
      session_id: 'session-1',
      project_id: project.project_id,
      checkpoint: 'sketch_confirmed',
    })

    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    const prd = readFileSync(join(dir, 'sketch_confirmed.md'), 'utf8')
    expect(prd).toContain('PRD 草案')
    expect(prd).toContain('F-001')
    expect(prd).toContain('记录收入与支出')
    // 结构化 PRD 背板：含产品定位 + 验收标准 + 范围外
    expect(prd).toContain('产品定位')
    expect(prd).toContain('验收标准')
    expect(prd).toContain('范围外')
    expect(result.documents.length).toBeGreaterThan(0)
    expect(result.documents[0].status).toBe('synced')
    expect(result.documents[0].type).toBe('prd')
  })

  it('writes a machine-readable PRD backplane (prd.json) with positioning + acceptance on sketch_confirmed', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-doc-backplane-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [
      { id: 'F-001', description: '音乐合成器' },
      { id: 'F-002', description: '网页端' },
    ])

    syncDocuments({
      request_id: 'req-sync',
      session_id: 'session-1',
      project_id: project.project_id,
      checkpoint: 'sketch_confirmed',
    })

    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    const backplane = JSON.parse(readFileSync(join(dir, 'prd.json'), 'utf8'))
    expect(backplane.positioning).toBe('音乐合成器')
    expect(backplane.requirements.map((r: { id: string }) => r.id)).toEqual(['F-001', 'F-002'])
    expect(backplane.acceptance['F-001']).toContain('音乐合成器')
    expect(backplane.frozen_at).toBeUndefined()
    expect(Array.isArray(backplane.out_of_scope)).toBe(true)
  })

  it('freezes the PRD backplane (frozen_at) on mvp_before_generation', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-doc-frozen-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '音乐合成器' }])

    syncDocuments({
      request_id: 'req-sync',
      session_id: 'session-1',
      project_id: project.project_id,
      checkpoint: 'mvp_before_generation',
    })

    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    const full = readFileSync(join(dir, 'mvp_before_generation.md'), 'utf8')
    expect(full).toContain('产品定位')
    expect(full).toContain('音乐合成器')
    expect(full).toContain('冻结时间')
  })

  it('writes a full PRD plus a GWT feature skeleton per P0 feature on mvp_before_generation', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-doc-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [
      { id: 'F-001', description: '记录收入与支出' },
      { id: 'F-002', description: '展示本月结余' },
    ])

    const result = syncDocuments({
      request_id: 'req-sync',
      session_id: 'session-1',
      project_id: project.project_id,
      checkpoint: 'mvp_before_generation',
    })

    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    expect(readFileSync(join(dir, 'mvp_before_generation.md'), 'utf8')).toContain('F-001')
    const feature1 = readFileSync(join(dir, 'features', 'F-001.feature'), 'utf8')
    expect(feature1).toContain('Feature:')
    expect(feature1).toContain('Scenario:')
    expect(feature1).toContain('Given')
    expect(readFileSync(join(dir, 'features', 'F-002.feature'), 'utf8')).toContain('Feature:')
    expect(result.documents.some((doc) => doc.type === 'gwt_feature')).toBe(true)
    // 每个功能项覆盖「正常路径 + 边界 + 异常」三类场景（PRD §11.3）
    expect(feature1.match(/Scenario:/g)).toHaveLength(3)
    expect(feature1).toContain('核心路径可运行')
    expect(feature1).toContain('边界输入不崩溃')
    expect(feature1).toContain('异常输入不崩溃')
    // 场景文本引用主题词（功能项描述），从 PRD 背板派生
    expect(feature1).toContain('记录收入与支出')
    expect(feature1).toContain('验收要点')
  })

  it('mounts a test report reference (body written by GWT execution) on mvp_tested', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-doc-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })

    const result = syncDocuments({
      request_id: 'req-sync',
      session_id: 'session-1',
      project_id: project.project_id,
      checkpoint: 'mvp_tested',
    })

    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    const report = readFileSync(join(dir, 'mvp_tested.md'), 'utf8')
    expect(report).toContain('测试报告')
    expect(report).toContain('total_count')
    expect(result.documents[0].type).toBe('test_report')
  })

  it('produces PlantUML and Sprint docs only for longterm projects', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-doc-'))
    process.env.PROMA_HOME = home
    const quick = createProject({ request_id: 'req-quick', mode: 'quick' })
    const longterm = createProject({ request_id: 'req-long', mode: 'longterm' })
    const base = { request_id: 'req-sync', session_id: 'session-1' }

    syncDocuments({ ...base, project_id: quick.project_id, checkpoint: 'sketch_confirmed' })
    syncDocuments({ ...base, project_id: longterm.project_id, checkpoint: 'sketch_confirmed' })

    const quickDir = getDocumentsDir(quick.workspace_slug, quick.project_id)
    const longDir = getDocumentsDir(longterm.workspace_slug, longterm.project_id)
    expect(existsSync(join(quickDir, 'plantuml', 'architecture.puml'))).toBe(false)
    expect(existsSync(join(quickDir, 'sprint', 'sprint-plan.md'))).toBe(false)
    expect(readFileSync(join(longDir, 'plantuml', 'architecture.puml'), 'utf8')).toContain('@startuml')
    expect(readFileSync(join(longDir, 'sprint', 'sprint-plan.md'), 'utf8')).toContain('Sprint')
  })

  it('marks a previously synced document stale when the same checkpoint is re-synced', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-doc-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const base = { request_id: 'req-sync', session_id: 'session-1', project_id: project.project_id }

    const first = syncDocuments({ ...base, checkpoint: 'sketch_confirmed' })
    const second = syncDocuments({ ...base, checkpoint: 'sketch_confirmed' })

    expect(first.stale_documents).toHaveLength(0)
    // sketch_confirmed 现产出两个文件（sketch_confirmed.md + prd.json），重同步时均标记为 stale
    expect(second.stale_documents.map((doc) => doc.status)).toEqual(['stale', 'stale'])
    expect(second.documents[0].status).toBe('synced')
  })
})
