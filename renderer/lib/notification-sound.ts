/**
 * 通知声音与语音播报（2026-10-06 体验批 A；音效资产搬自 Proma 上游 AGPL 同源
 * assets/sound/uisfx，三套 × 四事件——事件语义映射见 routeEventForSound）。
 *
 * 设计：
 * - 播放器预加载 12 个 mp3（HTMLAudio 复用实例，零重复解码）；
 * - 设置存 localStorage（开关/音量/风格/播报开关），默认 minimal、播报开；
 * - Windows 中文播报经受限 IPC 调用本地 System.Speech；浏览器仅作有中文嗓音时的后备；
 * - 自动提醒受总开关控制，手动试听独立；失败结果可显示在设置界面。
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
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_SETTINGS.enabled,
      speakEnabled: typeof parsed.speakEnabled === 'boolean' ? parsed.speakEnabled : DEFAULT_SETTINGS.speakEnabled,
      notificationEnabled: typeof parsed.notificationEnabled === 'boolean' ? parsed.notificationEnabled : DEFAULT_SETTINGS.notificationEnabled,
      pack: parsed.pack && Object.hasOwn(PACK_ASSETS, parsed.pack) ? parsed.pack : DEFAULT_SETTINGS.pack,
      volume: typeof parsed.volume === 'number' && Number.isFinite(parsed.volume) ? Math.max(0, Math.min(1, parsed.volume)) : DEFAULT_SETTINGS.volume,
    }
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
export type SoundPlaybackResult = { ok: true } | { ok: false; message: string; skipped?: boolean }
export async function playEventSound(kind: SoundKind, preview = false): Promise<SoundPlaybackResult> {
  const settings = loadSoundSettings()
  if (!preview && !settings.enabled) return { ok: false, message: '自动提示音已关闭', skipped: true }
  if (!preview && kind === 'notification' && !settings.notificationEnabled) return { ok: false, message: '轻提醒已关闭', skipped: true }
  if (settings.volume === 0) return { ok: false, message: '音量为 0，请先调高音量', skipped: true }
  try {
    const audio = acquire(PACK_ASSETS[settings.pack][kind])
    audio.currentTime = 0
    audio.volume = Math.max(0, Math.min(1, settings.volume))
    await audio.play()
    return { ok: true }
  } catch {
    return { ok: false, message: '提示音未能加载或播放，请重试' }
  }
}

/** 本地中文语音播报，试听可绕过自动提醒开关。 */
export async function speakNotificationText(text: string, preview = false): Promise<SoundPlaybackResult> {
  const settings = loadSoundSettings()
  if (!preview && (!settings.enabled || !settings.speakEnabled)) return { ok: false, message: '自动语音播报已关闭', skipped: true }
  if (settings.volume === 0) return { ok: false, message: '音量为 0，请先调高音量', skipped: true }
  try {
    const native = window.electronAPI?.speech?.speakNotification
    if (native) {
      const result = await native({ request_id: crypto.randomUUID(), text, volume: settings.volume })
      return result.ok && result.data.spoken ? { ok: true } : { ok: false, message: result.ok ? '人声播报未完成' : result.error.user_visible_message ?? result.error.message }
    }
    if (!userInteracted || typeof window.speechSynthesis === 'undefined') return { ok: false, message: '当前环境没有可用的本地语音引擎' }
    const voice = window.speechSynthesis.getVoices().find(voice => voice.localService && voice.lang.startsWith('zh'))
    if (!voice) return { ok: false, message: '当前环境没有中文嗓音，请重启新版应用后重试' }
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'zh-CN'
    utterance.voice = voice
    utterance.rate = 1.0
    utterance.volume = settings.volume
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
    return { ok: true }
  } catch {
    return { ok: false, message: '本地人声播报失败，请重试' }
  }
}

export async function announce(kind: SoundKind, text: string): Promise<void> {
  const sound = await playEventSound(kind)
  if (!sound.ok && !sound.skipped) console.warn('[notification-sound]', sound.message)
  const voice = await speakNotificationText(text)
  if (!voice.ok && !voice.skipped) console.warn('[notification-speech]', voice.message)
}

const seenEvents = new Set<string>()
const deliveredProjects = new Set<string>()
export function resetSoundRuntimeForTests(): void { seenEvents.clear(); deliveredProjects.clear() }

/**
 * 渲染端事件 → 声音路由（agent-atoms onStreamEvent 入口消费）。
 * 事件映射（体验批拍板 2026-10-06）：
 * - user_decision_required（PRD 卡/审查选择题/需求确认）→ checkpoint「叮，看一眼」；
 * - UX/MVP 的 user_decision_required 确认卡 → blocked；预览 ready 事件不重复提醒；
 * - permission_requested → checkpoint；stage_changed 到 delivered/completed →
 *   complete 音 + 人声「项目已完成」；
 * - delegation_completed → notification（默认关）。
 * projectName 仅在事件所属项目匹配当前项目时传入。事件 ID 与完成阶段去重。
 */
export function routeEventForSound(
  event: { type: string; payload: Record<string, unknown>; event_id?: string; project_id?: string; session_id?: string },
  projectName?: string,
): void {
  if (event.event_id) {
    if (seenEvents.has(event.event_id)) return
    seenEvents.add(event.event_id)
    if (seenEvents.size > 512) seenEvents.delete(seenEvents.values().next().value!)
  }
  const key = event.project_id ?? event.session_id
  switch (event.type) {
    case 'user_decision_required': {
      const kind = event.payload.kind
      const gate = kind === 'ux_confirm' || kind === 'mvp_confirm'
      void announce(gate ? 'blocked' : 'checkpoint', kind === 'ux_confirm' ? '界面草图已准备好，请你确认' : kind === 'mvp_confirm' ? '程序已准备好，请你确认' : '有一项内容需要你确认')
      return
    }
    case 'permission_requested':
      void announce('checkpoint', '有一个操作需要你确认')
      return
    case 'ux_sketch_ready':
    case 'mvp_review_ready':
      // Preview readiness is not a second user decision. The following card is the cue.
      return
    case 'stage_changed': {
      const stage = event.payload.stage as string | undefined
      if (stage === 'delivered' || stage === 'completed') {
        if (key && deliveredProjects.has(key)) return
        if (key) { deliveredProjects.add(key); if (deliveredProjects.size > 256) deliveredProjects.delete(deliveredProjects.values().next().value!) }
        void announce('complete', projectName ? `${projectName}已完成` : '项目已完成')
      } else if (key) {
        deliveredProjects.delete(key)
      }
      return
    }
    case 'delegation_completed':
      void playEventSound('notification')
      return
    default:
      return
  }
}
