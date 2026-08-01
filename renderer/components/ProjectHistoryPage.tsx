import React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { Sparkles, Gem, ArrowRight, LayoutTemplate } from './icons'
import {
  currentProjectAtom,
  projectModeAtom,
  workflowStageAtom,
  STAGE_LABEL_MAP,
  activeAgentSessionIdAtom,
} from './atoms'
import type { Project, ProjectMode, WorkflowStage } from './atoms'

export interface ProjectHistoryPageProps {
  /** 缓存的本地项目列表（演示/开发模式下为手动维护的列表） */
  projects?: Project[]
  /** 进入已有项目工作区 */
  onResumeProject: (project: Project) => void
  /** 新建项目 → 回到两道门 */
  onNewProject: () => void
  /** 返回当前工作区（如果有活跃项目） */
  onBackToWorkspace?: () => void
}

const modeLabelMap: Record<ProjectMode, string> = {
  quick: '快速尝鲜',
  longterm: '精细打磨',
}

const modeColorMap: Record<ProjectMode, string> = {
  quick: 'var(--color-quick)',
  longterm: 'var(--color-longterm)',
}

const modeBgMap: Record<ProjectMode, string> = {
  quick: 'var(--color-quick-soft)',
  longterm: 'var(--color-longterm-soft)',
}

const statusLabelMap: Record<string, string> = {
  active: '进行中',
  completed: '已完成',
  abandoned: '已放弃',
  archived: '已归档',
}

/**
 * 历史项目列表页
 *
 * 规范来源：interaction-spec §3.2 状态机
 *   choosing_mode --> project_history: 从历史入口返回
 *   sitemap.md 标注"历史项目列表（新增，Phase 1）"
 *
 * 功能：
 * - 展示所有活动项目（名称、模式、阶段、更新时间）
 * - 点击进入已有项目工作区
 * - "新建项目"按钮回到两道门选择页
 * - 支持从工作区顶栏"所有项目"进入
 */
export const ProjectHistoryPage: React.FC<ProjectHistoryPageProps> = ({
  projects = [],
  onResumeProject,
  onNewProject,
  onBackToWorkspace,
}) => {
  const currentProject = useAtomValue(currentProjectAtom)

  // 只展示非归档项目，按更新时间倒序
  const activeProjects = [...projects]
    .filter((p) => p.status !== 'archived')
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())

  const formatDate = (iso: string): string => {
    try {
      return new Date(iso).toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      return iso
    }
  }

  return (
    <div
      data-ai-id="project-history-page"
      style={{
        position: 'relative',
        zIndex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        minHeight: '100vh',
        padding: 'var(--space-8) var(--space-6)',
        background: 'transparent',
      }}
    >
      {/* 顶栏导航 */}
      <div
        style={{
          width: '100%',
          maxWidth: 780,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 'var(--space-8)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          {onBackToWorkspace && currentProject && (
            <button
              onClick={onBackToWorkspace}
              style={{
                fontSize: 'var(--font-size-sm)',
                color: 'var(--color-text-muted)',
                padding: 'var(--space-2) var(--space-3)',
                borderRadius: 'var(--radius-sm)',
                transition: 'color var(--transition-fast)',
              }}
            >
              ← 返回工作区
            </button>
          )}
          <h1
            style={{
              fontSize: 'var(--font-size-xl)',
              fontWeight: 700,
              color: 'var(--color-text)',
              letterSpacing: '-0.3px',
            }}
          >
            所有项目
          </h1>
        </div>
        <button
          onClick={onNewProject}
          data-ai-id="new-project-button"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            fontSize: 'var(--font-size-sm)',
            fontWeight: 600,
            color: 'var(--white)',
            padding: '10px var(--space-5)',
            borderRadius: 'var(--radius-full)',
            background: 'linear-gradient(135deg, var(--color-quick), var(--color-quick-bright))',
            boxShadow: '0 4px 12px -2px rgba(124,58,237,0.4)',
            transition: 'all var(--transition-fast)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'translateY(-1px)'
            e.currentTarget.style.boxShadow = '0 6px 16px -2px rgba(124,58,237,0.5)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'none'
            e.currentTarget.style.boxShadow = '0 4px 12px -2px rgba(124,58,237,0.4)'
          }}
        >
          <Sparkles size={15} />
          新建项目
        </button>
      </div>

      {/* 项目列表 */}
      <div
        style={{
          width: '100%',
          maxWidth: 780,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
        }}
      >
        {activeProjects.length === 0 ? (
          <EmptyState onNewProject={onNewProject} />
        ) : (
          activeProjects.map((project) => (
            <ProjectRow
              key={project.project_id}
              project={project}
              isCurrent={currentProject?.project_id === project.project_id}
              onResume={() => onResumeProject(project)}
            />
          ))
        )}
      </div>
    </div>
  )
}

