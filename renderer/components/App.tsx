import type { AgentSendMessageResult, ApiResult } from '../../shared/types'
import type { ComposerSubmission } from '../hooks/use-composer'
import type { SendReceipt } from '../../shared/attachment-types'
import React, { useState, useCallback } from 'react'
import { useSetAtom, useAtomValue, useStore } from 'jotai'
import { submitInitialProjectIdea } from '../lib/initial-project-idea'
import { restartDiscussion } from '../lib/restart-discussion'
import { composerDraftFamily, composerScopeAtom, draftKey } from '../composer-state'
import { ModeSelectionPage } from './ModeSelectionPage'
import { WorkspaceShell } from './WorkspaceShell'
import { ProjectHistoryPage } from './ProjectHistoryPage'
import { PermissionDialog } from './PermissionDialog'
import { RequirementConfirmDialog } from './RequirementConfirmDialog'
import { PrdConfirmDialog } from './PrdConfirmDialog'
import { ClarificationCard } from './ClarificationCard'
import { ReviewChoicesDialog } from './ReviewChoicesDialog'
import { SettingsPage } from './SettingsPage'
import { useUserDecisionCards, toCardSelectionMeta } from './ChatPanel-sprint2'
import { globalUserErrorAtom } from '../agent-atoms'
import type { CardOption } from './CardOptions'
import type { PreviewStatus } from './PreviewPanel'
import type { Snapshot, AgentMessage, Project, PastedImageRef } from './atoms'
import {
  modeSelectedAtom,
  projectModeAtom,
  workflowStageAtom,
  desktopPhaseAtom,
  stageIndicatorLabelAtom,
  STAGE_LABEL_MAP,
  currentProjectAtom,
  agentMessagesFamily,
  appendMessageToSession,
  markDecisionConsumed,
  activeAgentSessionIdAtom,
  snapshotsListAtom,
  previewUrlsAtom,
  currentSnapshotIdAtom,
  hasActiveStreamAtom,
  loadAgentSessions,
  loadSessionHistory,
  loadSnapshots,
} from './atoms'
import { refreshChannelsList, channelsListAtom, channelsLoadingAtom, hasUsableChannelsAtom, requestChatInputFocus } from './atoms-sprint2'
import type { ProjectMode, WorkflowStage } from './atoms'
/**
 * 这些阶段后端已产出可渲染文件（草图 / MVP）。回访恢复或重启后，旧沙箱进程已死，
 * 需要重跑 sandbox 回填 previewUrlsAtom（P0-2）。
 */
const PREVIEW_READY_STAGES = new Set<WorkflowStage>([
  'sketch_ready',
  'testing',
  'judge_review',
  'repairing',
  'ready',
  'iterating',
  'completed',
])

/** 审计 A-09（2026-10-04）：沙箱预览恢复只服务存量 web 项目——桌面项目（deliveryPanel
 *  承接右栏）没有 web 产物，restore 必失败，白跑一次 IPC 还进入无消费者的 error 态。 */
const shouldRestorePreview = (project: Project): boolean =>
  project.template_type !== 'desktop_tool' && PREVIEW_READY_STAGES.has(project.current_stage)
/* =========================================================================
   App 根组件
   ========================================================================= */
const App: React.FC = () => {
  return (
    <>
      <AppRoutes />
      <PermissionDialog />
      <RequirementConfirmDialog />
      <PrdConfirmDialog />
      <ClarificationCard />
      <ReviewChoicesDialog />
    </>
  )
}
/* =========================================================================
   AppRoutes — 路由 + 业务逻辑
   通过 Jotai hooks 直接操作 store，不依赖全局变量
   ========================================================================= */
