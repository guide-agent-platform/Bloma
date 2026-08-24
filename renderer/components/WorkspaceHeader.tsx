import React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { StageIndicator } from './StageIndicator'
import { Sparkles, IconSettings } from './icons'
import {
  canUpgradeAtom,
  collaborationPanelExpandedAtom,
  currentProjectAtom,
  documentPanelExpandedAtom,
  networkOnlineAtom,
  projectModeAtom,
  stageIndicatorLabelAtom,
  workflowStageAtom,
} from './atoms'

export interface WorkspaceHeaderProps {
  /** 点击"所有项目"的回调 */
  onAllProjects?: () => void
  /** 打开设置页回调 */
  onOpenSettings?: () => void
  /** 点击「升级为长期模式」回调（U1：升级接线） */
  onUpgrade?: () => void
}

const ACTIVE_STAGES = new Set([
  'clarifying', 'generating_sketch', 'generating_mvp', 'testing',
  'judge_review', 'repairing', 'iterating', 'upgrading',
])

export const WorkspaceHeader: React.FC<WorkspaceHeaderProps> = ({ onAllProjects, onOpenSettings, onUpgrade }) => {
  const project = useAtomValue(currentProjectAtom)
  const mode = useAtomValue(projectModeAtom)
  const isOnline = useAtomValue(networkOnlineAtom)
  const stageLabel = useAtomValue(stageIndicatorLabelAtom)
  const stage = useAtomValue(workflowStageAtom)
  const canUpgrade = useAtomValue(canUpgradeAtom)
  const [docPanelExpanded, setDocPanelExpanded] = useAtom(documentPanelExpandedAtom)
  const [collabPanelExpanded, setCollabPanelExpanded] = useAtom(collaborationPanelExpandedAtom)
  const stageActive = ACTIVE_STAGES.has(stage)

  const modeLabel = mode === 'quick' ? '快速尝鲜' : mode === 'longterm' ? '精细打磨' : ''
  const modeColor = mode === 'quick' ? 'var(--color-quick)' : 'var(--color-longterm)'
  const modeBg = mode === 'quick' ? 'var(--color-quick-soft)' : 'var(--color-longterm-soft)'
  const modeText = mode === 'quick' ? 'var(--violet-700)' : 'var(--cyan-700)'

  return (
    <header
      data-ai-id="workspace-header"
      className="tile"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 'var(--header-height)',
        padding: '0 var(--space-5)',
        flexShrink: 0,
      }}
    >
      {/* 左侧：品牌 + 项目 + 模式 + 阶段 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontFamily: 'var(--font-display)', fontWeight: 400, fontSize: 26, letterSpacing: 0.5, padding: '4px 0', color: 'var(--color-text)' }}>
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: 'var(--radius-sm)',
              background: 'linear-gradient(135deg, var(--violet-600), var(--pink-500))',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--white)',
            }}
          >
            <Sparkles size={16} />
          </span>
          BLOMA
        </span>
        <span style={{ width: 1, height: 22, background: 'var(--color-border)', flexShrink: 0 }} />
        <h1
          style={{
            fontSize: 'var(--font-size-sm)',
            fontWeight: 600,
            color: 'var(--color-text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: 180,
          }}
        >
          {project?.name ?? '未命名项目'}
        </h1>
        {modeLabel && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              padding: '3px var(--space-3)',
              fontSize: 'var(--font-size-xs)',
              fontWeight: 600,
              color: modeText,
              background: modeBg,
              borderRadius: 'var(--radius-full)',
              whiteSpace: 'nowrap',
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: modeColor, display: 'inline-block' }} />
            {modeLabel}
          </span>
        )}
        <StageIndicator label={stageLabel} active={stageActive} />
      </div>

      {/* 右侧：联网 + 文档 + 升级 + 所有项目 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <span
          title={isOnline ? '已连接' : '网络离线'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            fontSize: 'var(--font-size-xs)',
            fontWeight: 500,
            color: isOnline ? 'var(--color-text-muted)' : 'var(--color-danger)',
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: isOnline ? 'var(--color-success)' : 'var(--color-danger)',
              display: 'inline-block',
            }}
          />
          {isOnline ? '已连接' : '离线'}
        </span>

        {/* 长期迭代型：委派协作 + 文档入口（两个抽屉门控，M4-C） */}
        {mode === 'longterm' && (
          <>
            <button
              data-ai-id="collaboration-button"
              title="委派协作"
              onClick={() => setCollabPanelExpanded((v) => !v)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-1)',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 500,
                color: 'var(--color-text)',
                padding: '7px var(--space-4)',
                borderRadius: 'var(--radius-full)',
                background: collabPanelExpanded ? 'var(--glass-bg-strong)' : 'var(--glass-bg-soft)',
                border: '1px solid var(--glass-border-subtle)',
                cursor: 'pointer',
                transition: 'all var(--transition-fast)',
              }}
            >
              协作
            </button>
            <button
              data-ai-id="docs-button"
              onClick={() => setDocPanelExpanded((v) => !v)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-1)',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 500,
                color: 'var(--color-text)',
                padding: '7px var(--space-4)',
                borderRadius: 'var(--radius-full)',
                background: 'var(--glass-bg-soft)',
                border: '1px solid var(--glass-border-subtle)',
                cursor: 'pointer',
                transition: 'all var(--transition-fast)',
              }}
            >
              文档
            </button>
          </>
        )}

        {/* 快消型已完成：升级入口 */}
        {canUpgrade && (
          <button
            data-ai-id="upgrade-to-longterm-button"
            onClick={onUpgrade}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              fontSize: 'var(--font-size-sm)',
              fontWeight: 600,
              color: 'var(--white)',
              padding: '7px var(--space-4)',
              borderRadius: 'var(--radius-full)',
              background: 'linear-gradient(135deg, var(--violet-600), var(--pink-500))',
              border: 'none',
              cursor: 'pointer',
              transition: 'all var(--transition-fast)',
            }}
          >
            升级为长期模式
          </button>
        )}

        {/* 设置入口（Sprint 2） */}
        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            data-ai-id="settings-button"
            title="设置（模型渠道）"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              fontSize: 'var(--font-size-sm)',
              fontWeight: 500,
              color: 'var(--color-text)',
              padding: '7px var(--space-4)',
              borderRadius: 'var(--radius-full)',
              background: 'var(--glass-bg-soft)',
              border: '1px solid var(--glass-border-subtle)',
              cursor: 'pointer',
              transition: 'all var(--transition-fast)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--glass-bg-strong)'
              e.currentTarget.style.transform = 'translateY(-1px)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--glass-bg-soft)'
              e.currentTarget.style.transform = 'none'
            }}
          >
            <IconSettings size={16} />
            设置
          </button>
        )}

        {/* 所有项目按钮（仅在传入回调时显示） */}
        {onAllProjects && (
          <button
            onClick={onAllProjects}
            data-ai-id="all-projects-button"
            title="查看所有项目"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              fontSize: 'var(--font-size-sm)',
              fontWeight: 500,
              color: 'var(--color-text)',
              padding: '7px var(--space-4)',
              borderRadius: 'var(--radius-full)',
              background: 'var(--glass-bg-soft)',
              border: '1px solid var(--glass-border-subtle)',
              transition: 'all var(--transition-fast)',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--glass-bg-strong)'
              e.currentTarget.style.transform = 'translateY(-1px)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--glass-bg-soft)'
              e.currentTarget.style.transform = 'none'
            }}
          >
            所有项目
          </button>
        )}
      </div>
    </header>
  )
}