/* =========================================================================
   ProjectRow
   ========================================================================= */

const ProjectRow: React.FC<{
  project: Project
  isCurrent: boolean
  onResume: () => void
}> = ({ project, isCurrent, onResume }) => {
  const stageLabel = STAGE_LABEL_MAP[project.current_stage] ?? project.current_stage
  const modeLabel = modeLabelMap[project.mode] ?? project.mode
  const modeColor = modeColorMap[project.mode] ?? 'var(--color-text-muted)'
  const modeBg = modeBgMap[project.mode] ?? 'var(--glass-bg-soft)'
  const statusLabel = statusLabelMap[project.status] ?? project.status

  const formattedDate = React.useMemo(() => {
    try {
      return new Date(project.updated_at).toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      return project.updated_at
    }
  }, [project.updated_at])

  return (
    <button
      onClick={onResume}
      data-ai-id="project-list-item"
      className="tile"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 'var(--space-4) var(--space-5)',
        textAlign: 'left',
        animation: 'tile-enter 0.3s ease both',
        transition: 'all var(--transition-fast)',
        cursor: 'pointer',
        border: isCurrent ? '1px solid var(--color-quick)' : undefined,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-1px)'
        e.currentTarget.style.boxShadow = 'var(--shadow-md)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'none'
        e.currentTarget.style.boxShadow = 'var(--shadow-glass)'
      }}
    >
      {/* 左侧信息 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', minWidth: 0 }}>
        {/* 项目图标 */}
        <span
          style={{
            width: 44,
            height: 44,
            borderRadius: 'var(--radius-md)',
            background: 'var(--white)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: modeColor,
            boxShadow: 'var(--shadow-sm)',
            flexShrink: 0,
          }}
        >
          {project.mode === 'quick' ? <Sparkles size={20} /> : <Gem size={20} />}
        </span>

        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 2 }}>
            <span
              style={{
                fontSize: 'var(--font-size-sm)',
                fontWeight: 600,
                color: 'var(--color-text)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 240,
              }}
            >
              {project.name}
            </span>
            {isCurrent && (
              <span
                style={{
                  fontSize: 'var(--font-size-xs)',
                  fontWeight: 600,
                  color: 'var(--color-quick)',
                  padding: '1px var(--space-2)',
                  borderRadius: 'var(--radius-full)',
                  background: 'var(--color-quick-soft)',
                }}
              >
                当前
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-1)',
                padding: '2px var(--space-2)',
                fontSize: 'var(--font-size-xs)',
                fontWeight: 500,
                color: modeColor,
                background: modeBg,
                borderRadius: 'var(--radius-full)',
              }}
            >
              {modeLabel}
            </span>
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
              {stageLabel}
            </span>
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
              · {statusLabel}
            </span>
          </div>
        </div>
      </div>

      {/* 右侧：时间 + 箭头 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexShrink: 0 }}>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
          {formattedDate}
        </span>
        <ArrowRight size={16} style={{ color: 'var(--color-text-muted)' }} />
      </div>
    </button>
  )
}

/* =========================================================================
   EmptyState
   ========================================================================= */

const EmptyState: React.FC<{ onNewProject: () => void }> = ({ onNewProject }) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
      padding: 'var(--space-12) var(--space-6)',
    }}
  >
    <span
      aria-hidden
      style={{
        width: 72,
        height: 72,
        borderRadius: 'var(--radius-lg)',
        background: 'var(--glass-bg-strong)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 'var(--space-5)',
        color: 'var(--color-text-muted)',
      }}
    >
      <LayoutTemplate size={34} />
    </span>
    <h2
      style={{
        fontSize: 'var(--font-size-lg)',
        fontWeight: 600,
        marginBottom: 'var(--space-2)',
        color: 'var(--color-text)',
      }}
    >
      还没有项目
    </h2>
    <p
      style={{
        fontSize: 'var(--font-size-sm)',
        color: 'var(--color-text-muted)',
        marginBottom: 'var(--space-5)',
        maxWidth: 360,
        lineHeight: 'var(--line-height-base)',
      }}
    >
      你还没有创建过任何项目。点击下方按钮，选择一个模式开始你的第一个项目吧。
    </p>
    <button
      onClick={onNewProject}
      data-ai-id="empty-new-project-button"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        fontSize: 'var(--font-size-sm)',
        fontWeight: 600,
        color: 'var(--white)',
        padding: '10px var(--space-5)',
        borderRadius: 'var(--radius-full)',
        background: 'linear-gradient(135deg, var(--color-quick), var(--color-quick-bright))',
        boxShadow: '0 4px 12px -2px rgba(124,58,237,0.4)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-1px)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'none'
      }}
    >
      <Sparkles size={15} />
      创建第一个项目
    </button>
  </div>
)

export default ProjectHistoryPage
