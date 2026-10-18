import React from 'react'
import clarify from '../../resources/studio/guide-clarify-v2.webp'
import prd from '../../resources/studio/guide-prd-v2.webp'
import { characterCueKey } from '../lib/character-cues'
import { useCharacterReveal } from '../hooks/use-character-reveal'
import '../styles/character-cues.css'

const portraits = { clarify, requirements: prd, prd }
const captions = {
  clarify: '我把需要你选择的地方展开给你。',
  requirements: '先看看有没有漏掉你在意的事。',
  prd: '需求说明整理好了，交给你来确认。',
}

export const CharacterDecisionStage: React.FC<{
  kind: keyof typeof portraits
  cue: unknown
  children: React.ReactNode
}> = ({ kind, cue, children }) => {
  const key = React.useMemo(() => characterCueKey(kind, cue), [kind, cue])
  const actor = React.useRef<HTMLDivElement>(null)
  const card = React.useRef<HTMLDivElement>(null)
  const finish = useCharacterReveal(key, actor, card)
  return <div className="character-decision-stage" data-ai-id="character-decision-stage" data-kind={kind} onPointerDownCapture={finish} onKeyDownCapture={finish}>
    <div className="character-presented-card" ref={card}>{children}</div>
    <aside className="character-presenter" aria-hidden="true"><div className="character-presenter-caption">{captions[kind]}</div><div ref={actor} className="character-presenter-art"><img src={portraits[kind]} alt="" /></div></aside>
  </div>
}
