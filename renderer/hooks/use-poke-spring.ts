import { useEffect, useRef } from 'react'

/** Animate the artwork, keeping the button stationary so rapid clicks remain reliable. */
export function usePokeSpring() {
  const animation = useRef<Animation>()
  useEffect(() => () => animation.current?.cancel(), [])
  return (element: HTMLElement | null) => {
    if (!element) return
    const current = getComputedStyle(element).transform
    animation.current?.cancel()
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || !element.animate) return
    animation.current = element.animate([
      { transform: !current || current === 'none' ? 'translateY(0) scale(1) rotate(0deg)' : current, offset: 0 },
      { transform: 'translateY(4px) scale(1.10,.89) rotate(-.8deg)', offset: .14 },
      { transform: 'translateY(-10px) scale(.95,1.07) rotate(1.1deg)', offset: .32 },
      { transform: 'translateY(2px) scale(1.035,.98) rotate(-.6deg)', offset: .51 },
      { transform: 'translateY(-2px) scale(.99,1.015) rotate(.25deg)', offset: .69 },
      { transform: 'translateY(.5px) scale(1.005,.996) rotate(0deg)', offset: .85 },
      { transform: 'translateY(0) scale(1) rotate(0deg)', offset: 1 },
    ], { duration: 640, easing: 'cubic-bezier(.22,.8,.3,1)' })
  }
}
