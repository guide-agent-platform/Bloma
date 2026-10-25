import React from 'react'
import { characterCueKey, hasCharacterCue, rememberCharacterCue } from '../lib/character-cues'
import { useCharacterReveal } from '../hooks/use-character-reveal'
import { X } from './icons'
import { PointingGuide, type GuideMaterialState } from './PointingGuide'
import { usePreviewPointing } from '../hooks/use-preview-pointing'
import '../styles/character-cues.css'

export const SketchCharacterReminder: React.FC<{ cue: string; previewRef?: React.RefObject<HTMLElement> }> = ({ cue, previewRef }) => {
  const key = characterCueKey('sketch-pointing-layered-v1', cue)
  const [dismissedKey, setDismissed] = React.useState<string | null>(null)
  const dismissed = dismissedKey === key || hasCharacterCue(`dismissed:${key}`)
  const actor = React.useRef<HTMLDivElement>(null)
  const arm = React.useRef<SVGGElement>(null)
  const [material, setMaterial] = React.useState<GuideMaterialState>('loading')
  const [following, setFollowing] = React.useState(true)
  const available = usePreviewPointing(previewRef, actor, arm, following && !dismissed && material === 'ready')
  const finish = useCharacterReveal(key, actor, undefined, !dismissed, 'rise')
  if (dismissed) return null
  return <aside className="sketch-character-reminder guide-emergence" data-ai-id="sketch-character-reminder" aria-label="人物草图提醒">
    <div className="guide-emergence-label">Bloma · 请你确认</div>
    <button type="button" className="guide-emergence-close" aria-label="收起角色提醒" onClick={() => { finish(); rememberCharacterCue(`dismissed:${key}`); setDismissed(key) }}><X size={14} /></button>
    <div ref={actor} className="guide-emergence-actor" aria-hidden="true"><PointingGuide armRef={arm} onMaterialState={setMaterial} /></div>
    <p className="guide-emergence-caption"><span role="status">草图准备好啦，看看是不是你想要的？</span></p>
    <button type="button" className="guide-follow-toggle" disabled={!available || material !== 'ready'} aria-pressed={following && available && material === 'ready'} onClick={() => setFollowing(value => !value)}>{material === 'loading' ? '准备形象中' : material === 'fallback' || !available ? '静态引导' : following ? '暂停跟随' : '开启跟随'}</button>
    <div className="guide-emergence-edge" aria-hidden="true" />
  </aside>
}
