import React from 'react'
import { createPortal } from 'react-dom'
import requirements from '../../resources/studio/stage-comics-v2/requirements.thumb.webp'
import design from '../../resources/studio/stage-comics-v2/design.thumb.webp'
import build from '../../resources/studio/stage-comics-v2/build.thumb.webp'
import verify from '../../resources/studio/stage-comics-v2/verify.thumb.webp'
import deliver from '../../resources/studio/stage-comics-v2/deliver.thumb.webp'
import type { WorkspaceProgressStep } from '../lib/workspace-progress'
import { X, FileText } from './icons'

const comics = { requirements, design, build, verify, deliver }
const labels = { pending: '未开始', active: '进行中', done: '已结束', attention: '需处理' }

export const WorkspaceProgress: React.FC<{
  steps: WorkspaceProgressStep[]
  liveDetail?: string
  onRecords: () => void
}> = ({ steps, liveDetail, onRecords }) => {
  const [open, setOpen] = React.useState<number | null>(null)
  const [comic, setComic] = React.useState(true)
  const [expanded, setExpanded] = React.useState(false)
  const [position, setPosition] = React.useState({ left: 8, top: 64 })
  const nav = React.useRef<HTMLElement>(null)
  const panel = React.useRef<HTMLDivElement>(null)
  const buttons = React.useRef<Array<HTMLButtonElement | null>>([])
  const timer = React.useRef<ReturnType<typeof setTimeout>>()
  const pinned = React.useRef(false)
  const restoringFocus = React.useRef(false)
  const id = React.useId()
  const close = React.useCallback(() => { clearTimeout(timer.current); pinned.current = false; setOpen(null); setExpanded(false) }, [])
  const show = (index: number) => { clearTimeout(timer.current); setOpen(index) }
  const leave = () => { if (!pinned.current) timer.current = setTimeout(close, 160) }
  React.useEffect(() => () => clearTimeout(timer.current), [])
  React.useEffect(() => {
    if (open === null) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!nav.current?.contains(target) && !panel.current?.contains(target)) close()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const button = buttons.current[open]
      close(); restoringFocus.current = true; button?.focus(); restoringFocus.current = false
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open, close])
  React.useLayoutEffect(() => {
    if (open === null) return
    const measure = () => {
      const anchor = buttons.current[open]?.getBoundingClientRect()
      if (!anchor) return
      const width = Math.min(expanded ? 700 : 400, window.innerWidth - 24)
      const height = panel.current?.getBoundingClientRect().height ?? 220
      setPosition({ left: Math.max(12, Math.min(window.innerWidth - width - 12, anchor.left + anchor.width / 2 - width / 2)), top: Math.max(8, Math.min(anchor.bottom + 8, window.innerHeight - height - 8)) })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (panel.current) observer?.observe(panel.current)
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [open, expanded, comic])
  const step = open === null ? undefined : steps[open]
  return <>
    <nav className="workspace-progress" aria-label="软件制作进度" ref={nav}>
      {steps.map((item, index) => <button key={item.key} type="button" ref={element => { buttons.current[index] = element }} data-ai-id={`progress-${item.key}`} data-state={item.state} data-moving={item.moving} aria-label={`${item.label}：${labels[item.state]}`} aria-current={item.state === 'active' || item.state === 'attention' ? 'step' : undefined} aria-expanded={open === index} aria-controls={open === index ? id : undefined}
        onPointerEnter={() => show(index)} onPointerLeave={leave} onFocus={() => { if (!restoringFocus.current) show(index) }} onBlur={event => { if (!panel.current?.contains(event.relatedTarget as Node)) leave() }} onClick={() => { if (pinned.current && open === index) close(); else { pinned.current = true; show(index) } }}>
        <span className="workspace-progress-label">{item.label}<small>{item.state === 'done' ? '✓' : item.state === 'attention' ? '!' : ''}</small></span><span className="workspace-progress-line" />
      </button>)}
    </nav>
    {step && createPortal(<div id={id} className="workspace-progress-popover" data-expanded={expanded} role="dialog" aria-label={`${step.label}阶段详情`} ref={panel} style={{ left: position.left, top: position.top }} onPointerEnter={() => clearTimeout(timer.current)} onPointerLeave={leave} onBlur={event => { if (!panel.current?.contains(event.relatedTarget as Node) && !nav.current?.contains(event.relatedTarget as Node)) leave() }}>
      <header><strong>{step.label}</strong><span data-state={step.state}>{labels[step.state]}</span><button type="button" onClick={() => setComic(value => !value)}>{comic ? '进展' : '小漫画'}</button><button type="button" aria-label="关闭阶段详情" onClick={close}><X size={14} /></button></header>
      {comic && <button type="button" className="workspace-comic" aria-label={expanded ? '缩小阶段漫画' : '放大阶段漫画'} onClick={() => { pinned.current = true; setExpanded(value => !value) }}><img src={comics[step.key]} alt={`${step.label}阶段三格小漫画`} /></button>}
      <p>{step.state === 'active' && liveDetail ? liveDetail : step.detail}</p>
      <button type="button" className="workspace-progress-records" onClick={() => { close(); onRecords() }}><FileText size={13} />工作记录</button>
    </div>, document.body)}
  </>
}
