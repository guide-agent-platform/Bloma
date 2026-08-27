import { randomUUID } from 'node:crypto'
import { dialog } from 'electron'
import type { BrowserWindow, IpcMain } from 'electron'
import type {
  AgentCancelInput,
  AgentConfirmRequirementsInput,
  AgentListSessionsInput,
  AgentLoadMessagesInput,
  AgentSendMessageInput,
  AnalyticsTrackInput,
  CategoryRoutingUpdateEnvelope,
  ChannelCreateEnvelope,
  ChannelDeleteEnvelope,
  ChannelTestEnvelope,
  ChannelTestDirectEnvelope,
  ChannelUpdateEnvelope,
  FetchModelsEnvelope,
  ConfirmSketchInput,
  DocumentListInput,
  DocumentReadInput,
  DocumentSyncInput,
  DomCollectContextInput,
  DomScrollPreviewInput,
  PermissionResponseInput,
  PermissionSetModeInput,
  PointCorrectionInput,
  PromptReadInput,
  PromptResetInput,
  PromptSaveInput,
  ProjectAbandonInput,
  ProjectArchiveInput,
  ProjectCreateInput,
  ProjectDeleteInput,
  ProjectExportInput,
  ProjectFinalizeInput,
  ProjectListInput,
  ProjectReopenInput,
  ProjectRenameInput,
  ProjectUnarchiveInput,
  ProjectUpgradeInput,
  RequestEnvelope,
  SandboxRunInput,
  SandboxStopInput,
  SnapshotCreateInput,
  SnapshotDocumentListInput,
  SnapshotDocumentReadInput,
  SnapshotListInput,
  SnapshotRollbackInput,
  SnapshotScreenshotInput,
} from '../shared/types'
import { IPC_CHANNELS } from '../shared/types'
import { fail, ok } from './api-result'
import { cancelAgent, getSdkQuery, registerBackgroundRun, runAgent, setAgentStreamPublisher, unregisterBackgroundRun } from './orchestrator'
import { collectDomContext, scrollPreview } from './dom-context'
import { runAgentLoopPostTesting, runIterationTask, runMvpTask, setProgrammingEventPublisher } from './programming-orchestrator'
import { handleAgentStreamEvent } from './notifications'
import { assertToolAllowed, getPermissionMode, resolvePermission, setPermissionMode, setPermissionRequestPublisher } from './permission-service'
import {
  abandonProject,
  archiveProject,
  confirmSketch,
  createProject,
  deleteProject,
  exportProject,
  finalizeProject,
  findProject,
  getProjectProgressSummary,
  listProjects,
  renameProject,
  reopenProject,
  submitCorrection,
  unarchiveProject,
  upgradeProject,
} from './project-service'
import { cleanOrphanSessions, listSessions, loadMessages } from './session-service'
import { resolveRequirementConfirm } from './guide-agent-service'
import { createChannel, deleteChannel, fetchModels, listChannels, testChannel, testChannelDirect, updateChannel } from './channel-manager'
import { buildCategoryRoutingViews, updateCategoryRouting } from './category-routing'
import { listPromptSlots, readPromptSlot, resetPromptSlot, savePromptSlot } from './prompt-service'
import { listDocuments, readDocument, syncDocuments, isPrdUserConfirmed } from './document-engine'
import { isCircuitBreakSettled } from './recovery-service'
import {
  createSnapshot,
  listSnapshotDocuments,
  listSnapshots,
  loadSnapshotScreenshot,
  readSnapshotDocument,
  rollbackSnapshot,
  runSandbox,
  stopSandbox,
  trackAnalytics,
} from './platform-services'
import { hasRequestId, isRecord, requireValue } from './validators'
import { getAgentSessionPath } from '../storage/config-paths'
import { appendJsonLine } from '../storage/json-store'

