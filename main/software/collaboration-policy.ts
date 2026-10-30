import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ToolContext } from '../agent/loop/agent-loop'
import type { DelegationParentContext } from '../agent/delegation/delegation-context'
import { softwareVerificationFingerprint as verificationFingerprint } from '../desktop/verification-fingerprint'
import { hasSoftwareSessionProcess } from './process-manager'
import { hasDebugSession } from './debug-sessions'

interface Assignment { paths: string[]; readOnly: boolean; active: boolean; source?: string }
const overlap = (a: string, b: string) => a === b || a.endsWith('/') && b.startsWith(a) || b.endsWith('/') && a.startsWith(b)

/** Shared-workspace collaborators edit assigned files only. Arbitrary commands
 * stay with the integrator: a language/shell allowlist cannot enforce write paths. */
export function createSoftwareCollaborationPolicy(projectId: string, root: string, parentSessionId: string) {
  const assignments = new Map<string, Assignment>(), canonicalRoot = realpathSync(root)
  let reviewFrozen = false
  const pathOf = (raw: string): string => {
    if (!raw || isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.split(/[\\/]/).some(part => part === '..') || /[*?\0]/.test(raw)) throw new Error('DELEGATION_WRITE_PATH_INVALID')
    const directory = /[\\/]$/.test(raw)
    const resolved = resolve(canonicalRoot, raw)
    let ancestor = resolved
    while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor)
    const canonical = resolve(realpathSync(ancestor), relative(ancestor, resolved))
    const rel = relative(canonicalRoot, canonical).replaceAll('\\', '/')
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || /^(?:\.git|node_modules|\.venv|data-backups)(?:\/|$)/i.test(rel)) throw new Error('DELEGATION_WRITE_PATH_OUTSIDE_PROJECT')
    return (process.platform === 'win32' ? rel.toLowerCase() : rel) + (directory ? '/' : '')
  }
  const assertFileWrite = (path: string, ctx: ToolContext) => {
    ctx.signal.throwIfAborted()
    if (ctx.projectId !== projectId) throw new Error('DELEGATION_PROJECT_MISMATCH')
    if (reviewFrozen) throw Error('QUALITY_REVIEW_FROZEN: 等待只读审阅结束后再修改候选')
    const target = pathOf(path)
    if (ctx.sessionId === parentSessionId) {
      if ([...assignments.values()].some(assignment => assignment.active && !assignment.readOnly && assignment.paths.some(owned => overlap(owned, target)))) throw new Error('FILE_OWNED_BY_ACTIVE_COLLABORATOR: 等待任务结束后再集成，不覆盖其文件')
      return
    }
    const assignment = assignments.get(ctx.sessionId)
    if (!assignment?.active || assignment.readOnly || !assignment.paths.some(owned => overlap(owned, target))) throw new Error('DELEGATION_WRITE_SCOPE_DENIED')
  }
  const assertCommand = (ctx: ToolContext) => {
    ctx.signal.throwIfAborted()
    if (ctx.projectId !== projectId || ctx.sessionId !== parentSessionId) throw new Error('COMMAND_INTEGRATOR_ONLY')
    if (reviewFrozen) throw Error('QUALITY_REVIEW_FROZEN: 审阅期间不能运行可能修改候选的命令')
    if ([...assignments.values()].some(assignment => assignment.active && !assignment.readOnly)) throw new Error('COMMAND_WAIT_FOR_WRITERS: 先收齐文件改动，再统一构建/验证；只读调研可继续并行')
  }
  const prepare: NonNullable<DelegationParentContext['prepareDelegation']> = ({ parent, args, childSessionId }) => {
    if (parent.projectId !== projectId || parent.sessionId !== parentSessionId) throw new Error('DELEGATION_PARENT_MISMATCH')
    parent.signal.throwIfAborted()
    if (reviewFrozen && args.role !== 'review') throw Error('QUALITY_REVIEW_FROZEN')
    const writable = args.role === 'implement' && args.readOnly !== true || args.role === 'custom' && args.readOnly === false
    if (writable && (hasSoftwareSessionProcess(projectId, parentSessionId) || hasDebugSession(projectId, parentSessionId))) throw Error('DELEGATION_STOP_DEV_SERVICE_BEFORE_WRITING: 先停止会话中的开发服务/调试实例，再划分写入任务；避免后台构建与子任务改动互相覆盖')
    const paths = writable ? (args.writePaths ?? []).map(pathOf) : []
    if (writable && (!paths.length || paths.length > 32)) throw new Error('DELEGATION_EXPLICIT_WRITE_PATHS_REQUIRED')
    if (paths.some((path, i) => paths.slice(0, i).some(other => overlap(path, other)))
      || [...assignments.values()].some(assignment => assignment.active && !assignment.readOnly && paths.some(path => assignment.paths.some(other => overlap(path, other))))) throw new Error('DELEGATION_WRITE_PATH_CONFLICT')
    const assignment: Assignment = { paths, readOnly: !writable, active: true, source: verificationFingerprint(root) }
    assignments.set(childSessionId, assignment)
    return { release: () => { assignment.active = false }, completionNote: () => assignment.readOnly && assignment.source !== verificationFingerprint(root)
      ? '\n核查期间源码已变化；以上仅供定位，不能作为当前版本通过证据。' : '' }
  }
  return { prepare, assertFileWrite, assertCommand,
    freezeReview: () => {
      if (reviewFrozen || [...assignments.values()].some(a => a.active && !a.readOnly)) throw Error('QUALITY_REVIEW_WAIT_FOR_WRITERS')
      reviewFrozen = true
      return () => { reviewFrozen = false }
    },
    describe: (sessionId: string) => { const value = assignments.get(sessionId); return value ? JSON.stringify({ read_only: value.readOnly, write_paths: value.paths }) : '主负责人持有集成与运行权限' } }
}
