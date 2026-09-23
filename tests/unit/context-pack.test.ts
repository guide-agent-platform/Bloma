import { restorePromaHome } from '../support/proma-home-guard'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject, findProject } from '../../main/project/project-service'
import { recordSessionActivity } from '../../main/platform/sessions/session-service'
import { writeTestReport } from '../../main/verification/gwt-service'
import type { PrdBackplane } from '../../main/model/prd-backplane'
import { recordDecision } from '../../main/project/decision-log'
import {
  appendContextPack,
  buildContextPack,
  contextPackEnabled,
  renderContextPackSection,
} from '../../main/coding/context-pack'

// 决策留痕断言用 mock（context-pack 与本测试图内仅 recordDecision 消费面）
vi.mock('../../main/project/decision-log', () => ({
  DECISION_PREFIX: '[decision]',
  recordDecision: vi.fn(),
  exportDecisionsMd: vi.fn(),
  parseDecisionText: vi.fn(() => undefined),
}))

/**
 * Phase 10 W1-3（2026-09-16）：项目侦察包——确定性组装（零 LLM）+ 迭代/修复轮 task
 * 头注入。关键语义：①开关缺省 off=appendContextPack 返回原 task 字节级；②空态如实
 * 为空不编造；③契约⇄路由对账 hints；④截断保预算；⑤决策留痕 fail-open。
 */
