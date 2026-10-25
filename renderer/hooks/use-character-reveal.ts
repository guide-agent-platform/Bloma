import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { hasCharacterCue, rememberCharacterCue } from '../lib/character-cues'

/** Short, cancellable presentation only. User input always keeps the existing handlers. */
export function useCharacterReveal(key: string, actor: RefObject<HTMLElement>, card?: RefObject<HTMLElement>, enabled = true, entry: 'slide' | 'rise' = 'slide') {
  const animations = useRef<Animation[]>([])
  const stopped = useRef(false)
  const finish = () => { stopped.current = true; animations.current.forEach(animation => animation.cancel()); animations.current = [] }
  useEffect(() => {
    stopped.current = false
    if (!enabled || hasCharacterCue(`played:${key}`)) return
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    let cancelled = false
    const animate = (target: HTMLElement | null | undefined, frames: Keyframe[], options: KeyframeAnimationOptions) => {
      if (target?.animate) animations.current.push(target.animate(frames, options))
    }
    // StrictMode's trial mount must not consume the cue before the real effect can play it.
    queueMicrotask(() => {
      if (cancelled || stopped.current || hasCharacterCue(`played:${key}`)) return
      rememberCharacterCue(`played:${key}`)
      if (media?.matches) return
      animate(actor.current, entry === 'rise'
        ? [{ transform: 'translateY(92px) scale(.96)', opacity: 0 }, { transform: 'translateY(-3px)', opacity: 1, offset: .85 }, { transform: 'translateY(0)', opacity: 1 }]
        : [{ transform: 'translateX(26px)', opacity: 0 }, { transform: 'translateX(-3px)', opacity: 1, offset: .8 }, { transform: 'translateX(0)', opacity: 1 }], { duration: entry === 'rise' ? 660 : 560, easing: 'cubic-bezier(.2,.8,.3,1)' })
      animate(card?.current, [{ transform: 'translate(16px,20px) scale(.12,.18)', opacity: 0 }, { transform: 'translate(2px,-2px) scale(.99,1.01)', opacity: 1, offset: .8 }, { transform: 'none', opacity: 1 }], { duration: 640, delay: 220, fill: 'backwards', easing: 'cubic-bezier(.2,.8,.3,1)' })
    })
    const onPreference = () => { if (media?.matches) finish() }
    media?.addEventListener?.('change', onPreference)
    return () => { cancelled = true; finish(); media?.removeEventListener?.('change', onPreference) }
  }, [key, enabled, entry])
  return finish
}
