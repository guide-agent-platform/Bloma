import React from 'react'
import { useAtom } from 'jotai'
import { ModeCard } from './ModeCard'
import { projectModeAtom, modeSelectedAtom, currentProjectAtom } from './atoms'
import '../styles/theatre.css'
import brandIcon from '../../resources/branding/icon.png'

export interface ModeSelectionPageProps {
  onBackToHistory?: () => void
  onModeSelected: (mode: 'quick' | 'longterm', idea?: string) => void | Promise<void>
}

export const ModeSelectionPage: React.FC<ModeSelectionPageProps> = ({ onBackToHistory, onModeSelected }) => {
  const [, setMode] = useAtom(projectModeAtom)
  const [, setSelected] = useAtom(modeSelectedAtom)
  const [, setProject] = useAtom(currentProjectAtom)
  const [idea, setIdea] = React.useState('')
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
  return <main className="idea-start" data-ai-id="mode-selection-page">
    <header><span className="theatre-brand"><span className="theatre-brandmark" aria-hidden><img src={brandIcon} alt="" /></span>Bloma</span>{onBackToHistory && <button type="button" className="theatre-tool" onClick={onBackToHistory}>返回项目列表</button>}</header>
    <section className="idea-start-content">
      <p className="theatre-eyebrow">从一个想法，到你的软件</p>
      <h1>你想做什么样的软件？</h1>
      <p>先说你想解决什么。细节，可以一起补齐。</p>
      <div className="idea-start-input"><textarea aria-label="你的软件想法" placeholder="例如：一个安静的专注计时器，能记住今天专注了多久…" value={idea} disabled={selecting} onChange={event => setIdea(event.target.value)} /></div>
      {error && <p role="alert" style={{color:'var(--color-danger)'}}>{error}</p>}
      <div className="idea-modes"><ModeCard mode="quick" title="快速做一个试试" description="适合一次性小工具。先做出能用的版本，再看看是否喜欢。" helperText="以后也能转为长期维护" badge="新手推荐" onSelect={start} disabled={selecting} /><ModeCard mode="longterm" title="认真打磨一个产品" description="适合长期使用、持续改进。关键节点一起确认，一步步打磨。" helperText="关键节点由你确认" onSelect={start} disabled={selecting} /></div>
    </section>
  </main>
}