/** 从错误信息里提取统一的错误码前缀（如 MVP_LLM_PARSE_FAILED、SANDBOX_RUN_FAILED），缺省 AGENT_SDK_ERROR。 */
function errorCodeFrom(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const match = /^([A-Z][A-Z0-9_]*):/.exec(message)
  return match ? match[1] : 'AGENT_SDK_ERROR'
}

export function registerIpcHandlers(ipcMain: IpcMain, mainWindow: BrowserWindow): void {
  setAgentStreamPublisher((event) => {
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_EVENT, event)
    // T6 后台执行通知：completed/error/user_decision_required → 系统通知（无后端注入时内部 no-op）
    handleAgentStreamEvent(event)
  })
  setProgrammingEventPublisher((event) => {
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_EVENT, event)
    handleAgentStreamEvent(event)
  })
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

  ipcMain.handle(IPC_CHANNELS.AGENT_SEND_MESSAGE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = validateAgentSend(payload)
      return runAgent(input)
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
      return loadMessages(input)
    })
  })

  // U11：清理孤儿会话——移除指向已删除项目的会话记录及其 JSONL 文件。
  ipcMain.handle(IPC_CHANNELS.SESSION_CLEAN_ORPHANS, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      requireFields<RequestEnvelope>(payload, [])
      return cleanOrphanSessions()
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
      registerBackgroundRun(input.session_id, controller)
      try {
        return await resolveRequirementConfirm(input, controller.signal)
      } finally {
        unregisterBackgroundRun(input.session_id)
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

  ipcMain.handle(IPC_CHANNELS.PROJECT_CREATE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = validateProjectCreate(payload)
      const project = createProject(input)
      trackAnalytics({
        request_id: input.request_id,
        event: {
          event_type: 'project_created',
          project_id: project.project_id,
          payload: { mode: project.mode },
          privacy_level: 'research_safe',
        },
      })
      return project
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_LIST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectListInput>(payload, [])
      // U16：为每个项目附带最近进展摘要，列表卡片纯展示用。
      return listProjects(input.scope ?? 'active').map((project) => ({
        ...project,
        progress_summary: getProjectProgressSummary(project.project_id),
      }))
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_ARCHIVE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectArchiveInput>(payload, ['project_id'])
      return archiveProject(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_UNARCHIVE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectUnarchiveInput>(payload, ['project_id'])
      return unarchiveProject(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_DELETE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectDeleteInput>(payload, ['project_id'])
      // 先停该项目沙箱，避免 Windows 文件句柄占用导致 rmSync EPERM（复用回滚的"先停后删"模式）
      stopSandbox({ request_id: input.request_id, project_id: input.project_id })
      return deleteProject(input)
    })
  })

  // U10：手动导出项目——弹系统目录选择框，把生成的项目代码复制到用户选定目录。
  // 取消导出不是错误，返回 { canceled: true } 让前端静默处理，不落 error 事件。
  ipcMain.handle(IPC_CHANNELS.PROJECT_EXPORT, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectExportInput>(payload, ['project_id'])
      const project = findProject(input.project_id)
      const result = await dialog.showOpenDialog(mainWindow, {
        title: `导出「${project.name}」`,
        buttonLabel: '导出到这里',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true }
      }
      return exportProject(input, result.filePaths[0])
    })
  })

  // U13：项目重命名——清洗由 renameProject 完成，空名回抛 VALIDATION_ERROR。
  ipcMain.handle(IPC_CHANNELS.PROJECT_RENAME, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectRenameInput>(payload, ['project_id', 'name'])
      return renameProject(input)
    })
  })

  // U15：状态流转——标记为「已放弃」/「恢复进行」（active ↔ abandoned）。
  ipcMain.handle(IPC_CHANNELS.PROJECT_ABANDON, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectAbandonInput>(payload, ['project_id'])
      return abandonProject(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_REOPEN, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectReopenInput>(payload, ['project_id'])
      return reopenProject(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_CONFIRM_SKETCH, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ConfirmSketchInput>(payload, ['project_id', 'session_id', 'snapshot_id', 'decision'])
      const project = confirmSketch(input)
      if (input.decision === 'accepted') {
        // 决策 D5：接受后 main 侧直接下发 MVP 生成，无需用户再次发消息；
        // MVP 就绪后自动进入测试与状态机后半段（A2-09）
        // U4/U5：注册可取消句柄，让「停止生成」能 abort 这条 fire-and-forget 链路。
        const abortController = new AbortController()
        registerBackgroundRun(input.session_id, abortController)
        void runMvpTask({
          request_id: input.request_id,
          session_id: input.session_id,
          project_id: input.project_id,
          mode: project.mode,
          channel_id: input.channel_id,
          query: getSdkQuery(),
          signal: abortController.signal,
        })
          .then((mvp) => {
            // Agent Loop 唯一运行时：MVP 生成后统一走独立门禁（只终验不重修）
            return runAgentLoopPostTesting({
              request_id: input.request_id,
              session_id: input.session_id,
              project_id: input.project_id,
              mode: project.mode,
              preview_url: mvp.preview_url,
              loop: mvp.loop_result,
            })
          })
          .catch((error) => {
            // U5：用户主动停止（signal 已 abort）不再发 error 事件——渲染端已落「已停止生成」，
            // 避免两条相互矛盾的消息；只有真实失败才上报错误。
            if (abortController.signal.aborted) return
            // 熔断回滚已完成收尾（T5）：阶段/消息/completed 事件已在回滚内发布，不再发 error
            if (isCircuitBreakSettled(error)) return
            // P1：不再静默吞错——MVP 生成/测试链失败时向渲染端发 error 事件，
            // 让「预览为什么空」可观测，而不是停在空态。
            const message = error instanceof Error ? error.message : String(error)
            console.error('[ipc] MVP generation/testing flow failed:', message, error)
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_EVENT, {
              event_id: randomUUID(),
              session_id: input.session_id,
              project_id: input.project_id,
              type: 'error',
              payload: { code: errorCodeFrom(error), message },
              created_at: new Date().toISOString(),
            })
          })
          .finally(() => unregisterBackgroundRun(input.session_id))
      }
      return project
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_SUBMIT_CORRECTION, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<PointCorrectionInput>(payload, ['project_id', 'session_id', 'mode'])
      const result = submitCorrection(input)

      // S3-CORRECT-006 / research-plan §5：point_correction 埋点（含 repeat_count / fallback_mode）。
      trackAnalytics({
        request_id: input.request_id,
        event: {
          event_type: 'point_correction',
          project_id: input.project_id,
          session_id: input.session_id,
          payload: {
            target_type: input.context?.element_selector ? 'element' : 'region',
            fallback_mode: input.context?.fallback_mode ?? false,
            repeat_count: result.repeat_count ?? 1,
            mode: input.mode,
          },
          privacy_level: 'research_safe',
        },
      })

      // R-CORR-07 / S3-CORRECT-004：同一区域已连续两次纠错 → 向导 Agent 主动追问，
      // 不再盲目自动修改（跳过再生成），让用户更具体地描述期望（文案不含技术术语）。
      if (result.should_follow_up) {
        const followUp =
          '我注意到这里你已经连续改过两次了，怕又猜错。能再具体一点吗？比如想要改成什么内容、放在哪个位置，还是换个样子？'
        appendJsonLine(getAgentSessionPath(input.session_id), {
          role: 'assistant',
          content: [{ type: 'text', text: followUp }],
          timestamp: Date.now(),
        })
        mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_EVENT, {
          event_id: randomUUID(),
          session_id: input.session_id,
          project_id: input.project_id,
          type: 'message_delta',
          payload: { text: followUp },
          created_at: new Date().toISOString(),
        })
        return result
      }

      // 点选纠错 → 重新生成（Sprint 3 纠错主线接通）：落盘后触发带新需求的 MVP 重新生成。
      // 只有带明确诉求（user_note / 点选文本）时才重新生成；纯「猜」模式（无文案）保持只落盘。
      const prompt = extractCorrectionPrompt(input)
      if (prompt) {
        // 点选纠错原文按 user 角色回写会话 JSONL（对齐 runAgent 落盘），
        // 避免历史里出现"助手引用了用户没说过的话"的断层。
        appendJsonLine(getAgentSessionPath(input.session_id), {
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          timestamp: Date.now(),
        })
        // 「不过目不开工」防御（2026-08-27 用户拍板）：PRD 从未被用户确认过时，
        // 点选纠错不直接触发 MVP 全量重造——否则会绕过 PRD 确认门与草图确认门
        // （线上案例：审查 override 后草图阶段纠错直达 loop）。此时只留痕+引导
        // 回确认流；正常链路（确认门修复后）草图先于确认生成，此分支仅兑异常/存量
        // 不一致状态。fail-closed：prd.json 缺失/损坏均视为未确认。
        if (!isPrdUserConfirmed(input.project_id)) {
          const guidance =
            '收到，这处调整意见我先记下了。不过需求定稿（PRD）还没经你确认过，我先不动手重做——请回到对话里把想法告诉我，我们先一起确认需求，再按你的意见改。'
          appendJsonLine(getAgentSessionPath(input.session_id), {
            role: 'assistant',
            content: [{ type: 'text', text: guidance }],
            timestamp: Date.now(),
          })
          mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_EVENT, {
            event_id: randomUUID(),
            session_id: input.session_id,
            project_id: input.project_id,
            type: 'message_delta',
            payload: { text: guidance },
            created_at: new Date().toISOString(),
          })
          return result
        }
        // 草图阶段分流（2026-08-27 线上案例 dbe1e6fd：用户在草图预览点选说「换个名字」，
        // 项目还在 sketch_ready（草图未确认），却被直接推进 MVP 迭代——11 轮 loop 全量
        // 重写三文件+测试+扫描，草图确认门（「生成完整功能」按钮）被抢跑。
        // 草图阶段的点选纠错改走 send-message 的草图修改门：归一化并入后重生成草图
        // （秒级、低成本方向确认），MVP 只能经确认草图或已交付后的迭代到达）
        const stage = String(findProject(input.project_id).current_stage ?? '')
        const mode = findProject(input.project_id).mode
        if (stage !== 'ready' && stage !== 'completed') {
          const sketchNote = '收到，我按这处意见先调整草图（确认草图后才会生成完整功能）。'
          appendJsonLine(getAgentSessionPath(input.session_id), {
            role: 'assistant',
            content: [{ type: 'text', text: sketchNote }],
            timestamp: Date.now(),
          })
          mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_EVENT, {
            event_id: randomUUID(),
            session_id: input.session_id,
            project_id: input.project_id,
            type: 'message_delta',
            payload: { text: sketchNote },
            created_at: new Date().toISOString(),
          })
          const sketchAbort = new AbortController()
          registerBackgroundRun(input.session_id, sketchAbort)
          void runAgent({
            request_id: input.request_id,
            session_id: input.session_id,
            project_id: input.project_id,
            content: prompt,
            mode,
            current_stage: 'sketch_ready' as never,
          }).catch((error) => {
            if (sketchAbort.signal.aborted) return
            console.error('[ipc] correction sketch regeneration failed:', error)
          })
          return result
        }
        // U4/U5：注册可取消句柄，让「停止生成」能 abort 点选纠错触发的再生成链路。
        const abortController = new AbortController()
        registerBackgroundRun(input.session_id, abortController)
        void runIterationTask({
          request_id: input.request_id,
          session_id: input.session_id,
          project_id: input.project_id,
          mode,
          prompt,
          query: getSdkQuery(),
          signal: abortController.signal,
        }).catch((error) => {
          // U5：用户主动停止不再发 error 事件（runIterationTask 内部已回滚到 ready）。
          if (abortController.signal.aborted) return
          // 熔断回滚已完成收尾（T5）：不再发 error 事件（收尾已全部完成）
          if (isCircuitBreakSettled(error)) return
          const message = error instanceof Error ? error.message : String(error)
          console.error('[ipc] correction regeneration failed:', message, error)
          mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_EVENT, {
            event_id: randomUUID(),
            session_id: input.session_id,
            project_id: input.project_id,
            type: 'error',
            payload: { code: errorCodeFrom(error), message },
            created_at: new Date().toISOString(),
          })
        })
        .finally(() => unregisterBackgroundRun(input.session_id))
      }
      return result
    })
  })

  // U8：点选纠错 DOM 上下文收集。渲染进程读不到跨域预览 iframe，主进程通过
  // subframe.executeJavaScript(document.elementFromPoint) 收集 selector/文本/包围盒。
  ipcMain.handle(IPC_CHANNELS.DOM_COLLECT_CONTEXT, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<DomCollectContextInput>(payload, ['project_id', 'session_id'])
      const click = input.click ?? { x: 0, y: 0 }
      return collectDomContext(mainWindow.webContents, click)
    })
  })

  // 点选纠错滚动转发：捕获层挡住预览滚动，这里把滚轮/中键拖拽增量滚回跨域 iframe。
  ipcMain.handle(IPC_CHANNELS.DOM_SCROLL_PREVIEW, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<DomScrollPreviewInput>(payload, [])
      return scrollPreview(mainWindow.webContents, input.delta_x ?? 0, input.delta_y ?? 0)
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_UPGRADE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectUpgradeInput>(payload, ['project_id', 'session_id'])
      // 切换模式前先创建 upgrade 快照，保留升级前的可回滚状态
      const snapshot = await createSnapshot({
        request_id: input.request_id,
        project_id: input.project_id,
        kind: 'upgrade',
        summary: '升级为长期迭代模式前的快照',
        include_documents: true,
        health_status: 'healthy',
      })
      // research-plan §5：mode_upgraded 埋点（from_mode → to_mode + 快照 id）。
      trackAnalytics({
        request_id: input.request_id,
        event: {
          event_type: 'mode_upgraded',
          project_id: input.project_id,
          session_id: input.session_id,
          payload: { from_mode: 'quick', to_mode: 'longterm', snapshot_id: snapshot.snapshot_id },
          privacy_level: 'research_safe',
        },
      })
      return upgradeProject(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_FINALIZE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectFinalizeInput>(payload, ['project_id', 'session_id'])
      // U6：满意度埋点 + 项目收口。product_finalized 走研究安全级，不含具体对话内容。
      trackAnalytics({
        request_id: input.request_id,
        event: {
          event_type: 'satisfaction_marked',
          project_id: input.project_id,
          session_id: input.session_id,
          payload: { stage: 'ready' },
          privacy_level: 'research_safe',
        },
      })
      trackAnalytics({
        request_id: input.request_id,
        event: {
          event_type: 'project_finalized',
          project_id: input.project_id,
          session_id: input.session_id,
          payload: {},
          privacy_level: 'research_safe',
        },
      })
      return finalizeProject(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.SANDBOX_RUN, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SandboxRunInput>(payload, ['project_id'])
      // 用户显式操作（沙箱运行按钮）走当前权限模式（默认 ask，可在设置中切换）
      await assertToolAllowed(
        'run_project',
        { project_id: input.project_id, command: input.command },
        resolvePermissionSession(input.project_id),
        getPermissionMode(),
        input.project_id,
      )
      return runSandbox(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.SANDBOX_STOP, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SandboxStopInput>(payload, ['project_id'])
      return stopSandbox(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.SANDBOX_RESTORE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SandboxRunInput>(payload, ['project_id'])
      // 恢复路径（P0-2）：项目已产出草图/MVP 文件，但沙箱进程随主进程退出而亡，
      // 旧端口必死。用默认静态服务器直接重跑并回填 preview_url，不弹权限确认
      // （该本地项目本就归当前用户所有，命令受 runSandbox 白名单约束）。
      return runSandbox({ request_id: input.request_id, project_id: input.project_id })
    })
  })

  ipcMain.handle(IPC_CHANNELS.SNAPSHOT_CREATE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SnapshotCreateInput>(payload, ['project_id', 'kind', 'summary', 'health_status'])
      await assertToolAllowed(
        'create_snapshot',
        { project_id: input.project_id, kind: input.kind },
        resolvePermissionSession(input.project_id),
        getPermissionMode(),
        input.project_id,
      )
      return createSnapshot(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.SNAPSHOT_ROLLBACK, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SnapshotRollbackInput>(payload, ['project_id', 'snapshot_id', 'reason'])
      // 危险操作（手动回滚）走当前权限模式（默认 ask，可在设置中切换）
      await assertToolAllowed(
        'rollback_snapshot',
        { project_id: input.project_id, snapshot_id: input.snapshot_id },
        resolvePermissionSession(input.project_id),
        getPermissionMode(),
        input.project_id,
      )
      const result = await rollbackSnapshot(input)
      // research-plan §5：user_undo 埋点（用户主动回滚使用率）。熔断/升级失败回滚走
      // self_repair_triggered / decision-log，不算用户主动撤销。
      if (input.reason === 'user_undo') {
        trackAnalytics({
          request_id: input.request_id,
          event: {
            event_type: 'user_undo',
            project_id: input.project_id,
            session_id: resolvePermissionSession(input.project_id),
            payload: {
              snapshot_id: input.snapshot_id,
              reason: input.reason,
              stage: findProject(input.project_id).current_stage,
            },
            privacy_level: 'research_safe',
          },
        })
      }
      return result
    })
  })

  ipcMain.handle(IPC_CHANNELS.SNAPSHOT_LIST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SnapshotListInput>(payload, ['project_id'])
      return { snapshots: listSnapshots(input.project_id) }
    })
  })

  // U9：快照缩略图——主进程读截图文件转 base64 data URL，供渲染端 `<img>` 展示。
  ipcMain.handle(IPC_CHANNELS.SNAPSHOT_SCREENSHOT, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SnapshotScreenshotInput>(payload, ['project_id', 'snapshot_id'])
      return { data_url: await loadSnapshotScreenshot(input.project_id, input.snapshot_id) }
    })
  })

  // T7 文档版本化：时间轴回看某快照冻结的文档（「当时的想法」与代码快照对齐）。
  ipcMain.handle(IPC_CHANNELS.SNAPSHOT_DOCUMENT_LIST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SnapshotDocumentListInput>(payload, ['project_id', 'snapshot_id'])
      return listSnapshotDocuments(input.project_id, input.snapshot_id)
    })
  })

  ipcMain.handle(IPC_CHANNELS.SNAPSHOT_DOCUMENT_READ, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SnapshotDocumentReadInput>(payload, ['project_id', 'snapshot_id', 'document_id'])
      return readSnapshotDocument(input.project_id, input.snapshot_id, input.document_id)
    })
  })

  ipcMain.handle(IPC_CHANNELS.DOCUMENT_SYNC, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<DocumentSyncInput>(payload, ['project_id', 'session_id', 'checkpoint'])
      return syncDocuments(input)
    })
  })

  // U2：文档面板——列出/读取项目文档（PRD/GWT/测试报告）。
  ipcMain.handle(IPC_CHANNELS.DOCUMENT_LIST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<DocumentListInput>(payload, ['project_id'])
      return { documents: listDocuments(input.project_id) }
    })
  })

  ipcMain.handle(IPC_CHANNELS.DOCUMENT_READ, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<DocumentReadInput>(payload, ['project_id', 'document_id'])
      return readDocument(input.project_id, input.document_id)
    })
  })

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_TRACK, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<AnalyticsTrackInput>(payload, ['event'])
      return trackAnalytics(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.CHANNEL_LIST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      requireFields<RequestEnvelope>(payload, [])
      return listChannels()
    })
  })

  ipcMain.handle(IPC_CHANNELS.CHANNEL_CREATE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ChannelCreateEnvelope>(payload, ['name', 'provider_type', 'base_url', 'api_key'])
      return createChannel(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.CHANNEL_UPDATE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ChannelUpdateEnvelope>(payload, ['channel_id', 'input'])
      const updated = updateChannel(input.channel_id, input.input)
      if (!updated) {
        throw new Error('CHANNEL_NOT_FOUND: channel does not exist')
      }
      return updated
    })
  })

  ipcMain.handle(IPC_CHANNELS.CHANNEL_TEST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ChannelTestEnvelope>(payload, ['channel_id'])
      return testChannel(input.channel_id)
    })
  })

  ipcMain.handle(IPC_CHANNELS.CHANNEL_TEST_DIRECT, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ChannelTestDirectEnvelope>(payload, ['input'])
      return testChannelDirect(input.input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.CHANNEL_FETCH_MODELS, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<FetchModelsEnvelope>(payload, ['input'])
      return fetchModels(input.input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.CHANNEL_DELETE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ChannelDeleteEnvelope>(payload, ['channel_id'])
      if (!deleteChannel(input.channel_id)) {
        throw new Error('CHANNEL_NOT_FOUND: channel does not exist')
      }
      return { deleted: true, channel_id: input.channel_id }
    })
  })

  // M5：类别 → 渠道路由（职责分工）。list 返回视图模型（渠道名/模型预览，不含明文 key）。
  ipcMain.handle(IPC_CHANNELS.CATEGORY_ROUTING_LIST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      requireFields<RequestEnvelope>(payload, [])
      return buildCategoryRoutingViews()
    })
  })

  // M5：全量覆盖路由表。结构非法走 VALIDATION_ERROR；无效引用（已删除/非本项目/
  // 非 Anthropic 协议）在 updateCategoryRouting 内剥离 + console.warn，不阻塞其余类别。
  ipcMain.handle(IPC_CHANNELS.CATEGORY_ROUTING_UPDATE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<CategoryRoutingUpdateEnvelope>(payload, ['routing'])
      return updateCategoryRouting(input.routing)
    })
  })

  // ==================== 提示词配置（设置页「提示词配置」Tab） ====================

  ipcMain.handle(IPC_CHANNELS.PROMPT_LIST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      requireFields<RequestEnvelope>(payload, [])
      return listPromptSlots()
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROMPT_READ, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<PromptReadInput>(payload, ['prompt_id'])
      return readPromptSlot(input.prompt_id)
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROMPT_SAVE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<PromptSaveInput>(payload, ['prompt_id', 'content'])
      return savePromptSlot(input.prompt_id, input.content)
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROMPT_RESET, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<PromptResetInput>(payload, ['prompt_id'])
      return resetPromptSlot(input.prompt_id)
    })
  })
}

