import React from 'react'
import sketch from '../../resources/studio/guide-sketch-v2.webp'
import { characterCueKey, hasCharacterCue, rememberCharacterCue } from '../lib/character-cues'
import { useCharacterReveal } from '../hooks/use-character-reveal'
import { X } from './icons'
import '../styles/character-cues.css'

export const SketchCharacterReminder: React.FC<{ cue: string }> = ({ cue }) => {
  const key = characterCueKey('sketch', cue)
  const [dismissedKey, setDismissed] = React.useState<string | null>(null)
  const dismissed = dismissedKey === key || hasCharacterCue(`dismissed:${key}`)
  const actor = React.useRef<HTMLDivElement>(null)
  const finish = useCharacterReveal(key, actor, undefined, !dismissed)
  if (dismissed) return null
  return <aside className="sketch-character-reminder" data-ai-id="sketch-character-reminder" aria-label="人物草图提醒">
    <p><span role="status">草图准备好啦，看看是不是你想要的？</span><button type="button" aria-label="收起角色提醒" onClick={() => { finish(); rememberCharacterCue(`dismissed:${key}`); setDismissed(key) }}><X size={13} /></button></p>
    <div ref={actor} className="sketch-character-art" aria-hidden="true"><img src={sketch} alt="" /></div>
  </aside>
}
