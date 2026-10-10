/**
 * implement 子会话受控执行工具测试（2026-10-05 方案 B）。
 *
 * 覆盖：happy path 真实输出/绿红判定、边界拒绝（越界/非 .py/不存在/绝对路径）、
 * 执行预算、超时/ENOENT 错误映射、env 白名单（不含 BLOMA_ 前缀与密钥类变量）、角色装配面。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restorePromaHome } from '../../support/proma-home-guard'
import { DriverExecutionError, type DriverCommandRequest } from '../../../main/desktop/process-driver'
import { buildChildScriptRunnerTool } from '../../../main/desktop/child-exec-tool'
import { buildDesktopChildTools } from '../../../main/desktop/dispatcher-loop'
import { createToolState, type ToolContext } from '../../../main/agent/loop/agent-loop'
import { createProject } from '../../../main/project/project-service'

function ctxFor(projectId: string): ToolContext {
  return {
    projectId,
    sessionId: 'session-child-exec',
    requestId: 'req-child-exec',
    signal: new AbortController().signal,
    state: createToolState(),
  }
}

describe('run_project_script（方案 B：implement 子会话受控执行）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let projectRoot: string
  let projectId: string

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-child-exec-'))
    const project = createProject({ request_id: 'req-child-exec-setup', mode: 'quick' })
    projectId = project.project_id
    projectRoot = project.root_path
    writeFileSync(join(projectRoot, '自测.py'), 'print("S1 PASS 加法")', 'utf8')
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  function fakeSpawn(result: { code: number; stdout?: string; stderr?: string } | Error) {
    return vi.fn(async (request: DriverCommandRequest) => {
      if (result instanceof Error) throw result
      return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
    })
  }

  const okPython = async () => 'C:/Python313/python.exe'

  it('短代码直接以参数执行，无临时文件；坏请求不消耗执行预算', async () => {
    const spawn = fakeSpawn({ code: 0, stdout: 'PASS clean\n' })
    const tool = buildChildScriptRunnerTool(projectId, { spawn, resolvePython: okPython, maxRuns: 1 })
    const ctx = ctxFor(projectId)
    expect((await tool.execute({ script: '自测.py', code: 'print(1)' }, ctx)).isError).toBe(true)
    expect((await tool.execute({ code: 'x'.repeat(16001) }, ctx)).isError).toBe(true)
    const outcome = await tool.execute({ code: 'print("PASS clean")' }, ctx)
    expect(outcome.isError).toBeFalsy()
    expect(spawn.mock.calls[0][0].command).toEqual(['C:/Python313/python.exe', '-c', 'print("PASS clean")'])
    expect(spawn.mock.calls[0][0].cwd).toBe(projectRoot)
    expect(spawn.mock.calls[0][0].env).not.toHaveProperty('BLOMA_SECRET_CHANNEL_KEY')
  })

  it('happy path：真实输出 + 绿判定 + env 白名单（无 BLOMA_*，带 PYTHONIOENCODING）', async () => {
    process.env.BLOMA_SECRET_CHANNEL_KEY = 'should-not-leak'
    const spawn = fakeSpawn({ code: 0, stdout: 'S1 PASS 加法\n' })
    const tool = buildChildScriptRunnerTool(projectId, { spawn, resolvePython: okPython })
    const outcome = await tool.execute({ script: '自测.py' }, ctxFor(projectId))
    expect(outcome.isError).toBeFalsy()
    expect(outcome.output).toContain('退出码 0（绿）')
    expect(outcome.output).toContain('S1 PASS 加法')
    expect(spawn).toHaveBeenCalledTimes(1)
    const request = spawn.mock.calls[0][0] as DriverCommandRequest
    expect(request.command[0]).toBe('C:/Python313/python.exe')
    expect(request.command[1].endsWith('自测.py')).toBe(true)
    expect(request.cwd).toBeTruthy()
    expect(Object.keys(request.env)).not.toContain('BLOMA_SECRET_CHANNEL_KEY')
    expect(request.env.PYTHONIOENCODING).toBe('utf-8')
    delete process.env.BLOMA_SECRET_CHANNEL_KEY
  })

  it('红判定：非零退出码输出红话术', async () => {
    const tool = buildChildScriptRunnerTool(projectId, { spawn: fakeSpawn({ code: 1, stderr: 'AssertionError' }), resolvePython: okPython })
    const outcome = await tool.execute({ script: '自测.py' }, ctxFor(projectId))
    expect(outcome.isError).toBeFalsy()
    expect(outcome.output).toContain('退出码 1（红')
    expect(outcome.output).toContain('AssertionError')
  })

  it('边界拒绝：越界 / 非 .py / 不存在 / 绝对路径', async () => {
    const tool = buildChildScriptRunnerTool(projectId, { spawn: fakeSpawn({ code: 0 }), resolvePython: okPython })
    const ctx = ctxFor(projectId)
    expect((await tool.execute({ script: '../outside.py' }, ctx)).isError).toBe(true)
    expect((await tool.execute({ script: 'notes.txt' }, ctx)).isError).toBe(true)
    expect((await tool.execute({ script: '不存在的.py' }, ctx)).isError).toBe(true)
    expect((await tool.execute({ script: 'C:/abs/path.py' }, ctx)).isError).toBe(true)
  })

  it('执行预算：超上限后拒答并指引如实收尾', async () => {
    const tool = buildChildScriptRunnerTool(projectId, { spawn: fakeSpawn({ code: 0 }), resolvePython: okPython, maxRuns: 2 })
    const ctx = ctxFor(projectId)
    expect((await tool.execute({ script: '自测.py' }, ctx)).isError).toBeFalsy()
    expect((await tool.execute({ script: '自测.py' }, ctx)).isError).toBeFalsy()
    const third = await tool.execute({ script: '自测.py' }, ctx)
    expect(third.isError).toBe(true)
    expect(third.output).toContain('预算用尽')
  })

  it('超时/解释器缺失：DriverExecutionError 分类话术', async () => {
    const ctx = ctxFor(projectId)
    const timeoutTool = buildChildScriptRunnerTool(projectId, {
      spawn: vi.fn(async () => { throw new DriverExecutionError('timeout', '驱动超时强杀') }),
      resolvePython: okPython,
    })
    const timeoutOutcome = await timeoutTool.execute({ script: '自测.py' }, ctx)
    expect(timeoutOutcome.isError).toBe(true)
    expect(timeoutOutcome.output).toContain('timeout')

    const noPythonTool = buildChildScriptRunnerTool(projectId, {
      spawn: fakeSpawn({ code: 0 }),
      resolvePython: async () => { throw new Error('python-not-found: 未找到') },
    })
    const noPythonOutcome = await noPythonTool.execute({ script: '自测.py' }, ctx)
    expect(noPythonOutcome.isError).toBe(true)
    expect(noPythonOutcome.output).toContain('python-not-found')
  })

  it('角色装配面：implement 有 run_project_script，research 没有', () => {
    const implTools = buildDesktopChildTools(projectId, 'implement', 'diff')
    expect(implTools.some((tool) => tool.name === 'run_project_script')).toBe(true)
    const researchTools = buildDesktopChildTools(projectId, 'research', 'diff')
    expect(researchTools.some((tool) => tool.name === 'run_project_script')).toBe(false)
    expect(buildDesktopChildTools(projectId, 'custom', 'diff').some((tool) => tool.name === 'run_project_script')).toBe(true)
  })
})