describe('context-pack 开关与注入语义', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalSwitch = process.env.BLOMA_CONTEXT_PACK
  let home: string
  let projectId: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'proma-cpack-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-create', mode: 'quick' })
    recordSessionActivity('session-cpack', project.project_id)
    projectId = project.project_id
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    if (originalSwitch === undefined) delete process.env.BLOMA_CONTEXT_PACK
    else process.env.BLOMA_CONTEXT_PACK = originalSwitch
    vi.restoreAllMocks()
  })

  function backplaneWith(spec: Array<{ endpoint: string; method?: string }>): PrdBackplane {
    return {
      project_id: projectId,
      name: '测试项目',
      positioning: '定位',
      requirements: [],
      acceptance: {},
      out_of_scope: [],
      assumptions: [],
      interface_spec: spec.map((s) => ({ endpoint: s.endpoint, ...(s.method ? { method: s.method } : {}) })),
    } as PrdBackplane
  }

  it('开关缺省 off；1/on/true 开；0/off/false 关', () => {
    delete process.env.BLOMA_CONTEXT_PACK
    expect(contextPackEnabled()).toBe(false)
    process.env.BLOMA_CONTEXT_PACK = '1'
    expect(contextPackEnabled()).toBe(true)
    process.env.BLOMA_CONTEXT_PACK = 'false'
    expect(contextPackEnabled()).toBe(false)
    process.env.BLOMA_CONTEXT_PACK = 'true'
    expect(contextPackEnabled()).toBe(true)
    process.env.BLOMA_CONTEXT_PACK = '0'
    expect(contextPackEnabled()).toBe(false)
  })

  it('off：appendContextPack 返回原 task 字节级（不触 fs）', () => {
    delete process.env.BLOMA_CONTEXT_PACK
    const task = '【本轮任务】改一下列表'
    expect(appendContextPack({ projectId, sessionId: 'session-cpack', task, changeQuery: '列表' })).toBe(task)
  })

  it('空项目：全空态如实（无契约无路由无数据无基线），段渲染不编造，注入后 task 含侦察包标题', () => {
    process.env.BLOMA_CONTEXT_PACK = '1'
    const pack = buildContextPack(projectId)
    expect(pack.codeFiles).toEqual([])
    expect(pack.routes).toEqual([])
    expect(pack.dataFiles).toEqual([])
    expect(pack.reusableModules).toEqual([])
    expect(pack.baseline).toBeNull()
    expect(pack.openQuestions).toEqual([])
    const section = renderContextPackSection(pack)
    expect(section).toContain('【项目侦察包')
    expect(section).toContain('后端契约与路由：无')
    expect(section).toContain('无历史测试报告')
    const task = appendContextPack({ projectId, sessionId: 'session-cpack', task: '任务本体', changeQuery: '诉求' })
    expect(task.startsWith('任务本体')).toBe(true)
    expect(task).toContain('【项目侦察包')
  })

  it('契约⇄路由对账：双侧均在=both 且无 hint', () => {
    process.env.BLOMA_CONTEXT_PACK = '1'
    const root = findProject(projectId).root_path
    mkdirSync(join(root, 'server', 'routes'), { recursive: true })
    writeFileSync(join(root, 'server', 'routes', 'notes.js'), 'module.exports = {}', 'utf8')
    writeFileSync(join(root, 'server', 'routes', '_example.js'), '// 只读样例不参与对账', 'utf8')
    const pack = buildContextPack(projectId, undefined, { backplaneOverride: backplaneWith([{ endpoint: '/api/notes', method: 'GET' }]) })
    const both = pack.routes.find((r) => r.source === 'both')
    expect(both?.label).toContain('GET /api/notes')
    expect(pack.affectedHints).toEqual([]) // _example 跳过、无残留 hint
  })

  it('对账 hints：契约端点无路由文件 / 路由文件不在契约', () => {
    process.env.BLOMA_CONTEXT_PACK = '1'
    const root = findProject(projectId).root_path
    mkdirSync(join(root, 'server', 'routes'), { recursive: true })
    writeFileSync(join(root, 'server', 'routes', 'scores.js'), 'module.exports = {}', 'utf8')
    const pack = buildContextPack(projectId, undefined, { backplaneOverride: backplaneWith([{ endpoint: '/api/notes' }]) })
    expect(pack.affectedHints.some((h) => h.includes('/api/notes') && h.includes('无对应文件'))).toBe(true)
    expect(pack.affectedHints.some((h) => h.includes('scores.js') && h.includes('不在 interface_spec'))).toBe(true)
  })

  it('data 采样：array 形状+首条键；坏 JSON 标 unreadable 不抛错', () => {
    process.env.BLOMA_CONTEXT_PACK = '1'
    const root = findProject(projectId).root_path
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'notes.json'), JSON.stringify([{ id: '1', content: 'x', createdAt: 't' }]), 'utf8')
    writeFileSync(join(root, 'data', 'bad.json'), '{oops', 'utf8')
    const pack = buildContextPack(projectId)
    const notes = pack.dataFiles.find((d) => d.file === 'data/notes.json')
    expect(notes?.shape).toBe('array')
    expect(notes?.sampleKeys).toEqual(['id', 'content', 'createdAt'])
    expect(pack.dataFiles.find((d) => d.file === 'data/bad.json')?.shape).toBe('unreadable')
  })

  it('影响面提示：诉求关键词命中相关文件路径', () => {
    process.env.BLOMA_CONTEXT_PACK = '1'
    const root = findProject(projectId).root_path
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'notes-list.js'), 'export {}', 'utf8')
    writeFileSync(join(root, 'src', 'settings.js'), 'export {}', 'utf8')
    const pack = buildContextPack(projectId, '改一下 notes 列表显示', { backplaneOverride: backplaneWith([]) })
    expect(pack.affectedHints.some((h) => h.includes('「notes」') && h.includes('src/notes-list.js'))).toBe(true)
  })

  it('基线测试：读上次 test-report（含未过场景清单）', () => {
    process.env.BLOMA_CONTEXT_PACK = '1'
    writeTestReport({
      request_id: 'r',
      session_id: 'session-cpack',
      project_id: projectId,
      result: {
        total_count: 3,
        passed_count: 2,
        failed_count: 1,
        failure_summary: [{ scenario: '新增记录后刷新仍在', reason: '断言未命中' }],
      },
    })
    const pack = buildContextPack(projectId)
    expect(pack.baseline).toEqual({ total: 3, passed: 2, failed: 1, failedScenarios: ['新增记录后刷新仍在'] })
    expect(renderContextPackSection(pack)).toContain('2/3 过')
  })

  it('截断：超 60 文件封顶；渲染段不超预算', () => {
    process.env.BLOMA_CONTEXT_PACK = '1'
    const root = findProject(projectId).root_path
    mkdirSync(join(root, 'src'), { recursive: true })
    for (let i = 0; i < 80; i++) writeFileSync(join(root, 'src', `m${String(i).padStart(3, '0')}.js`), 'export {}', 'utf8')
    const pack = buildContextPack(projectId)
    expect(pack.codeFiles.length).toBe(60)
    const section = renderContextPackSection(pack)
    expect(section.length).toBeLessThanOrEqual(2300)
    expect(section).toContain('仅列前 40')
  })

  it('可复用模块：official-modules 子目录清单', () => {
    process.env.BLOMA_CONTEXT_PACK = '1'
    const root = findProject(projectId).root_path
    mkdirSync(join(root, 'src', 'official-modules', 'storage-state'), { recursive: true })
    mkdirSync(join(root, 'src', 'official-modules', 'modal-dialog'), { recursive: true })
    const pack = buildContextPack(projectId)
    expect(pack.reusableModules).toEqual(['modal-dialog', 'storage-state'])
    expect(renderContextPackSection(pack)).toContain('official-modules/storage-state')
  })

  it('on：注入即决策留痕（recordDecision 收到 context_pack 条目+统计 detail）', () => {
    process.env.BLOMA_CONTEXT_PACK = '1'
    const mock = vi.mocked(recordDecision)
    mock.mockClear()
    appendContextPack({ projectId, sessionId: 'session-cpack', task: '任务', changeQuery: '诉求' })
    const call = mock.mock.calls.map((c) => c[0]).find((input) => input.entry.type === 'context_pack')
    expect(call).toBeTruthy()
    expect(call?.entry.detail).toMatchObject({
      code_files: expect.any(Number),
      routes: expect.any(Number),
      data_files: expect.any(Number),
    })
  })
})
