import React, { useState, useCallback } from 'react'
import { Provider, createStore } from 'jotai'
import { ModeSelectionPage } from './ModeSelectionPage'
import { WorkspaceShell } from './WorkspaceShell'
import type { PreviewStatus } from './PreviewPanel'
import type { Snapshot, AgentMessage } from './atoms'
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
  hasActiveStreamAtom,
  agentStreamStateFamily,
} from './atoms'
import type { ProjectMode, WorkflowStage } from './atoms'

/**
 * 演示用示例草图（与 demo.html 中 SAMPLE_SKETCH 完全一致）。
 * 真实环境由编程 Agent 通过沙箱提供 preview_url，此处仅用于渲染进程演示。
 */
const SAMPLE_SKETCH = `<html><head><meta charset="UTF-8"><style>body{font-family:'Inter',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:linear-gradient(135deg,#F4F3FA,#FDF2F8);color:#1D1D1F}.app{text-align:center;padding:40px;max-width:440px;width:100%}h1{background:linear-gradient(135deg,#7C3AED,#EC4899);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:6px;font-size:22px;font-weight:700}.sub{color:#6E6E73;margin-bottom:28px;font-size:13px}.card{background:#fff;border:1px solid #E6E5EE;border-radius:16px;padding:18px 20px;margin:10px 0;text-align:left;box-shadow:0 4px 16px -4px rgba(29,29,31,.08)}.card h3{margin-bottom:2px;font-size:12px;color:#6E6E73;font-weight:500}.card .val{font-size:24px;font-weight:700;margin-top:4px}.income{color:#10B981}.expense{color:#DC2626}.balance{color:#7C3AED}</style></head><body><div class="app"><h1>记账应用 · 草图预览</h1><p class="sub">Sprint 1 演示 · 实际由编程Agent生成</p><div class="card"><h3>本月收入</h3><p class="val income">¥ 12,500</p></div><div class="card"><h3>本月支出</h3><p class="val expense">¥ 8,320</p></div><div class="card"><h3>本月结余</h3><p class="val balance">¥ 4,180</p></div></div></body></html>`

/** Aurora 渐变网格背景（与 demo.html .aurora 一致） */
const Aurora: React.FC = () => (
  <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 0, overflow: 'hidden', pointerEvents: 'none' }}>
    <span style={{ position: 'absolute', borderRadius: '50%', filter: 'blur(80px)', opacity: 0.9, width: '46vw', height: '46vw', top: '-12%', left: '-8%', background: 'var(--aurora-violet)', animation: 'aurora-drift 18s ease-in-out infinite' }} />
    <span style={{ position: 'absolute', borderRadius: '50%', filter: 'blur(80px)', opacity: 0.9, width: '42vw', height: '42vw', bottom: '-14%', right: '-6%', background: 'var(--aurora-pink)', animation: 'aurora-drift 22s ease-in-out infinite reverse' }} />
    <span style={{ position: 'absolute', borderRadius: '50%', filter: 'blur(80px)', opacity: 0.9, width: '38vw', height: '38vw', top: '30%', right: '18%', background: 'var(--aurora-cyan)', animation: 'aurora-drift 26s ease-in-out infinite' }} />
  </div>
)

const App: React.FC = () => {
  const storeRef = React.useRef(createStore())
  const store = storeRef.current

  return (
    <Provider store={store}>
      <Aurora />
      <AppRoutes />
    </Provider>
  )
}

const AppRoutes: React.FC = () => {
  const [route, setRoute] = useState<'mode-selection' | 'workspace'>('mode-selection')
  const [mode, setMode] = useState<ProjectMode | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [waitStart, setWaitStart] = useState<number | undefined>()
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>('empty')
  const [sessionId] = useState(() => `demo-${Date.now()}`)
  // 演示用：将示例草图转为 blob URL 注入预览，使 running 态与 demo.html 视觉一致
  const [samplePreviewUrl] = useState(() => {
    try {
      return URL.createObjectURL(new Blob([SAMPLE_SKETCH], { type: 'text/html' }))
    } catch {
      return undefined
    }
  })

  // 选择模式 → 进入工作区
  const handleModeSelected = useCallback((selectedMode: 'quick' | 'longterm') => {
    setMode(selectedMode)

    // 模拟：通过 store 更新 atoms
    const store = (window as any).__jotai_demo_store__
    if (store) {
      store.set(projectModeAtom, selectedMode)
      store.set(modeSelectedAtom, true)
      store.set(workflowStageAtom, 'clarifying')
      store.set(stageIndicatorLabelAtom, STAGE_LABEL_MAP.clarifying)
      store.set(activeAgentSessionIdAtom, sessionId)
      store.set(currentProjectAtom, {
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
      })
    }

    setRoute('workspace')
  }, [sessionId])

  // 发送消息 → 模拟 Agent 响应
  const handleSendMessage = useCallback((content: string) => {
    const store = (window as any).__jotai_demo_store__
    if (!store) return

    // 追加用户消息
    const msgsAtom = agentMessagesFamily(sessionId)
    const userMsg: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: content }],
      timestamp: Date.now(),
    }
    store.set(msgsAtom, (prev: AgentMessage[]) => [...prev, userMsg])

    // 模拟等待
    setWaiting(true)
    setWaitStart(Date.now())
    setPreviewStatus('loading')

    // 模拟：更新阶段
    store.set(workflowStageAtom, 'generating_sketch' as WorkflowStage)
    store.set(stageIndicatorLabelAtom, STAGE_LABEL_MAP.generating_sketch)

    // 2秒后模拟响应
    setTimeout(() => {
      setWaiting(false)
      setPreviewStatus('running')

      const assistantMsg: AgentMessage = {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `收到你的需求：「${content.slice(0, 50)}${content.length > 50 ? '…' : ''}」。\n\n我已经理解了你的想法。这是一个演示模式——在实际环境中，向导 Agent 将澄清需求并生成可交互草图。`,
          },
        ],
        timestamp: Date.now(),
      }
      store.set(msgsAtom, (prev: AgentMessage[]) => [...prev, assistantMsg])

      store.set(workflowStageAtom, 'sketch_ready' as WorkflowStage)
      store.set(stageIndicatorLabelAtom, STAGE_LABEL_MAP.sketch_ready)

      // 创建演示快照
      store.set(snapshotsListAtom, [
        {
          snapshot_id: `snap-demo-${Date.now()}`,
          project_id: 'demo',
          kind: 'sketch',
          name: '验证草图 v1',
          summary: '演示快照：包含一个简单的预览页面',
          files_archive_path: '/demo/snapshots/sketch/files',
          health_status: 'healthy',
          created_at: new Date().toISOString(),
        },
      ])
    }, 2000)
  }, [sessionId])

  if (route === 'mode-selection') {
    return <ModeSelectionPage onModeSelected={handleModeSelected} />
  }

  return (
    <WorkspaceShell
      onSendMessage={handleSendMessage}
      isWaiting={waiting}
      waitStartTime={waitStart}
      waitActionLabel="生成可运行版本"
      previewStatus={previewStatus}
      previewUrl={previewStatus === 'running' ? samplePreviewUrl : undefined}
      onRefreshPreview={() => {
        setPreviewStatus('loading')
        setTimeout(() => setPreviewStatus('running'), 1500)
      }}
      onAllProjects={() => {
        setRoute('mode-selection')
      }}
    />
  )
}

export default App
