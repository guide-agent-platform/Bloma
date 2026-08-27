import { restorePromaHome } from '../support/proma-home-guard'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listDocuments, readDocument, syncDocuments } from '../../main/document-engine'
import { createProject, recordSketchGenerated, updateProject } from '../../main/project-service'
import { getDocumentsDir } from '../../storage/config-paths'

describe('DocumentEngine (A2-05)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
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
    // 结构化 PRD 背板（密背板版）：产品定位 + 用户故事与行为断言 + 范围外
    expect(prd).toContain('产品定位')
    expect(prd).toContain('用户故事与行为断言')
    expect(prd).toContain('行为断言：该功能项在产物中可见且可交互')
    expect(prd).toContain('范围外')
    expect(result.documents.length).toBeGreaterThan(0)
    expect(result.documents[0].status).toBe('synced')
    expect(result.documents[0].type).toBe('prd')
  })

  it('renders thick backplane: story/assertions/priority materialized into prd.json; scope_exclusions merged into out_of_scope', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-doc-thick-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    updateProject(project.project_id, { scope_exclusions: ['不做排行榜', '不做登录'] })
    recordSketchGenerated(project.project_id, [
      {
        id: 'F-001',
        description: '赛车模拟器',
        story: '作为玩家，我想驾驶赛车，以便获得竞速体验',
        behavior_assertions: ['按右方向键→车辆 x 坐标增加'],
        priority: 'P0',
      },
      { id: 'F-002', description: '历史记录' },
    ])

    // prd.json 产自 sketch_confirmed；mvp_before_generation.md 是用户可读渲染（两检查点各取所需）
    syncDocuments({
      request_id: 'req-sync',
      session_id: 'session-1',
      project_id: project.project_id,
      checkpoint: 'sketch_confirmed',
    })
    syncDocuments({
      request_id: 'req-sync',
      session_id: 'session-1',
      project_id: project.project_id,
      checkpoint: 'mvp_before_generation',
    })

    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    const backplane = JSON.parse(readFileSync(join(dir, 'prd.json'), 'utf8'))
    // 薄项（F-002）构建侧归一化：story 回退 description、默认断言、P2（不触发 P0 门禁）
    expect(backplane.requirements[0]).toMatchObject({
      id: 'F-001',
      story: '作为玩家，我想驾驶赛车，以便获得竞速体验',
      behavior_assertions: ['按右方向键→车辆 x 坐标增加'],
      priority: 'P0',
    })
    expect(backplane.requirements[1]).toMatchObject({
      id: 'F-002',
      story: '历史记录',
      behavior_assertions: ['该功能项在产物中可见且可交互'],
      priority: 'P2',
    })
    // normalizer 判定的范围声明并入 out_of_scope
    expect(backplane.out_of_scope).toEqual(['不做排行榜', '不做登录'])
    // 用户可读渲染：故事 + 断言 + 优先级 + 范围排除
    const full = readFileSync(join(dir, 'mvp_before_generation.md'), 'utf8')
    expect(full).toContain('用户故事与行为断言')
    expect(full).toContain('作为玩家，我想驾驶赛车，以便获得竞速体验')
    expect(full).toContain('行为断言：按右方向键→车辆 x 坐标增加')
    expect(full).toContain('不做排行榜')
    // 无 ux_contract 时不渲染草图契约段（质量门未通过 → PRD-only）
    expect(full).not.toContain('草图契约')
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

  it('[S4-DOCUMENT-001] appends a changelog on iteration_completed with current feature set and timestamp', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-doc-iter-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [
      { id: 'F-001', description: '记录收入与支出' },
      { id: 'F-002', description: '导出月度报表' },
    ])

    const result = syncDocuments({
      request_id: 'req-iter',
      session_id: 'session-1',
      project_id: project.project_id,
      checkpoint: 'iteration_completed',
    })

    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    const changelog = readFileSync(join(dir, 'iteration_completed.md'), 'utf8')
    expect(changelog).toContain('变更记录')
    expect(changelog).toContain('F-001')
    expect(changelog).toContain('F-002')
    // 合并本轮反馈：changelog 引用当前功能项清单（非静态占位）
    expect(changelog).toContain('记录收入与支出')
    expect(changelog).toContain('导出月度报表')
    // 时间戳：changelog 记录迭代完成时刻
    expect(changelog).toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(result.documents[0].type).toBe('changelog')
    expect(result.documents[0].status).toBe('synced')
    expect(listDocuments(project.project_id).some((d) => d.type === 'changelog')).toBe(true)

    // 幂等/覆盖语义：再次同步同检查点 → 旧 changelog 标记 stale，仍只保留一份 synced
    const second = syncDocuments({
      request_id: 'req-iter-2',
      session_id: 'session-1',
      project_id: project.project_id,
      checkpoint: 'iteration_completed',
    })
    expect(second.stale_documents.length).toBe(1)
    const synced = listDocuments(project.project_id).filter((d) => d.type === 'changelog')
    expect(synced.filter((d) => d.status === 'synced').length).toBe(1)
  })

  it('[S4-DOCUMENT-004] 无功能项时 changelog 不伪造默认项，输出「本轮无功能项变更」', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-doc-iter-empty-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    // 不 recordSketchGenerated：需求清单为空

    syncDocuments({
      request_id: 'req-iter-empty',
      session_id: 'session-1',
      project_id: project.project_id,
      checkpoint: 'iteration_completed',
    })

    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    const changelog = readFileSync(join(dir, 'iteration_completed.md'), 'utf8')
    expect(changelog).toContain('变更记录')
    // 不套用 PRD 草案默认回退（F-001 是用户从未提过的占位项）
    expect(changelog).not.toContain('F-001')
    expect(changelog).toContain('本轮无功能项变更')
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

describe('DocumentEngine 文档面板（U2）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  it('lists synced documents, skipping stale overrides', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-doc-list-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    const base = { request_id: 'req-sync', session_id: 'session-1', project_id: project.project_id }

    // 首次同步 → 2 份文档；再次同步 → 旧版本 stale，仅保留最新
    syncDocuments({ ...base, checkpoint: 'sketch_confirmed' })
    syncDocuments({ ...base, checkpoint: 'sketch_confirmed' })

    const documents = listDocuments(project.project_id)
    expect(documents.length).toBeGreaterThan(0)
    expect(documents.every((doc) => doc.status !== 'stale')).toBe(true)
    expect(documents.every((doc) => doc.type === 'prd')).toBe(true)
    expect(documents.some((doc) => doc.path.endsWith('sketch_confirmed.md'))).toBe(true)
  })

  it('reads a document by id and returns its content', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-doc-read-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({
      request_id: 'req-sync',
      session_id: 'session-1',
      project_id: project.project_id,
      checkpoint: 'sketch_confirmed',
    })

    const documents = listDocuments(project.project_id)
    const target = documents.find((doc) => doc.path.endsWith('sketch_confirmed.md'))
    expect(target).toBeDefined()

    const result = readDocument(project.project_id, target!.document_id)
    expect(result.document.document_id).toBe(target!.document_id)
    expect(result.document.type).toBe('prd')
    expect(result.content).toContain('PRD 草案')
  })

  it('throws DOCUMENT_NOT_FOUND for an unknown document id', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-doc-missing-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    syncDocuments({
      request_id: 'req-sync',
      session_id: 'session-1',
      project_id: project.project_id,
      checkpoint: 'sketch_confirmed',
    })

    expect(() => readDocument(project.project_id, 'no-such-document')).toThrow('DOCUMENT_NOT_FOUND')
  })
})
