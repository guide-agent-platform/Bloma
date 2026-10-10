import React from 'react'
import { useAtomValue } from 'jotai'
import { Sparkles, Gem, ArrowRight, LayoutTemplate } from './icons'
import {
  currentProjectAtom,
  STAGE_LABEL_MAP,
} from './atoms'
import { desktopPhaseFullLabel } from '../lib/desktop-stages'
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
  /** 归档/删除/恢复后回传最新活动项目列表（供 App 同步 projectList） */
  onProjectsChanged?: (projects: Project[]) => void
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

type LoadState = 'loading' | 'loaded' | 'error'
type ActiveTab = 'active' | 'archived'

/** 稳定空数组默认值：避免 props 默认参数每次渲染新建引用导致 load effect 无限重跑。 */
const EMPTY_PROJECTS: Project[] = []

/**
 * 历史项目列表页
 *
 * 规范来源：interaction-spec §3.2 状态机 + sitemap.md「历史项目列表（Phase 1）」。
 * 本轮（Sprint 3）补齐项目管理操作（迁移自 Proma 归档/删除）：
 * - 「进行中 / 已归档」两个视角 Tab（对齐 Proma archived scope）
 * - 活动行「归档 / 删除」，归档行「恢复 / 删除」，删除需二次确认
 * - 操作成功后经 onProjectsChanged 回传最新活动列表，供 App 同步 projectList
 */
