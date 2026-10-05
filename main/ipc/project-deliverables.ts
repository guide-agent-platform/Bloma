/**
 * 交付面板 IPC（2026-10-04 呈现层收口批）。
 *
 * 两通道（四层强类型链路）：
 *   PROJECT_DELIVERABLES（invoke）：项目文件清单 + DELIVERY.md + LAUNCH.json 声明快照；
 *   PROJECT_LAUNCH_APP（invoke）：completed 项目的「启动程序」——LAUNCH.json 声明制，
 *   detached spawn（用户主动点击启动长驻产品进程，不挂 Agent 会话终端——陷阱 26 反向
 *   场景：这是用户产品进程，本就应独立于 Bloma 生命周期存活）。
 *
 * 域逻辑复用：launch-smoke 的声明解析/黑名单（与交付前冒烟同一套约定）。
 */
import type { BrowserWindow, IpcMain } from 'electron'
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { IPC_CHANNELS } from '../../shared/types'
import { isVenvDirectory } from '../verification/security-scan'
import { extractRequestId, requireFields, safeInvoke } from './shared'
import type { ProjectDeliverablesInput, ProjectDeliverablesResult, ProjectLaunchAppInput, ProjectLaunchAppResult } from '../../shared/types'
import { findProject } from '../project/project-service'
import { parseLaunchDeclaration, readLaunchDeclaration } from '../desktop/launch-smoke'
import { violatesCommandBlacklist } from '../desktop/contract-schema'

const SKIP_DIRS = new Set(['archive', 'node_modules', 'dist', '.git', '__pycache__', '00_VERIFY/screenshots'])
const MAX_FILES = 200
const MAX_DELIVERY_MD = 64 * 1024

function listFiles(rootPath: string): string[] {
  const files: string[] = []
  const visit = (dir: string, rel: string, depth: number): void => {
    if (files.length >= MAX_FILES || depth > 4) return
    let entries: Array<{ name: string; isDirectory: () => boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory: () => boolean }>
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        // 审计 B-10（2026-10-04）：SKIP_DIRS 按目录名匹配，'00_VERIFY/screenshots' 是
        // 复合路径永远不命中——改按相对路径拦截，截图不再泄入文件清单（占 200 上限）。
        if (childRel === '00_VERIFY/screenshots') continue
        // 确认门新规（2026-10-04）：00_UX 外观草图存档不是交付物，不进文件清单。
        if (childRel === '00_UX') continue
        // 迁移批（2026-10-05）：venv/缓存目录是环境产物不是交付物；名字集之外用
        // pyvenv.cfg 标记兑底异名 venv（同 security-scan 根治口径）
        if (['.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox', '.gradle'].includes(entry.name)) continue
        if (isVenvDirectory(join(dir, entry.name))) continue
        visit(join(dir, entry.name), childRel, depth + 1)
      } else {
        files.push(childRel)
      }
    }
  }
  visit(rootPath, '', 0)
  return files
}

export function registerProjectDeliverablesIpc(ipcMain: IpcMain, _mainWindow: BrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.PROJECT_DELIVERABLES, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectDeliverablesInput>(payload, ['project_id'])
      const project = findProject(input.project_id)
      const result: ProjectDeliverablesResult = {
        files: listFiles(project.root_path),
        launch: { declared: false, parse_ok: false },
        can_launch: false,
      }
      try {
        const md = readFileSync(join(project.root_path, 'DELIVERY.md'), 'utf8')
        if (md.length <= MAX_DELIVERY_MD) result.delivery_md = md
        else result.delivery_md = `${md.slice(0, MAX_DELIVERY_MD)}\n…（超长截断）`
      } catch {
        /* DELIVERY.md 缺失如实呈现 */
      }
      const declaration = readLaunchDeclaration(project.root_path)
      if (declaration === null) {
        result.launch = { declared: false, parse_ok: false }
      } else if (declaration.ok) {
        result.launch = { declared: true, parse_ok: true, command: declaration.launch.command }
      } else {
        result.launch = { declared: true, parse_ok: false, parse_error: declaration.error }
      }
      result.can_launch = project.current_stage === 'completed' && result.launch.parse_ok
      return result
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_LAUNCH_APP, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectLaunchAppInput>(payload, ['project_id'])
      const project = findProject(input.project_id)
      if (project.current_stage !== 'completed') {
        throw new Error('LAUNCH_NOT_DELIVERED: 项目尚未完成交付，不能启动')
      }
      const raw = readFileSync(join(project.root_path, 'LAUNCH.json'), 'utf8')
      const parsed = parseLaunchDeclaration(raw)
      if (!parsed.ok) {
        throw new Error(`LAUNCH_INVALID: ${parsed.error}`)
      }
      const blacklistHit = violatesCommandBlacklist(parsed.launch.command)
      if (blacklistHit) {
        throw new Error(`LAUNCH_BLOCKED: ${blacklistHit}`)
      }
      const child = spawn(parsed.launch.command[0]!, parsed.launch.command.slice(1), {
        cwd: project.root_path,
        detached: true,
        stdio: 'ignore',
        windowsHide: true, // 隐藏控制台宿主；GUI 窗口照常
      })
      child.unref()
      let pid: number | undefined
      try {
        // 立即退出（启动即崩）如实回报——面板提示用户走修复而不是静默
        if (child.exitCode !== null) pid = undefined
        else pid = child.pid
      } catch {
        pid = child.pid
      }
      return { started: pid !== undefined, ...(pid !== undefined ? { pid } : {}), command: parsed.launch.command.join(' ') } satisfies ProjectLaunchAppResult
    })
  })
}
