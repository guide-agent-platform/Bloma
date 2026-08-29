import { restorePromaHome } from '../support/proma-home-guard'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendPrdRequirements, isPrdUserConfirmed, listDocuments, markPrdUserConfirmed, readDocument, syncDocuments } from '../../main/document-engine'
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

  it('sketch_confirmed 重建 prd.json 继承盘上 user_confirmed_at（2026-08-29 线上：MVP 交付后点选纠错被误判未确认踢回确认流）', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-doc-confirm-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project-confirm', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '做一个记账计算器' }])

    // 线上时序：requirement_confirmed 落盘 prd.json → 用户在确认卡确认 → 草图 → 点「生成完整功能」
    syncDocuments({
      request_id: 'req-sync-confirm-1',
      session_id: 'session-confirm',
      project_id: project.project_id,
      checkpoint: 'requirement_confirmed',
    })
    expect(markPrdUserConfirmed(project.project_id)).not.toBeNull()
    expect(isPrdUserConfirmed(project.project_id)).toBe(true)

    // 修复前：此处全量重建丢 user_confirmed_at → isPrdUserConfirmed false → 迭代/点选纠错死局
    syncDocuments({
      request_id: 'req-sync-confirm-2',
      session_id: 'session-confirm',
      project_id: project.project_id,
      checkpoint: 'sketch_confirmed',
    })
    expect(isPrdUserConfirmed(project.project_id)).toBe(true)
    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    const prd = JSON.parse(readFileSync(join(dir, 'prd.json'), 'utf8'))
    expect(prd.user_confirmed_at).toBeTruthy()
  })

  it('appendPrdRequirements：盘上现状内部编号（盘上条目多于传入清单时不碰撞丢想法，审查修复 P1）+ 全字段保留', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-doc-append-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-append', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '做一个音乐合成器' }])

    syncDocuments({
      request_id: 'req-append-1',
      session_id: 'session-append',
      project_id: project.project_id,
      checkpoint: 'requirement_confirmed',
    })
    expect(markPrdUserConfirmed(project.project_id)).not.toBeNull()

    // 盘上人工加厚到 F-005（模拟 enrichment 已扩展，比 pending 薄清单多）
    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    const prd = JSON.parse(readFileSync(join(dir, 'prd.json'), 'utf8'))
    prd.requirements.push(
      { id: 'F-002', description: '虚拟键盘' },
      { id: 'F-005', description: '录音回放' },
    )
    require('node:fs').writeFileSync(join(dir, 'prd.json'), JSON.stringify(prd, null, 2) + '\n')

    // 采纳两条想法（不传 id，内部应按盘上 max=5 编号为 F-006/F-007，而非 length+1 碰撞被丢）
    const updated = appendPrdRequirements(project.project_id, [
      { description: '参考市面做法：步进音序器', origin: 'user' },
      { description: '参考市面做法：音色参数实验', origin: 'user' },
    ])
    expect(updated).not.toBeNull()
    const ids = updated!.requirements.map((item) => item.id)
    expect(ids).toContain('F-006')
    expect(ids).toContain('F-007')
    expect(updated!.requirements).toHaveLength(5)
    // 全字段保留：确认标记仍在
    expect(updated!.user_confirmed_at).toBeTruthy()
    // 幂等：重复追加同描述被去重
    const again = appendPrdRequirements(project.project_id, [
      { description: '参考市面做法：步进音序器', origin: 'user' },
    ])
    expect(again!.requirements).toHaveLength(5)
  })

  it('requirement_confirmed checkpoint: 状态行如实（不谎报草图已确认）+ 无 priority 条目不渲染缺省 P2（abb1a19f）', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-doc-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project-2', mode: 'quick' })
    recordSketchGenerated(project.project_id, [
      { id: 'F-001', description: '做一个电子合成音乐平台', priority: 'P0' },
      // 模拟 enrichment prioritySuppressed 后的条目：无 priority 字段
      { id: 'F-002', description: '提供氛围类电子音乐在线试听' },
    ])

    syncDocuments(
      {
        request_id: 'req-sync-2',
        session_id: 'session-2',
        project_id: project.project_id,
        checkpoint: 'requirement_confirmed',
      },
      // 线上同款路径：resolvePrdBackplane 产物作 override（enrichment 抑制后 priority 缺失保留），
      // 不走 buildPrdBackplane 的构建侧物化
      {
        project_id: project.project_id,
        name: '未命名项目',
        positioning: '做一个电子合成音乐平台',
        requirements: [
          { id: 'F-001', description: '做一个电子合成音乐平台', priority: 'P0' },
          { id: 'F-002', description: '提供氛围类电子音乐在线试听' },
        ],
        out_of_scope: [],
        constraints: [],
        acceptance: {},
        assumptions: [],
      },
    )

    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    const prd = readFileSync(join(dir, 'requirement_confirmed.md'), 'utf8')
    // 修复②：需求确认检查点不得谎报「草图已确认」（草图还没画）
    expect(prd).toContain('需求已确认，PRD 草案形成')
    expect(prd).not.toContain('草图已确认')
    // 修复③a：显式优先级照常渲染，被抑制的条目不再硬标缺省 P2
    expect(prd).toContain('**F-001**（P0）')
    expect(prd).toContain('**F-002**')
    expect(prd).not.toContain('**F-002**（P2）')
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

  // 用户裁决（2026-08-28 09:05）：GA-03 P1 changelog 语义 = 追加式。
  // 每轮迭代完成后 append 历史条目（时间戳 + 本轮变更记录 + 功能项变化），
  // 历史条目 append-only 永不改写（PRD §7.1「每轮迭代结束后追加 Changelog」字面语义）。
  it('[S4-DOCUMENT-007] changelog 追加式：第二轮同步保留第一轮历史条目（append-only）', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-doc-iter-append-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    const changelogPath = join(dir, 'iteration_completed.md')

    // 第一轮：F-001 + F-002
    recordSketchGenerated(project.project_id, [
      { id: 'F-001', description: '记录收入与支出' },
      { id: 'F-002', description: '导出月度报表' },
    ])
    syncDocuments({ request_id: 'req-iter-r1', session_id: 'session-1', project_id: project.project_id, checkpoint: 'iteration_completed' })
    const afterRound1 = readFileSync(changelogPath, 'utf8')

    // 第二轮：F-002 消失、F-003 新增
    recordSketchGenerated(project.project_id, [
      { id: 'F-001', description: '记录收入与支出' },
      { id: 'F-003', description: '导出CSV文件' },
    ])
    syncDocuments({ request_id: 'req-iter-r2', session_id: 'session-1', project_id: project.project_id, checkpoint: 'iteration_completed' })

    const changelog = readFileSync(changelogPath, 'utf8')
    // append-only 铁律：第一轮历史条目逐字保留（旧覆盖式实现会丢失「导出月度报表」）
    expect(changelog).toContain(afterRound1)
    expect(changelog).toContain('导出月度报表')
    // 新条目反映第二轮当前清单
    expect(changelog).toContain('导出CSV文件')
    // 轮次计数：两个条目标题，第 1 轮 → 第 2 轮
    expect(changelog).toContain('第 1 轮迭代')
    expect(changelog).toContain('第 2 轮迭代')
  })

  it('[S4-DOCUMENT-008] changelog 追加式：新条目标注功能项变化（新增/移除）', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-doc-iter-diff-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const dir = getDocumentsDir(project.workspace_slug, project.project_id)

    recordSketchGenerated(project.project_id, [
      { id: 'F-001', description: '记录收入与支出' },
      { id: 'F-002', description: '导出月度报表' },
    ])
    syncDocuments({ request_id: 'req-iter-r1', session_id: 'session-1', project_id: project.project_id, checkpoint: 'iteration_completed' })

    recordSketchGenerated(project.project_id, [
      { id: 'F-001', description: '记录收入与支出' },
      { id: 'F-003', description: '导出CSV文件' },
    ])
    syncDocuments({ request_id: 'req-iter-r2', session_id: 'session-1', project_id: project.project_id, checkpoint: 'iteration_completed' })

    const changelog = readFileSync(join(dir, 'iteration_completed.md'), 'utf8')
    // 功能项变化段：相对上一条历史条目的 diff
    expect(changelog).toContain('新增 F-003')
    expect(changelog).toContain('移除 F-002')
    // 首轮条目不带 diff 标注（无基线，如实记录首次记录）
    expect(changelog).toContain('首次记录')
  })

  it('[S4-DOCUMENT-009] changelog 追加式：旧覆盖式遗留文件兼容追加（原内容原样保留）', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-doc-iter-legacy-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    const changelogPath = join(dir, 'iteration_completed.md')
    // 改造上线前旧实现产出的覆盖式文件（无轮次编号格式）
    const legacy = [
      '# 变更记录',
      '',
      '> 迭代完成时间：2026-08-27T10:00:00.000Z（checkpoint: iteration_completed）',
      '',
      '## 当前功能项清单',
      '',
      '- F-001：记录收入与支出',
      '',
    ].join('\n')
    mkdirSync(dir, { recursive: true })
    writeFileSync(changelogPath, legacy, 'utf8')

    recordSketchGenerated(project.project_id, [{ id: 'F-002', description: '导出月度报表' }])
    syncDocuments({ request_id: 'req-iter-legacy', session_id: 'session-1', project_id: project.project_id, checkpoint: 'iteration_completed' })

    const changelog = readFileSync(changelogPath, 'utf8')
    // 旧内容原样保留（append-only 不改写历史）
    expect(changelog).toContain(legacy.trimEnd())
    // 新条目从第 1 轮开始编号（旧格式无轮次编号，无法归轮，如实从新起算）
    expect(changelog).toContain('第 1 轮迭代')
    expect(changelog).toContain('导出月度报表')
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
