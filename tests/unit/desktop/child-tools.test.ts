/**
 * 桌面线子会话工具集测试（2026-09-26 首跑深修）。
 *
 * 覆盖：真实工程写范围（00_ARCH/*.md|.json、.py 可写；基础设施目录拒绝）——
 * 首跑实证：缺省 web 静态规则拒绝桌面交付物，desktop-arch 门禁产物写不进去。
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { restorePromaHome } from '../../support/proma-home-guard'
import { buildDesktopChildTools } from '../../../main/desktop/production-runtime-tools'
import { buildAgentTools } from '../../../main/agent/tools/agent-tools'
import { createToolState, type AgentLoopTool, type ToolContext } from '../../../main/agent/loop/agent-loop'
import { createProject } from '../../../main/project/project-service'

function ctxFor(projectId: string): ToolContext {
  return {
    projectId,
    sessionId: 'session-child-tools',
    requestId: 'req-child-tools',
    signal: new AbortController().signal,
    state: createToolState(),
  }
}

function writeToolOf(tools: AgentLoopTool[]): AgentLoopTool {
  const tool = tools.find((candidate) => candidate.name === 'write_file')
  if (!tool) throw new Error('write_file 缺失')
  return tool
}

describe('桌面线子会话工具集（首跑深修：真实工程写范围）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-child-tools-'))
  })
  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  it('门禁产物落盘合法：00_ARCH/architecture.md、00_ARCH/env-checklist.json、src/app.py', async () => {
    const project = createProject({ request_id: 'req-child-1', mode: 'quick' })
    const write = writeToolOf(buildDesktopChildTools(project.project_id, 'implement', 'diff'))
    const ctx = ctxFor(project.project_id)

    const arch = await write.execute({ path: '00_ARCH/architecture.md', content: '# 选型：P1 Python' }, ctx)
    expect(arch.isError).toBeFalsy()
    const checklist = await write.execute({ path: '00_ARCH/env-checklist.json', content: '{"python":"ok"}' }, ctx)
    expect(checklist.isError).toBeFalsy()
    const app = await write.execute({ path: 'src/app.py', content: 'print("hi")' }, ctx)
    expect(app.isError).toBeFalsy()

    expect(existsSync(join(project.root_path, '00_ARCH', 'architecture.md'))).toBe(true)
    expect(existsSync(join(project.root_path, '00_ARCH', 'env-checklist.json'))).toBe(true)
    expect(existsSync(join(project.root_path, 'src', 'app.py'))).toBe(true)
  })

  it('基础设施目录仍然拒绝：node_modules/.git/data-backups', async () => {
    const project = createProject({ request_id: 'req-child-2', mode: 'quick' })
    const write = writeToolOf(buildDesktopChildTools(project.project_id, 'implement', 'diff'))
    const ctx = ctxFor(project.project_id)
    for (const path of ['node_modules/evil.js', '.git/config', 'data-backups/x.json']) {
      const outcome = await write.execute({ path, content: 'x' }, ctx)
      expect(outcome.isError, path).toBe(true)
    }
  })

  it('对照：缺省（web 静态规则）拒绝 00_ARCH/*.md——锁定变体必要性', async () => {
    const project = createProject({ request_id: 'req-child-3', mode: 'quick' })
    const write = writeToolOf(buildAgentTools({ projectId: project.project_id, role: 'implement', editFormat: 'diff' }))
    const outcome = await write.execute({ path: '00_ARCH/architecture.md', content: '# x' }, ctxFor(project.project_id))
    expect(outcome.isError).toBe(true)
    expect(String(outcome.output)).toContain('不在可写范围内')
  })
})
