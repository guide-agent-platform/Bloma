import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyGeneratedProjectName, createProject, findProject, renameProject, sanitizeGeneratedProjectName, updateProject } from '../../main/project/project-service'
import { resolvePrdBackplane } from '../../main/guide/pipeline'
import { readPrdBackplane, syncDocuments } from '../../main/project/document-engine'
import { provisionDesktopSkeletonV2 } from '../../main/desktop/skeleton-provision'
import { getAgentSessionPath, getDocumentsDir } from '../../storage/config-paths'
import { appendJsonLine } from '../../storage/json-store'
import { restorePromaHome } from '../support/proma-home-guard'
import type { SDKQuery, SDKQueryOptions } from '../../main/orchestration/orchestrator'

vi.mock('../../main/platform/llm/runtime-fallback', () => ({
  resolveChannelEnv: () => ({ env: {}, channel: { max_tokens: 4096 } }),
}))

describe('PRD 同轮自动命名', () => {
  const originalHome = process.env.PROMA_HOME
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bloma-auto-name-'))
    process.env.PROMA_HOME = home
  })
  afterEach(() => {
    restorePromaHome(originalHome)
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  function prepare() {
    const project = createProject({ request_id: 'new-name', mode: 'quick', initial_message: '帮我做一个能安排每天学习时间并记录完成次数的程序' })
    const sessionId = `naming-${project.project_id}`
    appendJsonLine(getAgentSessionPath(sessionId), { role: 'user', content: [{ type: 'text', text: '我想管理每天的专注时间，完成后记录一次。' }], timestamp: Date.now() })
    return { project, sessionId, requirements: [{ id: 'F-001', description: '计时并记录完成次数' }] }
  }

  function model(name: unknown, onPrd?: () => void) {
    const calls: Array<{ prompt: string; options: SDKQueryOptions }> = []
    const query: SDKQuery = async function* (prompt, options) {
      calls.push({ prompt, options })
      const isEnricher = JSON.stringify(options.history).includes('需求加厚腿')
      if (!isEnricher) onPrd?.()
      const value = isEnricher ? { requirements: [{ id: 'F-001', story: '计时并记录完成次数', behavior_assertions: [], priority: 'P0' }] } : {
        ...(name === undefined ? {} : { name }),
        document: '# PRD：晨光专注\n## 功能\n计时并记录完成次数', positioning: '个人专注计时工具',
        acceptance: { 'F-001': '计时结束后完成次数增加一' }, out_of_scope: [], assumptions: [],
      }
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(value) }] } }
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
    return { query, calls }
  }

  it('模型概括名替换消息截取名，同步项目/PRD/新骨架，沿用两条原有模型调用', async () => {
    const { project, sessionId, requirements } = prepare()
    // 模拟用户旧覆盖：命名附录仍由平台追加，用户不用更新此文件。
    mkdirSync(join(home, 'prompts'), { recursive: true })
    writeFileSync(join(home, 'prompts', 'prd-system.md'), '用户的 PRD 提炼规则', 'utf8')
    const { query, calls } = model('“晨光专注”')
    const backplane = await resolvePrdBackplane({ project_id: project.project_id, session_id: sessionId, query }, requirements)
    expect(findProject(project.project_id)).toMatchObject({ name: '晨光专注', name_source: 'model', auto_named: true, root_path: project.root_path })
    expect(backplane.name).toBe('晨光专注')
    expect(backplane.prd_document).toContain('# PRD：晨光专注')
    expect(calls).toHaveLength(2) // PRD + 加厚，不新增独立命名请求。
    const prdCall = calls.find((call) => !JSON.stringify(call.options.history).includes('需求加厚腿'))!
    expect(JSON.stringify(prdCall.options.history)).toContain('【产品命名】')
    expect(JSON.stringify(prdCall.options.history)).toContain('用户的 PRD 提炼规则')
    syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: sessionId, checkpoint: 'requirement_confirmed' }, backplane)
    expect(readPrdBackplane(project.project_id).name).toBe('晨光专注')
    expect(JSON.parse(readFileSync(join(getDocumentsDir(project.workspace_slug, project.project_id), 'prd.json'), 'utf8')).name).toBe('晨光专注')
    provisionDesktopSkeletonV2(project.root_path, findProject(project.project_id).name)
    expect(readFileSync(join(project.root_path, 'app.py'), 'utf8')).toContain('晨光专注')
    expect(existsSync(project.root_path)).toBe(true)
  })

  it.each([undefined, '', null, '名称说明\n晨光专注', '太长'.repeat(30)])('模型名称无效（%s）时保留临时名，PRD 继续生成', async (candidate) => {
    const { project, sessionId, requirements } = prepare()
    const { query } = model(candidate)
    const backplane = await resolvePrdBackplane({ project_id: project.project_id, session_id: sessionId, query }, requirements)
    expect(backplane.name).toBe(project.name)
    expect(findProject(project.project_id).auto_named).not.toBe(true)
    expect(backplane.acceptance['F-001']).toContain('增加一')
  })

  it('请求期间手动改名为同一个临时名称也锁定用户选择，不被迟到结果覆盖', async () => {
    const { project, sessionId, requirements } = prepare()
    const { query } = model('晨光专注', () => { renameProject({ request_id: 'manual', project_id: project.project_id, name: project.name }) })
    const backplane = await resolvePrdBackplane({ project_id: project.project_id, session_id: sessionId, query }, requirements)
    expect(findProject(project.project_id)).toMatchObject({ name: project.name, name_source: 'user', auto_named: true })
    expect(backplane.name).toBe(project.name)
    expect(backplane.prd_document).toContain(`# PRD：${project.name}`)
  })

  it('已定名重跑沿用原名，用户手动名称传入模型任务', async () => {
    const { project, sessionId, requirements } = prepare()
    renameProject({ request_id: 'manual', project_id: project.project_id, name: '我的学习钟' })
    const { query, calls } = model('另一个模型名')
    const backplane = await resolvePrdBackplane({ project_id: project.project_id, session_id: sessionId, query }, requirements)
    expect(backplane.name).toBe('我的学习钟')
    expect(calls.some((call) => call.prompt.includes('【已定名称】"我的学习钟"'))).toBe(true)
    expect(applyGeneratedProjectName(project.project_id, '我的学习钟', '替换名')).toBe(false)
  })

  it('已生成项目、已归档和名称来源未知的旧项目保持原名', () => {
    for (const patch of [{ desktop_phase: 'desktop-implement' }, { status: 'archived' }, { name_source: undefined }]) {
      const { project } = prepare()
      updateProject(project.project_id, patch as Parameters<typeof updateProject>[1])
      expect(applyGeneratedProjectName(project.project_id, project.name, '晨光专注')).toBe(false)
      expect(findProject(project.project_id).name).toBe(project.name)
    }
  })

  it('停止后不提交自动名称；已删除项目的迟到候选不抛错', async () => {
    const { project, sessionId, requirements } = prepare()
    const controller = new AbortController()
    const { query } = model('晨光专注', () => controller.abort())
    await resolvePrdBackplane({ project_id: project.project_id, session_id: sessionId, query, signal: controller.signal }, requirements)
    expect(findProject(project.project_id).name).toBe(project.name)
    expect(applyGeneratedProjectName('missing-project', '未命名项目', '晨光专注')).toBe(false)
  })

  it('生成名清洗去掉包裹引号与文件名非法字符，拒绝占位/无内容', () => {
    expect(sanitizeGeneratedProjectName(' 「晨光:专注」 ')).toBe('晨光专注')
    expect(sanitizeGeneratedProjectName('未命名项目')).toBeUndefined()
    expect(sanitizeGeneratedProjectName({ name: '钟' })).toBeUndefined()
    expect(sanitizeGeneratedProjectName('***')).toBeUndefined()
  })
})
