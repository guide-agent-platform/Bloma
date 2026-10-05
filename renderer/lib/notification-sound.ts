/**
 * 通知声音与语音播报（2026-10-06 体验批 A；音效资产搬自 Proma 上游 AGPL 同源
 * assets/sound/uisfx，三套 × 四事件——事件语义映射见 routeEventForSound）。
 *
 * 设计：
 * - 播放器预加载 12 个 mp3（HTMLAudio 复用实例，零重复解码）；
 * - 设置存 localStorage（开关/音量/风格/播报开关），默认 minimal、播报开；
 * - speechSynthesis 中文播报仅两处（真完成/需要确认），先提示音后人声；
 *   首次用户交互前不播人声（Chromium autoplay 语义，静默降级只播提示音）。
 */

import soundMinimalBlocked from '../assets/sound/minimal/blocked.mp3'
import soundMinimalCheckpoint from '../assets/sound/minimal/checkpoint.mp3'
import soundMinimalComplete from '../assets/sound/minimal/complete.mp3'
import soundMinimalNotification from '../assets/sound/minimal/notification.mp3'
import soundSoftBlocked from '../assets/sound/soft/blocked.mp3'
import soundSoftCheckpoint from '../assets/sound/soft/checkpoint.mp3'
import soundSoftComplete from '../assets/sound/soft/complete.mp3'
import soundSoftNotification from '../assets/sound/soft/notification.mp3'
import soundGlassBlocked from '../assets/sound/glass/blocked.mp3'
import soundGlassCheckpoint from '../assets/sound/glass/checkpoint.mp3'
import soundGlassComplete from '../assets/sound/glass/complete.mp3'
import soundGlassNotification from '../assets/sound/glass/notification.mp3'

export type SoundKind = 'checkpoint' | 'blocked' | 'complete' | 'notification'
export type SoundPack = 'minimal' | 'soft' | 'glass'

export interface NotificationSoundSettings {
  enabled: boolean
  pack: SoundPack
  volume: number
  /** notification 类（轻提醒）默认关——只保留三类高价值事件。 */
  notificationEnabled: boolean
  /** 语音播报（真完成/需要确认两处）。 */
  speakEnabled: boolean
}

const STORAGE_KEY = 'bloma.notification-sound'
const DEFAULT_SETTINGS: NotificationSoundSettings = {
  enabled: true, pack: 'minimal', volume: 0.5, notificationEnabled: false, speakEnabled: true,
}

const PACK_ASSETS: Record<SoundPack, Record<SoundKind, string>> = {
  minimal: { blocked: soundMinimalBlocked, checkpoint: soundMinimalCheckpoint, complete: soundMinimalComplete, notification: soundMinimalNotification },
  soft: { blocked: soundSoftBlocked, checkpoint: soundSoftCheckpoint, complete: soundSoftComplete, notification: soundSoftNotification },
  glass: { blocked: soundGlassBlocked, checkpoint: soundGlassCheckpoint, complete: soundGlassComplete, notification: soundGlassNotification },
}

export function loadSoundSettings(): NotificationSoundSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<NotificationSoundSettings>
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSoundSettings(settings: NotificationSoundSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

/** 预加载播放器（模块单例；首次调用惰性建池）。 */
const audioPool = new Map<string, HTMLAudioElement>()
function acquire(url: string): HTMLAudioElement {
  let audio = audioPool.get(url)
  if (!audio) {
    audio = new Audio(url)
    audio.preload = 'auto'
    audioPool.set(url, audio)
  }
  return audio
}

// 预热：模块加载即解码（避免首播延迟）
for (const pack of Object.values(PACK_ASSETS)) for (const url of Object.values(pack)) acquire(url)

/** Chromium autoplay：首次用户交互前 speechSynthesis 可能被静默——交互后置真。 */
let userInteracted = false
if (typeof window !== 'undefined') {
  const markInteracted = (): void => { userInteracted = true }
  window.addEventListener('pointerdown', markInteracted, { once: true, capture: true })
  window.addEventListener('keydown', markInteracted, { once: true, capture: true })
}

/** 播放一次事件音（设置即时生效；notification 类受独立开关）。 */
export function playEventSound(kind: SoundKind): void {
  const settings = loadSoundSettings()
  if (!settings.enabled) return
  if (kind === 'notification' && !settings.notificationEnabled) return
  try {
    const audio = acquire(PACK_ASSETS[settings.pack][kind])
    audio.currentTime = 0
    audio.volume = Math.max(0, Math.min(1, settings.volume))
    void audio.play().catch(() => undefined)
  } catch {
    /* 播放失败静默（无头/音频设备缺失不影响功能） */
  }
}

/** 中文语音播报（先提示音后人声；未交互过只播提示音）。 */
export function announce(kind: SoundKind, text: string): void {
  playEventSound(kind)
  const settings = loadSoundSettings()
  if (!settings.speakEnabled || !userInteracted || typeof window.speechSynthesis === 'undefined') return
  try {
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'zh-CN'
    utterance.rate = 1.0
    utterance.volume = Math.max(0, Math.min(1, settings.volume + 0.2))
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
  } catch {
    /* TTS 不可用静默降级 */
  }
}

/**
 * 渲染端事件 → 声音路由（agent-atoms onStreamEvent 入口消费）。
 * 事件映射（体验批拍板 2026-10-06）：
 * - user_decision_required（PRD 卡/审查选择题/需求确认）→ checkpoint「叮，看一眼」；
 * - ux_sketch_ready / mvp_review_ready / blocked_for_user_decision → blocked「卡在等你」；
 * - stage_changed 到 ready/completed（真完成，对齐主进程通知口径——对话轮不打扰）→
 *   complete 音 + 人声「项目已完成」；
 * - delegation_completed → notification（默认关）。
 * projectName 供完成播报使用（调用方从项目 store 取）。
 */
export function routeEventForSound(
  event: { type: string; payload: Record<string, unknown> },
  projectName?: string,
): void {
  switch (event.type) {
    case 'user_decision_required':
      playEventSound('checkpoint')
      return
    case 'ux_sketch_ready':
    case 'mvp_review_ready':
      playEventSound('blocked')
      return
    case 'stage_changed': {
      const stage = event.payload.stage as string | undefined
      if (stage === 'ready' || stage === 'completed') {
        announce('complete', projectName ? `${projectName}已完成` : '项目已完成')
      }
      return
    }
    case 'delegation_completed':
      playEventSound('notification')
      return
    default:
      return
  }
}