type AppRoute = 'mode-selection' | 'workspace' | 'project-history' | 'settings'
const AppRoutes: React.FC = () => {
  const store = useStore()
  const [route, setRoute] = useState<AppRoute>('mode-selection')
  const [mode, setMode] = useState<ProjectMode | null>(null)
  const [waitStart, setWaitStart] = useState<number | undefined>()
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>('empty')
  const [sessionId, setSessionId] = useState<string>(() => crypto.randomUUID())
  const [confirmingSketch, setConfirmingSketch] = useState(false)
  // U1：升级为长期模式的确认弹窗开关
  const [upgradeConfirmOpen, setUpgradeConfirmOpen] = useState(false)
  // 本地项目列表（真实 IPC 返回的项目索引）
  const [projectList, setProjectList] = useState<Project[]>([])
  // 回访恢复：加载历史消息期间的骨架占位开关
  const [historyLoading, setHistoryLoading] = useState(false)
  const [forkNotice, setForkNotice] = useState<string>()
  const forkLock = React.useRef(false)
  // ✅ 使用 Jotai hooks 直接读写
  const setProjectMode = useSetAtom(projectModeAtom)
  const setModeSelected = useSetAtom(modeSelectedAtom)
  const setWorkflowStage = useSetAtom(workflowStageAtom)
  const setDesktopPhase = useSetAtom(desktopPhaseAtom)
  const setStageLabel = useSetAtom(stageIndicatorLabelAtom)
  const setActiveSessionId = useSetAtom(activeAgentSessionIdAtom)
  const setCurrentProject = useSetAtom(currentProjectAtom)
  const setSnapshotsList = useSetAtom(snapshotsListAtom)
  const setPreviewUrls = useSetAtom(previewUrlsAtom)
  const setCurrentSnapshotId = useSetAtom(currentSnapshotIdAtom)
  const setMessages = useSetAtom(agentMessagesFamily(sessionId))
  const sessionMessages = useAtomValue(agentMessagesFamily(sessionId))
  const setChannels = useSetAtom(channelsListAtom)
  const setChannelsLoading = useSetAtom(channelsLoadingAtom)
  const hasChannels = useAtomValue(hasUsableChannelsAtom)
  // QW#1：启动即加载渠道列表（Header 三态徽标需要，不只 Settings 页）；Settings 页复用幂等加载
  React.useEffect(() => {
    void refreshChannelsList(setChannels, setChannelsLoading)
  }, [setChannels, setChannelsLoading])
  // QW#2（ux-first-run-0basics I2）：进入工作区且零渠道（已决 false）→ 追加一次
  // 引导提示（纯文本，指向右上角 ⚙️ 设置入口）；有渠道/未决（null）不打扰。
  const zeroChannelHintShownRef = React.useRef(false)
  React.useEffect(() => {
    if (route !== 'workspace') return
    if (zeroChannelHintShownRef.current) return
    if (hasChannels !== false) return
    // 审查 P2-③：用户已对话（含回访恢复历史/中途删渠道）时不打扰——引导只在空会话首跑显示
    if (sessionMessages.some((m) => m.role === 'user')) return
    zeroChannelHintShownRef.current = true
    appendMessageToSession(sessionId, {
      role: 'system',
      // QW#2 二期（2026-08-28）：[welcome-hint] 前缀走 ChatPanel 专属醒目卡片（内嵌直达按钮）；
      // 文案去黑话（API Key=门禁卡，从模型官网复制）+ 时长如实（首次约 10 分钟，不再承诺 2 分钟）
      content: [{
        type: 'text',
        text: '[welcome-hint]💡 你还没连接 AI 模型。添加一个 AI 模型需要从模型官网复制一段「API Key」（相当于门禁卡），首次约 10 分钟。连接后向导就能直接为你生成。',
      }],
      timestamp: Date.now(),
    })
  }, [route, hasChannels, sessionId, sessionMessages])
  // QW#2 二期 P2-④（2026-08-28）：引导已出且渠道从无到有 → 追加连接成功正反馈，
  // 对称闭环衔接用户下一步动作（不再让用户试探性发消息确认自己搞对了）
  const channelSuccessShownRef = React.useRef(false)
  React.useEffect(() => {
    if (route !== 'workspace') return
    if (!zeroChannelHintShownRef.current) return
    if (hasChannels !== true) return
    if (channelSuccessShownRef.current) return
    channelSuccessShownRef.current = true
    appendMessageToSession(sessionId, {
      role: 'system',
      content: [{
        type: 'text',
        text: '[welcome-hint:done]✅ 连接成功！把你想做的软件告诉我吧。',
      }],
      timestamp: Date.now(),
    })
  }, [route, hasChannels, sessionId, sessionMessages])
  const restoreAttemptedRef = React.useRef(false)
  // Sprint 2: 从 AgentEvent 提取 user_decision_required → CardOptions
  const decisionCards = useUserDecisionCards()
  const setGlobalError = useSetAtom(globalUserErrorAtom)
  const currentProject = useAtomValue(currentProjectAtom)
  const currentStage = useAtomValue(workflowStageAtom)
  const hasActiveStream = useAtomValue(hasActiveStreamAtom)
  const previewUrls = useAtomValue(previewUrlsAtom)
  const currentSnapshotId = useAtomValue(currentSnapshotIdAtom)
  // 当前项目预览地址（按 project_id 隔离）：从 previewUrlsAtom 取本项目沙箱地址；
  // updatedAt 拼进 query 作 cache-buster——沙箱同端口重 serve 新产物时强制 webview 重载
  const previewEntry = currentProject?.project_id
    ? (previewUrls[currentProject.project_id] ?? null)
    : null
  const streamPreviewUrl = previewEntry
    ? `${previewEntry.url}${previewEntry.url.includes('?') ? '&' : '?'}_r=${previewEntry.updatedAt}`
    : null
  // 写 / 清空指定项目的预览地址（多项目各自独立预览）
  const setProjectPreview = useCallback((projectId: string, url: string | null) => {
    setPreviewUrls((prev) => {
      if (url) return { ...prev, [projectId]: { url, updatedAt: Date.now() } }
      const next = { ...prev }
      delete next[projectId]
      return next
    })
  }, [setPreviewUrls])
  // 回访恢复预览（P0-2）：项目已产出草图/MVP 文件时，重跑沙箱并回填 previewUrlsAtom。
  // 旧沙箱进程已随主进程退出而亡，旧端口必死，直接重跑拿新 preview_url。
  // 失败不再静默吞掉：显式进入 error 态（带「重新连接沙箱」重试），避免停在空态。
  const restorePreview = useCallback((projectId: string) => {
    const api = window.electronAPI
    if (!api?.sandbox?.restore) {
      setPreviewStatus('error')
      return
    }
    setPreviewStatus('loading')
    void api.sandbox.restore({ request_id: crypto.randomUUID(), project_id: projectId })
      .then((result) => {
        if (result?.ok && result.data.preview_url) {
          setProjectPreview(projectId, result.data.preview_url)
          setPreviewStatus('running')
        } else {
          setProjectPreview(projectId, null)
          setPreviewStatus('error')
        }
      })
      .catch(() => {
        setProjectPreview(projectId, null)
        setPreviewStatus('error')
      })
  }, [setProjectPreview])
  // 离开 sketch_ready 后复位「生成中」态（由 stage_changed 事件驱动）
  React.useEffect(() => {
    if (currentStage !== 'sketch_ready') setConfirmingSketch(false)
  }, [currentStage])
  // 启动恢复：若本地存在活动项目，直接进入工作区而不是显示两道门
  React.useEffect(() => {
    if (restoreAttemptedRef.current) return
    restoreAttemptedRef.current = true
    const api = window.electronAPI
    if (!api?.project?.list) return
    void api.project.list({ request_id: crypto.randomUUID() }).then((result) => {
      if (!result?.ok || result.data.length === 0) return
      const restored = result.data[0]
      if (!restored) return
      // 回访恢复：用项目记录的最后活跃会话续接上下文（sitemap §2.6），
      // 不新建会话 id；无历史会话时退回新会话 id。
      const restoredSessionId = restored.last_session_id ?? sessionId
      setMode(restored.mode)
      setCurrentProject(restored)
      setProjectMode(restored.mode)
      setModeSelected(true)
      setWorkflowStage(restored.current_stage)
      setStageLabel(STAGE_LABEL_MAP[restored.current_stage] ?? '处理中')
      setDesktopPhase(restored.desktop_phase ?? null)
      setSessionId(restoredSessionId)
      setActiveSessionId(restoredSessionId)
      setProjectList(result.data)
      // 时间轴数据源：恢复时回填磁盘快照列表（否则胶片条永远空）
      void loadSnapshots(restored.project_id)
      if (restored.last_session_id) {
        setHistoryLoading(true)
        void Promise.all([
          loadAgentSessions(restored.project_id),
          loadSessionHistory(restored.last_session_id),
        ]).finally(() => setHistoryLoading(false))
      }
      // 已产出预览的项目：重跑沙箱回填预览（旧端口必死，无需校验）
      if (shouldRestorePreview(restored)) {
        restorePreview(restored.project_id)
      }
      setRoute('workspace')
    })
  }, [sessionId, restorePreview])
  // ==================== 选择模式 → 创建工作区 ====================
  const handleModeSelected = useCallback(async (selectedMode: 'quick' | 'longterm', idea?: string) => {
    setMode(selectedMode)
    // 复用 ModeSelectionPage 经 api.project.create 建好的真实项目（读 store 拿最新值，避开闭包过期）
    const newProject = window.__jotai_store__?.get(currentProjectAtom) ?? null
    if (!newProject) return // 无主进程 / 项目创建失败：不进入工作区
    // 真实会话 id：后端首次 sendMessage 时经 recordSessionActivity 落会话索引并回填 last_session_id
    const newSessionId = crypto.randomUUID()
    setProjectList((prev: Project[]) => [newProject, ...prev])
    setProjectMode(selectedMode)
    setModeSelected(true)
    setWorkflowStage(newProject.current_stage)
    setStageLabel(STAGE_LABEL_MAP[newProject.current_stage] ?? STAGE_LABEL_MAP.clarifying)
    setDesktopPhase(newProject.desktop_phase ?? null)
    setSessionId(newSessionId)
    setActiveSessionId(newSessionId)
    setCurrentProject(newProject)

    // D3 修复：进入工作区后 Agent 发送首条问候消息（写入新会话 family，避开闭包过期）
    if (!idea) appendMessageToSession(newSessionId, {
      role: 'assistant',
      content: [{ type: 'text', text: '你好！告诉我你想做什么软件，我会一步步帮你做出来。' }],
      timestamp: Date.now(),
    })
    // 新项目开始：清掉上一项目的预览地址与时间轴，避免串台
    setProjectPreview(newProject.project_id, null)
    setSnapshotsList([])
    setRoute('workspace')
    if (idea) {
      try {
        await submitInitialProjectIdea(newProject, newSessionId, idea, store, receipt => {
          appendMessageToSession(newSessionId, {role:'user',client_message_id:receipt.client_message_id,content:[{type:'text',text:idea}],timestamp:Date.now()})
        })
      } catch (error) { setGlobalError(error instanceof Error ? error.message : '首条消息发送失败，想法已保留。') }
    }
  }, [store, setGlobalError, setProjectMode, setModeSelected, setWorkflowStage, setStageLabel, setActiveSessionId, setCurrentProject, setProjectPreview, setSnapshotsList])
  // ==================== 从历史列表恢复项目 ====================
  const handleResumeProject = useCallback((project: Project) => {
    setMode(project.mode)
    // 回访恢复：沿用项目最后活跃会话，不新建会话 id（sitemap §2.6）
    const resumeSessionId = project.last_session_id ?? crypto.randomUUID()
    setProjectMode(project.mode)
    setModeSelected(true)
    setWorkflowStage(project.current_stage)
    setStageLabel(STAGE_LABEL_MAP[project.current_stage] ?? project.current_stage)
    setDesktopPhase(project.desktop_phase ?? null)
    setSessionId(resumeSessionId)
    setActiveSessionId(resumeSessionId)
    setCurrentProject(project)    setProjectList((prev: Project[]) =>
      prev.map((p) =>
        p.project_id === project.project_id
          ? { ...p, updated_at: new Date().toISOString() }
          : p,
      ),
    )
    // 时间轴数据源：从历史列表恢复项目时回填磁盘快照列表
    void loadSnapshots(project.project_id)
    if (project.last_session_id) {
      setHistoryLoading(true)
      void Promise.all([
        loadAgentSessions(project.project_id),
        loadSessionHistory(project.last_session_id),
      ]).finally(() => setHistoryLoading(false))
    }
    // 已产出预览的项目：重跑沙箱回填预览
    if (shouldRestorePreview(project)) {
      restorePreview(project.project_id)
    }
    setRoute('workspace')
  }, [setProjectMode, setModeSelected, setWorkflowStage, setStageLabel, setActiveSessionId, setCurrentProject, restorePreview])
  // ==================== 发送消息 ====================
  // 发送/回退结果的下游处理（与 2026-08-27 起 send-message 语义一致）：
  // queued → 「已排队」提示；BUSY → 引导等待或停止；其余失败静默（原状）
  const handleSendOutcome = useCallback((targetSessionId: string, result: ApiResult<AgentSendMessageResult>) => {
    if (result.ok) {
      // message-queue（2026-08-27）：生成期间发送 → 后端入队并返回 queued:true——
      // 追加「已排队」提示，消息不会丢，run 完成后自动处理。
      if (result.data?.queued) {
        appendMessageToSession(targetSessionId, {
          role: 'system',
          content: [{ type: 'text', text: '⏳ 已排队：当前生成完成后会自动处理这条消息。' }],
          timestamp: Date.now(),
        })
      }
      return
    }
    // U5 兜底：后端仍拒绝（旧后端/边缘 BUSY）→ 引导用户等待或停止，而不是消息石沉大海。
    // 全链路审查 P1-1（2026-10-01）：补 PROJECT_BUSY 分支——同项目另一会话/后台审查占锁时
    // 主进程已改为入队，此分支仅防御边缘路径（如旧会话残留锁）。
    if (result.error?.code === 'AGENT_SESSION_BUSY' || result.error?.code === 'AGENT_PROJECT_BUSY') {
      appendMessageToSession(targetSessionId, {
        role: 'system',
        content: [
          {
            type: 'text',
            text:
              result.error?.code === 'AGENT_PROJECT_BUSY'
                ? '这个项目正在处理另一个任务（可能是一次生成或检查），新消息暂时送不进去。你可以等它完成、切换到其他项目，或回到正在运行的任务里点停止。'
                : '我正在生成中，暂时没法同时处理新消息。你可以点输入框右侧的停止按钮中断当前生成，或等它完成后再发。',
          },
        ],
        timestamp: Date.now(),
      })
    }
  }, [])
  const handleLegacySendMessage = useCallback((content: string, images?: PastedImageRef[]) => {
    const api = window.electronAPI
    if (!api?.agent?.sendMessage) return
    // 真实链路：交给主进程 runAgent，流式事件由 setupGlobalAgentListeners 驱动 UI
    // clipboard-paste P1（2026-08-29）：带图消息本地气泡即块数组（imageId 短引用，无 base64）
    appendMessageToSession(sessionId, {
      role: 'user',
      content: images?.length
        ? [
            { type: 'text', text: content },
            ...images.map((r) => ({ type: 'image' as const, imageId: r.imageId, media_type: r.media_type })),
          ]
        : [{ type: 'text', text: content }],
      timestamp: Date.now(),
    })
    const payload = {
      request_id: crypto.randomUUID(),
      session_id: sessionId,
      project_id: currentProject?.project_id ?? projectList[0]?.project_id ?? '',
      content,
      images,
      mode: mode ?? 'quick',
      current_stage: currentStage,
      metadata: { source: 'chat' } as const,
    }
    const settle = async (): Promise<void> => {
      // P0-1 steer（运行中转向，2026-09-08）：会话有前台/后台生成的流式事件（hasActiveStream）
      // 且为纯文本消息时，输入框消息改道 agent:steer-message——主进程有活跃主 loop 则入
      // steer 队列、工具批间注入（【用户中途补充】包裹，注入回执由 steer_injected 事件气泡
      // 承担）；无活跃主 loop 时主进程内部回退 runAgent，语义与 send-message 完全一致
      //（忙则入 SessionMessageQueue）。带图消息不做 steer（注入只承载文本，走既有链路）。
      const steerChannel = api?.agent?.steerMessage
      if (hasActiveStream && !images?.length && steerChannel) {
        const steerResult = await steerChannel(payload)
        if (steerResult.ok && steerResult.data.steered) return
        if (steerResult.ok && steerResult.data.fallback) {
          handleSendOutcome(sessionId, {
            ok: true as const,
            request_id: steerResult.request_id,
            data: steerResult.data.fallback,
          })
          return
        }
        // 回退分支之外仍失败：走与 send-message 相同的错误处理（含 BUSY 引导）
        if (!steerResult.ok) {
          handleSendOutcome(sessionId, { ok: false as const, request_id: steerResult.request_id, error: steerResult.error })
          return
        }
        return
      }
      const result = await api.agent.sendMessage!(payload)
      handleSendOutcome(sessionId, result)
    }
    void settle()
  }, [sessionId, currentProject, projectList, mode, currentStage, hasActiveStream, handleSendOutcome])
  const handleSendMessage = useCallback((content: string, images?: PastedImageRef[], submission?: ComposerSubmission): void | Promise<SendReceipt> => {
    if (!submission) return handleLegacySendMessage(content, images)
    return (async () => {
      const api = window.electronAPI?.composer
      if (!api) throw new Error('消息接收接口不可用，草稿已保留')
      const target = submission.draft
      const result = await api.submit({
        request_id: crypto.randomUUID(), client_message_id: submission.client_message_id,
        project_id: target.project_id, session_id: target.session_id, draft_id: target.draft_id,
        content, attachment_refs: target.attachment_refs, mode: mode ?? 'quick', current_stage: currentStage,
        metadata: { source: 'chat' },
      })
      if (!result.ok) throw new Error(result.error.message)
      const receipt = result.data
      if (receipt.status !== 'needs_recovery') {
        appendMessageToSession(target.session_id, {
          role: 'user', client_message_id: submission.client_message_id,
          attachments: receipt.attachments,
          content: [{ type: 'text', text: content }, ...(receipt.images ?? []).map(image => ({ type: 'image' as const, ...image }))], timestamp: Date.now(),
        })
        if (receipt.status === 'queued') appendMessageToSession(target.session_id, {
          role: 'system', client_message_id: 'receipt-' + submission.client_message_id,
          content: [{ type: 'text', text: '⏳ 已排队：当前生成完成后会自动处理这条消息。' }], timestamp: Date.now(),
        })
      }
      return receipt
    })()
  }, [handleLegacySendMessage, mode, currentStage])
  // ==================== 停止生成（U4 / T3：agent:stop） ====================
  /**
   * 用户点击停止键：调 agent:stop（后端 cancelAgent 以 AGENT_CANCELLED 标记中止
   * 查询并清除运行登记，随后发 AGENT_CANCELLED 终态事件）。带 project_id 停止同项目
   * 全部入口的运行；只在实际取消成功时才落「已停止」提示，避免假反馈。
   */
  const handleStopGeneration = useCallback(async () => {
    const api = window.electronAPI
    if (!api?.agent?.cancel) return
    const result = await api.agent.cancel({
      request_id: crypto.randomUUID(),
      session_id: sessionId,
      project_id: currentProject?.project_id,
      reason: 'user_cancelled',
    })
    // cancelled:false 说明没有可停止的运行（已结束/已被其他路径清掉），不写成功提示
    if (result.ok && result.data.cancelled) {
      // Phase 7 U2 I4（2026-09-10）：停止≠删除——承接话术三栏（已确认/已保存/尚未
      // 完成）+ 后果如实（本轮未验证完成的内容不作为交付；上一交付版本不受影响）。
      // T1 reconcileInterruptedProject 在重启时对质量门中断另有承接，此处是运行中
      // 即时停止的呈现层（实施稿定性：呈现层重构，直接上）。
      appendMessageToSession(sessionId, {
        role: 'system',
        content: [{
          type: 'text',
          text: [
            '已停止本轮制作。你的成果都在：',
            '· 已确认：需求描述与已确认的草图/PRD 保留不变',
            '· 已保存：之前已交付的版本不受影响，可随时回看',
            '· 尚未完成：这一轮正在制作的内容没有完成验证，还不能当作可交付的应用',
            '接下来可以：直接发消息继续制作（会重新开始这一轮的未完成部分）；或先调整需求再告诉我；也可以在版本记录里查看已保存的成果。',
          ].join('\n'),
        }],
        timestamp: Date.now(),
      })
    }
  }, [sessionId, currentProject])
  // ==================== 卡片选项回传（Sprint 2：澄清卡片） ====================
  const handleCardOptionSelect = useCallback((option: CardOption) => {
    const api = window.electronAPI
    if (!api?.agent?.sendMessage) return
    // 就绪引导卡「导出部署」（2026-09-06）：不走聊天管道，直接调导出 IPC（与
    // MvpStatusBanner 导出按钮同一 API/错误口径），卡片消费但不追加用户气泡
    if (option.id === 'export_handoff') {
      if (!api.project?.export || !currentProject) return
      markDecisionConsumed(sessionId)
      void api.project
        .export({ request_id: crypto.randomUUID(), project_id: currentProject.project_id })
        .then((result) => {
          if (!result.ok) setGlobalError(result.error?.user_visible_message || result.error?.message || '导出失败，请重试。')
        })
        .catch(() => setGlobalError('导出失败，请重试。'))
      return
    }
    // 点击即有反馈：先本地追加用户气泡（与 handleSendMessage 一致），再回传后端
    appendMessageToSession(sessionId, {
      role: 'user',
      content: [{ type: 'text', text: option.label }],
      timestamp: Date.now(),
    })
    // 立即消费决策卡片，避免「选了选项卡片还赖着不走」（草图走 LLM 的空窗期）
    markDecisionConsumed(sessionId)
    // 局部优化 / 整版重做（2026-09-11 卡位改版）：聚焦聊天输入框，让用户直接补充内容
    //（后端已置对应补充态，用户下一句即消费——局部优化直接改、整版重做转二次确认）。
    if (option.id === 'optimize' || option.id === 'rebuild') {
      requestChatInputFocus(option.id === 'optimize' ? '说说你想改哪里…' : '说说想往哪个方向重做…')
    }
    // 真实链路：带 card_option metadata 回传（selected_option_id 对齐契约）
    void api.agent.sendMessage({
      request_id: crypto.randomUUID(),
      session_id: sessionId,
      project_id: currentProject?.project_id ?? projectList[0]?.project_id ?? '',
      content: option.label,
      mode: mode ?? 'quick',
      current_stage: currentStage,
      metadata: toCardSelectionMeta(option.id),
    })
  }, [sessionId, currentProject, projectList, mode, currentStage])
  /** 草图预览面板的「确认草图」入口：与聊天卡 ux_confirm_go 同一动作——复用
   *  handleCardOptionSelect 的气泡/消费卡/card_option metadata 全链，主进程按
   *  selected_option_id=ux_confirm_go 分流。2026-10-09 修复：此前 App 未给
   *  WorkspaceShell 传 onConfirmSketch，PreviewPanel 的草图点选标记监听
   *  （bloma-sketch-pick postMessage）与「发送调整意见」浮条整体不接线，
   *  草图点选纠错入口（入口 A）必然 not-found。 */
  const handleConfirmSketch = useCallback(() => {
    handleCardOptionSelect({ id: 'ux_confirm_go', label: '确认草图，开工' })
  }, [handleCardOptionSelect])
  // ==================== 点选纠错 ====================
  /** U8/R-CORR-01：点击预览元素时向主进程收集该元素的 DOM 上下文（用于高亮被选区域） */
  // ==================== 快照回滚 ====================
  /**
   * 真回滚（P0 修复，原为假实现：只插系统消息不调 IPC）。
   * 走 IPC snapshot:rollback——主进程先拍 rollback_guard 保护快照，再停沙箱、
   * 按快照恢复文件/文档、重启沙箱（危险操作，会先弹权限确认）。
   * 成功后回填 preview_url 与当前快照指针，并刷新时间轴（会多出 guard 快照）。
   */
  const handleRollback = useCallback((snapshot: Snapshot) => {
    const api = window.electronAPI
    const projectId = currentProject?.project_id ?? projectList[0]?.project_id ?? ''
    const notify = (text: string) => {
      setMessages((prev: AgentMessage[]) => [
        ...prev,
        { role: 'system', content: [{ type: 'text', text }], timestamp: Date.now() },
      ])
    }
    if (!api?.snapshots?.rollback || !projectId) {
      setPreviewStatus('error')
      notify('回滚服务暂时连不上，这次没有回滚成功，稍后再试一次。')
      return
    }
    setPreviewStatus('loading')
    void api.snapshots.rollback({
      request_id: crypto.randomUUID(),
      project_id: projectId,
      snapshot_id: snapshot.snapshot_id,
      reason: 'user_undo',
    })
      .then((result) => {
        if (result?.ok && result.data.rolled_back) {
          if (result.data.preview_url) {
            setProjectPreview(projectId, result.data.preview_url)
          } else {
            setProjectPreview(projectId, null)
            setPreviewStatus('error')
          }
          setCurrentSnapshotId(result.data.current_snapshot_id)
          void loadSnapshots(projectId)
          // T7 如实提示：存量快照（T7 前归档）没有冻结文档，回滚只还原了代码，
          // 文档面板仍是最新版——不静默、不补造
          const docsNote =
            result.data.documents_restored === false
              ? '（这个版本比较早，没有冻结当时的文档；文档面板显示的仍是最新版。）'
              : ''
          notify(
            result.data.preview_url
              ? `已经回到「${snapshot.name}」了，预览区就是当时的版本。${docsNote}要继续的话随时告诉我。`
              : `已经回到「${snapshot.name}」了，但预览沙箱没起来，可以点「重新连接沙箱」再看。${docsNote}`,
          )
        } else {
          setPreviewStatus('error')
          // A-05（2026-10-04）：失败原因如实区分——运行锁拒绝（AGENT_PROJECT_BUSY）不是
          //「快照失效」，误导归因会让用户去翻快照而不是停止生成。
          const failure = result && !result.ok ? result.error : undefined
          const errorMessage = failure?.user_visible_message || failure?.message || ''
          notify(
            errorMessage.toUpperCase().includes('PROJECT_BUSY')
              ? '现在正在生成，不能回滚——可以先点停止中断本轮制作，或等它完成后再回到这个版本。'
              : '回滚没有成功（快照可能已失效或被拒绝），当前版本没有被改动。',
          )
        }
      })
      .catch(() => {
        setPreviewStatus('error')
        notify('回滚出错了，当前版本没有被改动。可以稍后再试一次。')
      })
  }, [currentProject, projectList, setCurrentSnapshotId, setMessages, setProjectPreview])
  // ==================== 超时操作（超过 120 秒） ====================
  // 新一轮生成开始时，清掉上一轮「继续等待」遗留的计时起点：waitStart 只在
  // handleContinueWaiting 里被赋值且从不清理，若不在此复位，下一轮生成会取到这个
  // 陈旧时间戳、一开始就弹出超时卡片（effectiveWaitStart 优先用 waitStartTime）。
  const prevHasStreamRef = React.useRef(false)
  React.useEffect(() => {
    const risingEdge = hasActiveStream && !prevHasStreamRef.current
    prevHasStreamRef.current = hasActiveStream
    if (risingEdge) setWaitStart(undefined)
  }, [hasActiveStream])
  const handleContinueWaiting = useCallback(() => {
    // 继续等待：先给用户明确反馈，再重置等待起点重新计时
    appendMessageToSession(sessionId, {
      role: 'system',
      content: [{ type: 'text', text: '好的，我继续。生成完成后马上告诉你。' }],
      timestamp: Date.now(),
    })
    setWaitStart(Date.now())
  }, [sessionId])
  // ==================== 确认草图 → 生成完整功能（问题 A / P0-1） ====================
  // ==================== 标记为完成（U6） ====================
  const handleMarkComplete = useCallback(() => {
    const api = window.electronAPI
    const projectId = currentProject?.project_id ?? projectList[0]?.project_id
    if (!api?.project?.finalize || !projectId) return
    void api.project.finalize({
      request_id: crypto.randomUUID(),
      project_id: projectId,
      session_id: sessionId,
    }).then((result) => {
      if (!result?.ok) return
      // 后端已把项目收口到 completed（satisfaction_marked + project_finalized 埋点）；
      // 同步渲染端，让 stage 从 ready 切到 completed，头部随之出现「升级为长期模式」入口。
      setCurrentProject(result.data)
      setWorkflowStage(result.data.current_stage)
      setStageLabel(STAGE_LABEL_MAP[result.data.current_stage] ?? '已完成')
      appendMessageToSession(sessionId, {
        role: 'system',
        content: [{ type: 'text', text: '已标记为完成。这个项目会保留在你的历史列表里，随时可以回来继续完善，或升级为长期模式。' }],
        timestamp: Date.now(),
      })
    })
  }, [currentProject, projectList, sessionId, setCurrentProject, setWorkflowStage, setStageLabel])
  // ==================== 升级为长期模式（U1） ====================
  // 点击「升级为长期模式」按钮 → 先弹确认（PRD §4.4），确认后再走 IPC
  const handleUpgrade = useCallback(() => {
    setUpgradeConfirmOpen(true)
  }, [])
  const handleConfirmUpgrade = useCallback(() => {
    const api = window.electronAPI
    const projectId = currentProject?.project_id ?? projectList[0]?.project_id
    setUpgradeConfirmOpen(false)
    if (!api?.project?.upgrade || !projectId) return
    void api.project.upgrade({
      request_id: crypto.randomUUID(),
      project_id: projectId,
      session_id: sessionId,
    }).then((result) => {
      if (!result?.ok) return
      // 后端已把项目切到 longterm + upgrading 阶段并落 upgrade 快照；此处同步渲染端
      setCurrentProject(result.data)
      setProjectMode('longterm')
      setWorkflowStage(result.data.current_stage)
      setStageLabel(STAGE_LABEL_MAP[result.data.current_stage] ?? '处理中')
      appendMessageToSession(sessionId, {
        role: 'system',
        content: [{ type: 'text', text: '已升级为长期迭代模式，我会持续帮你维护文档与测试。随时可以继续完善。' }],
        timestamp: Date.now(),
      })
    })
  }, [currentProject, projectList, sessionId, setCurrentProject, setProjectMode, setWorkflowStage, setStageLabel])
  // ==================== 预览刷新 / 重新连接沙箱（P2） ====================
  const handleRefreshPreview = useCallback(() => {
    const api = window.electronAPI
    const projectId = currentProject?.project_id ?? projectList[0]?.project_id
    if (!api?.sandbox?.restore || !projectId) return
    setPreviewStatus('loading')
    void api.sandbox.restore({ request_id: crypto.randomUUID(), project_id: projectId })
      .then((result) => {
        if (result?.ok && result.data.preview_url) {
          setProjectPreview(projectId, result.data.preview_url)
          setPreviewStatus('running')
        } else {
          setProjectPreview(projectId, null)
          setPreviewStatus('error')
        }
      })
      .catch(() => {
        setProjectPreview(projectId, null)
        setPreviewStatus('error')
      })
  }, [currentProject, projectList, setProjectPreview])
  // ==================== 预览失效兜底（P0） ====================
  // iframe 加载失败（沙箱端口失效/进程已死）时：清掉失效的预览地址并进入 error 态，
  // 让用户看到「重新连接沙箱」重试按钮，而不是停在空态或死 iframe。
  const handlePreviewError = useCallback(() => {
    const projectId = currentProject?.project_id ?? projectList[0]?.project_id
    if (projectId) setProjectPreview(projectId, null)
    setPreviewStatus('error')
  }, [currentProject, projectList, setProjectPreview])
  // ==================== 设置页入口 ====================
  const handleOpenSettings = useCallback(() => {
    setRoute('settings')
  }, [])
  // ==================== 历史列表操作同步（Sprint 3：归档/删除/恢复） ====================
  // 历史项目页对项目做归档/删除/恢复后，回传最新活动列表：
  // 1) 同步 App 的 projectList（启动恢复与 handleSendMessage 兜底都依赖它）；
  // 2) 若当前项目已被删除（不在活动列表），清 currentProject 并回两道门。
  const handleProjectsChanged = useCallback(
    (list: Project[]) => {
      setProjectList(list)
      if (currentProject && !list.some((p) => p.project_id === currentProject.project_id)) {
        setCurrentProject(null)
        setProjectMode(null)
        setModeSelected(false)
        setRoute('mode-selection')
      }
    },
    [currentProject, setProjectList, setCurrentProject, setProjectMode, setModeSelected],
  )
  // 预览地址：由 sketch_ready / mvp_ready 事件回填的沙箱地址（streamPreviewUrl）
  const effectivePreviewUrl = streamPreviewUrl ?? undefined
  const effectivePreviewStatus: PreviewStatus = streamPreviewUrl ? 'running' : previewStatus
  // ==================== P0-2 fork：从这里重新来（2026-09-08） ====================
  /**
   * user 气泡「从这里重新来」：把当前会话从该 user 消息处 fork（主进程复制此前对话到
   * 新会话，原会话保留），渲染端续接到新 sessionId 并加载其历史。锚点优先带 v2 行 id，
   * 旧文件回退 entry_timestamp。fork 期间会话由主进程侧 BUSY 拒绝（此处不预判）。
   */
  const handleForkFromMessage = useCallback(async (message: AgentMessage) => {
    if (forkLock.current) throw new Error('正在新开讨论，请稍候')
    forkLock.current = true
    try {
      const branch = await restartDiscussion(window.electronAPI?.agent, currentProject?.project_id, sessionId, message)
      setSessionId(branch.sessionId); setActiveSessionId(branch.sessionId)
      const scope = store.get(composerScopeAtom)
      const draftAtom = composerDraftFamily(draftKey(scope))
      const previous = store.get(draftAtom)
      const draft = { ...previous, text: branch.text, revision: previous.revision + 1 }
      store.set(draftAtom, draft)
      setForkNotice('已新开讨论，当前程序保留。原要求已放入输入框，编辑后发送；恢复文件请使用版本。')
      await loadSessionHistory(branch.sessionId)
      requestChatInputFocus('编辑这条要求后发送，继续新的讨论')
    } catch (error) {
      store.set(globalUserErrorAtom, error instanceof Error ? error.message : '新开讨论失败，请重试')
      throw error
    } finally { forkLock.current = false }
  }, [sessionId, currentProject?.project_id, setActiveSessionId, store])
  // ==================== 路由渲染 ====================
  if (route === 'mode-selection') {
    return (
      <ModeSelectionPage
        onModeSelected={handleModeSelected}
        onBackToHistory={projectList.length > 0 ? () => setRoute('project-history') : undefined}
      />
    )
  }
  if (route === 'project-history') {
    return (
      <ProjectHistoryPage
        projects={projectList}
        onResumeProject={handleResumeProject}
        onNewProject={() => setRoute('mode-selection')}
        onBackToWorkspace={() => setRoute('workspace')}
        onProjectsChanged={handleProjectsChanged}
      />
    )
  }
  if (route === 'settings') {
    return <SettingsPage onBack={() => setRoute('workspace')} />
  }
  // route === 'workspace'
  return (
    <>
      <WorkspaceShell
        notice={forkNotice}
        cardOptions={decisionCards?.options}
        decisionTitle={decisionCards?.title}
        decisionBody={decisionCards?.body}
        onCardOptionSelect={handleCardOptionSelect}
        onSendMessage={handleSendMessage}
        onForkFromMessage={handleForkFromMessage}
        waitStartTime={waitStart}
        waitActionLabel="处理你的请求"
        isHistoryLoading={historyLoading}
        // 右栏门控（确认门新规 2026-10-04）：桌面项目默认 DeliveryPanel；UX 草图预览期间
        //（ux_sketch_ready → ux_sketch_closed）顶替为 PreviewPanel 供过目草图。
        deliveryPanel={currentProject?.template_type === 'desktop_tool' && !previewEntry}
        previewStatus={effectivePreviewStatus}
        previewUrl={effectivePreviewUrl}
        onRefreshPreview={handleRefreshPreview}
        onPreviewError={handlePreviewError}
        confirming={confirmingSketch}
        onConfirmSketch={handleConfirmSketch}
        onMarkComplete={window.electronAPI?.project?.finalize ? handleMarkComplete : undefined}
        onRollback={handleRollback}
        onContinueWaiting={handleContinueWaiting}
        onStopGeneration={handleStopGeneration}
        onOpenSettings={handleOpenSettings}
        onUpgrade={handleUpgrade}
        onAllProjects={projectList.length > 0 ? () => {
          setRoute('project-history')
        } : undefined}
      />
      {upgradeConfirmOpen && (
        <UpgradeConfirmDialog
          onCancel={() => setUpgradeConfirmOpen(false)}
          onConfirm={handleConfirmUpgrade}
        />
      )}
    </>
  )
}
/* =========================================================================
   UpgradeConfirmDialog — 升级为长期模式的确认弹窗（U1 / PRD §4.4）
   ========================================================================= */
