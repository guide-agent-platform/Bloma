import React from 'react'
import pointing from '../../resources/studio/guide-conversation-v1.webp'
import prd from '../../resources/studio/guide-prd-v2.webp'
import clarify from '../../resources/studio/guide-clarify-v2.webp'
import { characterCueKey } from '../lib/character-cues'

/** A stable visual for one reply; typing, resizing and history toggles never redraw it. */
export const ReplyCharacter: React.FC<{ cue: string; kind?: 'design' | 'requirements' | 'quiet' }> = ({ cue, kind = 'design' }) => {
  const pose = React.useMemo(() => kind === 'requirements' ? (parseInt(characterCueKey(kind, cue).split(':')[1]!, 16) % 2 ? prd : clarify) : pointing, [cue, kind])
  return <span className="conversation-reply-character" data-kind={kind} aria-hidden="true"><img src={pose} alt="" /></span>
}
