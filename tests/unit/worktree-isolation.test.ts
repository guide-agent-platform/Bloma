import { restorePromaHome } from '../support/proma-home-guard'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cleanupDelegationWorktree,
  createDelegationWorktree,
  delegationWorktreeEnabled,
  mergeDelegationWorktree,
  buildDelegationWorktreeProvider,
  resetDelegationWorktreesForTests,
} from '../../main/coding/worktree-isolation'
import { getProjectRootOverride, hasProjectRootOverride, resolveProjectRoot, runWithProjectRootOverride } from '../../shared/project-root-override'
import { commitProjectState, ensureProjectRepo, gitAvailable } from '../../main/coding/project-git'
import { createProject, findProject } from '../../main/project/project-service'
import { buildAgentTools } from '../../main/agent/tools/agent-tools'
import { buildDomainTools } from '../../main/coding/tool-handlers'

/**
 * 委派 worktree 隔离（2026-09-26 运行审计 P1-06 收尾）：
 * 子会话在独立工作树实现（读写隔离）、验证由父会话在合并后统一执行、父会话负责合并。
 */

describe('project-root-override（kernel 覆盖语义）', () => {
  it('覆盖内解析走覆盖；覆盖外走 fallback；并发异步链互不串扰', async () => {
    expect(hasProjectRootOverride()).toBe(false)
    expect(resolveProjectRoot('p', () => '/main')).toBe('/main')
    const inside = runWithProjectRootOverride('/wt-a', () => {
      expect(hasProjectRootOverride()).toBe(true)
      expect(getProjectRootOverride()).toBe('/wt-a')
      return resolveProjectRoot('p', () => '/main')
    })
    expect(inside).toBe('/wt-a')
    // 异步并发隔离：两条链各持自己的覆盖
    const results = await Promise.all([
      runWithProjectRootOverride('/wt-1', async () => {
        await new Promise((r) => setTimeout(r, 10))
        return resolveProjectRoot('p', () => '/main')
      }),
      runWithProjectRootOverride('/wt-2', async () => {
        await new Promise((r) => setTimeout(r, 5))
        return resolveProjectRoot('p', () => '/main')
      }),
    ])
    expect(results).toEqual(['/wt-1', '/wt-2'])
    expect(hasProjectRootOverride()).toBe(false)
  })
})

describe('worktree 生命周期（真 git；开关语义）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalSwitch = process.env.BLOMA_DELEGATION_WORKTREE

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-wt-'))
    delete process.env.BLOMA_DELEGATION_WORKTREE
    process.env.BLOMA_PROJECT_GIT = '1' // 项目 git 能力（worktree 前置；生产由 Phase 10 开关开启）
    resetDelegationWorktreesForTests()
  })
  afterEach(() => {
    restorePromaHome(originalPromaHome)
    if (originalSwitch === undefined) delete process.env.BLOMA_DELEGATION_WORKTREE
    else process.env.BLOMA_DELEGATION_WORKTREE = originalSwitch
    delete process.env.BLOMA_PROJECT_GIT
    resetDelegationWorktreesForTests()
  })

  it('开关缺省 off；显式 on 生效', () => {
    expect(delegationWorktreeEnabled()).toBe(false)
    process.env.BLOMA_DELEGATION_WORKTREE = '1'
    expect(delegationWorktreeEnabled()).toBe(true)
  })

  it('建树→在树内实现→合并进主目录→清理（分支删除）', { timeout: 120_000 }, () => {
    if (!gitAvailable()) return // 无 git 环境跳过（CI 缺 git 不红）
    const project = createProject({ request_id: 'req-wt', mode: 'quick' })
    ensureProjectRepo(project.root_path)
    commitProjectState(project.root_path, { kind: 'delegation_base', summary: '初始基线' })

    const created = createDelegationWorktree(project.project_id, 'deleg-aaa')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(existsSync(created.path)).toBe(true)
    // 子会话在 worktree 内实现（父主目录不受影响）
    writeFileSync(join(created.path, 'feature.js'), 'module.exports = 1', 'utf8')
    expect(existsSync(join(project.root_path, 'feature.js'))).toBe(false)

    const merged = mergeDelegationWorktree('deleg-aaa')
    expect(merged.ok).toBe(true)
    expect(merged.merged).toBe(true)
    expect(readFileSync(join(project.root_path, 'feature.js'), 'utf8')).toContain('module.exports = 1')

    cleanupDelegationWorktree('deleg-aaa', { removeBranch: true })
    expect(existsSync(created.path)).toBe(false)
  })

  it('冲突：两边改同一文件 → 不自动解，回冲突清单且保留分支', () => {
    if (!gitAvailable()) return
    const project = createProject({ request_id: 'req-wt2', mode: 'quick' })
    ensureProjectRepo(project.root_path)
    writeFileSync(join(project.root_path, 'shared.js'), 'const v = 1\n', 'utf8')
    commitProjectState(project.root_path, { kind: 'delegation_base', summary: '基线含 shared' })

    const created = createDelegationWorktree(project.project_id, 'deleg-bbb')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    writeFileSync(join(created.path, 'shared.js'), 'const v = 2 // worktree\n', 'utf8')
    // 主目录同期改动同一文件（父会话或用户）
    writeFileSync(join(project.root_path, 'shared.js'), 'const v = 3 // main\n', 'utf8')
    commitProjectState(project.root_path, { kind: 'delegation_base', summary: '主目录同期改动' })

    const merged = mergeDelegationWorktree('deleg-bbb')
    expect(merged.merged).toBe(false)
    expect(merged.conflicts ?? []).toContain('shared.js')
    expect(merged.branch).toBeTruthy() // 分支保留供裁决
    // 主目录内容未被自动改写
    expect(readFileSync(join(project.root_path, 'shared.js'), 'utf8')).toContain('main')
    cleanupDelegationWorktree('deleg-bbb', { removeBranch: false })
  })
})

