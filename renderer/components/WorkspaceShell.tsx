/** web 线拆除刀3：点选纠错通道退役，类型本地最小化（UI 降级红点模式） */
type DomCollectContextResult = { fallback_mode: boolean; element_selector?: string; text_content?: string; bounding_rect?: { x: number; y: number; width: number; height: number } }
import React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { WorkspaceHeader, WorkspaceConnection } from './WorkspaceHeader'
import { ChatPanel } from './ChatPanel'
import { DesktopArtifactStrip } from './DesktopArtifactStrip'
import { DeliveryPanel } from './DeliveryPanel'
import type { AgentMessage } from './atoms'
import { PreviewPanel } from './PreviewPanel'
import { TimelinePanel } from './TimelinePanel'
import { MvpStatusBanner } from './MvpStatusBanner'
import { DocumentPanel } from './DocumentPanel'
import { CollaborationPanel } from './CollaborationPanel'
import { HistoryAttachments } from './HistoryAttachments'
import { DesktopStageBar } from './DesktopStageBar'
import { currentProjectAtom, desktopPhaseAtom, workflowStageAtom, documentPanelExpandedAtom, collaborationPanelExpandedAtom, timelineExpandedAtom } from './atoms'
import { desktopArtifactsAtom } from '../agent-atoms'
import { workspaceScene } from '../lib/workspace-scene'
import '../styles/theatre.css'
import { FileText, Layers, History, Users } from './icons'
import type { CardOption } from './CardOptions'
import type { PreviewStatus } from './PreviewPanel'
import type { Snapshot, PastedImageRef } from './atoms'

export interface WorkspaceShellProps {
  /* === ChatPanel props === */
  cardOptions?: CardOption[]
  /** 决策卡标题（U7：让渡偏差描述 / 澄清方向等） */
  decisionTitle?: string
  /** 决策卡正文（2026-08-29：审查卡的具体问题清单） */
  decisionBody?: string
  onCardOptionSelect?: (option: CardOption) => void
  onSendMessage?: (content: string, images?: PastedImageRef[]) => void
  waitStartTime?: number
  waitActionLabel?: string
  onContinueWaiting?: () => void
  /** 回访恢复时是否正在加载历史消息（对话区显示骨架占位） */
  isHistoryLoading?: boolean
  /** 停止当前生成（U4：Agent 流式生成中点击停止） */
  onStopGeneration?: () => void
  /** P0-2 fork（2026-09-08）：user 消息「从这里重新来」回调 */
  onForkFromMessage?: (message: AgentMessage) => void

  /** 桌面项目交付面板（2026-10-04 呈现层收口）：true 时右栏渲染 DeliveryPanel 替代空沙箱 */
  deliveryPanel?: boolean
  /* === PreviewPanel props === */
  previewStatus?: PreviewStatus
  previewUrl?: string
  previewErrorLabel?: string
  onRefreshPreview?: () => void
  onToggleFullscreen?: () => void
  onScreenshot?: () => void
  onCorrectionSubmit?: (payload: { position: { x: number; y: number }; userNote: string; fallbackMode: boolean; domContext?: DomCollectContextResult }) => void
  /** 点击预览元素时向主进程收集 DOM 上下文（高亮被选区域，R-CORR-01） */
  onCollectDomContext?: (click: { x: number; y: number }) => Promise<DomCollectContextResult | undefined>
  /** 确认草图 → 生成完整功能（问题 A / P0-1） */
  onConfirmSketch?: () => void
  confirming?: boolean
  /** iframe 加载失败（沙箱端口失效）时回调 */
  onPreviewError?: () => void
  /** U6：ready 阶段「标记为完成」回调 */
  onMarkComplete?: () => void

  /* === TimelinePanel props === */
  onRollback?: (snapshot: Snapshot) => void

  /* === Header props === */
  onAllProjects?: () => void
  /** 打开设置页回调 */
  onOpenSettings?: () => void
  /** 点击「升级为长期模式」回调（U1：升级接线） */
  onUpgrade?: () => void
}

/**
 * 工作区 Shell — Bento Glass 架构
 *
 * 布局:
 * ┌──────────────────────────────────────────┐
 * │  WorkspaceHeader (顶栏)                   │
 * ├──────────────────┬───────────────────────┤
 * │  ChatPanel       │  PreviewPanel          │
 * │  (对话, 左 1fr)   │  (预览, 右 2fr)        │
 * ├──────────────────┴───────────────────────┤
 * │  TimelinePanel (底部时间轴)                │
 * └──────────────────────────────────────────┘
 * 全部浮在 aurora 渐变网格背景上。
 */
