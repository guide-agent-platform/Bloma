import { useEffect, useState, type RefObject } from 'react'
import { PREVIEW_POINTER_EVENT, type PreviewPointer } from '../../shared/sketch-viewport'
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

/** Cosmetic local pointing only. No character limb cuts, React mousemove renders,
 * IPC, telemetry or model requests. The frame relay authenticates its token. */
export function usePreviewPointing(preview: RefObject<HTMLElement> | undefined, actor: RefObject<HTMLElement>, arm: RefObject<SVGGElement>, enabled: boolean) {
  const [available, setAvailable] = useState(true)
  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)'), coarse = window.matchMedia?.('(pointer: coarse)')
    let frame = 0, latest: PreviewPointer | undefined
    const draw = (angle = 0, tracking = false) => {
      arm.current?.setAttribute('transform', `rotate(${angle} 630 680)`)
      actor.current?.setAttribute('data-tracking', String(tracking))
    }
    const update = () => {
      frame = 0
      const target = preview?.current, figure = actor.current
      if (!enabled || reduced?.matches || coarse?.matches || document.hidden || !latest?.inside || !target || !figure?.getClientRects().length) { draw(); return }
      const bounds = target.getBoundingClientRect()
      if (latest.clientX < bounds.left || latest.clientX > bounds.right || latest.clientY < bounds.top || latest.clientY > bounds.bottom) { draw(); return }
      const x = clamp((latest.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1)
      const y = clamp((latest.clientY - bounds.top) / Math.max(1, bounds.height), 0, 1)
      draw(clamp(-10 + y * 20 + (x - .5) * 2, -12, 12), true)
    }
    const schedule = (point: PreviewPointer) => { latest = point; if (!frame) frame = requestAnimationFrame(update) }
    const move = (event: PointerEvent) => schedule({ clientX: event.clientX, clientY: event.clientY, inside: event.target instanceof Node && Boolean(preview?.current?.contains(event.target)) })
    const relay = (event: Event) => {
      const point = (event as CustomEvent<PreviewPointer>).detail
      if (point && Number.isFinite(point.clientX) && Number.isFinite(point.clientY) && typeof point.inside === 'boolean') schedule(point)
    }
    const stop = () => { if (frame) cancelAnimationFrame(frame); frame = 0; latest = undefined; draw() }
    const preference = () => { setAvailable(!reduced?.matches && !coarse?.matches); stop() }
    preference()
    if (enabled) {
      window.addEventListener('pointermove', move, { passive: true }); window.addEventListener(PREVIEW_POINTER_EVENT, relay)
      window.addEventListener('blur', stop); document.addEventListener('visibilitychange', stop)
    }
    reduced?.addEventListener?.('change', preference); coarse?.addEventListener?.('change', preference)
    return () => {
      window.removeEventListener('pointermove', move); window.removeEventListener(PREVIEW_POINTER_EVENT, relay)
      window.removeEventListener('blur', stop); document.removeEventListener('visibilitychange', stop)
      reduced?.removeEventListener?.('change', preference); coarse?.removeEventListener?.('change', preference); stop()
    }
  }, [preview, actor, arm, enabled])
  return available
}
