import React, { useState, useCallback } from 'react'
import { useAtomValue } from 'jotai'
import { ModeSelectionPage } from './ModeSelectionPage'
import { WorkspaceShell } from './WorkspaceShell'
import type { PreviewStatus } from './PreviewPanel'
import type { Snapshot, AgentMessage } from './atoms'
import type { CardOption } from './CardOptions'
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
  agentStreamStateFamily,
  globalUserErrorAtom,
} from './atoms'
import type { AgentEvent, Project, ProjectMode } from './atoms'

/** Aurora 渐变网格背景（与 demo.html .aurora 一致） */
const Aurora: React.FC = () => (
  <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 0, overflow: 'hidden', pointerEvents: 'none' }}>
    <span style={{ position: 'absolute', borderRadius: '50%', filter: 'blur(80px)', opacity: 0.9, width: '46vw', height: '46vw', top: '-12%', left: '-8%', background: 'var(--aurora-violet)', animation: 'aurora-drift 18s ease-in-out infinite' }} />
    <span style={{ position: 'absolute', borderRadius: '50%', filter: 'blur(80px)', opacity: 0.9, width: '42vw', height: '42vw', bottom: '-14%', right: '-6%', background: 'var(--aurora-pink)', animation: 'aurora-drift 22s ease-in-out infinite reverse' }} />
    <span style={{ position: 'absolute', borderRadius: '50%', filter: 'blur(80px)', opacity: 0.9, width: '38vw', height: '38vw', top: '30%', right: '18%', background: 'var(--aurora-cyan)', animation: 'aurora-drift 26s ease-in-out infinite' }} />
  </div>
)

const App: React.FC = () => {
  return (
    <>
      <Aurora />
      <AppRoutes />
    </>
  )
}

const AppRoutes: React.FC = () => {
  const [route, setRoute] = useState<'mode-selection' | 'workspace'>('mode-selection')
  const [mode, setMode] = useState<ProjectMode | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [waitStart, setWaitStart] = useState<number | undefined>()
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>('empty')
  const [previewUrl, setPreviewUrl] = useState<string | undefined>()
  const [previewError, setPreviewError] = useState<string | undefined>()
  const [cardOptions, setCardOptions] = useState<CardOption[]>([])
  const [sessionId] = useState(() => `session-${Date.now()}`)
  const processedEventIdsRef = React.useRef<Set<string>>(new Set())
  const currentProject = useAtomValue(currentProjectAtom)
  const streamState = useAtomValue(agentStreamStateFamily(sessionId))

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
    const userMsg: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: content }],
      timestamp: Date.now(),
    }
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
    void handleSendMessage(option.description ? `${option.label}：${option.description}` : option.label)
  }, [handleSendMessage])

  if (route === 'mode-selection') {
    return <ModeSelectionPage onModeSelected={handleModeSelected} />
  }

  return (
    <WorkspaceShell
      cardOptions={cardOptions}
      onCardOptionSelect={handleCardOptionSelect}
      onSendMessage={handleSendMessage}
      isWaiting={waiting}
      waitStartTime={waitStart}
      waitActionLabel="生成可运行版本"
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
      }}
    />
  )
}

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

export default App
