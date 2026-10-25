/**
 * Agent 会话族：send/steer×3/fork/pasted-image/stop/list/load/clean-orphans/confirm-requirements/permission×2（PR4d 自 ipc.ts 拆出；纯机械搬移，行为零变化）。
 */
import { randomUUID } from 'node:crypto'



import type { BrowserWindow, IpcMain } from 'electron'
import type { AgentForkSessionInput, AgentListSessionsInput, AgentLoadMessagesInput, AgentSteerQueryInput, AgentSteerResolveInput, PastedImageSaveInput, PermissionSetModeInput, RequestEnvelope } from '../../shared/types';
import { IPC_CHANNELS } from '../../shared/types'

import { cancelAgent, registerBackgroundRun, runAgent, unregisterBackgroundRun } from '../orchestration/orchestrator';
import { enqueueSteer, getSteerStatuses, pendingSteerCount, registerSteer, resolveSteer, steerConfirmEnabled } from '../agent/loop/steer-queue';
import { savePastedImage } from '../platform/shell/pasted-images'
import { registerComposerIpc } from './composer'


import { resolvePermission, setPermissionMode } from '../agent/permissions/permission-service';
import { listProjects } from '../project/project-service';
import { cleanOrphanSessions, forkFrom, listSessions, loadMessages } from '../platform/sessions/session-service';
import { readPendingDecision } from '../guide/pending-decision'




import { resolveRequirementConfirm } from '../guide/guide-agent-service'












import { safeInvoke, extractRequestId, requireFields, validateAgentSend, validateCancel, validateConfirmRequirements, validatePermissionResponse } from './shared';

