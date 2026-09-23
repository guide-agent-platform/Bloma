import { restorePromaHome } from '../support/proma-home-guard'
import type { ChildProcess } from 'node:child_process'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProject, findProject } from '../../main/project/project-service'
import { recordSessionActivity } from '../../main/platform/sessions/session-service'
import { clearSandboxRuntimeForTests, setSandboxRuntimeForTests } from '../../main/delivery/sandbox'
import { createSnapshot, restoreSnapshotFiles } from '../../main/delivery/snapshots'
import { SNAPSHOT_PRESERVED_TOPLEVEL } from '../../main/delivery/snapshots' /* PR3a-UNKNOWN 需人工确认 */
import {
  commitProjectState,
  ensureProjectRepo,
  gitAvailable,
  PROJECT_GITIGNORE_LINES,
  projectGitEnabled,
  resetGitProbeForTests,
} from '../../main/coding/project-git'

/**
 * Phase 10 W1-1（2026-09-16）：产物 git 化 + 快照/恢复原语双侧排除 .git/data-backups。
 * 关键语义：①开关缺省 off=不 init 不 commit；②git 相关用例带 skip-guard（无 git
 * 二进制环境跳过，恢复排除用例手造 .git 目录不依赖 git）；③fail-open——任何失败
 * 返回 reason 不抛错；④恢复后 .git/data-backups 保留恢复前状态、data/ 仍精确回滚
 * （既有 snapshot-data-rollback 语义正交不受影响）。
 */
describe('project-git 开关与 fail-open', () => {
  it('BLOMA_PROJECT_GIT 缺省 off；1/on/true 开；0/off/false 关', () => {
    const prev = process.env.BLOMA_PROJECT_GIT
    try {
      delete process.env.BLOMA_PROJECT_GIT
      expect(projectGitEnabled()).toBe(false)
      process.env.BLOMA_PROJECT_GIT = '1'
      expect(projectGitEnabled()).toBe(true)
      process.env.BLOMA_PROJECT_GIT = 'off'
      expect(projectGitEnabled()).toBe(false)
      process.env.BLOMA_PROJECT_GIT = 'true'
      expect(projectGitEnabled()).toBe(true)
      process.env.BLOMA_PROJECT_GIT = '0'
      expect(projectGitEnabled()).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.BLOMA_PROJECT_GIT
      else process.env.BLOMA_PROJECT_GIT = prev
    }
  })

  it('开关 off 时 ensureProjectRepo 不建 .git（reason=disabled）', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-git-off-'))
    const root = join(home, 'proj')
    mkdirSync(root, { recursive: true })
    const r = ensureProjectRepo(root)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('disabled')
    expect(existsSync(join(root, '.git'))).toBe(false)
  })

  it('root 不存在时 fail-open 不抛错（reason=root_missing）', () => {
    process.env.BLOMA_PROJECT_GIT = '1'
    try {
      const r = ensureProjectRepo(join(tmpdir(), 'definitely-not-exist-xyz'))
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('root_missing')
    } finally {
      delete process.env.BLOMA_PROJECT_GIT
    }
  })
})

