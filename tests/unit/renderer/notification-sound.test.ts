// @vitest-environment jsdom
/**
 * 通知声音路由测试（2026-10-06 体验批 A）。
 * 锁定：设置持久化与默认值、事件路由不抛错、总开关关闭零副作用。
 * （mp3 import 由 vite 转 URL；HTMLMediaElement.play 在 jsdom 打桩。）
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSoundSettings, routeEventForSound, saveSoundSettings } from '../../../renderer/lib/notification-sound'

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
})

describe('通知声音（体验批 A）', () => {
  it('默认设置：开 / minimal / notification 类关 / 播报开', () => {
    const defaults = loadSoundSettings()
    expect(defaults).toEqual({ enabled: true, pack: 'minimal', volume: 0.5, notificationEnabled: false, speakEnabled: true })
  })

  it('设置持久化：save 后 load 回读一致', () => {
    const next = { enabled: false, pack: 'glass' as const, volume: 0.8, notificationEnabled: true, speakEnabled: false }
    saveSoundSettings(next)
    expect(loadSoundSettings()).toEqual(next)
  })

  it('四类事件路由全部不抛错（含播报与项目名）', () => {
    expect(() => routeEventForSound({ type: 'user_decision_required', payload: {} })).not.toThrow()
    expect(() => routeEventForSound({ type: 'ux_sketch_ready', payload: {} })).not.toThrow()
    expect(() => routeEventForSound({ type: 'mvp_review_ready', payload: {} })).not.toThrow()
    expect(() => routeEventForSound({ type: 'stage_changed', payload: { stage: 'completed' } }, '测试项目')).not.toThrow()
    expect(() => routeEventForSound({ type: 'stage_changed', payload: { stage: 'clarifying' } })).not.toThrow()
    expect(() => routeEventForSound({ type: 'delegation_completed', payload: {} })).not.toThrow()
  })

  it('总开关关闭时路由零副作用', () => {
    saveSoundSettings({ ...loadSoundSettings(), enabled: false })
    expect(() => routeEventForSound({ type: 'ux_sketch_ready', payload: {} })).not.toThrow()
    expect(() => routeEventForSound({ type: 'user_decision_required', payload: {} })).not.toThrow()
  })
})
