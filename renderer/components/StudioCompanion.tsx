import React from 'react'
import neutral from '../../resources/studio/guide-neutral.webp'
import wave from '../../resources/studio/guide-wave.webp'
import blush from '../../resources/studio/guide-blush.webp'
import fumo from '../../resources/studio/guide-fumo.webp'
import { Sparkles } from './icons'

/** The plush stays static: only the adult portrait reacts to clicks. */
export const StudioFumoAvatar: React.FC = () => <span className="studio-fumo-avatar" aria-hidden="true"><img src={fumo} alt="" /></span>

export const StudioFumoNote: React.FC = () => <div className="studio-fumo-note"><img src={fumo} alt="" aria-hidden="true" /><span>……我在。<br />你先想想。</span><Sparkles size={11} /></div>

export const StudioFumoEmpty: React.FC = () => <img className="studio-fumo-empty" src={fumo} alt="" aria-hidden="true" />

export const StudioCompanion: React.FC = () => {
  const [pose, setPose] = React.useState<'neutral' | 'wave' | 'blush'>('neutral')
  const [caption, setCaption] = React.useState('先写下来，我们慢慢来。')
  const recent = React.useRef<number[]>([])
  const timeout = React.useRef<ReturnType<typeof setTimeout>>()
  React.useEffect(() => () => { clearTimeout(timeout.current) }, [])
  const greet = () => {
    if (pose === 'blush') return
    const now = performance.now()
    recent.current = recent.current.filter(time => now - time < 4500)
    recent.current.push(now)
    const annoyed = recent.current.length >= 5
    setPose(annoyed ? 'blush' : 'wave')
    setCaption(annoyed ? '……不许再戳了。' : recent.current.length > 2 ? '听见了……别一直戳。' : '嗯？叫我？')
    clearTimeout(timeout.current)
    timeout.current = setTimeout(() => {
      setPose('neutral'); setCaption('先写下来，我们慢慢来。'); recent.current = []
    }, annoyed ? 3600 : 1800)
  }
  return <div className="studio-companion" data-ai-id="studio-companion" data-pose={pose}>
    <span className="studio-companion-orbit" aria-hidden="true" />
    <span className="studio-companion-star" aria-hidden="true"><Sparkles size={15} /></span>
    <button type="button" className="studio-companion-button" aria-label="和向导打个招呼" onClick={greet}>
      {/* Keep all poses in one fixed stage so changing the pose does not shift the layout. */}
      <img src={neutral} className="studio-companion-pose" data-pose="neutral" alt="成年女性向导，银紫头发，穿着紫色长裙，神情放空" aria-hidden={pose !== 'neutral'} />
      <img src={wave} className="studio-companion-pose" data-pose="wave" alt="向导轻微歪头，抬手回应" aria-hidden={pose !== 'wave'} />
      <img src={blush} className="studio-companion-pose" data-pose="blush" alt="向导脸红，举起拳头，假装生气" aria-hidden={pose !== 'blush'} />
    </button>
    <span className="studio-companion-caption" role="status">{caption}</span>
  </div>
}
