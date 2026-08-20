import React, { useState, useCallback } from 'react'
import { useSetAtom, useAtomValue } from 'jotai'
import { ModeSelectionPage } from './ModeSelectionPage'
import { WorkspaceShell } from './WorkspaceShell'
import { ProjectHistoryPage } from './ProjectHistoryPage'
import { PermissionDialog } from './PermissionDialog'
import { SettingsPage } from './SettingsPage'
import { useUserDecisionCards, toCardSelectionMeta } from './ChatPanel-sprint2'
import type { CardOption } from './CardOptions'
import type { PreviewStatus } from './PreviewPanel'
import type { Snapshot, AgentMessage, Project } from './atoms'
import {
  modeSelectedAtom,
  projectModeAtom,
  workflowStageAtom,
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
  loadAgentSessions,
  loadSessionHistory,
  loadSnapshots,
} from './atoms'
import type { ProjectMode, WorkflowStage } from './atoms'
import type { DomCollectContextResult } from '../../shared/types'

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

/* =========================================================================
   Aurora 背景
   ========================================================================= */

const Aurora: React.FC = () => (
  <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 0, overflow: 'hidden', pointerEvents: 'none' }}>
    <span style={{ position: 'absolute', borderRadius: '50%', filter: 'blur(80px)', opacity: 0.9, width: '46vw', height: '46vw', top: '-12%', left: '-8%', background: 'var(--aurora-violet)', animation: 'aurora-drift 18s ease-in-out infinite' }} />
    <span style={{ position: 'absolute', borderRadius: '50%', filter: 'blur(80px)', opacity: 0.9, width: '42vw', height: '42vw', bottom: '-14%', right: '-6%', background: 'var(--aurora-pink)', animation: 'aurora-drift 22s ease-in-out infinite reverse' }} />
    <span style={{ position: 'absolute', borderRadius: '50%', filter: 'blur(80px)', opacity: 0.9, width: '38vw', height: '38vw', top: '30%', right: '18%', background: 'var(--aurora-cyan)', animation: 'aurora-drift 26s ease-in-out infinite' }} />
  </div>
)

/* =========================================================================
   App 根组件
   ========================================================================= */

const App: React.FC = () => {
  return (
    <>
      <Aurora />
      <AppRoutes />
      <PermissionDialog />
    </>
  )
}

/* =========================================================================
   AppRoutes — 路由 + 业务逻辑
   通过 Jotai hooks 直接操作 store，不依赖全局变量
   ========================================================================= */

type AppRoute = 'mode-selection' | 'workspace' | 'project-history' | 'settings'