export const WorkspaceShell: React.FC<WorkspaceShellProps> = (props) => {
  const project = useAtomValue(currentProjectAtom)
  const stage = useAtomValue(workflowStageAtom)
  const phase = useAtomValue(desktopPhaseAtom)
  const artifacts = useAtomValue(desktopArtifactsAtom)
  const [documents, setDocuments] = useAtom(documentPanelExpandedAtom)
  const [collaboration, setCollaboration] = useAtom(collaborationPanelExpandedAtom)
  const [, setTimelineExpanded] = useAtom(timelineExpandedAtom)
  const [localPanel, setLocalPanel] = React.useState<'versions' | 'materials' | null>(null)
  React.useEffect(() => { setDocuments(false); setCollaboration(false); setLocalPanel(null) }, [project?.project_id])
  const scene = workspaceScene(project, stage, phase ?? project?.desktop_phase ?? null, Boolean(props.previewUrl && props.onConfirmSketch && !props.deliveryPanel))
  const openTool = (name: 'documents' | 'collaboration' | 'versions' | 'materials') => {
    setDocuments(name === 'documents' ? !documents : false)
    setCollaboration(name === 'collaboration' ? !collaboration : false)
    setLocalPanel(name === 'versions' || name === 'materials' ? localPanel === name ? null : name : null)
    if (name === 'versions') setTimelineExpanded(true)
  }
  return (
    <div className="workspace-theatre" data-ai-id="workspace-theatre" data-mode={project?.mode ?? 'quick'}>
      {/* 顶栏 */}
      <WorkspaceHeader
        showConnection={false}
        onAllProjects={props.onAllProjects}
        onOpenSettings={props.onOpenSettings}
        onUpgrade={props.onUpgrade}
      />

      {/* 桌面线产物预览条（刀3 呈现层最小版）：桌面线激活且有产物时显示（阶段条下方窄带） */}
      <nav className="theatre-journey" aria-label="软件制作进度">
        {['想法', '需求', '界面', '制作', '试用与交付'].map((label, index) => <span key={label} aria-current={scene.chapter === index ? 'step' : undefined} data-current={scene.chapter === index}><span className="theatre-step-number">{index + 1}</span>{label}</span>)}
      </nav>
      <main className="theatre-stage">
        <div className="theatre-stage-heading"><div><p className="theatre-eyebrow">你的一句话，正在成形</p><h2>{scene.title}</h2><p>{scene.description}</p></div>{(phase || project?.desktop_phase) && <details className="theatre-phase-details"><summary>制作详情</summary><DesktopStageBar /></details>}</div>
        <div className="theatre-main" data-panel-open={documents || collaboration || Boolean(localPanel)}>
          <section className="theatre-product" aria-label="软件与当前结果">
        {props.deliveryPanel
          ? <DeliveryPanel embedded />
          : <PreviewPanel embedded
          status={props.previewStatus}
          previewUrl={props.previewUrl}
          errorLabel={props.previewErrorLabel}
          onRefresh={props.onRefreshPreview}
          onToggleFullscreen={props.onToggleFullscreen}
          onScreenshot={props.onScreenshot}
          onCorrectionSubmit={props.onCorrectionSubmit}
          onCollectDomContext={props.onCollectDomContext}
          onConfirmSketch={props.onConfirmSketch}
          confirming={props.confirming}
          onPreviewError={props.onPreviewError}
          onMarkComplete={props.onMarkComplete}
          />}
          </section>
          {(documents || collaboration || localPanel) && <aside className="theatre-sidepanel">
            <DocumentPanel embedded />
            <CollaborationPanel embedded />
            {localPanel && <><div className="theatre-panel-heading"><h3>{localPanel === 'versions' ? '一路变成现在' : '参考材料'}</h3><button type="button" className="theatre-tool" aria-label="关闭项目工具" onClick={() => setLocalPanel(null)}>关闭</button></div>{localPanel === 'versions' ? <TimelinePanel onRollback={props.onRollback} /> : <HistoryAttachments onClose={() => setLocalPanel(null)} />}</>}
          </aside>}
        </div>
        {artifacts.projectId === project?.project_id && artifacts.items.length > 0 && <details className="theatre-artifact-details"><summary>制作记录与截图 · {artifacts.items.length}</summary><DesktopArtifactStrip /></details>}
        <MvpStatusBanner />
      </main>
      <section className="theatre-conversation" aria-label="向导与下一步">
        <ChatPanel presentation="theatre"
          cardOptions={props.cardOptions}
          decisionTitle={props.decisionTitle}
          decisionBody={props.decisionBody}
          onCardOptionSelect={props.onCardOptionSelect}
          onSendMessage={props.onSendMessage}
          waitStartTime={props.waitStartTime}
          waitActionLabel={props.waitActionLabel}
          onContinueWaiting={props.onContinueWaiting}
          isHistoryLoading={props.isHistoryLoading}
          onStopGeneration={props.onStopGeneration}
          onOpenSettings={props.onOpenSettings}
          onForkFromMessage={props.onForkFromMessage}
        />
        <nav className="theatre-tools" aria-label="项目资料"><button type="button" className="theatre-tool" data-ai-id="docs-button" aria-pressed={documents} onClick={() => openTool('documents')}><FileText />文档</button><button type="button" className="theatre-tool" data-ai-id="materials-button" aria-pressed={localPanel === 'materials'} onClick={() => openTool('materials')}><Layers />材料</button><button type="button" className="theatre-tool" data-ai-id="versions-button" aria-pressed={localPanel === 'versions'} onClick={() => openTool('versions')}><History />版本</button><button type="button" className="theatre-tool" data-ai-id="collaboration-button" aria-pressed={collaboration} onClick={() => openTool('collaboration')}><Users />协作</button><WorkspaceConnection /></nav>
      </section>
    </div>
  )
}
