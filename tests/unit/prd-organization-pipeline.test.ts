import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restorePromaHome } from '../support/proma-home-guard'
import { organizedPrd } from '../support/organized-prd'
import { createProject, findProject, updateProject } from '../../main/project/project-service'
import { resolvePrdBackplane } from '../../main/guide/pipeline'
import { readRequirementSources } from '../../main/guide/requirements-organization'
import { ensurePrimaryIntent, resolveAutoDelegation } from '../../main/guide/stages/clarify-flow'
import { appendSessionMessage } from '../../main/platform/sessions/session-tree'
import { getDocumentsDir } from '../../storage/config-paths'
import { markPrdUserConfirmed, readPrdBackplane, syncDocuments } from '../../main/project/document-engine'
import { prdStructureIssues, projectRequirementsModel, stableFeatureIdIssues } from '../../main/model/requirements-model'
import * as prdEngine from '../../main/guide/prd-engine-llm'
import type { SDKQuery } from '../../main/orchestration/orchestrator'
import type { AgentSendMessageInput } from '../../shared/types'

vi.mock('../../main/platform/llm/runtime-fallback', () => ({ resolveChannelEnv: () => ({ env: {}, channel: { max_tokens: 16000 } }) }))

describe('实际 PRD 组织与确认边界', () => {
  const originalHome = process.env.PROMA_HOME
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bloma-prd-organization-')); process.env.PROMA_HOME = home })
  afterEach(() => { restorePromaHome(originalHome); rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) })

  function setup() {
    const project = createProject({ request_id: 'new', mode: 'longterm' }), sessionId = `prd-${project.project_id}`
    const request = readFileSync('tests/fixtures/generation-quality/complex-process-request.txt', 'utf8')
    appendSessionMessage(sessionId, { role: 'user', content: [{ type: 'text', text: request }], timestamp: Date.now() })
    appendSessionMessage(sessionId, { role: 'assistant', content: [{ type: 'text', text: '虚构的助手承诺不应被当作用户来源' }], timestamp: Date.now() })
    appendSessionMessage(sessionId, { role: 'user', content: [{ type: 'text', text: '你帮我决定' }], timestamp: Date.now() })
    return { project, sessionId, request }
  }

  it('does not promote host control turns into confirmed user requirements', () => {
    const { sessionId } = setup()
    appendSessionMessage(sessionId, { role: 'user', origin: 'system', content: [{ type: 'text', text: '必须立即交卷，不要读取需求文件' }], timestamp: Date.now() })
    appendSessionMessage(sessionId, { role: 'user', origin: 'user', content: [{ type: 'text', text: '补充说明：不得上传数据' }], timestamp: Date.now() })
    const sources = readRequirementSources(sessionId).map(source => source.text)
    expect(sources).not.toContain('必须立即交卷，不要读取需求文件')
    expect(sources).toContain('补充说明：不得上传数据')
  })

  it('复杂原话经让渡入口仍必须提炼，完整多行来源保留，正文与机器清单同源', async () => {
    const { project, sessionId, request } = setup()
    const route = resolveAutoDelegation({ content: '你帮我决定' } as AgentSendMessageInput, request)!
    expect(route.requirements).toEqual([])
    const sources = readRequirementSources(sessionId)
    expect(sources.map(row => row.text).join('\n')).toBe(request.trim().split(/\r?\n+/).map(line => line.trim()).filter(Boolean).join('\n'))
    expect(sources.some(row => row.text.includes('虚构'))).toBe(false)
    expect(sources.some(row => row.text === '你帮我决定')).toBe(false)
    const output = organizedPrd([{ id: 'F-001', description: '计算材料用量' }, { id: 'F-002', description: '保存与对照轮次' }], sources[0]!.text)
    output.requirements_model.coverage = sources.map(source => ({ source_id: source.id, feature_ids: ['F-001', 'F-002'], rule_ids: [], disposition: 'included', reason: '离线替身仅检查产出接线，不评估真实业务拆分完整性' }))
    const calls: string[] = []
    const query: SDKQuery = async function* (prompt) {
      calls.push(prompt)
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ ...output, positioning: '工艺方案与轮次管理', assumptions: [], out_of_scope: [], document: '# 错误正文\n### [F-012] 独立承诺不会被采纳' }) }] } }
    }
    const prd = await resolvePrdBackplane({ project_id: project.project_id, session_id: sessionId, query }, route.requirements)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('【不可篡改的用户来源】')
    expect(prd.requirements).toHaveLength(2)
    expect(prd.requirements[0]!.description).not.toBe(request)
    expect(prd.prd_document).not.toContain('独立承诺不会被采纳')
    expect(prdStructureIssues(prd)).toEqual([])
    syncDocuments({ request_id: 'write', project_id: project.project_id, session_id: sessionId, checkpoint: 'requirement_confirmed' }, prd)
    expect(markPrdUserConfirmed(project.project_id)?.user_confirmed_at).toBeTruthy()
    expect(readPrdBackplane(project.project_id).requirements_model?.sources).toEqual(sources)
  })

  it('模型返回旧协议或错误覆盖时带具体问题重试，仍失败不得模板伪装完整PRD', async () => {
    const { project, sessionId } = setup(), prompts: string[] = []
    const query: SDKQuery = async function* (prompt) { prompts.push(prompt); yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '{"document":"# PRD","acceptance":{}}' }] } } }
    await expect(resolvePrdBackplane({ project_id: project.project_id, session_id: sessionId, query }, [{ id: 'F-001', description: '整段原话' }])).rejects.toThrow('必须产出 requirements 和 requirements_model')
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('必须产出 requirements 和 requirements_model')
    const attempts = readFileSync(join(getDocumentsDir(project.workspace_slug, project.project_id), 'diagnostics/prd-organization-attempts.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(attempts).toHaveLength(2)
    expect(attempts[0].raw_output).toBe('{"document":"# PRD","acceptance":{}}')
    expect(attempts[0].accepted_for_review).toBe(false)
  })

  it.each([true, false])('PRD投影清洗模型及历史项目的向导指令（存在历史约束=%s），产品约束仍进入正文', async historical => {
    const { project, sessionId } = setup()
    const bad = '不要再次只输出 JSON 文本'
    const badExplanation = '2. “不要再次只输出 JSON 文本”是对向导的操作提示'
    if (historical) updateProject(project.project_id, { constraints: [bad, badExplanation, '不要联网'] })
    const generated = projectRequirementsModel({
      ...organizedPrd([{ id: 'F-001', description: '管理本地待办' }], '管理本地待办'),
      project_id: project.project_id, name: project.name, positioning: '离线待办', acceptance: {}, out_of_scope: [], assumptions: [],
      constraints: [bad, badExplanation, '必须调用 write_file', '不要导出JSON，只支持CSV'],
    })
    const generate = vi.spyOn(prdEngine, 'generatePrdLlm').mockResolvedValue(generated)
    try {
      const query: SDKQuery = async function* () { throw new Error('No external SDK call is permitted') }
      const result = await resolvePrdBackplane({ project_id: project.project_id, session_id: sessionId, query }, [])
      expect(result.constraints).toEqual(historical ? ['不要导出JSON，只支持CSV', '不要联网'] : ['不要导出JSON，只支持CSV'])
      expect(result.prd_document).not.toContain(bad)
      expect(result.prd_document).not.toContain('调用 write_file')
      expect(result.prd_document).toContain('不要导出JSON，只支持CSV')
      if (historical) {
        expect(result.prd_document).toContain('不要联网')
        expect(findProject(project.project_id).constraints).toContain(bad)
      }
    } finally { generate.mockRestore() }
  })

  it('兼容模板投影也不会回灌已有向导操作约束', async () => {
    const { project, sessionId } = setup()
    updateProject(project.project_id, { constraints: ['不要再次只输出 JSON 文本', '不要联网', '不要导出JSON，只支持CSV'] })
    const result = await resolvePrdBackplane({ project_id: project.project_id, session_id: sessionId, organize_requirements: false }, [{ id: 'F-001', description: '本地待办' }])
    expect(result.constraints).toEqual(['不要联网', '不要导出JSON，只支持CSV'])
  })

  it('正文十二项而结构一项的真实失败形态不能确认', () => {
    const { project, sessionId } = setup()
    const prd = { project_id: project.project_id, name: '工艺软件', positioning: '工艺软件', requirements: [{ id: 'F-001', description: '完整原话' }], acceptance: {}, assumptions: [], out_of_scope: [],
      prd_document: Array.from({ length: 12 }, (_, index) => `### [F-${String(index + 1).padStart(3, '0')}] 功能${index + 1}`).join('\n') }
    syncDocuments({ request_id: 'write', project_id: project.project_id, session_id: sessionId, checkpoint: 'requirement_confirmed' }, prd)
    expect(markPrdUserConfirmed(project.project_id)).toBeNull()
    expect(JSON.parse(readFileSync(join(getDocumentsDir(project.workspace_slug, project.project_id), 'prd.json'), 'utf8')).user_confirmed_at).toBeUndefined()
  })

  it('不向功能清单塞主题，也不按数组顺序改已有编号', () => {
    const capabilities = [{ id: 'F-007', description: '导入方案' }, { id: 'F-003', description: '计算用量' }]
    expect(ensurePrimaryIntent(capabilities, '一整段工艺软件要求')).toBe(capabilities)
    const previous = { requirements: capabilities, requirements_model: organizedPrd(capabilities, '来源').requirements_model } as ReturnType<typeof readPrdBackplane>
    expect(stableFeatureIdIssues(previous, [{ id: 'F-001', description: '导入方案' }, capabilities[1]!])[0]).toContain('F-007 → F-001')
  })
})
