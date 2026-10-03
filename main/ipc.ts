/**
 * IPC 注册入口（PR4d 拆解后）：本文件只保留跨族接线（发布器/活跃检查/steer 监听）
 * 与各族注册调用；通道实现拆入 main/ipc/（shared + 五族）。registerIpcHandlers 契约不变。
 * 死 import 尸块已清（2026-10-03 审查卫生批——拆分残留的 145 个未用符号）。
 */
import type { BrowserWindow, IpcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/types'
import { hasForegroundRun, isSessionActive, persistSteerDeferredNotice, publishSteerStatusEvent, setAgentStreamPublisher } from './orchestration/orchestrator'
import { setSteerStatusListener } from './agent/loop/steer-queue'
import { setForegroundRunChecker, setProgrammingEventPublisher } from './coding/programming-orchestrator'
import { handleAgentStreamEvent } from './platform/shell/notifications'
import { setPermissionRequestPublisher } from './agent/permissions/permission-service'
import { setSessionActiveChecker } from './platform/sessions/session-service'
import { registerAgentSessionsIpc } from './ipc/agent-sessions'
import { registerProjectsIpc } from './ipc/projects'
import { registerSandboxSnapshotsIpc } from './ipc/sandbox-snapshots'
import { registerChannelsRoutingIpc } from './ipc/channels-routing'
import { registerPromptsIpc } from './ipc/prompts'
import { registerDesktopArtifactsIpc } from './ipc/desktop-artifacts'

export function registerIpcHandlers(ipcMain: IpcMain, mainWindow: BrowserWindow): void {
  // P0-2 fork：活跃会话检查注入（session-service 不反向 import orchestrator——防循环依赖）
  setSessionActiveChecker(isSessionActive)
  // I3 转向生效确认链（P7-7）：steer-queue 状态机推进 → orchestrator 发布口 →
  // steer_status 事件→渲染端状态条。listener 引用 orchestrator 的 publishSteerStatusEvent
  //（其内部走 streamPublisher，接线时序与本处 setAgentStreamPublisher 之后自然生效）。
  // deferred 达成时同步落盘待办留痕（JSONL 跨重启可见——状态条内存态重启丢的补口）。
  setSteerStatusListener((entry) => {
    publishSteerStatusEvent(entry)
    if (entry.status === 'deferred_next_run') persistSteerDeferredNotice(entry.sessionId, entry.content)
  })
  setAgentStreamPublisher((event) => {
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_EVENT, event)
    // T6 后台执行通知：completed/error/user_decision_required → 系统通知（无后端注入时内部 no-op）
    handleAgentStreamEvent(event)
  })
  setProgrammingEventPublisher((event) => {
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_EVENT, event)
    handleAgentStreamEvent(event)
  })
  // 让渡终态补发的前台判定（2026-08-29）：前台 runAgent 流自带终态，后台编程流没有——
  // publishBlockedDecision 据此决定是否补发 completed，避免 UI 永久卡「生成中」。
  setForegroundRunChecker(hasForegroundRun)
  setPermissionRequestPublisher((request) => {
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_EVENT, {
      event_id: request.id,
      session_id: request.session_id,
      project_id: request.project_id,
      type: 'permission_requested',
      payload: { request },
      created_at: request.created_at,
    })
  })


  registerAgentSessionsIpc(ipcMain, mainWindow)
  registerProjectsIpc(ipcMain, mainWindow)
  registerSandboxSnapshotsIpc(ipcMain, mainWindow)
  registerChannelsRoutingIpc(ipcMain, mainWindow)
  registerPromptsIpc(ipcMain, mainWindow)
  registerDesktopArtifactsIpc(ipcMain, mainWindow)
}