const AppRoutes: React.FC = () => {
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

  // ✅ 使用 Jotai hooks 直接读写
  const setProjectMode = useSetAtom(projectModeAtom)
  const setModeSelected = useSetAtom(modeSelectedAtom)
  const setWorkflowStage = useSetAtom(workflowStageAtom)
  const setStageLabel = useSetAtom(stageIndicatorLabelAtom)
  const setActiveSessionId = useSetAtom(activeAgentSessionIdAtom)
  const setCurrentProject = useSetAtom(currentProjectAtom)
  const setSnapshotsList = useSetAtom(snapshotsListAtom)
  const setPreviewUrls = useSetAtom(previewUrlsAtom)
  const setCurrentSnapshotId = useSetAtom(currentSnapshotIdAtom)
  const setMessages = useSetAtom(agentMessagesFamily(sessionId))

  const restoreAttemptedRef = React.useRef(false)

  // Sprint 2: 从 AgentEvent 提取 user_decision_required → CardOptions
  const decisionCards = useUserDecisionCards()
  const currentProject = useAtomValue(currentProjectAtom)
  const currentStage = useAtomValue(workflowStageAtom)
  const previewUrls = useAtomValue(previewUrlsAtom)
  const currentSnapshotId = useAtomValue(currentSnapshotIdAtom)

  // 当前项目预览地址（按 project_id 隔离）：从 previewUrlsAtom 取本项目沙箱地址
  const streamPreviewUrl = currentProject?.project_id
    ? (previewUrls[currentProject.project_id] ?? null)
    : null

  // 写 / 清空指定项目的预览地址（多项目各自独立预览）
  const setProjectPreview = useCallback((projectId: string, url: string | null) => {
    setPreviewUrls((prev) => {
      if (url) return { ...prev, [projectId]: url }
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
      if (PREVIEW_READY_STAGES.has(restored.current_stage)) {
        restorePreview(restored.project_id)
      }
      setRoute('workspace')
    })
  }, [sessionId, restorePreview])

  // ==================== 选择模式 → 创建工作区 ====================

  const handleModeSelected = useCallback((selectedMode: 'quick' | 'longterm') => {
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
    setSessionId(newSessionId)
    setActiveSessionId(newSessionId)
    setCurrentProject(newProject)

    // D3 修复：进入工作区后 Agent 发送首条问候消息（写入新会话 family，避开闭包过期）
    appendMessageToSession(newSessionId, {
      role: 'assistant',
      content: [{ type: 'text', text: '你好！告诉我你想做什么软件，我会一步步帮你做出来。' }],
      timestamp: Date.now(),
    })

    // 新项目开始：清掉上一项目的预览地址与时间轴，避免串台
    setProjectPreview(newProject.project_id, null)
    setSnapshotsList([])

    setRoute('workspace')
  }, [setProjectMode, setModeSelected, setWorkflowStage, setStageLabel, setActiveSessionId, setCurrentProject, setProjectPreview, setSnapshotsList])

  // ==================== 从历史列表恢复项目 ====================

  const handleResumeProject = useCallback((project: Project) => {
    setMode(project.mode)
    // 回访恢复：沿用项目最后活跃会话，不新建会话 id（sitemap §2.6）
    const resumeSessionId = project.last_session_id ?? crypto.randomUUID()

    setProjectMode(project.mode)
    setModeSelected(true)
    setWorkflowStage(project.current_stage)
    setStageLabel(STAGE_LABEL_MAP[project.current_stage] ?? project.current_stage)
    setSessionId(resumeSessionId)
    setActiveSessionId(resumeSessionId)
    setCurrentProject(project)

    setProjectList((prev: Project[]) =>
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
    if (PREVIEW_READY_STAGES.has(project.current_stage)) {
      restorePreview(project.project_id)
    }

    setRoute('workspace')
  }, [setProjectMode, setModeSelected, setWorkflowStage, setStageLabel, setActiveSessionId, setCurrentProject, restorePreview])

  // ==================== 发送消息 ====================

  const handleSendMessage = useCallback((content: string) => {
    const api = window.electronAPI
    if (!api?.agent?.sendMessage) return

    // 真实链路：交给主进程 runAgent，流式事件由 setupGlobalAgentListeners 驱动 UI
    appendMessageToSession(sessionId, {
      role: 'user',
      content: [{ type: 'text', text: content }],
      timestamp: Date.now(),
    })
    void api.agent.sendMessage({
      request_id: crypto.randomUUID(),
      session_id: sessionId,
      project_id: currentProject?.project_id ?? projectList[0]?.project_id ?? '',
      content,
      mode: mode ?? 'quick',
      current_stage: currentStage,
      metadata: { source: 'chat' },
    }).then((result) => {
      // U5：生成期间发消息会被后端以 AGENT_SESSION_BUSY 拒绝并静默吞掉——
      // 这里补一条引导，告诉用户可等完成或点停止，而不是消息石沉大海。
      if (!result?.ok && result?.error?.code === 'AGENT_SESSION_BUSY') {
        appendMessageToSession(sessionId, {
          role: 'system',
          content: [{ type: 'text', text: '我正在生成中，暂时没法同时处理新消息。你可以点输入框右侧的停止按钮中断当前生成，或等它完成后再发。' }],
          timestamp: Date.now(),
        })
      }
    })
  }, [sessionId, currentProject, projectList, mode, currentStage])

  // ==================== 停止生成（U4 / T3：agent:stop） ====================

  /**
   * 用户点击停止键：调 agent:stop（后端 cancelAgent 以 AGENT_CANCELLED 标记中止
   * SDK 查询并清除 activeSessions）。后端随后发 AGENT_CANCELLED 终态事件，
   * 流式状态归 false，不残留「进行中」假象；会话解锁后可继续发消息。
   */
  const handleStopGeneration = useCallback(() => {
    const api = window.electronAPI
    if (!api?.agent?.cancel) return

    // 立即反馈：先落一条系统消息，再让主进程 abort 当前流
    appendMessageToSession(sessionId, {
      role: 'system',
      content: [{ type: 'text', text: '已停止生成。当前已生成的内容会保留，你可以继续补充或调整。' }],
      timestamp: Date.now(),
    })
    void api.agent.cancel({
      request_id: crypto.randomUUID(),
      session_id: sessionId,
      reason: 'user_cancelled',
    })
  }, [sessionId])

  // ==================== 卡片选项回传（Sprint 2：澄清卡片） ====================

  const handleCardOptionSelect = useCallback((option: CardOption) => {
    const api = window.electronAPI
    if (!api?.agent?.sendMessage) return

    // 点击即有反馈：先本地追加用户气泡（与 handleSendMessage 一致），再回传后端
    appendMessageToSession(sessionId, {
      role: 'user',
      content: [{ type: 'text', text: option.label }],
      timestamp: Date.now(),
    })
    // 立即消费决策卡片，避免「选了选项卡片还赖着不走」（草图走 LLM 的空窗期）
    markDecisionConsumed(sessionId)
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

  // ==================== 点选纠错 ====================

  /** U8/R-CORR-01：点击预览元素时向主进程收集该元素的 DOM 上下文（用于高亮被选区域） */
  const handleCollectDomContext = useCallback(async (click: { x: number; y: number }) => {
    const api = window.electronAPI
    const projectId = currentProject?.project_id ?? projectList[0]?.project_id ?? ''
    try {
      const dom = await api?.dom?.collectContext?.({
        request_id: crypto.randomUUID(),
        project_id: projectId,
        session_id: sessionId,
        click,
      })
      if (dom?.ok && dom.data) return dom.data
    } catch {
      // 收集异常返回 undefined，UI 回退红点标记
    }
    return undefined
  }, [sessionId, currentProject, projectList])

  const handleCorrectionSubmit = useCallback(async (payload: {
    position: { x: number; y: number }
    userNote: string
    fallbackMode: boolean
    domContext?: DomCollectContextResult
  }) => {
    const api = window.electronAPI
    if (!api?.project?.submitCorrection) return

    const projectId = currentProject?.project_id ?? projectList[0]?.project_id ?? ''

    // U8：优先使用点击时已收集的 DOM 上下文（PreviewPanel 点击即收集用于高亮）；缺失时提交前兜底收集一次。
    // 渲染进程读不到跨域预览 iframe 的 DOM，改由主进程通过 subframe.executeJavaScript 收集；
    // 收集失败则回退纯坐标模式（bounding_rect width/height 0、fallback_mode true）。
    let domContext: DomCollectContextResult | undefined = payload.domContext
    if (!domContext) {
      try {
        const dom = await api?.dom?.collectContext?.({
          request_id: crypto.randomUUID(),
          project_id: projectId,
          session_id: sessionId,
          click: { x: payload.position.x, y: payload.position.y },
        })
        if (dom?.ok && dom.data && !dom.data.fallback_mode) domContext = dom.data
      } catch {
        // 收集异常不阻断纠错提交，回退纯坐标
      }
    }

    // 真实链路：记录点选纠错（后端 appendProjectEvent + analytics point_correction）
    appendMessageToSession(sessionId, {
      role: 'system',
      content: [{ type: 'text', text: `已收到你的修改意见${payload.userNote ? `：「${payload.userNote}」` : '（你猜模式）'}，我来帮你调整。` }],
      timestamp: Date.now(),
    })
    void api.project.submitCorrection({
      request_id: crypto.randomUUID(),
      project_id: projectId,
      session_id: sessionId,
      context: domContext
        ? {
            element_selector: domContext.element_selector,
            text_content: domContext.text_content,
            bounding_rect: domContext.bounding_rect,
            fallback_mode: false,
          }
        : {
            bounding_rect: { x: payload.position.x, y: payload.position.y, width: 0, height: 0 },
            fallback_mode: true,
          },
      user_note: payload.userNote || undefined,
      mode: payload.userNote ? 'user_note' : 'guess',
    })
  }, [sessionId, currentProject, projectList])

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
          notify('回滚没有成功（快照可能已失效或被拒绝），当前版本没有被改动。')
        }
      })
      .catch(() => {
        setPreviewStatus('error')
        notify('回滚出错了，当前版本没有被改动。可以稍后再试一次。')
      })
  }, [currentProject, projectList, setCurrentSnapshotId, setMessages, setProjectPreview])

  // ==================== 超时操作（超过 120 秒） ====================

  const handleContinueWaiting = useCallback(() => {
    // 继续等待：重置等待起点，重新计时
    setWaitStart(Date.now())
  }, [])

  const handleViewPartial = useCallback(() => {
    // 查看已有部分：预览区已展示当前内容，加一条系统消息说明
    const msg: AgentMessage = {
      role: 'system',
      content: [{ type: 'text', text: '这是目前已经生成好的部分。你可以先看看效果，我继续在后台帮你完善。' }],
      timestamp: Date.now(),
    }
    setMessages((prev: AgentMessage[]) => [...prev, msg])
    setPreviewStatus('running')
  }, [setMessages])

  // ==================== 确认草图 → 生成完整功能（问题 A / P0-1） ====================

  const handleConfirmSketch = useCallback(() => {
    const api = window.electronAPI
    if (!api?.project?.confirmSketch) return
    const projectId = currentProject?.project_id ?? projectList[0]?.project_id
    const snapshotId = currentSnapshotId ?? currentProject?.current_snapshot_id
    if (!projectId || !snapshotId) return

    setConfirmingSketch(true)
    appendMessageToSession(sessionId, {
      role: 'system',
      content: [{ type: 'text', text: '好的，我按你确认的草图开始生成完整功能，稍等一下。' }],
      timestamp: Date.now(),
    })
    setPreviewStatus('loading')

    void api.project.confirmSketch({
      request_id: crypto.randomUUID(),
      project_id: projectId,
      session_id: sessionId,
      snapshot_id: snapshotId,
      decision: 'accepted',
    }).finally(() => setConfirmingSketch(false))
  }, [sessionId, currentProject, projectList, currentSnapshotId])

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
        cardOptions={decisionCards?.options}
        decisionTitle={decisionCards?.title}
        onCardOptionSelect={handleCardOptionSelect}
        onSendMessage={handleSendMessage}
        waitStartTime={waitStart}
        waitActionLabel="生成可运行版本"
        isHistoryLoading={historyLoading}
        previewStatus={effectivePreviewStatus}
        previewUrl={effectivePreviewUrl}
        onRefreshPreview={handleRefreshPreview}
        onPreviewError={handlePreviewError}
        onConfirmSketch={window.electronAPI?.project?.confirmSketch ? handleConfirmSketch : undefined}
        confirming={confirmingSketch}
        onMarkComplete={window.electronAPI?.project?.finalize ? handleMarkComplete : undefined}
        onCorrectionSubmit={handleCorrectionSubmit}
        onCollectDomContext={handleCollectDomContext}
        onRollback={handleRollback}
        onContinueWaiting={handleContinueWaiting}
        onViewPartial={handleViewPartial}
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