export function registerAgentSessionsIpc(ipcMain: IpcMain, mainWindow: BrowserWindow): void {
  registerComposerIpc(ipcMain)
  void mainWindow
  ipcMain.handle(IPC_CHANNELS.AGENT_SEND_MESSAGE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = validateAgentSend(payload)
      return runAgent(input)
    })
  })

  // P0-1 steer（运行中转向，2026-09-08）：活跃主 loop 期间输入框改道本通道。
  // 入参与 agent:send-message 同构（validateAgentSend 同一清洗）；无活跃主 loop 时
  //（空闲 / guide 单发 run / 后台间隙 / 带图消息）内部回退 runAgent——与 send-message
  // 行为完全一致（忙则入 SessionMessageQueue、空闲开新 run），渲染端无需二次兜底。
  ipcMain.handle(IPC_CHANNELS.AGENT_STEER_MESSAGE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = validateAgentSend(payload)
      // 带图消息不做 steer：注入只承载文本，图片走既有 send-message 链路（整体入队/开跑）
      // I3 转向生效确认链（P7-7，BLOMA_STEER_CONFIRM on 时）：入队前先登记账本并按档位
      //  分流——低档 received 直接入队（简短确认即注入）；中/高档 pending_impact 不入队，
      //  影响卡三选回执走 agent:steer-resolve。off 时与 P0-1 字节级一致。
      if ((input.images?.length ?? 0) === 0) {
        if (steerConfirmEnabled()) {
          const registered = registerSteer(input.session_id, {
            queueMessageId: input.request_id,
            content: input.content,
            enqueuedAt: Date.now(),
          }, input.project_id)
          if (registered) {
            return {
              session_id: input.session_id,
              steered: true,
              pending: pendingSteerCount(input.session_id),
              status: registered.status,
              impact: registered.impact,
              steer_id: registered.steerId,
            }
          }
        } else if (enqueueSteer(input.session_id, {
          queueMessageId: input.request_id,
          content: input.content,
          enqueuedAt: Date.now(),
        })) {
          return { session_id: input.session_id, steered: true, pending: pendingSteerCount(input.session_id) }
        }
      }
      const fallback = await runAgent(input)
      return { session_id: input.session_id, steered: false, fallback }
    })
  })

  // I3（P7-7）：影响卡三选回执——inject_now=本轮就改（入队注入）/defer=留待下一轮
  //（可见待办）/reject=不改了。只对 pending_impact 状态有效，非法回执拒收。
  ipcMain.handle(IPC_CHANNELS.AGENT_STEER_RESOLVE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<AgentSteerResolveInput>(payload, ['session_id', 'steer_id', 'action'])
      if (input.action !== 'inject_now' && input.action !== 'defer' && input.action !== 'reject') {
        throw new Error('INVALID_STEER_ACTION')
      }
      const resolved = resolveSteer(input.session_id, input.steer_id, input.action)
      if (!resolved) throw new Error('STEER_NOT_PENDING')
      return { session_id: input.session_id, steer_id: input.steer_id, status: resolved.status }
    })
  })

  // I3：会话 steer 状态查询（渲染端刷新后状态条恢复；「这轮会做吗」的权威答案源）
  ipcMain.handle(IPC_CHANNELS.AGENT_STEER_QUERY, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<AgentSteerQueryInput>(payload, ['session_id'])
      return {
        session_id: input.session_id,
        items: getSteerStatuses(input.session_id).map((entry) => ({
          steer_id: entry.steerId,
          content: entry.content,
          impact: entry.impact,
          status: entry.status,
          updated_at: entry.updatedAt,
        })),
      }
    })
  })

  // 粘贴图存盘（clipboard-paste P1，2026-08-29）：renderer 粘贴→base64 存文件→短引用；
  // 大小校验双保险（renderer 白名单先行，主进程兜底防绕过）
  // P0-2 fork（会话 fork，2026-09-08）：从任意 user 消息重开。渲染端 user 气泡「从这里
  // 重新来」→ 复制前缀到新会话（原文件一字不动），返回新 sessionId 由渲染端续接。
  ipcMain.handle(IPC_CHANNELS.AGENT_FORK_SESSION, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<AgentForkSessionInput>(payload, ['session_id', 'project_id'])
      const hasAnchor = (input.entry_id !== undefined && String(input.entry_id).trim() !== '')
        || typeof input.entry_timestamp === 'number'
      if (!hasAnchor) throw new Error('SESSION_FORK_ENTRY_NOT_FOUND: 需要 entry_id 或 entry_timestamp')
      return forkFrom(input.session_id, {
        project_id: input.project_id,
        entry_id: typeof input.entry_id === 'string' ? input.entry_id : undefined,
        entry_timestamp: typeof input.entry_timestamp === 'number' ? input.entry_timestamp : undefined,
      })
    })
  })

  ipcMain.handle(IPC_CHANNELS.PASTED_IMAGE_SAVE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<PastedImageSaveInput>(payload, ['session_id', 'base64', 'ext'])
      if (typeof input.base64 !== 'string' || input.base64.length === 0) throw new Error('PASTED_IMAGE_EMPTY: 空 base64 载荷')
      if (Buffer.byteLength(input.base64, 'base64') > 5 * 1024 * 1024) throw new Error('PASTED_IMAGE_TOO_LARGE: 超过 5MB 上限')
      return savePastedImage(input.session_id, input.base64, input.ext)
    })
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_STOP, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = validateCancel(payload)
      return cancelAgent(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_LIST_SESSIONS, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<AgentListSessionsInput>(payload, [])
      return listSessions(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_LOAD_MESSAGES, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<AgentLoadMessagesInput>(payload, ['session_id'])
      const result = loadMessages(input)
      if (result.session.project_id) {
        try { result.pending_decision = readPendingDecision(result.session.project_id, input.session_id) }
        catch (error) { result.pending_decision_error = error instanceof Error ? error.message : String(error) }
      }
      return result
    })
  })

  // U11：清理孤儿会话——移除指向已删除项目的会话记录及其 JSONL 文件。
  ipcMain.handle(IPC_CHANNELS.SESSION_CLEAN_ORPHANS, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      requireFields<RequestEnvelope>(payload, [])
      return cleanOrphanSessions(new Set(listProjects('all').map((p) => p.project_id)))
    })
  })

  // 需求确认弹窗决策回传（confirm_requirements 流，2026-08-26）：confirm/delegate →
  // PRD 前移 + 六维审查 + PRD 确认卡；supplement 由渲染端走既有 send-message，不经此通道。
  // 确认后管线不经过 runAgent（activeSessions 管不到），注册 backgroundRun 让「停止」
  // 按钮（cancelAgent）能 abort——否则审查委派等长环节停不掉（线上 abb1a19f 断链）。
  ipcMain.handle(IPC_CHANNELS.AGENT_CONFIRM_REQUIREMENTS, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = validateConfirmRequirements(payload)
      const controller = new AbortController()
      const runId = registerBackgroundRun(input.session_id, controller, input.project_id)
      try {
        return await resolveRequirementConfirm(input, controller.signal)
      } finally {
        unregisterBackgroundRun(input.session_id, runId)
      }
    })
  })

  ipcMain.handle(IPC_CHANNELS.PERMISSION_RESPONSE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = validatePermissionResponse(payload)
      return resolvePermission(input)
    })
  })

  // 权限模式切换：设置页三档（safe/ask/allow-all）同步到主进程 enforcement。
  // F8：切换成功后经 stream 通道广播 permission_mode_changed，渲染端 atom 随主进程
  // 同步（此前 atom 只在设置页本地写、其他入口 setMode 后弹窗契约押在未同步缺口上）。
  ipcMain.handle(IPC_CHANNELS.PERMISSION_SET_MODE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<PermissionSetModeInput>(payload, ['mode'])
      const mode = setPermissionMode(input.mode)
      mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_EVENT, {
        event_id: randomUUID(),
        session_id: `permission-mode-${mode}`,
        type: 'permission_mode_changed',
        payload: { mode },
        created_at: new Date().toISOString(),
      })
      return { mode }
    })
  })

}