async function safeInvoke<T>(requestId: string, fn: () => T | Promise<T>) {
  try {
    return ok(requestId, await fn())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 兜底前先把真实错误打到主进程终端，避免被 VALIDATION_ERROR 掩盖而无法排查
    console.error('[ipc] handler error:', message, error)
    if (message.includes('AGENT_SESSION_BUSY')) return fail<T>(requestId, 'AGENT_SESSION_BUSY', message, true)
    if (message.includes('CHANNEL_NOT_FOUND')) return fail<T>(requestId, 'CHANNEL_NOT_FOUND', message)
    if (message.includes('SESSION_NOT_FOUND')) return fail<T>(requestId, 'SESSION_NOT_FOUND', message)
    if (message.includes('PROJECT_NOT_FOUND')) return fail<T>(requestId, 'PROJECT_NOT_FOUND', message)
    if (message.includes('PERMISSION_REQUEST_NOT_FOUND')) return fail<T>(requestId, 'PERMISSION_REQUEST_NOT_FOUND', message)
    if (message.includes('PERMISSION_DENIED')) return fail<T>(requestId, 'PERMISSION_DENIED', message)
    if (message.includes('SANDBOX_RUN_FAILED')) {
      return fail<T>(requestId, 'SANDBOX_RUN_FAILED', message, true, {
        category: message.split(':')[1] ?? 'unknown',
      })
    }
    if (message.includes('SNAPSHOT_CREATE_FAILED')) return fail<T>(requestId, 'SNAPSHOT_CREATE_FAILED', message, true)
    if (message.includes('DOCUMENT_SYNC_FAILED')) return fail<T>(requestId, 'DOCUMENT_SYNC_FAILED', message, true)
    if (message.includes('ANALYTICS_WRITE_FAILED')) return fail<T>(requestId, 'ANALYTICS_WRITE_FAILED', message, true)
    // safeStorage 解密失败等：不要伪装成「缺少必要信息」，落到专用 code
    if (message.includes('safeStorage') || message.includes('decrypt') || message.includes('API_KEY_DECRYPT_FAILED')) {
      return fail<T>(requestId, 'API_KEY_DECRYPT_FAILED', message)
    }
    return fail<T>(requestId, 'VALIDATION_ERROR', message)
  }
}