describe('工具面在覆盖下的行为（写隔离闭环）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-wt3-'))
  })
  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  it('write_file 在覆盖内落 worktree 而非主目录（子会话读写隔离）', async () => {
    const project = createProject({ request_id: 'req-wt3', mode: 'quick' })
    const worktree = mkdtempSync(join(tmpdir(), 'proma-wt-dir-'))
    const tools = buildAgentTools({ projectId: project.project_id, role: 'custom', sessionId: 's', requestId: 'r' } as never)
    const write = tools.find((t) => t.name === 'write_file')!
    const ctx = {
      projectId: project.project_id,
      sessionId: 's',
      requestId: 'r',
      signal: new AbortController().signal,
      state: { file_revisions: new Map() },
    } as never
    const outcome = await runWithProjectRootOverride(worktree, () => write.execute({ path: 'src/x.js', content: 'const x = 1\n' }, ctx))
    expect((outcome as { isError?: boolean }).isError).toBeFalsy()
    expect(existsSync(join(worktree, 'src', 'x.js'))).toBe(true)
    expect(existsSync(join(project.root_path, 'src', 'x.js'))).toBe(false)
  })

  it('隔离模式下领域验证工具被裁掉（防「改 worktree、验主根」假验证）', () => {
    const project = createProject({ request_id: 'req-wt4', mode: 'quick' })
    const outside = buildDomainTools({ projectId: project.project_id, role: 'parent', sessionId: 's', requestId: 'r' } as never)
    expect(outside.length).toBeGreaterThan(0)
    const inside = runWithProjectRootOverride('/tmp/wt', () =>
      buildDomainTools({ projectId: project.project_id, role: 'parent', sessionId: 's', requestId: 'r' } as never),
    )
    expect(inside).toEqual([])
  })

  it('provider 工厂：开关 off 时返回的 provider 不隔离（不建树；工厂可重复调用）', () => {
    const provider = buildDelegationWorktreeProvider()
    expect(typeof provider).toBe('function')
    expect(delegationWorktreeEnabled()).toBe(false)
    expect(provider({ projectId: 'p', delegationId: 'd', childSessionId: 's', role: 'implement' })).toBeUndefined()
    expect(buildDelegationWorktreeProvider()({ projectId: 'p', delegationId: 'd', childSessionId: 's', role: 'implement' })).toBeUndefined()
  })
})
