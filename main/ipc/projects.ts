/**
 * 项目族：create/list/archive×2/delete/export×2/rename/abandon/reopen/confirm-sketch/submit-correction/dom×2/upgrade/finalize + APP_SWITCH_STATE（PR4d 自 ipc.ts 拆出；纯机械搬移，行为零变化）。
 */
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
} from '../../shared/types'
import { IPC_CHANNELS } from '../../shared/types'
import { fail, ok } from '../../shared/api-result'
import { cancelAgent, getSdkQuery, hasForegroundRun, isSessionActive, persistSteerDeferredNotice, publishSteerStatusEvent, registerBackgroundRun, runAgent, setAgentStreamPublisher, unregisterBackgroundRun } from '../orchestration/orchestrator'
import { enqueueSteer, getSteerStatuses, pendingSteerCount, registerSteer, resolveSteer, setSteerStatusListener, steerConfirmEnabled } from '../agent/loop/steer-queue'
import { savePastedImage } from '../platform/shell/pasted-images'
import { collectDomContext, scrollPreview } from '../verification/dom-context'
import { clearPendingReviewAction, runAgentLoopPostTesting, runIterationTask, runMvpTask, setForegroundRunChecker, setProgrammingEventPublisher } from '../coding/programming-orchestrator'
import { handleAgentStreamEvent } from '../platform/shell/notifications'
import { assertToolAllowed, getPermissionMode, resolvePermission, setPermissionMode, setPermissionRequestPublisher } from '../agent/permissions/permission-service'
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
} from '../project/project-service'
import { cleanOrphanSessions, forkFrom, listSessions, loadMessages, setSessionActiveChecker } from '../platform/sessions/session-service'
import { exportProjectHandoff } from '../delivery/project-export'
import { upgradeExport } from '../coding/export-manifest'
import { readExperimentSwitches } from '../platform/shell/experiment-switches'
import { dirname } from 'node:path'
import { resolveRequirementConfirm } from '../guide/guide-agent-service'
import { createChannel, deleteChannel, fetchModels, listChannels, testChannel, testChannelDirect, updateChannel } from '../platform/llm/channel-manager'
import {
  buildCategoryRoutingRoleViews,
  buildCategoryRoutingViews,
  updateCategoryRouting,
  updateCategoryRoutingRoles,
} from '../platform/llm/category-routing'
import { listPromptSlots, readPromptSlot, resetPromptSlot, savePromptSlot } from '../agent/prompting/prompt-service'
import { listDocuments, readDocument, syncDocuments, isPrdUserConfirmed } from '../project/document-engine'
import { isCircuitBreakSettled, convergeStageFromEvidence, evaluateDiskArtifact } from '../project/recovery-service'
import { runSandbox, stopSandbox } from '../delivery/sandbox'
import { createSnapshot, listSnapshotDocuments, listSnapshots, loadSnapshotScreenshot, readSnapshotDocument, rollbackSnapshot } from '../delivery/snapshots'
import { trackAnalytics } from '../delivery/track-analytics'
import { hasRequestId, isRecord, requireValue } from '../../shared/validators'
import { getAgentSessionPath } from '../../storage/config-paths'
import { appendJsonLine } from '../../storage/json-store'
import { appendSessionMessage } from '../platform/sessions/session-tree'
import { safeInvoke, errorCodeFrom, extractRequestId, requireFields, resolvePermissionSession, validateAgentSend, validateCancel, validateConfirmRequirements, validatePermissionResponse, validateProjectCreate, extractCorrectionPrompt, truncateForCorrection, MAX_CORRECTION_TARGET_LEN } from './shared'

export function registerProjectsIpc(ipcMain: IpcMain, mainWindow: BrowserWindow): void {
  void mainWindow
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

}