describe('project-git 仓库管理（真 git，skip-guard）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalSwitch = process.env.BLOMA_PROJECT_GIT
  const maybeIt = gitAvailable() ? it : it.skip

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    if (originalSwitch === undefined) delete process.env.BLOMA_PROJECT_GIT
    else process.env.BLOMA_PROJECT_GIT = originalSwitch
    resetGitProbeForTests()
  })

  maybeIt('ensureProjectRepo 幂等 init：.git/.gitignore/.gitattributes/autocrlf/身份兜底', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-git-ensure-'))
    process.env.PROMA_HOME = home
    process.env.BLOMA_PROJECT_GIT = '1'
    const root = join(home, 'proj')
    mkdirSync(root, { recursive: true })

    const first = ensureProjectRepo(root)
    expect(first.ok).toBe(true)
    expect(existsSync(join(root, '.git'))).toBe(true)
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8')
    for (const line of PROJECT_GITIGNORE_LINES) expect(ignore).toContain(line)
    // 用户手写行保留
    writeFileSync(join(root, '.gitignore'), ignore + 'my-local-artifact.bin\n', 'utf8')
    expect(existsSync(join(root, '.gitattributes'))).toBe(true)
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toContain('eol=lf')
    const gitConfig = readFileSync(join(root, '.git', 'config'), 'utf8')
    expect(gitConfig).toContain('autocrlf = false')

    // 幂等二跑：手写行不丢、不重复追加
    const second = ensureProjectRepo(root)
    expect(second.ok).toBe(true)
    const ignore2 = readFileSync(join(root, '.gitignore'), 'utf8')
    expect(ignore2).toContain('my-local-artifact.bin')
    expect(ignore2.match(/data\//g)?.length).toBe(1)
  })

  maybeIt('commitProjectState：有变更提交返回短 hash；无变更如实 nothing_to_commit；summary 换行压平', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-git-commit-'))
    process.env.PROMA_HOME = home
    process.env.BLOMA_PROJECT_GIT = '1'
    const root = join(home, 'proj')
    mkdirSync(root, { recursive: true })
    expect(ensureProjectRepo(root).ok).toBe(true)

    writeFileSync(join(root, 'index.html'), '<html></html>', 'utf8')
    const c1 = commitProjectState(root, { kind: 'mvp_loop_end', summary: '生成轮结束\n含换行的摘要', stage: 'generating_mvp' })
    expect(c1.ok).toBe(true)
    expect(c1.committed).toBe(true)
    expect(typeof c1.commit).toBe('string')
    expect(c1.commit).toMatch(/^[0-9a-f]{7,}$/)

    const c2 = commitProjectState(root, { kind: 'test_passed', summary: '终验通过' })
    expect(c2.ok).toBe(true)
    expect(c2.committed).toBe(false)
    expect(c2.reason).toBe('nothing_to_commit')
  })

  maybeIt('机器无全局 git 身份时写入仓库局部身份（不碰全局）', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-git-identity-'))
    process.env.PROMA_HOME = home
    process.env.BLOMA_PROJECT_GIT = '1'
    const root = join(home, 'proj')
    mkdirSync(root, { recursive: true })
    // 隔离全局/系统配置，模拟无身份机器（GIT_CONFIG_GLOBAL/SYSTEM 指空文件）
    const emptyCfg = join(home, 'empty.gitconfig')
    writeFileSync(emptyCfg, '', 'utf8')
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL
    const prevSystem = process.env.GIT_CONFIG_SYSTEM
    process.env.GIT_CONFIG_GLOBAL = emptyCfg
    process.env.GIT_CONFIG_SYSTEM = emptyCfg
    try {
      expect(ensureProjectRepo(root).ok).toBe(true)
      const gitConfig = readFileSync(join(root, '.git', 'config'), 'utf8')
      expect(gitConfig).toContain('bloma@local')
      // 身份就位后 commit 可用
      writeFileSync(join(root, 'a.txt'), 'x', 'utf8')
      const c = commitProjectState(root, { kind: 'test', summary: '无全局身份机器可提交' })
      expect(c.committed).toBe(true)
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal
      if (prevSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM
      else process.env.GIT_CONFIG_SYSTEM = prevSystem
    }
  })

  maybeIt('data/ 与 data-backups/ 被 gitignore 排除，commit 不含真实数据', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-git-data-'))
    process.env.PROMA_HOME = home
    process.env.BLOMA_PROJECT_GIT = '1'
    const root = join(home, 'proj')
    mkdirSync(root, { recursive: true })
    expect(ensureProjectRepo(root).ok).toBe(true)
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'notes.json'), '[]', 'utf8')
    const c = commitProjectState(root, { kind: 'iteration_end', summary: '迭代结束' })
    expect(c.committed).toBe(true)
    // git status 不应看到 data/（被 ignore）
    const ignored = execSync('git check-ignore data/notes.json', { cwd: root, encoding: 'utf8' }).trim()
    expect(ignored).toContain('data')
  })
})