export const ProjectHistoryPage: React.FC<ProjectHistoryPageProps> = ({
  projects = EMPTY_PROJECTS,
  onResumeProject,
  onNewProject,
  onBackToWorkspace,
  onProjectsChanged,
}) => {
  const currentProject = useAtomValue(currentProjectAtom)
  const [activeTab, setActiveTab] = React.useState<ActiveTab>('active')
  const [searchQuery, setSearchQuery] = React.useState('')
  const [modeFilter, setModeFilter] = React.useState<'all' | ProjectMode>('all')
  const [sortBy, setSortBy] = React.useState<'updated_desc' | 'updated_asc' | 'name'>('updated_desc')
  const [loadState, setLoadState] = React.useState<LoadState>('loading')
  const [ipcProjects, setIpcProjects] = React.useState<Project[]>([])
  /** 是否已从 IPC 成功加载（区分「IPC 返回空列表」与「无 IPC 数据」） */
  const [loadedFromIpc, setLoadedFromIpc] = React.useState(false)
  const [deletingProject, setDeletingProject] = React.useState<Project | null>(null)
  const [errorRetrying, setErrorRetrying] = React.useState(false)
  const [exportingProject, setExportingProject] = React.useState<Project | null>(null)
  const [exportNotice, setExportNotice] = React.useState<string | null>(null)
  const [cleaningSessions, setCleaningSessions] = React.useState(false)
  const [sessionCleanNotice, setSessionCleanNotice] = React.useState<string | null>(null)
  const [renamingProject, setRenamingProject] = React.useState<Project | null>(null)
  const [renameDraft, setRenameDraft] = React.useState('')
  const [renameSubmitting, setRenameSubmitting] = React.useState(false)

  const load = React.useCallback(async (scope: ActiveTab) => {
    setLoadState('loading')
    const api = window.electronAPI
    if (api?.project?.list) {
      try {
        const result = await api.project.list({ request_id: crypto.randomUUID(), scope })
        if (result.ok) {
          setIpcProjects(result.data)
          setLoadedFromIpc(true)
          setLoadState('loaded')
          return
        }
      } catch {
        // 落到 props 兜底
      }
    }
    setLoadedFromIpc(false)
    setIpcProjects([])
    setLoadState('loaded')
  }, [])

  React.useEffect(() => {
    void load(activeTab)
  }, [activeTab, load])

  const handleRetry = () => {
    setErrorRetrying(true)
    setTimeout(() => {
      setErrorRetrying(false)
      void load(activeTab)
    }, 800)
  }

  /** 操作成功后：刷新 active 列表并回传 App，再刷新当前 tab 视图。 */
  const afterMutate = React.useCallback(async () => {
    const api = window.electronAPI
    if (api?.project?.list) {
      const active = await api.project.list({ request_id: crypto.randomUUID(), scope: 'active' })
      if (active.ok) onProjectsChanged?.(active.data)
    }
    await load(activeTab)
  }, [activeTab, load, onProjectsChanged])

  const handleArchive = (project: Project) => {
    const api = window.electronAPI
    if (!api?.project?.archive) return
    void api.project
      .archive({ request_id: crypto.randomUUID(), project_id: project.project_id })
      .then((result) => {
        if (result.ok) void afterMutate()
      })
  }

  const handleUnarchive = (project: Project) => {
    const api = window.electronAPI
    if (!api?.project?.unarchive) return
    void api.project
      .unarchive({ request_id: crypto.randomUUID(), project_id: project.project_id })
      .then((result) => {
        if (result.ok) void afterMutate()
      })
  }

  const handleAbandon = (project: Project) => {
    const api = window.electronAPI
    if (!api?.project?.abandon) return
    void api.project
      .abandon({ request_id: crypto.randomUUID(), project_id: project.project_id })
      .then((result) => {
        if (result.ok) void afterMutate()
      })
  }

  const handleReopen = (project: Project) => {
    const api = window.electronAPI
    if (!api?.project?.reopen) return
    void api.project
      .reopen({ request_id: crypto.randomUUID(), project_id: project.project_id })
      .then((result) => {
        if (result.ok) void afterMutate()
      })
  }

  const handleDeleteConfirm = () => {
    if (!deletingProject) return
    const api = window.electronAPI
    const project = deletingProject
    setDeletingProject(null)
    if (!api?.project?.delete) return
    void api.project
      .delete({ request_id: crypto.randomUUID(), project_id: project.project_id })
      .then((result) => {
        if (result.ok) void afterMutate()
      })
  }

  const handleExport = (project: Project) => {
    const api = window.electronAPI
    if (!api?.project?.export) return
    setExportingProject(project)
    setExportNotice(null)
    void api.project
      .export({ request_id: crypto.randomUUID(), project_id: project.project_id })
      .then((result) => {
        if (result.ok && result.data && !result.data.canceled && result.data.destination) {
          const count = result.data.file_count != null ? `（${result.data.file_count} 个文件）` : ''
          setExportNotice(`已导出「${project.name}」到 ${result.data.destination}${count}`)
        }
      })
      .finally(() => setExportingProject(null))
  }

  const handleStartRename = (project: Project) => {
    setRenamingProject(project)
    setRenameDraft(project.name)
  }

  const handleRenameCancel = () => {
    setRenamingProject(null)
    setRenameDraft('')
  }

  const handleRenameSubmit = () => {
    if (!renamingProject) return
    const api = window.electronAPI
    if (!api?.project?.rename) return
    const name = renameDraft.trim()
    if (name.length === 0 || name === renamingProject.name) {
      handleRenameCancel()
      return
    }
    setRenameSubmitting(true)
    void api.project
      .rename({ request_id: crypto.randomUUID(), project_id: renamingProject.project_id, name })
      .then((result) => {
        if (result.ok) {
          setRenamingProject(null)
          setRenameDraft('')
          void afterMutate()
        }
      })
      .finally(() => setRenameSubmitting(false))
  }

  const handleCleanOrphanSessions = () => {
    const api = window.electronAPI
    if (!api?.agent?.cleanOrphans) return
    setCleaningSessions(true)
    setSessionCleanNotice(null)
    void api.agent
      .cleanOrphans({ request_id: crypto.randomUUID() })
      .then((result) => {
        if (result.ok && result.data) {
          const removed = result.data.removed
          setSessionCleanNotice(removed > 0 ? `已清理 ${removed} 个无效会话。` : '没有需要清理的无效会话。')
        }
      })
      .finally(() => setCleaningSessions(false))
  }

  const resetFilters = () => {
    setSearchQuery('')
    setModeFilter('all')
    setSortBy('updated_desc')
  }

  const resolvedProjects = loadedFromIpc ? ipcProjects : activeTab === 'active' ? projects : []

  const filteredProjects = React.useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return resolvedProjects.filter((project) => {
      if (modeFilter !== 'all' && project.mode !== modeFilter) return false
      if (query && !project.name.toLowerCase().includes(query)) return false
      return true
    })
  }, [resolvedProjects, modeFilter, searchQuery])

  const visibleProjects = React.useMemo(() => {
    const sorted = [...filteredProjects]
    if (sortBy === 'name') {
      sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    } else {
      sorted.sort((a, b) => {
        const diff = new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        return sortBy === 'updated_asc' ? -diff : diff
      })
    }
    return sorted
  }, [filteredProjects, sortBy])

  return (
    <div
      data-ai-id="project-history-page"
      style={{
        position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', minHeight: '100vh', padding: 'var(--space-8) var(--space-6)',
        background: 'transparent',
      }}
    >
      {/* 顶栏导航 */}
      <div
        style={{
          width: '100%', maxWidth: 780, display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', marginBottom: 'var(--space-6)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          {onBackToWorkspace && currentProject && (
            <button
              onClick={onBackToWorkspace}
              style={{
                fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)',
                padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-sm)',
                border: 'none', background: 'transparent', cursor: 'pointer',
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
            border: 'none',
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

      {/* 视角 Tab：进行中 / 已归档（对齐 Proma archived scope） */}
      <div
        style={{
          width: '100%', maxWidth: 780, display: 'flex', gap: 'var(--space-2)',
          marginBottom: 'var(--space-4)',
        }}
      >
        <TabButton
          label="进行中"
          dataAiId="history-tab-active"
          active={activeTab === 'active'}
          onClick={() => setActiveTab('active')}
        />
        <TabButton
          label="已归档"
          dataAiId="history-tab-archived"
          active={activeTab === 'archived'}
          onClick={() => setActiveTab('archived')}
        />
      </div>

      {/* 搜索 / 筛选 / 排序（U14）——纯前端过滤，project.list 已返回全量字段 */}
      {loadState === 'loaded' && resolvedProjects.length > 0 && (
        <div
          data-ai-id="project-filter-toolbar"
          style={{
            width: '100%', maxWidth: 780, display: 'flex', flexWrap: 'wrap', alignItems: 'center',
            gap: 'var(--space-2)', marginBottom: 'var(--space-4)',
          }}
        >
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索项目名称…"
            aria-label="搜索项目"
            data-ai-id="project-search-input"
            style={{
              flex: '1 1 180px', minWidth: 160, height: 34,
              fontSize: 'var(--font-size-sm)', color: 'var(--color-text)',
              padding: '0 var(--space-3)', borderRadius: 'var(--radius-full)',
              background: 'var(--glass-bg-soft)', border: '1px solid var(--color-border)',
              outline: 'none', fontFamily: 'inherit',
            }}
          />
          <TabButton label="全部" dataAiId="filter-mode-all" active={modeFilter === 'all'} onClick={() => setModeFilter('all')} />
          <TabButton label="快速尝鲜" dataAiId="filter-mode-quick" active={modeFilter === 'quick'} onClick={() => setModeFilter('quick')} />
          <TabButton label="精细打磨" dataAiId="filter-mode-longterm" active={modeFilter === 'longterm'} onClick={() => setModeFilter('longterm')} />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            aria-label="排序方式"
            data-ai-id="project-sort-select"
            style={{
              height: 34, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)',
              padding: '0 var(--space-2)', borderRadius: 'var(--radius-full)',
              background: 'var(--glass-bg-soft)', border: '1px solid var(--color-border)',
              outline: 'none', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <option value="updated_desc">最近更新</option>
            <option value="updated_asc">最早更新</option>
            <option value="name">名称排序</option>
          </select>
        </div>
      )}

      {/* 导出成功提示（U10） */}
      {exportNotice && (
        <div
          data-ai-id="project-export-notice"
          role="status"
          style={{
            width: '100%', maxWidth: 780, marginBottom: 'var(--space-4)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)',
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--glass-bg-strong)',
            border: '1px solid var(--glass-border-subtle)',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-text)',
            lineHeight: 1.6,
            animation: 'tile-enter 0.2s ease both',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minWidth: 0 }}>
            <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-success)', flexShrink: 0 }} />
            <span style={{ wordBreak: 'break-all' }}>{exportNotice}</span>
          </span>
          <button
            onClick={() => setExportNotice(null)}
            aria-label="关闭提示"
            style={{
              color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)',
              padding: '0 var(--space-1)', lineHeight: 1, cursor: 'pointer',
              background: 'transparent', border: 'none', fontFamily: 'inherit',
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* 项目列表 */}
      <div
        style={{
          width: '100%', maxWidth: 780, display: 'flex', flexDirection: 'column', gap: 'var(--space-3)',
        }}
      >
        {/* 加载状态：骨架屏 */}
        {loadState === 'loading' && (
          <>
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="tile"
                data-ai-id="history-skeleton-row"
                style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--space-4)',
                  padding: 'var(--space-4) var(--space-5)',
                  animation: `shimmer 1.5s ease-in-out ${i * 0.15}s infinite`,
                  background: 'linear-gradient(90deg, var(--glass-bg-soft) 25%, var(--glass-bg) 50%, var(--glass-bg-soft) 75%)',
                  backgroundSize: '200% 100%',
                }}
              >
                <span style={{ width: 44, height: 44, borderRadius: 'var(--radius-md)', background: 'var(--gray-200)', flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ width: '40%', height: 14, borderRadius: 4, background: 'var(--gray-200)', marginBottom: 8 }} />
                  <div style={{ width: '60%', height: 10, borderRadius: 4, background: 'var(--gray-200)' }} />
                </div>
                <div style={{ width: 60, height: 10, borderRadius: 4, background: 'var(--gray-200)', flexShrink: 0 }} />
              </div>
            ))}
          </>
        )}

        {/* 错误状态 */}
        {loadState === 'error' && (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            padding: 'var(--space-12) var(--space-6)', textAlign: 'center',
          }}>
            <span style={{
              width: 64, height: 64, borderRadius: 'var(--radius-lg)',
              background: 'var(--color-danger-soft)', display: 'inline-flex',
              alignItems: 'center', justifyContent: 'center', marginBottom: 'var(--space-5)',
              color: 'var(--color-danger)', fontSize: 28,
            }}>!</span>
            <h2 style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, marginBottom: 'var(--space-2)', color: 'var(--color-text)' }}>
              暂时无法加载你的项目
            </h2>
            <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-5)', maxWidth: 360, lineHeight: 1.6 }}>
              可能是本地存储出现了问题。你可以重试，也可以跳过直接新建项目。
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
              <button
                onClick={handleRetry}
                disabled={errorRetrying}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
                  fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--white)',
                  padding: '10px var(--space-5)', borderRadius: 'var(--radius-full)',
                  background: 'linear-gradient(135deg, var(--color-quick), var(--color-quick-bright))',
                  boxShadow: '0 4px 12px -2px rgba(124,58,237,0.4)',
                  cursor: errorRetrying ? 'wait' : 'pointer', fontFamily: 'inherit', border: 'none',
                  opacity: errorRetrying ? 0.7 : 1,
                }}
              >
                {errorRetrying ? '重试中…' : '重试'}
              </button>
              <button
                onClick={onNewProject}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
                  fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-text)',
                  padding: '10px var(--space-5)', borderRadius: 'var(--radius-full)',
                  background: 'var(--glass-bg-soft)', border: '1px solid var(--color-border)',
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                <Sparkles size={15} />
                跳过，直接新建项目
              </button>
            </div>
          </div>
        )}

        {/* 正常状态：无项目 */}
        {loadState === 'loaded' && resolvedProjects.length === 0 && (
          <EmptyState onNewProject={onNewProject} tabLabel={activeTab === 'archived' ? '已归档' : '进行中'} />
        )}

        {/* 正常状态：有项目但搜索/筛选无结果 */}
        {loadState === 'loaded' && resolvedProjects.length > 0 && visibleProjects.length === 0 && (
          <div
            data-ai-id="project-filter-empty"
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center',
              padding: 'var(--space-10) var(--space-6)',
            }}
          >
            <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-4)' }}>
              没有匹配「{searchQuery.trim()}」的项目
            </p>
            <button
              onClick={resetFilters}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
                fontSize: 'var(--font-size-sm)', fontWeight: 500, color: 'var(--color-text)',
                padding: '8px var(--space-4)', borderRadius: 'var(--radius-full)',
                background: 'var(--glass-bg-soft)', border: '1px solid var(--color-border)',
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              清除筛选
            </button>
          </div>
        )}

        {loadState === 'loaded' &&
          visibleProjects.map((project) => (
            <ProjectRow
              key={project.project_id}
              project={project}
              isCurrent={currentProject?.project_id === project.project_id}
              onResume={() => onResumeProject(project)}
              renaming={renamingProject?.project_id === project.project_id}
              renameValue={renameDraft}
              renameSubmitting={renameSubmitting}
              onRenameValueChange={setRenameDraft}
              onRenameSubmit={handleRenameSubmit}
              onRenameCancel={handleRenameCancel}
              actions={
                project.status === 'archived' ? (
                  <>
                    <ActionButton label="恢复" dataAiId="project-restore-button" onClick={() => handleUnarchive(project)} />
                    <ActionButton label="重命名" dataAiId="project-rename-button" onClick={() => handleStartRename(project)} />
                    <ActionButton
                      label={exportingProject?.project_id === project.project_id ? '导出中…' : '导出'}
                      dataAiId="project-export-button"
                      onClick={() => handleExport(project)}
                      disabled={exportingProject !== null}
                    />
                    <ActionButton label="删除" dataAiId="project-delete-button" danger onClick={() => setDeletingProject(project)} />
                  </>
                ) : (
                  <>
                    {project.status === 'abandoned' ? (
                      <ActionButton label="恢复进行" dataAiId="project-reopen-button" onClick={() => handleReopen(project)} />
                    ) : project.status === 'active' ? (
                      <ActionButton label="标记为已放弃" dataAiId="project-abandon-button" onClick={() => handleAbandon(project)} />
                    ) : null}
                    <ActionButton label="归档" dataAiId="project-archive-button" onClick={() => handleArchive(project)} />
                    <ActionButton label="重命名" dataAiId="project-rename-button" onClick={() => handleStartRename(project)} />
                    <ActionButton
                      label={exportingProject?.project_id === project.project_id ? '导出中…' : '导出'}
                      dataAiId="project-export-button"
                      onClick={() => handleExport(project)}
                      disabled={exportingProject !== null}
                    />
                    <ActionButton label="删除" dataAiId="project-delete-button" danger onClick={() => setDeletingProject(project)} />
                  </>
                )
              }
            />
          ))}
      </div>

      {/* 数据管理（U11）：清理孤儿会话 */}
      <div
        data-ai-id="session-cleanup-section"
        style={{
          width: '100%', maxWidth: 780, marginTop: 'var(--space-6)',
          paddingTop: 'var(--space-5)', borderTop: '1px solid var(--glass-border-subtle)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-text)', margin: 0 }}>
            数据管理
          </p>
          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', margin: '4px 0 0', lineHeight: 1.6 }}>
            清理指向已删除项目的无效会话记录，回收本地存储空间。
          </p>
        </div>
        <button
          onClick={handleCleanOrphanSessions}
          disabled={cleaningSessions}
          data-ai-id="session-clean-orphans-button"
          style={{
            flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
            fontSize: 'var(--font-size-xs)', fontWeight: 500, color: 'var(--color-text-muted)',
            padding: '6px var(--space-4)', borderRadius: 'var(--radius-full)',
            background: 'transparent', border: '1px solid var(--color-border)',
            cursor: cleaningSessions ? 'wait' : 'pointer', fontFamily: 'inherit',
            opacity: cleaningSessions ? 0.7 : 1, whiteSpace: 'nowrap',
          }}
        >
          {cleaningSessions ? '清理中…' : '清理无效会话'}
        </button>
      </div>

      {sessionCleanNotice && (
        <p
          data-ai-id="session-clean-notice"
          role="status"
          style={{
            width: '100%', maxWidth: 780, margin: 'var(--space-3) 0 0',
            fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', lineHeight: 1.6,
          }}
        >
          {sessionCleanNotice}
        </p>
      )}

      {/* 删除二次确认弹窗 */}
      {deletingProject && (
        <DeleteConfirmModal
          project={deletingProject}
          onCancel={() => setDeletingProject(null)}
          onConfirm={handleDeleteConfirm}
        />
      )}
    </div>
  )
}

