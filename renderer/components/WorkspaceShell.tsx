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
<<<<<<< HEAD
  onCorrectionSubmit?: (payload: { position: { x: number; y: number }; userNote: string; fallbackMode: boolean }) => void
=======
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84

  /* === TimelinePanel props === */
  onRollback?: (snapshot: Snapshot) => void

  /* === Header props === */
  onAllProjects?: () => void
}

/**
 * 工作区 Shell — Bento Glass 架构
 *
<<<<<<< HEAD
 * 布局:
 * ┌──────────────────────────────────────────┐
 * │  WorkspaceHeader (顶栏)                   │
 * ├──────────────────┬───────────────────────┤
 * │  ChatPanel       │  PreviewPanel          │
 * │  (对话, 左 1fr)   │  (预览, 右 2fr)        │
 * ├──────────────────┴───────────────────────┤
 * │  TimelinePanel (底部时间轴)                │
 * └──────────────────────────────────────────┘
=======
 * 布局（与 demo.html 一致）:
 * ┌──────────────────────────────────────────┐
 * │  WorkspaceHeader (玻璃胶囊, 60px)         │
 * ├──────────────────────────────────────────┤
 * │  TimelinePanel (顶部胶片条, 玻璃胶囊)     │
 * ├──────────────────────┬───────────────────┤
 * │  PreviewPanel        │  ChatPanel         │
 * │  (大磁贴, 左 1.55fr)  │  (磁贴, 右 1fr)    │
 * └──────────────────────┴───────────────────┘
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
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
<<<<<<< HEAD
      {/* 顶栏 */}
      <WorkspaceHeader onAllProjects={props.onAllProjects} />

      {/* 主区：对话（左 1fr ≈ 35%）+ 预览（右 2fr ≈ 65%），等高 */}
=======
      {/* 顶栏（玻璃胶囊） */}
      <WorkspaceHeader onAllProjects={props.onAllProjects} />

      {/* 顶部时间轴胶片条 */}
      <TimelinePanel onRollback={props.onRollback} />

      {/* Bento 主区：预览大磁贴（左）+ 对话磁贴（右） */}
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
      <div
        style={{
          flex: 1,
          display: 'grid',
<<<<<<< HEAD
          gridTemplateColumns: '1fr 2fr',
=======
          gridTemplateColumns: '1.55fr 1fr',
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
          gap: 'var(--tile-gap)',
          minHeight: 0,
        }}
      >
<<<<<<< HEAD
=======
        <PreviewPanel
          status={props.previewStatus}
          previewUrl={props.previewUrl}
          errorLabel={props.previewErrorLabel}
          onRefresh={props.onRefreshPreview}
          onToggleFullscreen={props.onToggleFullscreen}
          onScreenshot={props.onScreenshot}
        />
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
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
<<<<<<< HEAD
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
=======
      </div>
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
    </div>
  )
}
