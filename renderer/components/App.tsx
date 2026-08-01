import React, { useState, useCallback } from 'react'
<<<<<<< HEAD
import { useSetAtom } from 'jotai'
import { ModeSelectionPage } from './ModeSelectionPage'
import { WorkspaceShell } from './WorkspaceShell'
import { ProjectHistoryPage } from './ProjectHistoryPage'
import type { PreviewStatus } from './PreviewPanel'
import type { Snapshot, AgentMessage, Project } from './atoms'
=======
import { useAtomValue } from 'jotai'
import { ModeSelectionPage } from './ModeSelectionPage'
import { WorkspaceShell } from './WorkspaceShell'
import type { PreviewStatus } from './PreviewPanel'
import type { Snapshot, AgentMessage } from './atoms'
import type { CardOption } from './CardOptions'
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
import {
  modeSelectedAtom,
  projectModeAtom,
  workflowStageAtom,
  stageIndicatorLabelAtom,
  STAGE_LABEL_MAP,
  currentProjectAtom,
  agentMessagesFamily,
  activeAgentSessionIdAtom,
  snapshotsListAtom,
<<<<<<< HEAD
} from './atoms'
import type { ProjectMode, WorkflowStage } from './atoms'

/**
 * 演示用示例草图（与 demo.html 中 SAMPLE_SKETCH 完全一致）。
 */
const SAMPLE_SKETCH = `<html><head><meta charset="UTF-8"><style>body{font-family:'Inter',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:linear-gradient(135deg,#F4F3FA,#FDF2F8);color:#1D1D1F}.app{text-align:center;padding:40px;max-width:440px;width:100%}h1{background:linear-gradient(135deg,#7C3AED,#EC4899);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:6px;font-size:22px;font-weight:700}.sub{color:#6E6E73;margin-bottom:28px;font-size:13px}.card{background:#fff;border:1px solid #E6E5EE;border-radius:16px;padding:18px 20px;margin:10px 0;text-align:left;box-shadow:0 4px 16px -4px rgba(29,29,31,.08)}.card h3{margin-bottom:2px;font-size:12px;color:#6E6E73;font-weight:500}.card .val{font-size:24px;font-weight:700;margin-top:4px}.income{color:#10B981}.expense{color:#DC2626}.balance{color:#7C3AED}</style></head><body><div class="app"><h1>记账应用 · 草图预览</h1><p class="sub">Sprint 1 演示 · 实际由编程Agent生成</p><div class="card"><h3>本月收入</h3><p class="val income">¥ 12,500</p></div><div class="card"><h3>本月支出</h3><p class="val expense">¥ 8,320</p></div><div class="card"><h3>本月结余</h3><p class="val balance">¥ 4,180</p></div></div></body></html>`

/* =========================================================================
   Aurora 背景
   ========================================================================= */

=======
  agentStreamStateFamily,
  globalUserErrorAtom,
} from './atoms'
import type { AgentEvent, Project, ProjectMode } from './atoms'

/** Aurora 渐变网格背景（与 demo.html .aurora 一致） */
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
const Aurora: React.FC = () => (
  <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 0, overflow: 'hidden', pointerEvents: 'none' }}>
    <span style={{ position: 'absolute', borderRadius: '50%', filter: 'blur(80px)', opacity: 0.9, width: '46vw', height: '46vw', top: '-12%', left: '-8%', background: 'var(--aurora-violet)', animation: 'aurora-drift 18s ease-in-out infinite' }} />
    <span style={{ position: 'absolute', borderRadius: '50%', filter: 'blur(80px)', opacity: 0.9, width: '42vw', height: '42vw', bottom: '-14%', right: '-6%', background: 'var(--aurora-pink)', animation: 'aurora-drift 22s ease-in-out infinite reverse' }} />
    <span style={{ position: 'absolute', borderRadius: '50%', filter: 'blur(80px)', opacity: 0.9, width: '38vw', height: '38vw', top: '30%', right: '18%', background: 'var(--aurora-cyan)', animation: 'aurora-drift 26s ease-in-out infinite' }} />
  </div>
)

