import React from 'react'
import { Scan } from './icons'

export function sketchFitScale(width: number, _height: number, natural = false): number {
  // Fit horizontally and let the surface scroll vertically. Shrinking an
  // entire tall page into a short window would make its text unreadable.
  return natural ? 1 : Math.max(.1, Math.min(width / 1280, 1.5))
}

/** Keep the generated layout at a stable design viewport, scaling its surface instead of reflowing it. */
export const SketchViewport: React.FC<{ src?: string; html?: string; readOnly?: boolean; natural?: boolean; iframeRef?: React.Ref<HTMLIFrameElement>; onError?: () => void }> = ({ src, html, readOnly = false, natural = false, iframeRef, onError }) => {
  const surface = React.useRef<HTMLDivElement>(null)
  const [size, setSize] = React.useState({ width: 1280, height: 800 })
  const [original, setOriginal] = React.useState(false)
  React.useEffect(() => {
    const element = surface.current
    if (!element) return
    const measure = () => { const width = element.clientWidth, height = element.clientHeight; if (width > 0 && height > 0) setSize({ width, height }) }
    measure()
    if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure) }
    const observer = new ResizeObserver(measure); observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const scale = sketchFitScale(size.width, size.height, natural || original)
  return <div className="sketch-viewport" data-ai-id="sketch-viewport">
    <div className="sketch-toolbar"><span>{scale < .55 ? '预览较小，建议专注预览或原尺寸' : readOnly ? '已确认的界面 · 回看' : '草图独立视口'}</span><div><button type="button" className="theatre-tool" onClick={() => setOriginal(false)} aria-pressed={!original}><Scan size={13} />适应画布</button><button type="button" className="theatre-tool" onClick={() => setOriginal(true)} aria-pressed={original}>原尺寸</button><span>{Math.round(scale * 100)}%</span></div></div>
    <div ref={surface} className="sketch-surface"><div className="sketch-page" style={{ width: 1280 * scale, height: 800 * scale }}><iframe ref={iframeRef} src={src} srcDoc={html} title={readOnly ? '已确认的界面草图' : '软件预览'} sandbox={readOnly ? 'allow-scripts' : 'allow-scripts allow-forms allow-same-origin'} onError={onError} style={{ width: 1280, height: 800, transform: `scale(${scale})`, transformOrigin: 'top left' }} /></div></div>
  </div>
}
