import React from 'react'
import { Scan } from './icons'
import { injectSketchViewport, stripSketchReviewChrome, PREVIEW_POINTER_EVENT } from '../../shared/sketch-viewport'

const DESIGN = { width: 1280, height: 800 }

export function sketchFitScale(width: number, height: number, natural = false, page = DESIGN): number {
  return natural ? 1 : Math.min(Math.max(1, width) / page.width, Math.max(1, height) / page.height, 1)
}

/** Preserve the design layout while fitting the whole document into the available canvas. */
export const SketchViewport: React.FC<{ src?: string; html?: string; readOnly?: boolean; confirmed?: boolean; natural?: boolean; iframeRef?: React.Ref<HTMLIFrameElement>; onError?: () => void }> = ({ src, html, readOnly = false, confirmed = false, natural = false, iframeRef, onError }) => {
  const surface = React.useRef<HTMLDivElement>(null)
  const frame = React.useRef<HTMLIFrameElement | null>(null)
  const [size, setSize] = React.useState(DESIGN)
  const [page, setPage] = React.useState(DESIGN)
  const [zoom, setZoom] = React.useState<number | null>(null)
  const [responsive, setResponsive] = React.useState(false)
  const [marking, setMarking] = React.useState(false)
  const token = React.useMemo(() => crypto.randomUUID(), [src, html])
  const source = React.useMemo(() => {
    if (!src?.startsWith('bloma-file:')) return src
    const url = new URL(src); url.searchParams.set('bloma-viewport', '1'); url.searchParams.set('bloma-readonly', readOnly || !marking ? '1' : '0'); return url.href
  }, [src, readOnly, marking])
  const sourceHtml = React.useMemo(() => html === undefined ? undefined : injectSketchViewport(readOnly || !marking ? stripSketchReviewChrome(html) : html), [html, readOnly, marking])
  React.useEffect(() => { setPage(DESIGN); setZoom(null); setResponsive(false) }, [src, html])
  React.useEffect(() => setMarking(false), [src, html, readOnly])
  React.useEffect(() => {
    const element = surface.current
    if (!element) return
    const measure = () => {
      const width = element.clientWidth - 24, height = element.clientHeight - 24
      if (width > 0 && height > 0) setSize({ width, height })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure) }
    const observer = new ResizeObserver(measure); observer.observe(element)
    return () => observer.disconnect()
  }, [])
  React.useEffect(() => {
    const receive = (event: MessageEvent) => {
      const data = event.data
      if (event.source !== frame.current?.contentWindow || data?.token !== token) return
      if (data.type === PREVIEW_POINTER_EVENT) {
        if (typeof data.inside !== 'boolean' || typeof data.x !== 'number' || typeof data.y !== 'number' || !Number.isFinite(data.x) || !Number.isFinite(data.y) || data.x < 0 || data.x > 1 || data.y < 0 || data.y > 1) return
        const rect = frame.current?.getBoundingClientRect()
        if (rect) window.dispatchEvent(new CustomEvent(PREVIEW_POINTER_EVENT, { detail: { clientX: rect.left + data.x * rect.width, clientY: rect.top + data.y * rect.height, inside: data.inside } }))
        return
      }
      if (data.type !== 'bloma-viewport-size') return
      if (typeof data.width !== 'number' || typeof data.height !== 'number' || !Number.isFinite(data.width) || !Number.isFinite(data.height) || data.width < 1280 || data.height < 800 || data.width > 100000 || data.height > 100000) return
      setPage({ width: data.width, height: data.height })
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [token])
  const fluid = responsive && !natural
  const fit = zoom === null && !natural && !fluid
  const scale = natural || fluid ? 1 : zoom ?? sketchFitScale(size.width, size.height, false, page)
  const dimensions = fluid ? size : natural ? DESIGN : page
  const resetScroll = () => { if (surface.current) { surface.current.scrollTop = 0; surface.current.scrollLeft = 0 } }
  React.useLayoutEffect(() => { if (fit) resetScroll() }, [fit, scale])
  return <div className="sketch-viewport" data-ai-id="sketch-viewport" data-fit={fit}>
    <div className="sketch-toolbar"><span>{natural ? '点选模式 · 原尺寸' : fluid ? '按当前窗口展示 · 可直接查看细节' : scale < .55 ? '完整画布缩略图 · 可切换适应窗口' : confirmed ? '已确认的界面 · 回看' : readOnly ? '仅查看' : '草图独立视口'}</span><div>
      <button type="button" className="theatre-tool" disabled={natural} onClick={() => { setResponsive(true); setZoom(null); resetScroll() }} aria-pressed={fluid}>适应窗口</button>
      <button type="button" className="theatre-tool" disabled={natural} onClick={() => { setResponsive(false); setZoom(null); resetScroll() }} aria-pressed={fit} title="将完整草图缩放到画布内"><Scan size={13} />完整画布</button>
      <button type="button" className="theatre-tool" disabled={natural} onClick={() => { setResponsive(false); setZoom(1); resetScroll() }} aria-pressed={!fluid && (zoom === 1 || natural)}>原尺寸</button>
      <button type="button" className="theatre-tool" aria-label="缩小草图" disabled={natural || scale <= .02} onClick={() => { setResponsive(false); setZoom(Math.max(.02, scale / 1.25)) }}>−</button>
      <span className="sketch-scale" aria-live="polite">{Math.round(scale * 100)}%</span>
      <button type="button" className="theatre-tool" aria-label="放大草图" disabled={natural || scale >= 2} onClick={() => { setResponsive(false); setZoom(Math.min(2, scale * 1.25)) }}>+</button>
      {!readOnly && <button type="button" className="theatre-tool" disabled={natural} aria-pressed={marking} onClick={() => setMarking(value => !value)}>{marking ? '退出点选' : '点选修改'}</button>}
    </div></div>
    <div ref={surface} className="sketch-surface"><div className="sketch-page" style={{ width: dimensions.width * scale, height: dimensions.height * scale }}><iframe key={token} ref={element => {
      frame.current = element
      if (typeof iframeRef === 'function') iframeRef(element)
      else if (iframeRef) (iframeRef as React.MutableRefObject<HTMLIFrameElement | null>).current = element
    }} src={source} srcDoc={sourceHtml} title={confirmed ? '已确认的界面草图' : '软件预览'} sandbox={readOnly ? 'allow-scripts' : 'allow-scripts allow-forms allow-same-origin'} onError={onError} onLoad={() => frame.current?.contentWindow?.postMessage({ type: 'bloma-viewport-measure', token }, '*')} style={{ width: dimensions.width, height: dimensions.height, transform: `scale(${scale})`, transformOrigin: 'top left' }} /></div></div>
  </div>
}
