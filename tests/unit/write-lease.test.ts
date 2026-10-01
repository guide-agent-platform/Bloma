import { restorePromaHome } from '../support/proma-home-guard'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAgentTools, setJsSyntaxCheckerForTests } from '../../main/agent/tools/agent-tools'
import { createToolState, type AgentLoopTool, type ToolContext } from '../../main/agent/loop/agent-loop'
import { createProject } from '../../main/project/project-service'
import {
  acquireWriteLease,
  clearWriteLeasesForTests,
  releaseLeasesForHolder,
  releaseWriteLease,
} from '../../main/agent/tools/write-lease'

/**
 * 宿主级写隔离（2026-09-26 运行审计 P1-06）：
 * - 文件写租约：并行写者同时写同一文件 → 后到者拒绝（教育文案），单会话零影响；
 * - 提交点 CAS：读后被外部修改 → 写盘前拒绝（含语法校验 await 窗口内被改）。
 */

const toolsFor = (projectId: string) => {
  setJsSyntaxCheckerForTests(async () => ({ ok: true as const }))
  return buildAgentTools({ projectId, mode: 'quick', sessionId: 'session-lease', requestId: 'req-lease' } as never)
}

const byName = (tools: AgentLoopTool[], name: string): AgentLoopTool => {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`工具不存在：${name}`)
  return tool
}

const ctxFor = (projectId: string, toolCallId?: string, state?: ReturnType<typeof createToolState>): ToolContext => ({
  projectId,
  sessionId: 'session-lease',
  requestId: 'req-lease',
  signal: new AbortController().signal,
  // state 可注入：真实 loop 是一会话一个 ToolState 跨工具共享（file_revisions 版本登记
  // 在会话级）；缺省新建仅适配单次调用的用例。连续写用例必须传共享 state，否则会被
  // write 守卫（缺省 on，2026-10-02）误判为盲覆盖。
  state: state ?? createToolState(),
  ...(toolCallId ? { toolCallId } : {}),
})

describe('写租约（P1-06a：宿主级写隔离）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-lease-'))
    clearWriteLeasesForTests()
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    clearWriteLeasesForTests()
  })

  it('租约语义：同 holder 重入成功；他人持有拒绝；释放后可获取；TTL 过期回收', () => {
    expect(acquireWriteLease('p1', 'src/app.js', 'holder-a').ok).toBe(true)
    expect(acquireWriteLease('p1', 'src/app.js', 'holder-a').ok).toBe(true) // 重入
    const conflict = acquireWriteLease('p1', 'src/app.js', 'holder-b')
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) expect(conflict.holder).toBe('holder-a')
    // 不同项目/不同路径互不影响
    expect(acquireWriteLease('p1', 'src/other.js', 'holder-b').ok).toBe(true)
    expect(acquireWriteLease('p2', 'src/app.js', 'holder-b').ok).toBe(true)
    releaseWriteLease('p1', 'src/app.js', 'holder-a')
    expect(acquireWriteLease('p1', 'src/app.js', 'holder-b').ok).toBe(true)
    // holder 批量释放
    releaseLeasesForHolder('holder-b')
    expect(acquireWriteLease('p1', 'src/app.js', 'holder-c').ok).toBe(true)
  })

  it('工具层：并行写者冲突 → 后到者 WRITE_LEASE_CONFLICT，先到者照常写入', async () => {
    const project = createProject({ request_id: 'req-wl', mode: 'quick' })
    // 模拟另一个并行子会话已持有该文件租约
    acquireWriteLease(project.project_id, 'src/app.js', 'other-session-call')

    const tools = toolsFor(project.project_id)
    const blocked = await byName(tools, 'write_file').execute(
      { path: 'src/app.js', content: 'const a = 1\n' },
      ctxFor(project.project_id, 'call-1'),
    )
    expect(blocked.isError).toBe(true)
    expect(blocked.output).toContain('WRITE_LEASE_CONFLICT')

    // 对方释放后同一写入成功
    releaseWriteLease(project.project_id, 'src/app.js', 'other-session-call')
    const ok = await byName(tools, 'write_file').execute(
      { path: 'src/app.js', content: 'const a = 1\n' },
      ctxFor(project.project_id, 'call-2'),
    )
    expect(ok.isError).toBeFalsy()
    expect(readFileSync(join(project.root_path, 'src', 'app.js'), 'utf8')).toContain('const a = 1')
  })

  it('工具层：同会话连续写（不同 toolCallId）不误伤——写完即释放（共享 ToolState，对齐真实 loop 语义）', async () => {
    const project = createProject({ request_id: 'req-wl2', mode: 'quick' })
    const tools = toolsFor(project.project_id)
    const sharedState = createToolState()
    const first = await byName(tools, 'write_file').execute({ path: 'src/a.js', content: 'const a = 1\n' }, ctxFor(project.project_id, 'c1', sharedState))
    const second = await byName(tools, 'write_file').execute({ path: 'src/a.js', content: 'const a = 2\n' }, ctxFor(project.project_id, 'c2', sharedState))
    const third = await byName(tools, 'write_file').execute({ path: 'src/b.js', content: 'const b = 1\n' }, ctxFor(project.project_id, 'c3', sharedState))
    expect(first.isError).toBeFalsy()
    expect(second.isError).toBeFalsy()
    expect(third.isError).toBeFalsy()
  })
})

