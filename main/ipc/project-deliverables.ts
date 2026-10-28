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
import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, statSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { IPC_CHANNELS } from '../../shared/types'
import { resolveDriverVenvCommand } from '../desktop/process-driver'
import { isVenvDirectory } from '../verification/security-scan'
import { extractRequestId, requireFields, safeInvoke } from './shared'
import type { ProjectDeliverablesInput, ProjectDeliverablesResult, ProjectLaunchAppInput, ProjectLaunchAppResult } from '../../shared/types'
import { softwareStatusView } from '../software/state-view'
import { findProject } from '../project/project-service'
import { parseLaunchDeclaration, readLaunchDeclaration } from '../desktop/launch-smoke'
import { violatesCommandBlacklist } from '../desktop/contract-schema'
import { mintProjectPreviewUrl } from '../delivery/preview-scheme'
import { isSoftwareProject } from '../desktop/workflow-policy'
import { launchSoftwareForUser } from '../software/user-launch'
import { activeSoftwareRelease } from '../software/release-store'
import { listSoftwareDataSnapshots, softwareFallbackReleaseId } from '../software/data-update'
import { launchSoftwareTrial, softwareTrial, closeSoftwareTrial } from '../software/trial'
import { readPrdBackplane } from '../project/prd-store'
import { readSoftwareSuggestions, decideSoftwareSuggestion } from '../software/improvement-suggestions'
import { hasRunForProject, registerBackgroundRun, unregisterBackgroundRun, backgroundRuns } from '../orchestration/stages/run-registry'
import { randomUUID } from 'node:crypto'
import { isLongtermSoftware, readLongtermState } from '../software/longterm-state'
import { performLongtermAction } from '../software/longterm-control'

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
  ipcMain.handle(IPC_CHANNELS.SOFTWARE_LONGTERM_ACTION,(_event,payload:unknown)=>safeInvoke(extractRequestId(payload),async()=>{
    const input=requireFields<import('../../shared/types').LongtermActionInput>(payload,['request_id','project_id','session_id','revision','action'])
    const emit=(type:import('../../shared/types').AgentEvent['type'],data:Record<string,unknown>)=>_mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_EVENT,{event_id:randomUUID(),project_id:input.project_id,session_id:input.session_id,type,payload:data,created_at:new Date().toISOString()})
    const controller=new AbortController(),busy=hasRunForProject(input.project_id)
    let runId:string|undefined,completed=false
    if(input.action==='confirm'&&!busy)runId=registerBackgroundRun(input.session_id,controller,input.project_id,event=>_mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_EVENT,event))
    try{
      if(runId)emit('message_delta',{text:'正在核对当前里程碑版本；不会发起模型请求。'})
      const result=await performLongtermAction(input,AbortSignal.any([controller.signal,AbortSignal.timeout(180000)]),{busy,emit})
      emit('message_delta',{text:result.detail});completed=true;return result
    }finally{
      if(runId&&backgroundRuns.get(input.session_id)?.runId===runId){emit('completed',{subtype:completed&&!controller.signal.aborted?'success':'incomplete'});unregisterBackgroundRun(input.session_id,runId)}
    }
  }))
  ipcMain.handle(IPC_CHANNELS.SOFTWARE_SUGGESTIONS_DECIDE, (_event,payload:unknown)=>safeInvoke(extractRequestId(payload),async()=>{
    const input=requireFields<import('../../shared/types').SoftwareSuggestionDecisionInput>(payload,['request_id','project_id','session_id','set_id','suggestion_id','action'])
    return decideSoftwareSuggestion(input,hasRunForProject(input.project_id),(type,data)=>_mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_EVENT,{
      event_id:randomUUID(),project_id:input.project_id,session_id:input.session_id,type,payload:data,created_at:new Date().toISOString()}))
  }))
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
        const root = realpathSync(project.root_path)
        const sketch = realpathSync(join(root, '00_UX', 'confirmed.html'))
        if (sketch.startsWith(root + sep) && statSync(sketch).size <= 1024 * 1024) result.confirmed_sketch_url = mintProjectPreviewUrl(project.project_id, '00_UX/confirmed.html')
      } catch { /* A missing archived sketch is not an application failure. */ }
      try {
        const md = readFileSync(join(project.root_path, 'DELIVERY.md'), 'utf8')
        if (md.length <= MAX_DELIVERY_MD) result.delivery_md = md
        else result.delivery_md = `${md.slice(0, MAX_DELIVERY_MD)}\n…（超长截断）`
      } catch {
        /* DELIVERY.md 缺失如实呈现 */
      }
      const stable = isSoftwareProject(project.project_id) ? await activeSoftwareRelease(project.project_id, undefined, false) : undefined
      if (isSoftwareProject(project.project_id)) result.data_snapshots = listSoftwareDataSnapshots(project.project_id)
      if (stable) result.stable_release = stable.id
      if (stable) {
        try {
          const report = JSON.parse(readFileSync(join(stable.root, '00_VERIFY/core-verification.json'), 'utf8')) as { distribution?: { detail?: string } }
          if (report.distribution?.detail) result.delivery_qualification = { detail: report.distribution.detail, independent_verified: false }
        } catch { /* missing qualification is never an independent delivery PASS */ }
      }
      if (stable) result.can_use_previous_release = Boolean(softwareFallbackReleaseId(project.project_id, stable.id))
      const declaration = stable ? { ok: true as const, launch: stable.launch } : readLaunchDeclaration(project.root_path)
      if (declaration === null) {
        result.launch = { declared: false, parse_ok: false }
      } else if (declaration.ok) {
        result.launch = { declared: true, parse_ok: true, command: declaration.launch.command }
        if (isSoftwareProject(project.project_id)) result.supports_point_selection = declaration.launch.ui === 'electron'
      } else {
        result.launch = { declared: true, parse_ok: false, parse_error: declaration.error }
      }
      result.can_launch = (project.current_stage === 'completed' || Boolean(stable)) && result.launch.parse_ok
      if (isSoftwareProject(project.project_id)) {
        result.status_view = softwareStatusView(project.project_id, hasRunForProject(project.project_id))
        if(isLongtermSoftware(project.project_id))try{result.longterm=readLongtermState(project.project_id)}catch(error){result.longterm_error=String(error)}
        result.improvement_suggestions = readSoftwareSuggestions(project.project_id)
        result.trial = softwareTrial(project.project_id)
        result.can_trial = Boolean(readPrdBackplane(project.project_id).user_confirmed_at && readLaunchDeclaration(project.root_path)?.ok)
      }
      return result
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_LAUNCH_APP, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectLaunchAppInput>(payload, ['project_id'])
      const project = findProject(input.project_id)
      if (input.trial === true) {
        if (!isSoftwareProject(project.project_id) || input.restore_snapshot || input.previous_release) throw Error('TRIAL_INPUT_INVALID')
        if (input.stop_trial === true) return closeSoftwareTrial(project.project_id, input.trial_version)
        return launchSoftwareTrial(project.project_id, input.trial_version, input.restart === true)
      }
      const stable = isSoftwareProject(input.project_id) ? await activeSoftwareRelease(input.project_id, undefined, false) : undefined
      if (project.current_stage !== 'completed' && !stable) {
        throw new Error('LAUNCH_NOT_DELIVERED: 项目尚未完成交付，不能启动')
      }
      const parsed = stable ? { ok: true as const, launch: stable.launch } : parseLaunchDeclaration(readFileSync(join(project.root_path, 'LAUNCH.json'), 'utf8'))
      if (!parsed.ok) {
        throw new Error(`LAUNCH_INVALID: ${parsed.error}`)
      }
      if (input.restore_snapshot && input.restore_data_confirmed !== true) throw Error('DATA_RESTORE_CONFIRMATION_REQUIRED')
      if (isSoftwareProject(input.project_id)) return launchSoftwareForUser(input.project_id, project.root_path, parsed.launch, url => shell.openExternal(url), input.restart === true, input.restore_snapshot, input.previous_release === true)
      const blacklistHit = violatesCommandBlacklist(parsed.launch.command)
      if (blacklistHit) {
        throw new Error(`LAUNCH_BLOCKED: ${blacklistHit}`)
      }
      const command = resolveDriverVenvCommand(parsed.launch.command, project.root_path)
      const child = spawn(command[0]!, command.slice(1), {
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
      return { started: pid !== undefined, ...(pid !== undefined ? { pid } : {}), command: command.join(' ') } satisfies ProjectLaunchAppResult
    })
  })
}
