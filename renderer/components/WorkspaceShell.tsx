/** web 线拆除刀3：点选纠错通道退役，类型本地最小化（UI 降级红点模式） */
type DomCollectContextResult = { fallback_mode: boolean; element_selector?: string; text_content?: string; bounding_rect?: { x: number; y: number; width: number; height: number } }
import React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { WorkspaceHeader, WorkspaceConnection } from './WorkspaceHeader'
import { ChatPanel } from './ChatPanel'
import { ScopeConfirmationPanel } from './ScopeConfirmationPanel'
import type { LeanScopeView } from '../../shared/types'
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
import { StudioFumoNote } from './StudioCompanion'
import { SketchCharacterReminder } from './SketchCharacterReminder'
import { currentProjectAtom, desktopPhaseAtom, workflowStageAtom, documentPanelExpandedAtom, collaborationPanelExpandedAtom, timelineExpandedAtom, activeAgentSessionIdAtom, agentMessagesFamily, hasActiveStreamAtom } from './atoms'
import { desktopArtifactsAtom, requirementConfirmFamily, nullRequirementConfirmFallback, prdConfirmFamily, nullPrdConfirmFallback, enrichmentClarificationFamily, nullEnrichmentClarificationFallback } from '../agent-atoms'
import { workspaceScene } from '../lib/workspace-scene'
import { useConversationWidth } from '../hooks/use-conversation-width'
import '../styles/theatre.css'
import { FileText, Layers, History, Users, LayoutTemplate, Check, Hammer, Play, Activity, Maximize2, Minimize2, X } from './icons'
import type { CardOption } from './CardOptions'
import type { PreviewStatus } from './PreviewPanel'
import type { Snapshot, PastedImageRef } from './atoms'

export interface WorkspaceShellProps {
  decisionKind?: string
  decisionScope?: LeanScopeView
  notice?: string
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
  onForkFromMessage?: (message: AgentMessage) => void | Promise<void>

  /** 桌面项目交付面板（2026-10-04 呈现层收口）：true 时右栏渲染 DeliveryPanel 替代空沙箱 */
  deliveryPanel?: boolean
  /* === PreviewPanel props === */
  previewStatus?: PreviewStatus
  previewUrl?: string
  reviewUrl?: string
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
  onHome?: () => void
  /** 打开设置页回调 */
  onOpenSettings?: () => void
  /** 点击「升级为长期模式」回调（U1：升级接线） */
  onUpgrade?: () => void
}

/**
 * 通透画室：项目/阶段/资料在窄边栏，独立画布为主，简短交流在下方。
 * 历史与技术记录按需打开；资料覆盖画布边缘，不把草图再挤成窄栏。
 */