/* =========================================================================
   TabButton / ActionButton / ProjectRow / DeleteConfirmModal
   ========================================================================= */

const TabButton: React.FC<{ label: string; dataAiId: string; active: boolean; onClick: () => void }> = ({
  label,
  dataAiId,
  active,
  onClick,
}) => (
  <button
    data-ai-id={dataAiId}
    onClick={onClick}
    aria-pressed={active}
    style={{
      fontSize: 'var(--font-size-sm)',
      fontWeight: active ? 600 : 500,
      color: active ? 'var(--color-quick)' : 'var(--color-text-muted)',
      padding: 'var(--space-2) var(--space-4)',
      borderRadius: 'var(--radius-full)',
      background: active ? 'var(--color-quick-soft)' : 'transparent',
      border: 'none',
      cursor: 'pointer',
      transition: 'all var(--transition-fast)',
    }}
  >
    {label}
  </button>
)

const ActionButton: React.FC<{
  label: string
  dataAiId: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}> = ({ label, dataAiId, onClick, danger, disabled }) => (
  <button
    data-ai-id={dataAiId}
    disabled={disabled}
    onClick={(e) => {
      e.stopPropagation()
      if (disabled) return
      onClick()
    }}
    style={{
      fontSize: 'var(--font-size-xs)',
      fontWeight: 500,
      color: danger ? 'var(--color-danger)' : 'var(--color-text-muted)',
      padding: '4px var(--space-3)',
      borderRadius: 'var(--radius-full)',
      background: 'transparent',
      border: `1px solid ${danger ? 'var(--color-danger)' : 'var(--color-border)'}`,
      cursor: disabled ? 'not-allowed' : 'pointer',
      whiteSpace: 'nowrap',
      transition: 'all var(--transition-fast)',
      fontFamily: 'inherit',
      opacity: disabled ? 0.6 : 1,
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.background = danger ? 'var(--color-danger-soft)' : 'var(--glass-bg-soft)'
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.background = 'transparent'
    }}
  >
    {label}
  </button>
)