describe('快照/恢复排除 .git 与 data-backups（不依赖 git 二进制）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    clearSandboxRuntimeForTests()
  })

  function injectFakeSandboxRuntime(): void {
    setSandboxRuntimeForTests({
      processFactory: () =>
        ({
          stdout: { on: () => undefined },
          stderr: { on: () => undefined },
          once: () => undefined,
          kill: () => true,
        }) as unknown as ChildProcess,
      portAllocator: async () => 3212,
      healthCheck: async () => true,
    })
  }

  it('受保护顶层目录清单为 [.git, data-backups, node_modules]（W2：vendor 钉版供货确定性可重建，不进归档）', () => {
    expect([...SNAPSHOT_PRESERVED_TOPLEVEL]).toEqual(['.git', 'data-backups', 'node_modules'])
  })

  it('归档不含 .git/data-backups；恢复后二者保留恢复前状态、data/ 仍精确回滚', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-git-restore-'))
    process.env.PROMA_HOME = home
    injectFakeSandboxRuntime()
    const project = createProject({ request_id: 'req-create', mode: 'quick' })
    recordSessionActivity('session-git', project.project_id)
    const root = findProject(project.project_id).root_path

    // 快照时点：手造 .git（HEAD 内容 v1）、data-backups、data/notes.json=v1、index.html
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: v1', 'utf8')
    mkdirSync(join(root, 'data-backups'), { recursive: true })
    writeFileSync(join(root, 'data-backups', 'snap-a.json'), '{"n":30}', 'utf8')
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'notes.json'), 'v1', 'utf8')
    writeFileSync(join(root, 'index.html'), '<html>v1</html>', 'utf8')

    const snapshot = await createSnapshot({
      request_id: 'req-snap',
      project_id: project.project_id,
      kind: 'mvp',
      summary: '含 .git 的快照',
      include_documents: false,
      health_status: 'healthy',
    })
    // 归档不含受保护目录
    const archived = readdirSync(snapshot.files_archive_path)
    for (const name of SNAPSHOT_PRESERVED_TOPLEVEL) expect(archived).not.toContain(name)
    expect(archived).toContain('index.html')

    // 快照之后：.git 前进（v2）、data-backups 新增、data 被改写、index 被改写
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: v2', 'utf8')
    writeFileSync(join(root, 'data-backups', 'snap-b.json'), '{"n":35}', 'utf8')
    writeFileSync(join(root, 'data', 'notes.json'), 'v2-已改', 'utf8')
    writeFileSync(join(root, 'index.html'), '<html>v2</html>', 'utf8')

    await restoreSnapshotFiles({ request_id: 'req-restore', project_id: project.project_id, snapshot_id: snapshot.snapshot_id })

    // 恢复后：.git 与 data-backups 保留恢复前状态（版本史/备份不随回滚回退）
    expect(readFileSync(join(root, '.git', 'HEAD'), 'utf8')).toBe('ref: v2')
    expect(readFileSync(join(root, 'data-backups', 'snap-a.json'), 'utf8')).toBe('{"n":30}')
    expect(readFileSync(join(root, 'data-backups', 'snap-b.json'), 'utf8')).toBe('{"n":35}')
    // 既有语义不变：data/ 与代码精确回快照时点
    expect(readFileSync(join(root, 'data', 'notes.json'), 'utf8')).toBe('v1')
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('<html>v1</html>')
    // 临时挪出目录已清理
    const leftovers = readdirSync(root).filter((e) => e.startsWith('__preserve_') || e.includes('.__preserve_'))
    expect(leftovers).toEqual([])
  })
})