export const WorkspaceShell: React.FC<WorkspaceShellProps> = (props) => {
  const project = useAtomValue(currentProjectAtom)
  const stage = useAtomValue(workflowStageAtom)
  const phase = useAtomValue(desktopPhaseAtom)
  const artifacts = useAtomValue(desktopArtifactsAtom)
  const [documents, setDocuments] = useAtom(documentPanelExpandedAtom)
  const [collaboration, setCollaboration] = useAtom(collaborationPanelExpandedAtom)
  const [, setTimelineExpanded] = useAtom(timelineExpandedAtom)
  const [localPanel, setLocalPanel] = React.useState<'versions' | 'materials' | 'records' | null>(null)
  const [focused, setFocused] = React.useState(false)
  const [mobileView, setMobileView] = React.useState<'conversation' | 'preview'>('conversation')
  const conversation = useConversationWidth()
  const busy = useAtomValue(hasActiveStreamAtom)
  const scopePending = props.decisionKind === 'lean_scope' && Boolean(props.cardOptions?.length && props.onCardOptionSelect)
  const activeSession = useAtomValue(activeAgentSessionIdAtom)
  const requirementDialog = useAtomValue(activeSession ? requirementConfirmFamily(activeSession) : nullRequirementConfirmFallback)
  const prdDialog = useAtomValue(activeSession ? prdConfirmFamily(activeSession) : nullPrdConfirmFallback)
  const clarificationDialog = useAtomValue(activeSession ? enrichmentClarificationFamily(activeSession) : nullEnrichmentClarificationFallback)
  const canConfirmSketch = Boolean(props.previewUrl && !props.deliveryPanel && props.onConfirmSketch && (stage === 'sketch_ready' || props.cardOptions?.some(option => option.id === 'ux_confirm_go')))
  const sketchCue = `${project?.project_id ?? ''}:${props.previewUrl ?? ''}`
  React.useEffect(() => { setDocuments(false); setCollaboration(false); setLocalPanel(null) }, [project?.project_id])
  const scene = scopePending ? { chapter: 1, title: '确认需求', description: '核对这次范围，确认后继续' }
    : workspaceScene(project, stage, phase ?? project?.desktop_phase ?? null, Boolean(props.previewUrl && props.onConfirmSketch && !props.deliveryPanel), busy)
  const openTool = (name: 'documents' | 'collaboration' | 'versions' | 'materials' | 'records') => {
    setDocuments(name === 'documents' ? !documents : false)
    setCollaboration(name === 'collaboration' ? !collaboration : false)
    setLocalPanel(name === 'versions' || name === 'materials' || name === 'records' ? localPanel === name ? null : name : null)
    if (name === 'versions') setTimelineExpanded(true)
  }
  return (
    <div className="workspace-theatre" data-ai-id="workspace-theatre" data-mode={project?.mode ?? 'quick'} data-focused={focused} data-has-preview={Boolean(props.deliveryPanel || props.previewUrl)} data-view={mobileView} data-resizing-conversation={conversation.resizing} style={{ '--studio-conversation-width': `${conversation.width}px` } as React.CSSProperties}>
      <aside className="studio-sidebar" aria-label="项目导航">
      {/* 顶栏 */}
      <WorkspaceHeader
        showConnection={false}
        onAllProjects={props.onAllProjects}
        onOpenSettings={props.onOpenSettings}
        onUpgrade={props.onUpgrade}
        onHome={props.onHome}
      />
      <nav className="studio-steps" aria-label="软件制作进度">
        {['想法', '需求', '界面', '制作', '试用与交付'].map((label, index) => {
          const Icon = index < scene.chapter ? Check : [FileText, FileText, LayoutTemplate, Hammer, Play][index]
          return <button key={label} type="button" aria-current={scene.chapter === index ? 'step' : undefined} disabled={index > scene.chapter} title={index <= scene.chapter ? `回看${label}` : `${label}尚未开始`} onClick={() => openTool(index < 2 ? 'documents' : index === 2 ? 'versions' : 'records')}><Icon size={16} />{label}</button>
        })}
      </nav>
      <p className="studio-sidebar-label">项目资料</p>
      <nav className="studio-library" aria-label="项目资料"><button type="button" data-ai-id="docs-button" aria-pressed={documents} onClick={() => openTool('documents')}><FileText />文档</button><button type="button" data-ai-id="materials-button" aria-pressed={localPanel === 'materials'} onClick={() => openTool('materials')}><Layers />材料</button><button type="button" data-ai-id="versions-button" aria-pressed={localPanel === 'versions'} onClick={() => openTool('versions')}><History />版本</button><button type="button" data-ai-id="collaboration-button" aria-pressed={collaboration} onClick={() => openTool('collaboration')}><Users />协作</button></nav>
      <div className="studio-sidebar-foot"><StudioFumoNote /><WorkspaceConnection /></div>
      </aside>
      <div className="studio-body" ref={conversation.containerRef}>
      <nav className="studio-view-switch" aria-label="工作区视图"><button type="button" aria-pressed={mobileView === 'conversation'} onClick={() => setMobileView('conversation')}>对话</button><button type="button" aria-pressed={mobileView === 'preview'} onClick={() => setMobileView('preview')}>草图与程序</button></nav>
      <main className="theatre-stage">
        <div className="theatre-stage-heading"><div key={scene.title} className="studio-scene-heading"><p className="theatre-eyebrow">从想法到软件</p><h2>{scene.title}</h2></div><div className="studio-heading-actions"><span className="studio-scene-description">{scene.description}</span><button type="button" className="theatre-tool studio-control" title={focused ? '退出专注预览' : '专注预览'} aria-label={focused ? '退出专注预览' : '专注预览'} aria-pressed={focused} onClick={() => setFocused(value => !value)}>{focused ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button></div></div>
        <div className="theatre-main" data-panel-open={documents || collaboration || Boolean(localPanel)}>
          <section className="theatre-product" aria-label="软件与当前结果">
        {scopePending ? <ScopeConfirmationPanel scope={props.decisionScope} summary={props.decisionBody} options={props.cardOptions!} onSelect={props.onCardOptionSelect!} busy={busy} />
          : stage === 'generating_sketch' && busy && !props.previewUrl ? <div className="scope-preparing" role="status"><h3>正在准备界面草图</h3><p>需求已确认。草图会在这里展示，等你确认后才开始制作。</p></div> : props.deliveryPanel
          ? <DeliveryPanel embedded />
          : <PreviewPanel embedded
          status={props.previewStatus}
          previewUrl={props.previewUrl}
          reviewUrl={props.reviewUrl}
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
          {(documents || collaboration || localPanel) && <aside className="theatre-sidepanel" aria-label="项目资料面板">
            <DocumentPanel embedded />
            <CollaborationPanel embedded />
            {localPanel && <><div className="theatre-panel-heading"><h3>{localPanel === 'versions' ? '版本与回看' : localPanel === 'records' ? '工作记录' : '参考材料'}</h3><button type="button" className="theatre-tool" aria-label="关闭项目工具" onClick={() => setLocalPanel(null)}><X /></button></div>{localPanel === 'versions' ? <TimelinePanel onRollback={props.onRollback} /> : localPanel === 'records' ? <><DesktopStageBar /><WorkRecords />{artifacts.projectId === project?.project_id && <DesktopArtifactStrip />}</> : <HistoryAttachments onClose={() => setLocalPanel(null)} />}</>}
          </aside>}
        </div>
      </main>
      <button type="button" role="separator" aria-label="调整会话栏宽度" aria-orientation="vertical" className="studio-conversation-resizer" title="拖动调整会话栏；方向键微调，双击恢复默认" {...conversation.separatorProps} />
      <section className="theatre-conversation" aria-label="向导与下一步">
        {canConfirmSketch && !busy && !props.confirming && !requirementDialog && !prdDialog && !clarificationDialog && <SketchCharacterReminder key={sketchCue} cue={sketchCue} />}
        <ChatPanel presentation="theatre"
          cardOptions={scopePending ? undefined : props.cardOptions}
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
        {props.notice && <p className="studio-notice" role="status">{props.notice}</p>}
      </section>
      <footer className="studio-footer"><button type="button" className="theatre-tool" aria-pressed={localPanel === 'records'} onClick={() => openTool('records')}><Activity />工作记录</button><div className="studio-status-slot"><MvpStatusBanner suppressBlocked /></div>{canConfirmSketch && <button type="button" data-ai-id="confirm-sketch-button" className="studio-primary" disabled={props.confirming} onClick={props.onConfirmSketch}>{props.confirming ? '正在开始制作…' : '开始制作'}<Play size={13} /></button>}{project?.desktop_blocked && <button type="button" className="studio-primary" disabled={busy} onClick={() => props.onSendMessage?.('继续')}>继续制作</button>}</footer>
      </div>
    </div>
  )
}

const WorkRecords: React.FC = () => {
  const session = useAtomValue(activeAgentSessionIdAtom)
  const fallback = React.useMemo(() => agentMessagesFamily('__studio-records-empty__'), [])
  const messages = useAtomValue(session ? agentMessagesFamily(session) : fallback)
  return <div className="studio-work-records"><p>原始交流与执行记录保留在这里，用户正文不展示宿主指令。</p>{messages.map((message, index) => <details key={message.id ?? `${message.timestamp}-${index}`}><summary>{message.origin === 'system' ? '宿主记录' : message.role === 'assistant' ? '模型记录' : message.role === 'system' ? '系统记录' : '用户请求'} · {new Date(message.timestamp).toLocaleTimeString('zh-CN')}</summary><pre>{message.content.map(block => block.type === 'text' ? block.text : block.type === 'image' ? '[图片]' : JSON.stringify(block)).join('\n')}</pre></details>)}</div>
}
