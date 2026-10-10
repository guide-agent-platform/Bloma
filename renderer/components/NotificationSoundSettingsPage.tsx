import React, { useState } from 'react'
import { Play } from './icons'
import {
  loadSoundSettings, playEventSound, saveSoundSettings, speakNotificationText,
  type NotificationSoundSettings, type SoundKind, type SoundPack, type SoundPlaybackResult,
} from '../lib/notification-sound'

const PACK_LABELS: Record<SoundPack, string> = { minimal: '极简', soft: '柔和', glass: '清脆' }
const EVENTS: { kind: SoundKind; label: string; detail: string; voice?: string }[] = [
  { kind: 'checkpoint', label: '需要确认', detail: '需求、审查选择题或操作授权出现时', voice: '有一项内容需要你确认' },
  { kind: 'blocked', label: '验收确认', detail: '界面草图或程序验收卡出现时', voice: '程序已准备好，请你确认' },
  { kind: 'complete', label: '项目完成', detail: '项目完成交付时', voice: '项目已完成' },
  { kind: 'notification', label: '轻提醒', detail: '委派子会话完成时，默认关闭' },
]
const section: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 14, padding: '20px 0', borderBottom: '1px solid var(--gray-200)' }
const button: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '7px 12px', borderRadius: 9, border: '1px solid var(--gray-200)', background: 'var(--color-surface)', color: 'var(--color-text)', fontSize: 12, cursor: 'pointer' }

export const NotificationSoundSettingsPage: React.FC = () => {
  const [settings, setSettings] = useState<NotificationSoundSettings>(loadSoundSettings)
  const [feedback, setFeedback] = useState<{ error: boolean; text: string }>()
  const [speaking, setSpeaking] = useState(false)
  const patch = (update: Partial<NotificationSoundSettings>): void => {
    const next = { ...settings, ...update }
    setSettings(next)
    saveSoundSettings(next)
  }
  const preview = async (event: typeof EVENTS[number], voice: boolean): Promise<void> => {
    setFeedback({ error: false, text: voice ? '正在播报…' : '正在播放…' })
    if (voice) setSpeaking(true)
    try {
      const result: SoundPlaybackResult = voice
        ? await speakNotificationText(event.voice!, true)
        : await playEventSound(event.kind, true)
      setFeedback({ error: !result.ok, text: result.ok ? (voice ? '人声试听完成' : '提示音已播放：' + event.label) : result.message })
    } finally { if (voice) setSpeaking(false) }
  }
  return (
    <div data-testid="notification-sound-settings" style={{ width: '100%', maxWidth: 720, boxSizing: 'border-box', margin: '0 auto', padding: '0 20px 32px' }}>
      <section style={{ ...section, paddingTop: 8 }}>
        {([
          ['enabled', '启用声音提醒', '项目需要确认或完成交付时播放'],
          ['speakEnabled', '语音播报', '使用 Windows 本地中文嗓音'],
          ['notificationEnabled', '轻提醒', '委派子会话完成时播放提示音'],
        ] as const).map(([key, label, detail]) => (
          <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={settings[key]} onChange={e => patch({ [key]: e.target.checked })} style={{ accentColor: 'var(--color-quick)', width: 16, height: 16, margin: 0, flexShrink: 0 }} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}><span style={{ fontSize: 14 }}>{label}</span><span style={{ fontSize: 12, color: 'var(--gray-500)' }}>{detail}</span></span>
          </label>
        ))}
      </section>
      <section style={section}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>音效风格</span>
        <div style={{ display: 'flex', gap: 8 }}>
          {(Object.keys(PACK_LABELS) as SoundPack[]).map(pack => <button key={pack} aria-pressed={settings.pack === pack} onClick={() => patch({ pack })} style={{ ...button, minWidth: 72, borderColor: settings.pack === pack ? 'var(--color-quick)' : 'var(--gray-200)', background: settings.pack === pack ? 'rgba(124,58,237,0.06)' : 'transparent' }}>{PACK_LABELS[pack]}</button>)}
        </div>
        <label htmlFor="notification-volume" style={{ fontSize: 13, marginTop: 4 }}>音量 <span style={{ color: 'var(--gray-500)' }}>{Math.round(settings.volume * 100)}%</span></label>
        <input id="notification-volume" type="range" min={0} max={1} step={0.05} value={settings.volume} onChange={e => patch({ volume: Number(e.target.value) })} style={{ width: '100%', maxWidth: 320, margin: 0, accentColor: 'var(--color-quick)' }} />
      </section>
      <section style={{ ...section, borderBottom: 'none' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>试听</span>
        <span style={{ fontSize: 12, color: 'var(--gray-500)' }}>试听不受自动提醒开关影响，使用当前音量。</span>
        {EVENTS.map(event => (
          <div key={event.kind} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '8px 0' }}>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={{ fontSize: 13 }}>{event.label}</span><span style={{ fontSize: 12, color: 'var(--gray-500)' }}>{event.detail}</span></span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button aria-label={'试听' + event.label + '提示音'} onClick={() => void preview(event, false)} style={button}><Play />提示音</button>
              {event.voice && <button aria-label={'试听' + event.label + '人声'} disabled={speaking} onClick={() => void preview(event, true)} style={{ ...button, opacity: speaking ? 0.5 : 1 }}><Play />人声</button>}
            </div>
          </div>
        ))}
        <div role={feedback?.error ? 'alert' : 'status'} style={{ minHeight: 20, fontSize: 12, color: feedback?.error ? 'var(--color-error, #b42318)' : 'var(--gray-500)' }}>{feedback?.text}</div>
      </section>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--gray-500)', lineHeight: 1.7 }}>语音使用系统中文嗓音，无需联网。音效素材来自 Proma 上游（AGPL 同源）。</p>
    </div>
  )
}
export default NotificationSoundSettingsPage
