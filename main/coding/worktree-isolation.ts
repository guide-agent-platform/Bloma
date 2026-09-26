/**
 * 委派 worktree 隔离（2026-09-26 运行审计 P1-06 收尾）。
 *
 * 审计机制改动第 3 项：「高自由度实现用独立 worktree/分支，父会话负责合并；
 * 测试、构建和报告绑定同一稳定候选版本。」
 *
 * 落地形态：
 * - 开关 `BLOMA_DELEGATION_WORKTREE`（缺省 off，行为零变化）；
 * - 开关 on 时，implement/custom 角色的委派子会话在**独立工作树**上工作
 *   （`~/.proma/bloma-worktrees/<projectId>/<shortId>`，分支 `bloma-deleg/<shortId>`，
 *   基线=父会话当前 HEAD）——工作树在 Proma 家目录下，不进项目根，故不影响
 *   快照/指纹/启动对账；
 * - 子会话的工具面把「项目根」解析到 worktree（kernel/project-root-override 的
 *   AsyncLocalStorage 覆盖）；同时**移除绑主根的领域验证工具**（预览/GWT/安全/契约/
 *   预检）——隔离模式下的验证统一由父会话在合并后的稳定候选上执行（防「改 worktree、
 *   验主根」的假验证）；
 * - 子会话完成 → 自动尝试合并进项目根（无冲突即并入并落版本史提交）；冲突 → 中止合并、
 *   保留分支与工作树，把冲突文件清单如实回给父会话（平台不自动解冲突）；
 * - 中断/失败 → 移除工作树、保留分支（供排查），结果摘要如实标注 discarded。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { ensureProjectRepo, commitProjectState, gitAvailable, projectGitEnabled } from './project-git'
import { findProject } from '../project/project-service'
import type { ChildRunContext, ChildRunContextProvider, DelegationRunRole } from '../../shared/delegation-run-context'

/** 开关：委派 worktree 隔离（缺省 off=字节级零变化）。 */
export function delegationWorktreeEnabled(): boolean {
  const raw = (process.env.BLOMA_DELEGATION_WORKTREE ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

interface WorktreeHandle {
  projectId: string
  path: string
  branch: string
  rootPath: string
}

/** delegationId → 工作树句柄（进程内；重启后由 git worktree list 兜底清理挂账）。 */
const handles = new Map<string, WorktreeHandle>()

function runGit(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, timeout: 20_000, windowsHide: true, encoding: 'utf8' })
  return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
}

export type CreateWorktreeResult = { ok: true; path: string; branch: string } | { ok: false; reason: string }

