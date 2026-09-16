/**
 * Phase 10 W1-1（2026-09-16，咨询 G 收口）：产物 git 化——项目工作区纳入 git 版本管理。
 * host 单点执行（loop 工具面无 git 操作，权限面不变）；生命周期事件处由编排器接线
 * （接线点 ≤15 行，只调本模块入口）。恢复原语对 .git/data-backups 的排除在
 * platform-services（快照语义属主，SNAPSHOT_PRESERVED_TOPLEVEL）。
 * 依赖：仅 node 标准库；fail-open——git 缺失/命令失败一律返回 {ok:false,reason} 记
 * decision 后跳过，绝不抛错阻塞主链路。
 * 开关 BLOMA_PROJECT_GIT：'1'/'on'/'true'=开；未设/'0'/'off'/'false'=关（缺省 off，
 * 不 init 不 commit；快照排除逻辑属基础设施常开，与本开关无关）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 开关解析（与 iterationBriefEnabled 同风格，每次调用读取）。 */
export function projectGitEnabled(): boolean {
  const raw = (process.env.BLOMA_PROJECT_GIT ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

let gitProbe: boolean | null = null

/** git 可用性探测（进程内缓存一次；测试可用 resetGitProbeForTests 重置）。 */
export function gitAvailable(): boolean {
  if (gitProbe === null) {
    try {
      const r = spawnSync('git', ['--version'], { timeout: 5000, windowsHide: true, encoding: 'utf8' })
      gitProbe = r.status === 0
    } catch {
      gitProbe = false
    }
  }
  return gitProbe
}

export function resetGitProbeForTests(): void {
  gitProbe = null
}

/** .gitignore 追加行（真实数据与备份目录绝不进 git——回滚/升级各有自己的语义线）。 */
export const PROJECT_GITIGNORE_LINES = ['data/', 'data-backups/', 'node_modules/', 'dist/', '*.log', '.DS_Store'] as const

const GITATTRIBUTES = '* text=auto eol=lf\n'

export interface ProjectGitEvent {
  kind: string
  summary: string
  stage?: string
  taskId?: string
}

export interface ProjectGitResult {
  ok: boolean
  committed?: boolean
  commit?: string
  reason?: string
}

function runGit(root: string, args: string[]) {
  return spawnSync('git', args, { cwd: root, timeout: 15000, windowsHide: true, encoding: 'utf8' })
}

/** 单行化 summary（压制换行与超长，commit message 首行可读）。 */
function oneLine(text: string): string {
  const flat = text.replace(/[\r\n]+/g, ' ').trim()
  return flat.length > 200 ? flat.slice(0, 197) + '...' : flat
}

/** 幂等 init：.git 不存在则建；.gitignore 缺行则补（保留用户手写行）；autocrlf=false 统一 LF。 */
export function ensureProjectRepo(projectRoot: string): ProjectGitResult {
  try {
    if (!projectGitEnabled()) return { ok: false, reason: 'disabled' }
    if (!existsSync(projectRoot)) return { ok: false, reason: 'root_missing' }
    if (!gitAvailable()) return { ok: false, reason: 'git_missing' }
    const gitDir = join(projectRoot, '.git')
    if (!existsSync(gitDir)) {
      const init = runGit(projectRoot, ['init'])
      if (init.status !== 0) return { ok: false, reason: `init_failed:${String(init.stderr).slice(0, 120)}` }
    }
    const cfg = runGit(projectRoot, ['config', 'core.autocrlf', 'false'])
    if (cfg.status !== 0) return { ok: false, reason: 'config_failed' }
    // commit 身份兑底：机器无全局 user.email 时 commit 必败（fail-open 不允许）——
    // 探测为空则写入仓库局部身份（不碰全局配置）。
    const email = runGit(projectRoot, ['config', 'user.email'])
    if (email.status !== 0 || !String(email.stdout ?? '').trim()) {
      const setId = runGit(projectRoot, ['config', 'user.email', 'bloma@local'])
      const setName = runGit(projectRoot, ['config', 'user.name', 'Bloma'])
      if (setId.status !== 0 || setName.status !== 0) return { ok: false, reason: 'identity_failed' }
    }
    const ignorePath = join(projectRoot, '.gitignore')
    let existing = ''
    if (existsSync(ignorePath)) existing = readFileSync(ignorePath, 'utf8')
    const lines = existing.split(/\r?\n/).map((l) => l.trim())
    const missing = PROJECT_GITIGNORE_LINES.filter((l) => !lines.includes(l))
    if (missing.length > 0 || existing === '') {
      const next = existing === '' ? [...PROJECT_GITIGNORE_LINES].join('\n') + '\n' : existing.replace(/\s*$/, '\n') + missing.join('\n') + '\n'
      writeFileSync(ignorePath, next, 'utf8')
    }
    const attrPath = join(projectRoot, '.gitattributes')
    if (!existsSync(attrPath)) writeFileSync(attrPath, GITATTRIBUTES, 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: `error:${String((err as Error)?.message ?? err).slice(0, 120)}` }
  }
}

/** 生命周期事件提交：无变更如实 nothing_to_commit；失败 fail-open 返回 reason。 */
export function commitProjectState(projectRoot: string, event: ProjectGitEvent): ProjectGitResult {
  try {
    const ensure = ensureProjectRepo(projectRoot)
    if (!ensure.ok) return ensure
    const status = runGit(projectRoot, ['status', '--porcelain'])
    if (status.status !== 0) return { ok: false, reason: 'status_failed' }
    if (!String(status.stdout ?? '').trim()) return { ok: true, committed: false, reason: 'nothing_to_commit' }
    const add = runGit(projectRoot, ['add', '-A'])
    if (add.status !== 0) return { ok: false, reason: 'add_failed' }
    const message = [
      `[bloma:${event.kind}] ${oneLine(event.summary)}`,
      event.stage ? `stage: ${oneLine(event.stage)}` : null,
      event.taskId ? `task: ${oneLine(event.taskId)}` : null,
    ]
      .filter((l): l is string => l !== null)
      .join('\n')
    const commit = runGit(projectRoot, ['commit', '-m', message])
    if (commit.status !== 0) return { ok: false, reason: `commit_failed:${String(commit.stderr).slice(0, 120)}` }
    const hash = runGit(projectRoot, ['rev-parse', '--short', 'HEAD'])
    return {
      ok: true,
      committed: true,
      commit: hash.status === 0 ? String(hash.stdout ?? '').trim() : undefined,
    }
  } catch (err) {
    return { ok: false, reason: `error:${String((err as Error)?.message ?? err).slice(0, 120)}` }
  }
}
