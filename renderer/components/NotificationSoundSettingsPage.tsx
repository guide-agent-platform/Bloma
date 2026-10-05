/**
 * 通知与声音设置页（2026-10-06 体验批 A）。
 *
 * 面：总开关 / 音效风格（minimal·soft·glass，资产搬自 Proma 上游）/ 音量 /
 * 轻提醒（委派完成 notification 类，默认关）/ 语音播报开关 / 各事件试听。
 * 存储见 lib/notification-sound.ts（localStorage）。
 */

import React, { useState } from 'react'
import {
  loadSoundSettings, playEventSound, saveSoundSettings,
  type NotificationSoundSettings, type SoundKind, type SoundPack,
} from '../lib/notification-sound'

const PACK_LABELS: Record<SoundPack, string> = {
  minimal: '极简（默认）',
  soft: '柔和',
  glass: '清脆',
}

const EVENT_LABELS: Record<SoundKind, string> = {
  checkpoint: '需要你确认（PRD 卡 / 审查选择题）',
  blocked: '确认门（UX 草图 / MVP 验收）',
  complete: '项目完成',
  notification: '轻提醒（委派完成，默认关）',
}

export const NotificationSoundSettingsPage: React.FC = () => {
  const [settings, setSettings] = useState<NotificationSoundSettings>(loadSoundSettings)

  const patch = (update: Partial<NotificationSoundSettings>): void => {
    const next = { ...settings, ...update }
    setSettings(next)
    saveSoundSettings(next)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 560 }}>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14 }}>
          <input type="checkbox" checked={settings.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          启用提示音
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14 }}>
          <input type="checkbox" checked={settings.speakEnabled} onChange={(e) => patch({ speakEnabled: e.target.checked })} />
          语音播报（项目完成 / 需要确认时人声提示）
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14 }}>
          <input type="checkbox" checked={settings.notificationEnabled} onChange={(e) => patch({ notificationEnabled: e.target.checked })} />
          轻提醒（委派子会话完成）
        </label>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>音效风格</span>
        <div style={{ display: 'flex', gap: 8 }}>
          {(Object.keys(PACK_LABELS) as SoundPack[]).map((pack) => (
            <button
              key={pack}
              onClick={() => patch({ pack })}
              style={{
                padding: '6px 14px', borderRadius: 999, fontSize: 13, cursor: 'pointer',
                border: settings.pack === pack ? '2px solid var(--color-quick, #7c3aed)' : '1px solid var(--gray-200, #e5e7eb)',
                background: settings.pack === pack ? 'rgba(124,58,237,0.06)' : 'transparent',
                color: 'var(--color-text, #111)',
              }}
            >
              {PACK_LABELS[pack]}
            </button>
          ))}
        </div>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>音量（{Math.round(settings.volume * 100)}%）</span>
        <input
          type="range" min={0} max={1} step={0.05} value={settings.volume}
          onChange={(e) => patch({ volume: Number(e.target.value) })}
          style={{ width: 260 }}
        />
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>试听</span>
        {(Object.keys(EVENT_LABELS) as SoundKind[]).map((kind) => (
          <div key={kind} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
            <button
              onClick={() => playEventSound(kind)}
              style={{
                padding: '3px 12px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
                border: '1px solid var(--gray-200, #e5e7eb)', background: 'transparent',
                color: 'var(--color-text, #111)',
              }}
            >
              ▶ 播放
            </button>
            <span>{EVENT_LABELS[kind]}</span>
          </div>
        ))}
      </section>

      <p style={{ fontSize: 12, color: 'var(--gray-500, #6b7280)', lineHeight: 1.6 }}>
        语音播报使用 Windows 系统中文嗓音（无需联网）；提示音在项目生成/确认的关键节点播放。
        音效素材来自 Proma 上游（AGPL 同源）。
      </p>
    </div>
  )
}

export default NotificationSoundSettingsPage