function validateAgentSend(payload: unknown): AgentSendMessageInput {
  const input = requireFields<AgentSendMessageInput>(payload, ['session_id', 'project_id', 'content', 'mode', 'current_stage'])
  return input
}

function validateCancel(payload: unknown): AgentCancelInput {
  return requireFields<AgentCancelInput>(payload, ['session_id', 'reason'])
}

function validateConfirmRequirements(payload: unknown): AgentConfirmRequirementsInput {
  const input = requireFields<AgentConfirmRequirementsInput>(payload, ['session_id', 'project_id', 'decision'])
  if (input.decision !== 'confirm' && input.decision !== 'delegate') {
    throw new Error('decision must be confirm or delegate')
  }
  return input
}

function validatePermissionResponse(payload: unknown): PermissionResponseInput {
  return requireFields<PermissionResponseInput>(payload, ['permission_request_id', 'session_id', 'decision'])
}

function validateProjectCreate(payload: unknown): ProjectCreateInput {
  const input = requireFields<ProjectCreateInput>(payload, ['mode'])
  if (input.mode !== 'quick' && input.mode !== 'longterm') throw new Error('mode must be quick or longterm')
  return input
}

function extractRequestId(payload: unknown): string {
  return hasRequestId(payload) ? payload.request_id : ''
}

/** IPC 层权限门禁的会话标识：优先取项目最近会话，缺失时退化为 project_id。 */
function resolvePermissionSession(projectId: string): string {
  try {
    return findProject(projectId).last_session_id ?? projectId
  } catch {
    return projectId
  }
}

/** 从点选纠错入参提取可执行的修改诉求；无明确文案（纯猜模式）返回 undefined。 */
function extractCorrectionPrompt(input: PointCorrectionInput): string | undefined {
  const note = input.user_note?.trim()
  if (note) return note
  const textContent = input.context?.text_content?.trim()
  return textContent || undefined
}

function requireFields<T extends { request_id: string }>(payload: unknown, fields: string[]): T {
  if (!isRecord(payload)) throw new Error('Invalid payload: expected object')
  if (!hasRequestId(payload)) throw new Error('Missing required field: request_id')
  for (const field of fields) requireValue(payload, field)
  return payload as T
}
