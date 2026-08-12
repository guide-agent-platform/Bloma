import React from 'react'
import { WorkspaceHeader } from './WorkspaceHeader'
import { ChatPanel } from './ChatPanel'
import { PreviewPanel } from './PreviewPanel'
import { TimelinePanel } from './TimelinePanel'
import { MvpStatusBanner } from './MvpStatusBanner'
import type { CardOption } from './CardOptions'
import type { PreviewStatus } from './PreviewPanel'
import type { Snapshot } from './atoms'

export interface WorkspaceShellProps {
  /* === ChatPanel props === */
  cardOptions?: CardOption[]
  onCardOptionSelect?: (option: CardOption) => void
  onSendMessage?: (content: string) => void
  isWaiting?: boolean
  waitStartTime?: number
  waitActionLabel?: string
  onContinueWaiting?: () => void
  onViewPartial?: () => void
  /** 回访恢复时是否正在加载历史消息（对话区显示骨架占位） */
  isHistoryLoading?: boolean

  /* === PreviewPanel props === */
  previewStatus?: PreviewStatus
  previewUrl?: string
  previewErrorLabel?: string
  onRefreshPreview?: () => void
  onToggleFullscreen?: () => void
  onScreenshot?: () => void
  onCorrectionSubmit?: (payload: { position: { x: number; y: number }; userNote: string; fallbackMode: boolean }) => void

  /* === TimelinePanel props === */
  onRollback?: (snapshot: Snapshot) => void

  /* === Header props === */
  onAllProjects?: () => void
  /** 打开设置页回调 */
  onOpenSettings?: () => void
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
  return (
    <div
      style={{
        position: 'relative',
        zIndex: 1,
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        padding: 'var(--tile-gap)',
        gap: 'var(--tile-gap)',
        background: 'transparent',
        overflow: 'hidden',
      }}
    >
      {/* 顶栏 */}
      <WorkspaceHeader
        onAllProjects={props.onAllProjects}
        onOpenSettings={props.onOpenSettings}
      />

      {/* MVP 状态横幅（Sprint 2） */}
      <MvpStatusBanner />

      {/* 主区：对话（左 1fr ≈ 35%）+ 预览（右 2fr ≈ 65%），等高 */}
      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '1fr 2fr',
          gap: 'var(--tile-gap)',
          minHeight: 0,
        }}
      >
        <ChatPanel
          cardOptions={props.cardOptions}
          onCardOptionSelect={props.onCardOptionSelect}
          onSendMessage={props.onSendMessage}
          isWaiting={props.isWaiting}
          waitStartTime={props.waitStartTime}
          waitActionLabel={props.waitActionLabel}
          onContinueWaiting={props.onContinueWaiting}
          onViewPartial={props.onViewPartial}
          isHistoryLoading={props.isHistoryLoading}
        />
        <PreviewPanel
          status={props.previewStatus}
          previewUrl={props.previewUrl}
          errorLabel={props.previewErrorLabel}
          onRefresh={props.onRefreshPreview}
          onToggleFullscreen={props.onToggleFullscreen}
          onScreenshot={props.onScreenshot}
          onCorrectionSubmit={props.onCorrectionSubmit}
        />
      </div>

      {/* 底部时间轴胶片条 */}
      <TimelinePanel onRollback={props.onRollback} />
    </div>
  )
}