describe('提交点 CAS（P1-06b：版本一致性）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-cas-'))
    clearWriteLeasesForTests()
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    clearWriteLeasesForTests()
  })

  it('读后被外部修改 → edit_file（不传 expected_revision）提交点拒绝；重读后放行', async () => {
    const project = createProject({ request_id: 'req-cas', mode: 'quick' })
    const abs = join(project.root_path, 'src', 'app.js')
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, 'const a = 1\n', 'utf8')
    const tools = toolsFor(project.project_id)
    const ctx = ctxFor(project.project_id, 'call-cas')

    await byName(tools, 'read_file').execute({ path: 'src/app.js' }, ctx)
    // 外部写者修改（并行子会话/用户手改）
    writeFileSync(abs, 'const a = 2\n', 'utf8')

    const stale = await byName(tools, 'edit_file').execute(
      { path: 'src/app.js', old_string: 'const a = 2', new_string: 'const a = 3' },
      ctx,
    )
    expect(stale.isError).toBe(true)
    expect(stale.output).toContain('STALE_READ')

    // 重新读取 → 基准刷新 → 成功
    await byName(tools, 'read_file').execute({ path: 'src/app.js' }, ctx)
    const ok = await byName(tools, 'edit_file').execute(
      { path: 'src/app.js', old_string: 'const a = 2', new_string: 'const a = 3' },
      ctx,
    )
    expect(ok.isError).toBeFalsy()
    expect(readFileSync(abs, 'utf8')).toContain('const a = 3')
  })

  it('语法校验 await 窗口内被外部修改 → 写盘前拦下（TOCTOU 收窄）', async () => {
    const project = createProject({ request_id: 'req-toctou', mode: 'quick' })
    const abs = join(project.root_path, 'src', 'app.js')
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, 'const a = 1\n', 'utf8')
    const tools = toolsFor(project.project_id)
    // 语法检查桩：在 await 期间模拟外部写者修改同一文件（旧口径 revision 校验在 await 之前 → 漏）
    setJsSyntaxCheckerForTests(async () => {
      writeFileSync(abs, 'const a = 99\n', 'utf8')
      return { ok: true as const }
    })
    const ctx = ctxFor(project.project_id, 'call-toctou')
    await byName(tools, 'read_file').execute({ path: 'src/app.js' }, ctx)

    // old_string 用「进入时」内容（命中检查在 await 前）——真正的窗口是 await 内被改
    const blocked = await byName(tools, 'edit_file').execute(
      { path: 'src/app.js', old_string: 'const a = 1', new_string: 'const a = 2' },
      ctx,
    )
    expect(blocked.isError).toBe(true)
    expect(blocked.output).toContain('STALE_READ')
    expect(readFileSync(abs, 'utf8')).toBe('const a = 99\n') // 外部版本未被覆盖
    setJsSyntaxCheckerForTests(async () => ({ ok: true as const }))
  })

  it('本轮未读过的新建文件不受 CAS 影响；读过且未变的文件正常写', async () => {
    const project = createProject({ request_id: 'req-cas2', mode: 'quick' })
    const tools = toolsFor(project.project_id)
    const ctx = ctxFor(project.project_id, 'call-cas2')
    // 新建
    const created = await byName(tools, 'write_file').execute({ path: 'src/new.js', content: 'const n = 1\n' }, ctx)
    expect(created.isError).toBeFalsy()
    // 读 → 未外部修改 → 覆盖成功
    await byName(tools, 'read_file').execute({ path: 'src/new.js' }, ctx)
    const overwrite = await byName(tools, 'write_file').execute({ path: 'src/new.js', content: 'const n = 2\n' }, ctx)
    expect(overwrite.isError).toBeFalsy()
    expect(readFileSync(join(project.root_path, 'src', 'new.js'), 'utf8')).toContain('const n = 2')
  })
})
