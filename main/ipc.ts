import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dialog } from 'electron'
import type { BrowserWindow, IpcMain } from 'electron'
import type {
  AgentCancelInput,
  AgentConfirmRequirementsInput,
  AgentForkSessionInput,
  AgentListSessionsInput,
  AgentLoadMessagesInput,
  AgentSendMessageInput,
  AgentSteerQueryInput,
  AgentSteerResolveInput,
  AnalyticsTrackInput,
  CategoryRoutingUpdateEnvelope,
  CategoryRoutingRoleUpdateEnvelope,
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
  PastedImageSaveInput,
  PermissionSetModeInput,
  PointCorrectionInput,
  ProjectFileReadInput,
  PromptReadInput,
  PromptResetInput,
  PromptSaveInput,
  ProjectAbandonInput,
  ProjectArchiveInput,
  ProjectCreateInput,
  ProjectDeleteInput,
  ProjectExportInput,
  ProjectUpgradeExportInput,
  AppSwitchStateResult,
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
import { fail, ok } from '../shared/api-result'
import { cancelAgent, getSdkQuery, hasForegroundRun, isSessionActive, persistSteerDeferredNotice, publishSteerStatusEvent, registerBackgroundRun, runAgent, setAgentStreamPublisher, unregisterBackgroundRun } from './orchestration/orchestrator'
import { enqueueSteer, getSteerStatuses, pendingSteerCount, registerSteer, resolveSteer, setSteerStatusListener, steerConfirmEnabled } from './agent/loop/steer-queue'
import { savePastedImage } from './platform/shell/pasted-images'
import { collectDomContext, scrollPreview } from './verification/dom-context'
import { clearPendingReviewAction, runAgentLoopPostTesting, runIterationTask, runMvpTask, setForegroundRunChecker, setProgrammingEventPublisher } from './coding/programming-orchestrator'
import { handleAgentStreamEvent } from './platform/shell/notifications'
import { assertToolAllowed, getPermissionMode, resolvePermission, setPermissionMode, setPermissionRequestPublisher } from './agent/permissions/permission-service'
import {
  abandonProject,
  archiveProject,
  confirmSketch,
  createProject,
  deleteProject,
  finalizeProject,
  findProject,
  getProjectProgressSummary,
  listProjects,
  renameProject,
  reopenProject,
  submitCorrection,
  unarchiveProject,
  updateProject,
  upgradeProject,
} from './project/project-service'
import { cleanOrphanSessions, forkFrom, listSessions, loadMessages, setSessionActiveChecker } from './platform/sessions/session-service'
import { exportProjectHandoff } from './delivery/project-export'
import { upgradeExport } from './coding/export-manifest'
import { readExperimentSwitches } from './platform/shell/experiment-switches'
import { dirname } from 'node:path'
import { resolveRequirementConfirm } from './guide/guide-agent-service'
import { createChannel, deleteChannel, fetchModels, listChannels, testChannel, testChannelDirect, updateChannel } from './platform/llm/channel-manager'
import {
  buildCategoryRoutingRoleViews,
  buildCategoryRoutingViews,
  updateCategoryRouting,
  updateCategoryRoutingRoles,
} from './platform/llm/category-routing'
import { listPromptSlots, readPromptSlot, resetPromptSlot, savePromptSlot } from './agent/prompting/prompt-service'
import { listDocuments, readDocument, syncDocuments, isPrdUserConfirmed } from './project/document-engine'
import { isCircuitBreakSettled, convergeStageFromEvidence, evaluateDiskArtifact } from './orchestration/recovery-service'
import { runSandbox, stopSandbox } from './delivery/sandbox'
import { createSnapshot, listSnapshotDocuments, listSnapshots, loadSnapshotScreenshot, readSnapshotDocument, rollbackSnapshot } from './delivery/snapshots'
import { trackAnalytics } from './delivery/track-analytics'
import { hasRequestId, isRecord, requireValue } from '../shared/validators'
import { getAgentSessionPath } from '../storage/config-paths'
import { appendJsonLine } from '../storage/json-store'
import { appendSessionMessage } from './platform/sessions/session-tree'

/** 从错误信息里提取统一的错误码前缀（如 MVP_LLM_PARSE_FAILED、SANDBOX_RUN_FAILED），缺省 AGENT_SDK_ERROR。 */
function errorCodeFrom(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const match = /^([A-Z][A-Z0-9_]*):/.exec(message)
  return match ? match[1] : 'AGENT_SDK_ERROR'
}

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

  ipcMain.handle(IPC_CHANNELS.PROJECT_CREATE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = validateProjectCreate(payload)
      const project = createProject(input)
      trackAnalytics({
        request_id: input.request_id,
        event: {
          event_type: 'project_created',
          project_id: project.project_id,
          // Phase 7 U5 J5（project_started 口径扩）：首句长度/是否带句读——北极星分母
          // （开始首个有效项目的用户）与首句信息量分层的数据基础；不记原文（脱敏）。
          payload: {
            mode: project.mode,
            initial_message_chars: (input.initial_message ?? '').trim().length,
            has_punctuation: /[。，？！,.!?]/.test(input.initial_message ?? ''),
          },
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
      // F-A 修复：导出动作说明已离开补充流，清残留标记
      clearPendingReviewAction(input.project_id)
      const project = findProject(input.project_id)
      const result = await dialog.showOpenDialog(mainWindow, {
        title: `导出「${project.name}」`,
        buttonLabel: '导出到这里',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true }
      }
      return exportProjectHandoff(input, result.filePaths[0])
    })
  })

  // Phase 10 落地旅程（2026-09-16）：升级导出——系统目录选择器选旧导出包，平台产
  // 「新代码+携带旧数据（pre-upgrade 备份）+真实迁移+upgrade-report+新 manifest」
  // 的升级包（与导出同款交互形态；失败明细在升级包内 upgrade-report.json）。
  ipcMain.handle(IPC_CHANNELS.PROJECT_UPGRADE_EXPORT, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectUpgradeExportInput>(payload, ['project_id'])
      const project = findProject(input.project_id)
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: `升级「${project.name}」——选择旧导出包目录`,
        buttonLabel: '从这个版本升级',
        properties: ['openDirectory'],
      })
      if (picked.canceled || picked.filePaths.length === 0) {
        return { canceled: true }
      }
      const landedRoot = picked.filePaths[0]
      const result = await upgradeExport({
        projectRoot: project.root_path,
        landedRoot,
        destination: dirname(landedRoot),
        projectName: project.name,
      })
      return {
        canceled: false,
        target: result.target,
        migration: result.migration,
        summary: result.summary,
        drift: {
          clean: result.drift.clean,
          changed: result.drift.changed.length,
          missing: result.drift.missing.length,
          extra: result.drift.extra.length,
        },
      }
    })
  })

  // Phase 10：实验开关注读面板（白名单实况；I5 两口径文案等渲染端消费）。
  ipcMain.handle(IPC_CHANNELS.APP_SWITCH_STATE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const result: AppSwitchStateResult = { switches: readExperimentSwitches() }
      return result
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
        const runId = registerBackgroundRun(input.session_id, abortController, input.project_id)
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
              query: getSdkQuery(),
              channel_id: input.channel_id,
              signal: abortController.signal,
              // P2 失败回流（PR-C）：构建门禁结果透传终验组装器（failed → build 修复任务）
              ...(mvp.build_gate ? { buildGate: mvp.build_gate } : {}),
            })
          })
          .catch((error) => {
            // U5：用户主动停止（signal 已 abort）不再发 error 事件——渲染端已落「已停止生成」，
            // 避免两条相互矛盾的消息；只有真实失败才上报错误。
            if (abortController.signal.aborted) {
              // M-15：停止后按磁盘证据回滚阶段（与启动对账/熔断回滚同口径）——否则项目
              // 卡 generating_mvp/testing/judge_review 直至重启，后续「好了吗」落入编程
              // 路径被模型编造成「还在生成」。
              const projectNow = findProject(input.project_id)
              const stage = convergeStageFromEvidence(evaluateDiskArtifact(projectNow.root_path))
              updateProject(input.project_id, { current_stage: stage })
              mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_EVENT, {
                event_id: randomUUID(),
                session_id: input.session_id,
                project_id: input.project_id,
                type: 'stage_changed',
                payload: { stage },
                created_at: new Date().toISOString(),
              })
              return
            }
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
          .finally(() => unregisterBackgroundRun(input.session_id, runId))
      }
      return project
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_SUBMIT_CORRECTION, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<PointCorrectionInput>(payload, ['project_id', 'session_id', 'mode'])
      // F-A 修复（2026-09-11 审计）：用户转去点选纠错说明已离开「局部优化/整版重做」
      // 补充流，残留标记会让下一句普通诉求被误当局部修改，先清
      clearPendingReviewAction(input.project_id)
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
        appendSessionMessage(input.session_id, {
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
        appendSessionMessage(input.session_id, {
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
          appendSessionMessage(input.session_id, {
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
        // M-14：生成中不再发「我按这处意见先调整草图」——此时 MVP/迭代后台运行
        // 占项目锁，runAgent 会抛 AGENT_PROJECT_BUSY，承诺全落空且 error 零呈现；
        // 如实告知等生成完成（与渲染端 handleCorrectionSubmit 守卫双保险）。
        const BUSY_STAGES = new Set([
          'generating_sketch',
          'generating_mvp',
          'testing',
          'judge_review',
          'repairing',
          'iterating',
          'upgrading',
        ])
        if (BUSY_STAGES.has(stage)) {
          const busyNote = '正在生成中，这处修改意见我先记下了；等这一版完成后，你再点这里或直接告诉我，我马上按意见调整。'
          appendSessionMessage(input.session_id, {
            role: 'assistant',
            content: [{ type: 'text', text: busyNote }],
            timestamp: Date.now(),
          })
          mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_EVENT, {
            event_id: randomUUID(),
            session_id: input.session_id,
            project_id: input.project_id,
            type: 'message_delta',
            payload: { text: busyNote },
            created_at: new Date().toISOString(),
          })
          return result
        }
        if (stage !== 'ready' && stage !== 'completed') {
          const sketchNote = '收到，我按这处意见先调整草图（确认草图后才会生成完整功能）。'
          appendSessionMessage(input.session_id, {
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
          // runAgent 自带前台登记（activeSessions + 项目互斥）：不要再在此注册
          // backgroundRun——双重登记会先占住项目锁，runAgent 内 acquire 直接抛
          // AGENT_PROJECT_BUSY，且此分支此前没有 finally 清理句柄，会永久锁死项目。
          void runAgent({
            request_id: input.request_id,
            session_id: input.session_id,
            project_id: input.project_id,
            content: prompt,
            mode,
            current_stage: 'sketch_ready' as never,
          } as never).catch((error) => {
            // 用户取消时 runAgent 正常返回不抛错；这里只处理真实失败（含项目忙拒绝）
            if (String(error).includes('AGENT_CANCELLED')) return
            const message = error instanceof Error ? error.message : String(error)
            console.error('[ipc] correction sketch regeneration failed:', message, error)
            mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_EVENT, {
              event_id: randomUUID(),
              session_id: input.session_id,
              project_id: input.project_id,
              type: 'error',
              payload: { code: errorCodeFrom(error), message },
              created_at: new Date().toISOString(),
            })
          })
          return result
        }
        // U4/U5：注册可取消句柄，让「停止生成」能 abort 点选纠错触发的再生成链路。
        const abortController = new AbortController()
        const runId = registerBackgroundRun(input.session_id, abortController, input.project_id)
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
        .finally(() => unregisterBackgroundRun(input.session_id, runId))
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
      const project = upgradeProject(input)
      // P2-12（2026-09-04）：升级后补 longterm 附加文档（plantuml/sprint）——此前升级只切
      // mode/stage 不触发 syncDocuments，导致升级项目的 plantuml/sprint 缺失（老项目 64747c51
      // 有、后升级项目缺，升级路径未补）。upgradeProject 已把 mode 置 longterm，此处 syncDocuments
      // 的 longterm 分支会补产出 plantuml/architecture.puml + sprint/sprint-plan.md。
      syncDocuments({ request_id: input.request_id, session_id: input.session_id, project_id: input.project_id, checkpoint: 'mode_upgraded' })
      return project
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
      // 主进程内部生命周期节点（迭代收尾 / 模式升级）不允许 renderer 主动触发：
      // 防伪造 changelog/模式文档（2026-08-27 多角色审查 P2-IPC）。
      if (input.checkpoint === 'iteration_completed' || input.checkpoint === 'mode_upgraded') {
        throw new Error(`DOCUMENT_SYNC_FAILED: checkpoint ${input.checkpoint} is internal-only`)
      }
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

  // W4/W6 文档面板：产物文件只读查看（项目根内；拒基础设施目录/标记/二进制；256KB 截断）
  ipcMain.handle(IPC_CHANNELS.PROJECT_FILE_READ, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectFileReadInput>(payload, ['project_id', 'path'])
      const project = findProject(input.project_id) // 缺项目时自抛 PROJECT_NOT_FOUND
      const rel = String(input.path).replace(/\\/g, '/').replace(/^\.\//, '')
      if (!rel || rel.includes('..') || /^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) {
        throw new Error('FILE_READ_BAD_PATH: 路径必须是项目内相对路径')
      }
      const lower = rel.toLowerCase()
      const denied = lower.startsWith('node_modules/') || lower.startsWith('.git/') || lower.startsWith('data-backups/') || lower === '.bloma-real-variant'
      if (denied) throw new Error('FILE_READ_DENIED: 该路径不属于产物文件（基础设施/平台管理件）')
      const abs = join(project.root_path, rel)
      const stat = statSync(abs)
      if (!stat.isFile()) throw new Error('FILE_READ_NOT_FILE: 目标不是文件')
      const buf = readFileSync(abs)
      // 二进制喰探（前 8KB 出现 NUL 即判二进制，只读视图不支持）
      if (buf.subarray(0, 8192).includes(0)) throw new Error('FILE_READ_BINARY: 二进制文件不支持文本查看')
      const MAX = 256 * 1024
      const truncated = buf.byteLength > MAX
      return { path: rel, content: buf.subarray(0, MAX).toString('utf8'), truncated, bytes: buf.byteLength }
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

  // M5：三角色渠道路由（向导 / 编程 / 裁判）。角色配置在保存时展开到底层类别。
  ipcMain.handle(IPC_CHANNELS.CATEGORY_ROUTING_ROLE_LIST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      requireFields<RequestEnvelope>(payload, [])
      return buildCategoryRoutingRoleViews()
    })
  })

  ipcMain.handle(IPC_CHANNELS.CATEGORY_ROUTING_ROLE_UPDATE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<CategoryRoutingRoleUpdateEnvelope>(payload, ['routing'])
      return updateCategoryRoutingRoles(input.routing)
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
    if (message.includes('SESSION_FORK_ENTRY_NOT_FOUND')) {
      return fail<T>(requestId, 'SESSION_FORK_ENTRY_NOT_FOUND', message)
    }
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
  // request_id 必填：message-queue 用它作 queueMessageId 去重键（审查 P2-③：缺省会被 undefined 误判重复丢消息）
  const input = requireFields<AgentSendMessageInput>(payload, ['request_id', 'session_id', 'project_id', 'content', 'mode', 'current_stage'])
  // clipboard-paste P1（2026-08-29）：可选 images 结构校验——存在则必须为合法引用数组（消费端另有过滤）
  if (input.images !== undefined) {
    if (!Array.isArray(input.images)) throw new Error('PASTED_IMAGE_BAD_REFS: images 必须为数组')
    for (const r of input.images) {
      if (!r || typeof r.imageId !== 'string' || typeof r.media_type !== 'string') {
        throw new Error('PASTED_IMAGE_BAD_REFS: images 元素必须含 imageId/media_type 字符串')
      }
    }
  }
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
  // adopted_ideas：可选字符串数组（用户勾选采纳的市调想法原文），非数组/含非字符串项时剔除
  if (input.adopted_ideas !== undefined) {
    if (!Array.isArray(input.adopted_ideas)) {
      delete input.adopted_ideas
    } else {
      input.adopted_ideas = input.adopted_ideas.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    }
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

/** 圈选目标文本过长截断，避免整段页面文案灌进归一化 prompt。 */
const MAX_CORRECTION_TARGET_LEN = 80

/**
 * 从点选纠错入参提取可执行的修改诉求；无明确文案（纯猜模式）返回 undefined（只落盘不重生成）。
 *
 * 圈选 DOM 上下文（text_content / element_selector）必须拼进诉求文本：否则归一化模型
 * 只看到「换个名字」这种无目标文本，无法判定 revise，只能 skip——但 ack 又按已采纳回复，
 * 用户体感「我说改名它说改了结果没改」（2026-08-29 线上案例：圈选标题说「换个名字」）。
 *
 * 形态：
 * - user_note 模式："用户圈选了预览界面上的「<text>」（selector: <sel>），并说：<note>"；
 *   无 DOM 上下文时回退 note 原文（兼容旧测试与纯坐标兜底）；
 * - guess 模式（无 note）：元素文本是「被圈对象」不是修改诉求，不能原样当诉求（会被归一化
 *   当成新需求 append），改带「希望调整这个元素」语义；无 text_content 时返回 undefined。
 */
function extractCorrectionPrompt(input: PointCorrectionInput): string | undefined {
  const note = input.user_note?.trim()
  const textContent = input.context?.text_content?.trim()
  const selector = input.context?.element_selector?.trim()
  const targetText = textContent || selector
  const targetDesc = targetText
    ? `预览界面上的「${truncateForCorrection(targetText, MAX_CORRECTION_TARGET_LEN)}」${textContent && selector ? `（selector: ${selector}）` : ''}`
    : undefined
  if (note) return targetDesc ? `用户圈选了${targetDesc}，并说：${note}` : note
  if (textContent) return `用户圈选了${targetDesc}，未填写具体说明，希望调整这个元素`
  return undefined
}

function truncateForCorrection(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function requireFields<T extends { request_id: string }>(payload: unknown, fields: string[]): T {
  if (!isRecord(payload)) throw new Error('Invalid payload: expected object')
  if (!hasRequestId(payload)) throw new Error('Missing required field: request_id')
  for (const field of fields) requireValue(payload, field)
  return payload as T
}