const UpgradeConfirmDialog: React.FC<{
  onCancel: () => void
  onConfirm: () => void
}> = ({ onCancel, onConfirm }) => (
  <div
    role="dialog"
    aria-modal="true"
    aria-label="升级为长期模式"
    data-ai-id="upgrade-confirm-dialog"
    style={{
      position: 'fixed',
      inset: 0,
      zIndex: 1100,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0,0,0,0.35)',
      backdropFilter: 'blur(4px)',
      WebkitBackdropFilter: 'blur(4px)',
      animation: 'tile-enter 0.15s ease both',
    }}
    onClick={(e) => {
      if (e.target === e.currentTarget) onCancel()
    }}
  >
    <div
      style={{
        background: 'var(--white)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-6)',
        maxWidth: 420,
        width: '90%',
        boxShadow: 'var(--shadow-lg)',
        animation: 'tile-enter 0.2s ease both',
      }}
    >
      <p
        style={{
          fontSize: 'var(--font-size-md)',
          fontWeight: 700,
          color: 'var(--color-text)',
          margin: '0 0 var(--space-3)',
        }}
      >
        升级为长期模式？
      </p>
      <p
        style={{
          fontSize: 'var(--font-size-sm)',
          color: 'var(--color-text)',
          lineHeight: 'var(--line-height-base)',
          margin: '0 0 var(--space-5)',
        }}
      >
        升级后会切换到「精细打磨」模式，我会持续帮你维护 PRD / 测试报告等文档。升级前会自动保存一份当前版本快照，之后仍可回滚。
      </p>
      <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
        <button
          onClick={onCancel}
          data-ai-id="upgrade-cancel"
          style={{
            height: 36,
            padding: '0 var(--space-5)',
            fontSize: 'var(--font-size-sm)',
            fontWeight: 600,
            color: 'var(--color-text)',
            background: 'var(--color-surface-muted)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'all var(--transition-fast)',
          }}
        >
          取消
        </button>
        <button
          onClick={onConfirm}
          data-ai-id="upgrade-confirm"
          style={{
            height: 36,
            padding: '0 var(--space-5)',
            fontSize: 'var(--font-size-sm)',
            fontWeight: 600,
            color: 'var(--white)',
            background: 'linear-gradient(135deg, var(--color-quick), var(--color-quick-bright))',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            boxShadow: '0 4px 12px -2px rgba(124,58,237,0.4)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'all var(--transition-fast)',
          }}
        >
          确认升级
        </button>
      </div>
    </div>
  </div>
)
export default App
