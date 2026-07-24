import React from 'react'
import { WorkspaceHeader } from './WorkspaceHeader'
import { ChatPanel } from './ChatPanel'
import { PreviewPanel } from './PreviewPanel'
import { TimelinePanel } from './TimelinePanel'
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

  /* === PreviewPanel props === */
  previewStatus?: PreviewStatus
  previewUrl?: string
  previewErrorLabel?: string
  onRefreshPreview?: () => void
  onToggleFullscreen?: () => void
  onScreenshot?: () => void

  /* === TimelinePanel props === */
  onRollback?: (snapshot: Snapshot) => void

  /* === Header props === */
  onAllProjects?: () => void
}

/**
 * 工作区 Shell — Bento Glass 架构
 *
 * 布局（与 demo.html 一致）:
 * ┌──────────────────────────────────────────┐
 * │  WorkspaceHeader (玻璃胶囊, 60px)         │
 * ├──────────────────────────────────────────┤
 * │  TimelinePanel (顶部胶片条, 玻璃胶囊)     │
 * ├──────────────────────┬───────────────────┤
 * │  PreviewPanel        │  ChatPanel         │
 * │  (大磁贴, 左 1.55fr)  │  (磁贴, 右 1fr)    │
 * └──────────────────────┴───────────────────┘
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
      {/* 顶栏（玻璃胶囊） */}
      <WorkspaceHeader onAllProjects={props.onAllProjects} />

      {/* 顶部时间轴胶片条 */}
      <TimelinePanel onRollback={props.onRollback} />

      {/* Bento 主区：预览大磁贴（左）+ 对话磁贴（右） */}
      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '1.55fr 1fr',
          gap: 'var(--tile-gap)',
          minHeight: 0,
        }}
      >
        <PreviewPanel
          status={props.previewStatus}
          previewUrl={props.previewUrl}
          errorLabel={props.previewErrorLabel}
          onRefresh={props.onRefreshPreview}
          onToggleFullscreen={props.onToggleFullscreen}
          onScreenshot={props.onScreenshot}
        />
        <ChatPanel
          cardOptions={props.cardOptions}
          onCardOptionSelect={props.onCardOptionSelect}
          onSendMessage={props.onSendMessage}
          isWaiting={props.isWaiting}
          waitStartTime={props.waitStartTime}
          waitActionLabel={props.waitActionLabel}
          onContinueWaiting={props.onContinueWaiting}
          onViewPartial={props.onViewPartial}
        />
      </div>
    </div>
  )
}
