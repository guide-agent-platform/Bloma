import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyGeneratedProjectName, createProject, findProject, renameProject, sanitizeGeneratedProjectName, updateProject } from '../../main/project/project-service'

import { readPrdBackplane, syncDocuments } from '../../main/project/document-engine'
import { getAgentSessionPath, getDocumentsDir } from '../../storage/config-paths'
import { appendJsonLine } from '../../storage/json-store'
import { restorePromaHome } from '../support/proma-home-guard'
import type { SDKQuery, SDKQueryOptions } from '../../main/orchestration/orchestrator'
import { organizedPrd } from '../support/organized-prd'

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
        ...organizedPrd([{ id: 'F-001', description: '计时并记录完成次数' }], '我想管理每天的专注时间，完成后记录一次。'),
        ...(name === undefined ? {} : { name }),
        document: '# PRD：晨光专注\n## 功能\n计时并记录完成次数', positioning: '个人专注计时工具',
        acceptance: { 'F-001': '计时结束后完成次数增加一' }, out_of_scope: [], assumptions: [],
      }
      if ('requirements_model' in value) value.requirements_model.scenarios[0]!.then = '计时结束后完成次数增加一'
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(value) }] } }
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
    return { query, calls }
  }





  it('已生成项目、已归档和名称来源未知的旧项目保持原名', () => {
    for (const patch of [{ desktop_phase: 'desktop-implement' }, { status: 'archived' }, { name_source: undefined }]) {
      const { project } = prepare()
      updateProject(project.project_id, patch as Parameters<typeof updateProject>[1])
      expect(applyGeneratedProjectName(project.project_id, project.name, '晨光专注')).toBe(false)
      expect(findProject(project.project_id).name).toBe(project.name)
    }
  })


  it('生成名清洗去掉包裹引号与文件名非法字符，拒绝占位/无内容', () => {
    expect(sanitizeGeneratedProjectName(' 「晨光:专注」 ')).toBe('晨光专注')
    expect(sanitizeGeneratedProjectName('未命名项目')).toBeUndefined()
    expect(sanitizeGeneratedProjectName({ name: '钟' })).toBeUndefined()
    expect(sanitizeGeneratedProjectName('***')).toBeUndefined()
  })
})