/** 建委派工作树（幂等：同 delegationId 已存在直接复用）。基线=当前 HEAD（确保有提交）。 */
export function createDelegationWorktree(projectId: string, delegationId: string): CreateWorktreeResult {
  try {
    const existing = handles.get(delegationId)
    if (existing && existsSync(existing.path)) return { ok: true, path: existing.path, branch: existing.branch }
    if (!projectGitEnabled()) return { ok: false, reason: 'project_git_disabled' }
    if (!gitAvailable()) return { ok: false, reason: 'git_missing' }
    const project = findProject(projectId)
    const rootPath = project.root_path
    const ensured = ensureProjectRepo(rootPath)
    if (!ensured.ok) return { ok: false, reason: `repo_unavailable:${ensured.reason ?? ''}` }
    // 空仓（无 HEAD）时 worktree add 无基线可依——先落一次基线提交（无变更时如实 nothing_to_commit）
    commitProjectState(rootPath, { kind: 'delegation_base', summary: `委派隔离基线（${delegationId.slice(0, 8)}）` })
    const shortId = delegationId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'deleg'
    const branch = `bloma-deleg/${shortId}`
    const worktreePath = join(getPromaHome(), 'bloma-worktrees', projectId, shortId)
    mkdirSync(join(worktreePath, '..'), { recursive: true })
    // 残留同名分支/目录兜底清理（上次异常退出）
    if (existsSync(worktreePath)) runGit(rootPath, ['worktree', 'remove', '--force', worktreePath])
    runGit(rootPath, ['branch', '-D', branch])
    const added = runGit(rootPath, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'])
    if (added.status !== 0) return { ok: false, reason: `worktree_add_failed:${added.stderr.slice(0, 160)}` }
    handles.set(delegationId, { projectId, path: worktreePath, branch, rootPath })
    return { ok: true, path: worktreePath, branch }
  } catch (error) {
    return { ok: false, reason: `error:${String((error as Error)?.message ?? error).slice(0, 120)}` }
  }
}

export type MergeWorktreeResult = {
  ok: boolean
  merged: boolean
  conflicts?: string[]
  reason?: string
  branch?: string
  path?: string
}

/** 合并委派分支到项目根（父会话职责）。冲突：中止合并、保留分支与工作树、回冲突清单。 */
export function mergeDelegationWorktree(delegationId: string): MergeWorktreeResult {
  const handle = handles.get(delegationId)
  if (!handle) return { ok: false, merged: false, reason: 'no_worktree' }
  // 工作树内的改动先提交（子会话可能未提交）
  const inTree = runGit(handle.path, ['status', '--porcelain'])
  if (inTree.stdout.trim()) {
    runGit(handle.path, ['add', '-A'])
    runGit(handle.path, ['commit', '-m', `delegation ${delegationId.slice(0, 8)}: work in progress`])
  }
  const merge = runGit(handle.rootPath, ['merge', '--no-ff', handle.branch, '-m', `merge delegation ${delegationId.slice(0, 8)}（worktree 隔离）`])
  if (merge.status === 0) {
    commitProjectState(handle.rootPath, { kind: 'delegation_merge', summary: `委派分支 ${handle.branch} 已合并` })
    return { ok: true, merged: true, branch: handle.branch, path: handle.path }
  }
  // 冲突：取清单后中止（不自动解冲突——父会话/用户裁决）
  const conflicted = runGit(handle.rootPath, ['diff', '--name-only', '--diff-filter=U'])
  const conflicts = conflicted.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  runGit(handle.rootPath, ['merge', '--abort'])
  return {
    ok: false,
    merged: false,
    conflicts,
    reason: `merge_conflict:${merge.stderr.slice(0, 120)}`,
    branch: handle.branch,
    path: handle.path,
  }
}

/** 清理工作树（合并成功后可删分支；中断/失败保留分支供排查）。 */
export function cleanupDelegationWorktree(delegationId: string, opts: { removeBranch?: boolean } = {}): void {
  const handle = handles.get(delegationId)
  if (!handle) return
  try {
    runGit(handle.rootPath, ['worktree', 'remove', '--force', handle.path])
    if (opts.removeBranch) runGit(handle.rootPath, ['branch', '-D', handle.branch])
  } catch {
    // 清理失败不阻断（残留工作树可由后续 worktree prune 兜底）
  }
  handles.delete(delegationId)
}

function isWritableRole(role: DelegationRunRole): boolean {
  return role === 'implement' || role === 'custom'
}

/**
 * 构造 worktree 隔离 provider（coding 层实现；由 generate 装配到 agent 层注入位——
 * 依赖倒置：coding 不反向 import agent 层）。
 * 开关 off 时 provider 返回 undefined（子会话行为零变化）。
 */
export function buildDelegationWorktreeProvider(): ChildRunContextProvider {
  return (input) => {
    if (!delegationWorktreeEnabled()) return undefined
    if (!isWritableRole(input.role)) return undefined // 只读角色无写冲突面，不隔离
    const created = createDelegationWorktree(input.projectId, input.delegationId)
    if (!created.ok) {
      // 建不失败即不隔离（如实标注，不静默降格为"以为隔离了"）
      return { onFinish: () => ({ worktree: { isolated: false, reason: created.reason } }) }
    }
    const context: ChildRunContext = {
      rootOverride: created.path,
      onFinish: (outcome) => {
        if (outcome === 'completed') {
          const merged = mergeDelegationWorktree(input.delegationId)
          cleanupDelegationWorktree(input.delegationId, { removeBranch: merged.merged })
          return {
            worktree: {
              isolated: true,
              branch: created.branch,
              path: created.path,
              merged: merged.merged,
              ...(merged.conflicts && merged.conflicts.length > 0 ? { conflicts: merged.conflicts } : {}),
              ...(merged.reason && !merged.merged ? { merge_reason: merged.reason } : {}),
            },
          }
        }
        // aborted/failed：移除工作树、保留分支供排查，如实标注未并入
        cleanupDelegationWorktree(input.delegationId, { removeBranch: false })
        return { worktree: { isolated: true, branch: created.branch, path: created.path, merged: false, discarded: true } }
      },
    }
    return context
  }
}

/** 测试隔离：清空句柄表（不执行 git 清理）。 */
export function resetDelegationWorktreesForTests(): void {
  handles.clear()
}
