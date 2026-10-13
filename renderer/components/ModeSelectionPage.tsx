import React from 'react'
import { useAtom } from 'jotai'
import { StudioCompanion } from './StudioCompanion'
import { StudioPageFrame } from './StudioPageFrame'
import { Sparkles, Zap, Gem, ArrowRight, FileText } from './icons'
import type { Project } from '../../shared/types'
import { desktopPhaseFullLabel } from '../lib/desktop-stages'
import { STAGE_LABEL_MAP } from './atoms'
import { projectModeAtom, modeSelectedAtom, currentProjectAtom } from './atoms'
import '../styles/theatre.css'

export interface ModeSelectionPageProps {
  onBackToHistory?: () => void
  onOpenSettings?: () => void
  onBackToWorkspace?: () => void
  onResumeProject?: (project: Project) => void
  projects?: Project[]
  initialIdea?: string
  initialMode?: 'quick' | 'longterm'
  onIdeaChange?: (idea: string) => void
  onModeChange?: (mode: 'quick' | 'longterm') => void
  onModeSelected: (mode: 'quick' | 'longterm', idea?: string) => void | Promise<void>
}

export const ModeSelectionPage: React.FC<ModeSelectionPageProps> = ({ onBackToHistory, onModeSelected, onOpenSettings, onBackToWorkspace, onResumeProject, projects = [], initialIdea = '', initialMode = 'quick', onIdeaChange, onModeChange }) => {
  const [, setMode] = useAtom(projectModeAtom)
  const [, setSelected] = useAtom(modeSelectedAtom)
  const [, setProject] = useAtom(currentProjectAtom)
  const [idea, setIdeaValue] = React.useState(initialIdea)
  const [selectedMode, setModeValue] = React.useState<'quick' | 'longterm'>(initialMode)
  const setIdea = (value: string) => { setIdeaValue(value); onIdeaChange?.(value) }
  const setSelectedMode = (value: 'quick' | 'longterm') => { setModeValue(value); onModeChange?.(value) }
  const [selecting, setSelecting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const lock = React.useRef(false)
  const start = async (mode: 'quick' | 'longterm') => {
    if (lock.current) return
    lock.current=true; setSelecting(true); setError(null)
    try {
      const api=window.electronAPI
      if (!api?.project?.create) { setError('当前环境无法创建项目，请通过桌面应用启动。'); return }
      const text=idea.trim()
      const result=await api.project.create({request_id:crypto.randomUUID(),mode,...(text ? {initial_message:text} : {})})
      if (!result.ok) { setError(result.error?.user_visible_message ?? '项目创建失败，请重试。'); return }
      setProject(result.data); setMode(mode); setSelected(true)
      if (text) await onModeSelected(mode,text); else await onModeSelected(mode)
    } catch { setError('项目创建失败，请重试。') }
    finally { lock.current=false; setSelecting(false) }
  }
  const recent = [...projects].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)).slice(0, 2)
  return <StudioPageFrame active="home" mode={selectedMode} onProjects={onBackToHistory} onWorkspace={onBackToWorkspace} onSettings={onOpenSettings}><main className="idea-start" data-ai-id="mode-selection-page">
    <header className="studio-page-chrome"><span>主页面</span><span>从想法到作品</span></header>
    <section className="idea-start-content">
      <div className="studio-home-intro"><div><p className="theatre-eyebrow"><Sparkles size={13} />给每个小小的想法，一点光</p><h1>把一个想法，<br />做成喜欢的作品。</h1><p className="studio-home-description">说说你想解决什么。剩下的，我们一起补齐。</p></div><StudioCompanion /></div>
      <div className="idea-start-input">
        <textarea aria-label="你的软件想法" placeholder="例如，一个安静的专注计时器，能记住我今天专注了多久…" value={idea} disabled={selecting} onChange={event => setIdea(event.target.value)} />
        <div className="studio-idea-actions">
          <div className="studio-mode-picker" role="group" aria-label="制作模式">
            {(['quick', 'longterm'] as const).map(mode => <div key={mode} data-ai-id={`mode-card-${mode}`} role="group" aria-label={mode === 'quick' ? '快速做一个试试（快速尝鲜）' : '认真打磨一个产品（精细打磨）'} onClick={event => { if (event.target === event.currentTarget && !selecting) setSelectedMode(mode) }}>
              <button type="button" disabled={selecting} aria-pressed={selectedMode === mode} onClick={() => setSelectedMode(mode)}>{mode === 'quick' ? <Zap size={14} /> : <Gem size={14} />}{mode === 'quick' ? '快速型' : '长期型'}</button>
            </div>)}
          </div>
          <button type="button" data-ai-id="create-project-button" className="studio-primary" aria-label={selectedMode === 'quick' ? '开始：快速做一个试试' : '开始：认真打磨一个产品'} disabled={selecting} onClick={() => start(selectedMode)}>{selecting ? '正在创建…' : '开始制作'}<ArrowRight size={14} /></button>
        </div>
      </div>
      {error && <p role="alert" style={{color:'var(--color-danger)'}}>{error}</p>}
      <p className="studio-mode-help" aria-live="polite">{selectedMode === 'quick' ? <>先做一个能用的版本，再慢慢调整。<span>以后也能转为长期维护</span></> : '关键节点一起确认，从需求、界面到试用，一步步认真打磨。'}</p>
      <div className="studio-idea-examples">{[{ label: '专注计时器', text: '一个安静的专注计时器，能记住我今天专注了多久。' }, { label: '日常记账本', text: '一个简单的日常记账本，可以记录开销，查看每月花费。' }, { label: '课程规划', text: '一个课程规划工具，可以安排每周的课程和作业。' }].map(example => <button key={example.label} type="button" className="theatre-tool" disabled={selecting} onClick={() => setIdea(example.text)}>{example.label}</button>)}</div>
      {recent.length > 0 && onResumeProject && <section className="studio-recent-projects" aria-label="最近项目"><div className="studio-recent-heading"><h2>继续上次的想法</h2><button type="button" className="theatre-tool" onClick={onBackToHistory}>查看全部<ArrowRight size={13} /></button></div><div className="studio-recent-grid">{recent.map(project => <button type="button" key={project.project_id} className="studio-recent-project" onClick={() => onResumeProject(project)}><span className="studio-recent-icon"><FileText size={23} /></span><span><strong>{project.name}</strong><small>{project.mode === 'quick' ? '快速型' : '长期型'} · {project.desktop_phase ? desktopPhaseFullLabel(project.desktop_phase) : STAGE_LABEL_MAP[project.current_stage] ?? project.current_stage}</small></span><ArrowRight size={14} /></button>)}</div></section>}
    </section>
  </main></StudioPageFrame>
}