<<<<<<< HEAD
/* =========================================================================
   App 根组件
   ========================================================================= */

=======
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
const App: React.FC = () => {
  return (
    <>
      <Aurora />
      <AppRoutes />
    </>
  )
}

<<<<<<< HEAD
/* =========================================================================
   AppRoutes — 路由 + 业务逻辑
   通过 Jotai hooks 直接操作 store，不依赖全局变量
   ========================================================================= */

type AppRoute = 'mode-selection' | 'workspace' | 'project-history'

const AppRoutes: React.FC = () => {
  const [route, setRoute] = useState<AppRoute>('mode-selection')
=======
const AppRoutes: React.FC = () => {
  const [route, setRoute] = useState<'mode-selection' | 'workspace'>('mode-selection')
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
  const [mode, setMode] = useState<ProjectMode | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [waitStart, setWaitStart] = useState<number | undefined>()
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>('empty')
<<<<<<< HEAD
  const [sessionId] = useState(() => `demo-${Date.now()}`)
  const [samplePreviewUrl] = useState(() => {
    try { return URL.createObjectURL(new Blob([SAMPLE_SKETCH], { type: 'text/html' })) }
    catch { return undefined }
  })

  // 本地项目列表（演示模式）
  const [projectList, setProjectList] = useState<Project[]>([])

  // ✅ 使用 Jotai hooks 直接读写 — 不依赖 window.__jotai_demo_store__
  const setProjectMode = useSetAtom(projectModeAtom)
  const setModeSelected = useSetAtom(modeSelectedAtom)
  const setWorkflowStage = useSetAtom(workflowStageAtom)
  const setStageLabel = useSetAtom(stageIndicatorLabelAtom)
  const setActiveSessionId = useSetAtom(activeAgentSessionIdAtom)
  const setCurrentProject = useSetAtom(currentProjectAtom)
  const setSnapshotsList = useSetAtom(snapshotsListAtom)
  const setMessages = useSetAtom(agentMessagesFamily(sessionId))

  // ==================== 选择模式 → 创建工作区 ====================

  const handleModeSelected = useCallback((selectedMode: 'quick' | 'longterm') => {
    setMode(selectedMode)

    const newProject: Project = {
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

    setProjectList((prev: Project[]) => [newProject, ...prev])

    // ✅ 直接通过 hooks 设置 atom
    setProjectMode(selectedMode)
    setModeSelected(true)
    setWorkflowStage('clarifying')
    setStageLabel(STAGE_LABEL_MAP.clarifying)
    setActiveSessionId(sessionId)
    setCurrentProject(newProject)

    // D3 修复：进入工作区后 Agent 发送首条问候消息
    const greetingMsg: AgentMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: '你好！告诉我你想做什么软件，我会一步步帮你做出来。' }],
      timestamp: Date.now(),
    }
    setMessages([greetingMsg])

    setRoute('workspace')
  }, [sessionId, setProjectMode, setModeSelected, setWorkflowStage, setStageLabel, setActiveSessionId, setCurrentProject])

  // ==================== 从历史列表恢复项目 ====================

  const handleResumeProject = useCallback((project: Project) => {
    setMode(project.mode)
    const resumeSessionId = `demo-resume-${Date.now()}`

    setProjectMode(project.mode)
    setModeSelected(true)
    setWorkflowStage(project.current_stage)
    setStageLabel(STAGE_LABEL_MAP[project.current_stage] ?? project.current_stage)
    setActiveSessionId(resumeSessionId)
    setCurrentProject(project)

    setProjectList((prev: Project[]) =>
      prev.map((p) =>
        p.project_id === project.project_id
          ? { ...p, updated_at: new Date().toISOString() }
          : p,
      ),
    )

    setRoute('workspace')
  }, [setProjectMode, setModeSelected, setWorkflowStage, setStageLabel, setActiveSessionId, setCurrentProject])

  // ==================== "你帮我决定" — 跳过澄清（偏离 2.1 修复） ====================

  const handleDecideForMe = useCallback(() => {
    // 系统消息
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
    // 偏离 2.1：检测"你帮我决定"→ 跳过澄清
    if (content.trim() === '你帮我决定' || content.trim() === '你帮我决定。') {
      handleDecideForMe()
      return
    }

    // 用户消息
=======
  const [previewUrl, setPreviewUrl] = useState<string | undefined>()
  const [previewError, setPreviewError] = useState<string | undefined>()
  const [cardOptions, setCardOptions] = useState<CardOption[]>([])
  const [sessionId] = useState(() => `session-${Date.now()}`)
  const processedEventIdsRef = React.useRef<Set<string>>(new Set())
  const restoreAttemptedRef = React.useRef(false)
  const currentProject = useAtomValue(currentProjectAtom)
  const streamState = useAtomValue(agentStreamStateFamily(sessionId))

  // 启动恢复：若本地存在活动项目，直接进入工作区而不是显示两道门
  React.useEffect(() => {
    if (restoreAttemptedRef.current) return
    restoreAttemptedRef.current = true
    const api = window.electronAPI
    const store = window.__jotai_store__
    if (!api || !store) return
    if (typeof api.project.list !== 'function') return
    void api.project.list({ request_id: crypto.randomUUID() }).then((result) => {
      if (!result?.ok || result.data.length === 0) return
      const restored = result.data[0]
      if (!restored) return
      store.set(currentProjectAtom, restored)
      store.set(projectModeAtom, restored.mode)
      store.set(modeSelectedAtom, true)
      store.set(workflowStageAtom, restored.current_stage)
      store.set(stageIndicatorLabelAtom, STAGE_LABEL_MAP[restored.current_stage] ?? '处理中')
      store.set(activeAgentSessionIdAtom, sessionId)
      setMode(restored.mode)
      setRoute('workspace')
    })
  }, [sessionId])

  // 选择模式 → 进入工作区
  const handleModeSelected = useCallback((selectedMode: 'quick' | 'longterm') => {
    setMode(selectedMode)

    const store = window.__jotai_store__
    if (store) {
      store.set(projectModeAtom, selectedMode)
      store.set(modeSelectedAtom, true)
      store.set(workflowStageAtom, 'clarifying')
      store.set(stageIndicatorLabelAtom, STAGE_LABEL_MAP.clarifying)
      store.set(activeAgentSessionIdAtom, sessionId)
    }

    setCardOptions([])
    setPreviewUrl(undefined)
    setPreviewError(undefined)
    setPreviewStatus('empty')
    setRoute('workspace')
  }, [sessionId])

  React.useEffect(() => {
    const store = window.__jotai_store__
    if (!store) return
    for (const event of streamState.events) {
      if (processedEventIdsRef.current.has(event.event_id)) continue
      processedEventIdsRef.current.add(event.event_id)
      handleAgentEvent(event, sessionId, {
        setWaiting,
        setPreviewStatus,
        setPreviewUrl,
        setPreviewError,
        setCardOptions,
      })
    }
  }, [sessionId, streamState.events])

  const handleSendMessage = useCallback(async (content: string) => {
    const store = window.__jotai_store__
    if (!store || !mode) {
      setPreviewStatus('error')
      setPreviewError('请先选择一种开始方式。')
      return
    }
    const api = window.electronAPI
    if (!api) {
      setPreviewStatus('error')
      setPreviewError('当前环境无法连接桌面应用能力。')
      return
    }

    let project: Project | null = currentProject
    if (!project) {
      const created = await api.project.create({
        request_id: crypto.randomUUID(),
        mode,
        initial_message: content,
      })
      if (!created.ok) {
        setPreviewStatus('error')
        setPreviewError(created.error.user_visible_message ?? '项目没有创建成功，请再试一次。')
        return
      }
      project = created.data
      store.set(currentProjectAtom, project)
    }

    const msgsAtom = agentMessagesFamily(sessionId)
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
    const userMsg: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: content }],
      timestamp: Date.now(),
    }
<<<<<<< HEAD
    setMessages((prev: AgentMessage[]) => [...prev, userMsg])

    setWaiting(true)
    setWaitStart(Date.now())
    setPreviewStatus('loading')
    setWorkflowStage('generating_sketch')
    setStageLabel(STAGE_LABEL_MAP.generating_sketch)

    // 模拟 Agent 响应（2s 后）
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
  }, [handleDecideForMe, setMessages, setWorkflowStage, setStageLabel, setSnapshotsList])

  // ==================== 点选纠错 ====================

  const handleCorrectionSubmit = useCallback((payload: { position: { x: number; y: number }; userNote: string; fallbackMode: boolean }) => {
    // 系统消息：告知用户收到了纠错反馈
    const systemMsg: AgentMessage = {
      role: 'system',
      content: [{ type: 'text', text: `已收到你的修改意见${payload.userNote ? `：「${payload.userNote}」` : '（你猜模式）'}，我来帮你调整。` }],
      timestamp: Date.now(),
    }
    setMessages((prev: AgentMessage[]) => [...prev, systemMsg])

    setWorkflowStage('repairing')
    setStageLabel(STAGE_LABEL_MAP.repairing)
    setPreviewStatus('loading')

    // 模拟修复（1.5s 后重新展示预览）
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
  }, [setMessages, setWorkflowStage, setStageLabel])

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

  // route === 'workspace'
  return (
    <WorkspaceShell
=======
    store.set(msgsAtom, (prev: AgentMessage[]) => [...prev, userMsg])
    setCardOptions([])
    setPreviewError(undefined)
    setWaiting(true)
    setWaitStart(Date.now())
    setPreviewStatus('loading')

    const result = await api.agent.sendMessage({
      request_id: crypto.randomUUID(),
      session_id: sessionId,
      project_id: project.project_id,
      content,
      mode,
      current_stage: project.current_stage,
      metadata: { source: 'chat' },
    })

    if (!result.ok) {
      console.error('agent:send-message failed', result.error)
      setWaiting(false)
      setPreviewStatus('error')
      setPreviewError(result.error.user_visible_message ?? '刚才处理时遇到问题，我会换个方式继续。')
      store.set(globalUserErrorAtom, result.error.user_visible_message ?? '刚才处理时遇到问题，我会换个方式继续。')
    }
  }, [currentProject, mode, sessionId])

  const handleCardOptionSelect = useCallback((option: CardOption) => {
    void handleSendMessage(option.label)
  }, [handleSendMessage])

  if (route === 'mode-selection') {
    return <ModeSelectionPage onModeSelected={handleModeSelected} />
  }

  return (
    <WorkspaceShell
      cardOptions={cardOptions}
      onCardOptionSelect={handleCardOptionSelect}
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
      onSendMessage={handleSendMessage}
      isWaiting={waiting}
      waitStartTime={waitStart}
      waitActionLabel="生成可运行版本"
<<<<<<< HEAD
      previewStatus={previewStatus}
      previewUrl={previewStatus === 'running' ? samplePreviewUrl : undefined}
      onRefreshPreview={() => {
        setPreviewStatus('loading')
        setTimeout(() => setPreviewStatus('running'), 1500)
      }}
      // 点选纠错回调
      onCorrectionSubmit={handleCorrectionSubmit}
      onRollback={handleRollback}
      // "所有项目" → project_history（偏离 1.2 修复）
      onAllProjects={() => {
        setRoute('project-history')
=======
      onContinueWaiting={() => {
        setWaiting(true)
        setPreviewStatus('loading')
      }}
      onViewPartial={() => {
        setWaiting(false)
        setPreviewStatus(currentProject ? 'running' : 'empty')
      }}
      previewStatus={previewStatus}
      previewUrl={previewStatus === 'running' ? previewUrl : undefined}
      previewErrorLabel={previewError}
      onRefreshPreview={() => {
        if (!currentProject) return
        setPreviewStatus('loading')
        void window.electronAPI?.sandbox.run({
          request_id: crypto.randomUUID(),
          project_id: currentProject.project_id,
        }).then((result) => {
          if (result?.ok && result.data.status === 'running') {
            setPreviewUrl(result.data.preview_url)
            setPreviewStatus('running')
            return
          }
          setPreviewStatus('error')
          if (result && !result.ok) console.error('sandbox:run failed', result.error)
          setPreviewError(result?.ok ? result.data.error_summary?.user_visible_summary : result?.error.user_visible_message)
        })
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
      }}
    />
  )
}

<<<<<<< HEAD
=======
interface AgentEventHandlers {
  setWaiting: React.Dispatch<React.SetStateAction<boolean>>
  setPreviewStatus: React.Dispatch<React.SetStateAction<PreviewStatus>>
  setPreviewUrl: React.Dispatch<React.SetStateAction<string | undefined>>
  setPreviewError: React.Dispatch<React.SetStateAction<string | undefined>>
  setCardOptions: React.Dispatch<React.SetStateAction<CardOption[]>>
}

function handleAgentEvent(event: AgentEvent, sessionId: string, handlers: AgentEventHandlers): void {
  const store = window.__jotai_store__
  if (!store || event.session_id !== sessionId) return

  if (event.type === 'message_delta' && typeof event.payload.text === 'string') {
    const text = event.payload.text
    store.set(agentMessagesFamily(sessionId), (prev: AgentMessage[]) => [
      ...prev,
      { role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now() },
    ])
  }

  if (event.type === 'stage_changed' && event.payload.stage === 'generating_sketch') {
    handlers.setPreviewStatus('loading')
  }

  if (event.type === 'user_decision_required') {
    const options = Array.isArray(event.payload.options)
      ? event.payload.options.filter(isCardOption).slice(0, 4)
      : []
    handlers.setWaiting(false)
    handlers.setPreviewStatus((current) => (current === 'loading' ? 'empty' : current))
    handlers.setCardOptions(options)
  }

  if (event.type === 'sketch_ready') {
    const previewUrl = typeof event.payload.preview_url === 'string' ? event.payload.preview_url : undefined
    const snapshotId = typeof event.payload.snapshot_id === 'string' ? event.payload.snapshot_id : `snap-${Date.now()}`
    const summary = typeof event.payload.summary === 'string' ? event.payload.summary : '验证草图已生成'
    handlers.setWaiting(false)
    handlers.setCardOptions([])
    handlers.setPreviewError(undefined)
    handlers.setPreviewUrl(previewUrl)
    handlers.setPreviewStatus(previewUrl ? 'running' : 'error')
    store.set(snapshotsListAtom, (prev: Snapshot[]) => [
      {
        snapshot_id: snapshotId,
        project_id: event.project_id ?? 'unknown',
        kind: 'sketch',
        name: `验证草图 ${prev.length + 1}`,
        summary,
        files_archive_path: '',
        health_status: 'healthy',
        created_at: event.created_at,
      },
      ...prev,
    ])
  }

  if (event.type === 'error') {
    handlers.setWaiting(false)
    handlers.setPreviewStatus('error')
    handlers.setPreviewError(
      typeof event.payload.message === 'string'
        ? event.payload.message
        : '刚才处理时遇到问题，我会换个方式继续。',
    )
  }

  if (event.type === 'completed') {
    handlers.setWaiting(false)
  }
}

function isCardOption(value: unknown): value is CardOption {
  if (!value || typeof value !== 'object') return false
  const option = value as Partial<CardOption>
  return typeof option.id === 'string' && typeof option.label === 'string'
}

>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
export default App