const ProjectRow: React.FC<{
  project: Project
  isCurrent: boolean
  onResume: () => void
  actions?: React.ReactNode
  renaming?: boolean
  renameValue?: string
  renameSubmitting?: boolean
  onRenameValueChange?: (value: string) => void
  onRenameSubmit?: () => void
  onRenameCancel?: () => void
}> = ({
  project,
  isCurrent,
  onResume,
  actions,
  renaming,
  renameValue,
  renameSubmitting,
  onRenameValueChange,
  onRenameSubmit,
  onRenameCancel,
}) => {
  // 审计 B-07（2026-10-04）：桌面项目进行中 current_stage 长期停在 clarifying，一律显示
  //「等待你确认几个问题」无法区分选型/实现/验收——桌面项目改显 desktop_phase 全名。
  const stageLabel = project.template_type === 'desktop_tool' && project.desktop_phase
    ? desktopPhaseFullLabel(project.desktop_phase)
    : STAGE_LABEL_MAP[project.current_stage] ?? project.current_stage
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

  const projectIcon = (
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
  )

  return (
    <div
      data-ai-id="project-list-item"
      className="tile"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--space-3)',
        padding: 'var(--space-4) var(--space-5)',
        textAlign: 'left',
        animation: 'tile-enter 0.3s ease both',
        transition: 'all var(--transition-fast)',
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
      {/* 行主体：重命名态渲染内联表单，否则点击恢复项目 */}
      {renaming ? (
        <form
          data-ai-id="project-rename-form"
          onSubmit={(e) => {
            e.preventDefault()
            onRenameSubmit?.()
          }}
          style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minWidth: 0,
            flex: 1,
          }}
        >
          {projectIcon}
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => onRenameValueChange?.(e.target.value)}
            placeholder="输入新名称"
            aria-label="项目新名称"
            data-ai-id="project-rename-input"
            maxLength={32}
            style={{
              flex: 1, minWidth: 0, height: 34,
              fontSize: 'var(--font-size-sm)', color: 'var(--color-text)',
              padding: '0 var(--space-3)', borderRadius: 'var(--radius-md)',
              background: 'var(--glass-bg-soft)', border: '1px solid var(--color-quick)',
              outline: 'none', fontFamily: 'inherit',
            }}
          />
          <button
            type="submit"
            disabled={renameSubmitting}
            data-ai-id="project-rename-submit"
            style={{
              fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--white)',
              padding: '6px var(--space-3)', borderRadius: 'var(--radius-full)',
              background: 'var(--color-quick)', border: 'none',
              cursor: renameSubmitting ? 'wait' : 'pointer', fontFamily: 'inherit',
              whiteSpace: 'nowrap', opacity: renameSubmitting ? 0.7 : 1,
            }}
          >
            {renameSubmitting ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            onClick={onRenameCancel}
            data-ai-id="project-rename-cancel"
            style={{
              fontSize: 'var(--font-size-xs)', fontWeight: 500, color: 'var(--color-text-muted)',
              padding: '6px var(--space-3)', borderRadius: 'var(--radius-full)',
              background: 'transparent', border: '1px solid var(--color-border)',
              cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
            }}
          >
            取消
          </button>
        </form>
      ) : (
        <button
          onClick={onResume}
          style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-4)', minWidth: 0,
            flex: 1, textAlign: 'left', background: 'transparent', border: 'none',
            cursor: 'pointer', padding: 0, fontFamily: 'inherit',
          }}
        >
          {projectIcon}

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
                  maxWidth: 200,
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
            {project.progress_summary && (
              <p
                data-ai-id="project-progress-summary"
                style={{
                  margin: '2px 0 0',
                  fontSize: 'var(--font-size-xs)',
                  color: 'var(--color-text-muted)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: 360,
                }}
              >
                最近：{project.progress_summary}
              </p>
            )}
          </div>
        </button>
      )}

      {/* 右侧：时间 + 操作按钮 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexShrink: 0 }}>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
          {formattedDate}
        </span>
        <ArrowRight size={16} style={{ color: 'var(--color-text-muted)', display: 'none' }} />
        {actions}
      </div>
    </div>
  )
}

const DeleteConfirmModal: React.FC<{
  project: Project
  onCancel: () => void
  onConfirm: () => void
}> = ({ project, onCancel, onConfirm }) => (
  <div
    role="dialog"
    aria-modal="true"
    data-ai-id="project-delete-confirm-modal"
    style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.4)',
    }}
  >
    <div
      style={{
        background: 'var(--color-surface)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)',
        padding: 'var(--space-6)',
        width: 'min(420px, 90vw)',
      }}
    >
      <h3 style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--color-text)', marginBottom: 'var(--space-3)' }}>
        删除「{project.name}」？
      </h3>
      <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)', lineHeight: 1.6, marginBottom: 'var(--space-6)' }}>
        删除后无法恢复：项目文件、快照和对话记录都会被清除。确定要删除吗？
      </p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)' }}>
        <button
          onClick={onCancel}
          style={{
            fontSize: 'var(--font-size-sm)', fontWeight: 500, color: 'var(--color-text)',
            padding: '8px var(--space-4)', borderRadius: 'var(--radius-full)',
            background: 'var(--glass-bg-soft)', border: '1px solid var(--color-border)',
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          取消
        </button>
        <button
          onClick={onConfirm}
          data-ai-id="project-delete-confirm-button"
          style={{
            fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--white)',
            padding: '8px var(--space-4)', borderRadius: 'var(--radius-full)',
            background: 'var(--color-danger)', border: 'none',
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          确认删除
        </button>
      </div>
    </div>
  </div>
)

/* =========================================================================
   EmptyState
   ========================================================================= */

const EmptyState: React.FC<{ onNewProject: () => void; tabLabel: string }> = ({ onNewProject, tabLabel }) => (
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
      {tabLabel === '已归档' ? '还没有已归档的项目' : '还没有项目'}
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
      {tabLabel === '已归档'
        ? '归档的项目会出现在这里，可以随时恢复或删除。'
        : '你还没有创建过任何项目。点击下方按钮，选择一个模式开始你的第一个项目吧。'}
    </p>
    {tabLabel !== '已归档' && (
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
    )}
  </div>
)

export default ProjectHistoryPage
