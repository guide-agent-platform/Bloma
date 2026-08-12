import React, { useState, useCallback } from 'react'
import { useSetAtom, useAtomValue } from 'jotai'
import { ModeSelectionPage } from './ModeSelectionPage'
import { WorkspaceShell } from './WorkspaceShell'
import { ProjectHistoryPage } from './ProjectHistoryPage'
import { PermissionDialog } from './PermissionDialog'
import { ChannelSettingsPage } from './ChannelSettingsPage'
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
  activeAgentSessionIdAtom,
  snapshotsListAtom,
  previewUrlAtom,
  loadAgentSessions,
  loadSessionHistory,
} from './atoms'
import type { ProjectMode, WorkflowStage } from './atoms'

/**
 * 演示用示例草图（与 demo.html 中 SAMPLE_SKETCH 完全一致）。
 */
const SAMPLE_SKETCH = `<html><head><meta charset="UTF-8"><style>body{font-family:'Inter',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:linear-gradient(135deg,#F4F3FA,#FDF2F8);color:#1D1D1F}.app{text-align:center;padding:40px;max-width:440px;width:100%}h1{background:linear-gradient(135deg,#7C3AED,#EC4899);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:6px;font-size:22px;font-weight:700}.sub{color:#6E6E73;margin-bottom:28px;font-size:13px}.card{background:#fff;border:1px solid #E6E5EE;border-radius:16px;padding:18px 20px;margin:10px 0;text-align:left;box-shadow:0 4px 16px -4px rgba(29,29,31,.08)}.card h3{margin-bottom:2px;font-size:12px;color:#6E6E73;font-weight:500}.card .val{font-size:24px;font-weight:700;margin-top:4px}.income{color:#10B981}.expense{color:#DC2626}.balance{color:#7C3AED}</style></head><body><div class="app"><h1>记账应用 · 草图预览</h1><p class="sub">Sprint 1 演示 · 实际由编程Agent生成</p><div class="card"><h3>本月收入</h3><p class="val income">¥ 12,500</p></div><div class="card"><h3>本月支出</h3><p class="val expense">¥ 8,320</p></div><div class="card"><h3>本月结余</h3><p class="val balance">¥ 4,180</p></div></div></body></html>`

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
      <PermissionDialog mode="ask" />
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
  const [waiting, setWaiting] = useState(false)
  const [waitStart, setWaitStart] = useState<number | undefined>()
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>('empty')
  const [sessionId, setSessionId] = useState<string>(() => `demo-${Date.now()}`)
  const [samplePreviewUrl] = useState(() => {
    try { return URL.createObjectURL(new Blob([SAMPLE_SKETCH], { type: 'text/html' })) }
    catch { return undefined }
  })

  // 本地项目列表（演示模式）
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
  const setPreviewUrl = useSetAtom(previewUrlAtom)
  const setMessages = useSetAtom(agentMessagesFamily(sessionId))

  const restoreAttemptedRef = React.useRef(false)

  // Sprint 2: 从 AgentEvent 提取 user_decision_required → CardOptions
  const decisionCards = useUserDecisionCards()
  const currentProject = useAtomValue(currentProjectAtom)
  const currentStage = useAtomValue(workflowStageAtom)
  const streamPreviewUrl = useAtomValue(previewUrlAtom)

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
      if (restored.last_session_id) {
        setHistoryLoading(true)
        void Promise.all([
          loadAgentSessions(restored.project_id),
          loadSessionHistory(restored.last_session_id),
        ]).finally(() => setHistoryLoading(false))
      }
      setRoute('workspace')
    })
  }, [sessionId])

  // ==================== 选择模式 → 创建工作区 ====================

  const handleModeSelected = useCallback((selectedMode: 'quick' | 'longterm') => {
    setMode(selectedMode)

    // 复用 ModeSelectionPage 经 api.project.create 建好的真实项目（读 store 拿最新值，避开闭包过期）；
    // 仅 demo / 无 Electron 时才造本地假项目。
    const existing = window.__jotai_store__?.get(currentProjectAtom) ?? null
    const newProject: Project =
      existing && !existing.project_id.startsWith('demo-')
        ? existing
        : {
            project_id: `demo-${Date.now()}`,
            workspace_slug: 'default-software-builder',
            name: selectedMode === 'quick' ? '我的快速项目' : '我的长期项目',
            mode: selectedMode,
            template_type: 'web_fullstack',
            status: 'active',
            current_stage: 'clarifying',
            root_path: '/demo',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }

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

    // 新项目开始：清掉上一项目的预览地址，避免串台
    setPreviewUrl(null)

    setRoute('workspace')
  }, [setProjectMode, setModeSelected, setWorkflowStage, setStageLabel, setActiveSessionId, setCurrentProject, setPreviewUrl])

  // ==================== 从历史列表恢复项目 ====================

  const handleResumeProject = useCallback((project: Project) => {
    setMode(project.mode)
    // 回访恢复：沿用项目最后活跃会话，不新建会话 id（sitemap §2.6）
    const resumeSessionId = project.last_session_id ?? `demo-resume-${Date.now()}`

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

    if (project.last_session_id) {
      setHistoryLoading(true)
      void Promise.all([
        loadAgentSessions(project.project_id),
        loadSessionHistory(project.last_session_id),
      ]).finally(() => setHistoryLoading(false))
    }

    setRoute('workspace')
  }, [setProjectMode, setModeSelected, setWorkflowStage, setStageLabel, setActiveSessionId, setCurrentProject])

  // ==================== "你帮我决定" — 跳过澄清 ====================

  const handleDecideForMe = useCallback(() => {
    const systemMsg: AgentMessage = {
      role: 'system',
      content: [{ type: 'text', text: '好的，我根据常见场景帮你决定方向，直接开始生成草图。' }],
      timestamp: Date.now(),
    }
    setMessages((prev: AgentMessage[]) => [...prev, systemMsg])

    setWaiting(true)
    setWaitStart(Date.now())
    setPreviewStatus('loading')
    setWorkflowStage('generating_sketch')
    setStageLabel(STAGE_LABEL_MAP.generating_sketch)

    // 模拟生成（1.8s 后响应）
    setTimeout(() => {
      setWaiting(false)
      setPreviewStatus('running')

      const assistantMsg: AgentMessage = {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '我根据常见使用场景为你生成了初始草图。你可以在左侧预览效果，如果有不满意的地方，点击预览区告诉我哪里需要调整。',
        }],
        timestamp: Date.now(),
      }
      setMessages((prev: AgentMessage[]) => [...prev, assistantMsg])

      setWorkflowStage('sketch_ready')
      setStageLabel(STAGE_LABEL_MAP.sketch_ready)

      setSnapshotsList([{
        snapshot_id: `snap-demo-${Date.now()}`,
        project_id: 'demo',
        kind: 'sketch',
        name: '初始草图 v1',
        summary: '根据默认假设自动生成',
        files_archive_path: '/demo/snapshots/sketch/files',
        health_status: 'healthy',
        created_at: new Date().toISOString(),
      }])
    }, 1800)
  }, [setMessages, setWorkflowStage, setStageLabel, setSnapshotsList])

  // ==================== 发送消息 ====================

  const handleSendMessage = useCallback((content: string) => {
    const api = window.electronAPI

    // 真实链路：交给主进程 runAgent，流式事件由 setupGlobalAgentListeners 驱动 UI
    if (api?.agent?.sendMessage) {
      appendMessageToSession(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: content }],
        timestamp: Date.now(),
      })
      void api.agent.sendMessage({
        request_id: crypto.randomUUID(),
        session_id: sessionId,
        project_id: currentProject?.project_id ?? projectList[0]?.project_id ?? 'demo',
        content,
        mode: mode ?? 'quick',
        current_stage: currentStage,
        metadata: { source: 'chat' },
      })
      return
    }

    // demo / 无主进程：保留原有模拟流（含 "你帮我决定" 快捷语）
    if (content.trim() === '你帮我决定' || content.trim() === '你帮我决定。') {
      handleDecideForMe()
      return
    }

    const userMsg: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: content }],
      timestamp: Date.now(),
    }
    setMessages((prev: AgentMessage[]) => [...prev, userMsg])

    setWaiting(true)
    setWaitStart(Date.now())
    setPreviewStatus('loading')
    setWorkflowStage('generating_sketch')
    setStageLabel(STAGE_LABEL_MAP.generating_sketch)

    setTimeout(() => {
      setWaiting(false)
      setPreviewStatus('running')

      const assistantMsg: AgentMessage = {
        role: 'assistant',
        content: [{
          type: 'text',
          text: `收到你的需求：「${content.slice(0, 50)}${content.length > 50 ? '…' : ''}」\n\n我已经理解了你的想法。这是一个演示模式——在实际环境中，向导 Agent 将澄清需求并生成可交互草图。`,
        }],
        timestamp: Date.now(),
      }
      setMessages((prev: AgentMessage[]) => [...prev, assistantMsg])

      setWorkflowStage('sketch_ready')
      setStageLabel(STAGE_LABEL_MAP.sketch_ready)

      setSnapshotsList([{
        snapshot_id: `snap-demo-${Date.now()}`,
        project_id: 'demo',
        kind: 'sketch',
        name: '验证草图 v1',
        summary: '演示快照：包含一个简单的预览页面',
        files_archive_path: '/demo/snapshots/sketch/files',
        health_status: 'healthy',
        created_at: new Date().toISOString(),
      }])
    }, 2000)
  }, [sessionId, currentProject, projectList, mode, currentStage, handleDecideForMe, setMessages, setWorkflowStage, setStageLabel, setSnapshotsList])

  // ==================== 卡片选项回传（Sprint 2：澄清卡片） ====================

  const handleCardOptionSelect = useCallback((option: CardOption) => {
    const api = window.electronAPI
    if (api?.agent?.sendMessage) {
      // 点击即有反馈：先本地追加用户气泡（与 handleSendMessage 一致），再回传后端
      appendMessageToSession(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: option.label }],
        timestamp: Date.now(),
      })
      // 真实链路：带 card_option metadata 回传（selected_option_id 对齐契约）
      void api.agent.sendMessage({
        request_id: crypto.randomUUID(),
        session_id: sessionId,
        project_id: currentProject?.project_id ?? projectList[0]?.project_id ?? 'demo',
        content: option.label,
        mode: mode ?? 'quick',
        current_stage: currentStage,
        metadata: toCardSelectionMeta(option.id),
      })
      return
    }
    // demo / 无主进程：回退本地消息流
    handleSendMessage(option.label)
  }, [sessionId, currentProject, projectList, mode, currentStage, handleSendMessage])

  // ==================== 点选纠错 ====================

  const handleCorrectionSubmit = useCallback((payload: { position: { x: number; y: number }; userNote: string; fallbackMode: boolean }) => {
    const api = window.electronAPI
    if (api?.project?.submitCorrection) {
      // 真实链路：记录点选纠错（后端 appendProjectEvent + analytics point_correction）
      appendMessageToSession(sessionId, {
        role: 'system',
        content: [{ type: 'text', text: `已收到你的修改意见${payload.userNote ? `：「${payload.userNote}」` : '（你猜模式）'}，我来帮你调整。` }],
        timestamp: Date.now(),
      })
      void api.project.submitCorrection({
        request_id: crypto.randomUUID(),
        project_id: currentProject?.project_id ?? projectList[0]?.project_id ?? 'demo',
        session_id: sessionId,
        context: {
          bounding_rect: { x: payload.position.x, y: payload.position.y, width: 0, height: 0 },
          fallback_mode: payload.fallbackMode,
        },
        user_note: payload.userNote || undefined,
        mode: payload.userNote ? 'user_note' : 'guess',
      })
      return
    }

    // demo / 无主进程：保留原有模拟
    const systemMsg: AgentMessage = {
      role: 'system',
      content: [{ type: 'text', text: `已收到你的修改意见${payload.userNote ? `：「${payload.userNote}」` : '（你猜模式）'}，我来帮你调整。` }],
      timestamp: Date.now(),
    }
    setMessages((prev: AgentMessage[]) => [...prev, systemMsg])

    setWorkflowStage('repairing')
    setStageLabel(STAGE_LABEL_MAP.repairing)
    setPreviewStatus('loading')

    setTimeout(() => {
      setPreviewStatus('running')
      setWorkflowStage('sketch_ready')
      setStageLabel(STAGE_LABEL_MAP.sketch_ready)

      const doneMsg: AgentMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: '改好了，你看看效果？不满意随时告诉我。' }],
        timestamp: Date.now(),
      }
      setMessages((prev: AgentMessage[]) => [...prev, doneMsg])
    }, 1500)
  }, [sessionId, currentProject, projectList, setMessages, setWorkflowStage, setStageLabel])

  // ==================== 快照回滚 ====================

  const handleRollback = useCallback((snapshot: Snapshot) => {
    const msg: AgentMessage = {
      role: 'system',
      content: [{ type: 'text', text: `已经回到「${snapshot.name}」了，一切都在。要继续的话随时告诉我。` }],
      timestamp: Date.now(),
    }
    setMessages((prev: AgentMessage[]) => [...prev, msg])
    setPreviewStatus('running')
  }, [setMessages])

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

  // ==================== 设置页入口 ====================

  const handleOpenSettings = useCallback(() => {
    setRoute('settings')
  }, [])

  // 预览地址：真实流（sketch_ready/mvp_ready 事件）优先；demo 才退回 SAMPLE_SKETCH
  const effectivePreviewUrl = streamPreviewUrl ?? (previewStatus === 'running' ? samplePreviewUrl : undefined)
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
      />
    )
  }

  if (route === 'settings') {
    return <ChannelSettingsPage onBack={() => setRoute('workspace')} />
  }

  // route === 'workspace'
  return (
    <WorkspaceShell
      cardOptions={decisionCards ?? undefined}
      onCardOptionSelect={handleCardOptionSelect}
      onSendMessage={handleSendMessage}
      isWaiting={waiting}
      waitStartTime={waitStart}
      waitActionLabel="生成可运行版本"
      isHistoryLoading={historyLoading}
      previewStatus={effectivePreviewStatus}
      previewUrl={effectivePreviewUrl}
      onRefreshPreview={() => {
        setPreviewStatus('loading')
        setTimeout(() => setPreviewStatus('running'), 1500)
      }}
      onCorrectionSubmit={handleCorrectionSubmit}
      onRollback={handleRollback}
      onContinueWaiting={handleContinueWaiting}
      onViewPartial={handleViewPartial}
      onOpenSettings={handleOpenSettings}
      onAllProjects={projectList.length > 0 ? () => {
        setRoute('project-history')
      } : undefined}
    />
  )
}

export default App
