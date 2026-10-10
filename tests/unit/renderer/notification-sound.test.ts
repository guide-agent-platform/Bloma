// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadSoundSettings, routeEventForSound, saveSoundSettings, playEventSound,
  speakNotificationText, resetSoundRuntimeForTests,
} from '../../../renderer/lib/notification-sound'

const voice = vi.fn()
beforeEach(() => {
  localStorage.clear()
  resetSoundRuntimeForTests()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  voice.mockReset().mockResolvedValue({ ok: true, data: { spoken: true } })
  vi.stubGlobal('electronAPI', { speech: { speakNotification: voice } })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }

describe('通知声音与实际触发语义', () => {
  it('默认值与持久化', () => {
    expect(loadSoundSettings()).toEqual({ enabled: true, pack: 'minimal', volume: 0.5, notificationEnabled: false, speakEnabled: true })
    const next = { enabled: false, pack: 'glass' as const, volume: 0.8, notificationEnabled: true, speakEnabled: false }
    saveSoundSettings(next)
    expect(loadSoundSettings()).toEqual(next)
  })
  it('损坏的历史设置不会选中不存在的声音包或非法音量', () => {
    localStorage.setItem('bloma.notification-sound', JSON.stringify({ pack: '__proto__', volume: 8, enabled: 'false' }))
    expect(loadSoundSettings()).toMatchObject({ pack: 'minimal', volume: 1, enabled: true })
    localStorage.setItem('bloma.notification-sound', 'null')
    expect(loadSoundSettings().pack).toBe('minimal')
  })
  it('预览准备不响，UX/MVP 确认卡各响一次；事件重放去重', async () => {
    routeEventForSound({ type: 'ux_sketch_ready', payload: {} })
    routeEventForSound({ type: 'mvp_review_ready', payload: {} })
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
    for (const kind of ['ux_confirm', 'mvp_confirm']) {
      const event = { event_id: kind, type: 'user_decision_required', payload: { kind } }
      routeEventForSound(event); routeEventForSound(event)
    }
    await flush()
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2)
    expect(voice.mock.calls.map(call => call[0].text)).toEqual(['界面草图已准备好，请你确认', '程序已准备好，请你确认'])
  })
  it('普通对话结束与 ready 不表示交付；delivered 和 completed 只报一次，重新开工可再报', async () => {
    const send = (type: string, stage?: string) => routeEventForSound({ type, project_id: 'p', payload: { stage } }, '计算器')
    send('completed'); send('stage_changed', 'ready')
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
    send('stage_changed', 'delivered'); send('stage_changed', 'completed')
    await flush()
    expect(voice).toHaveBeenCalledTimes(1)
    expect(voice.mock.calls[0][0].text).toBe('计算器已完成')
    send('stage_changed', 'implementing'); send('stage_changed', 'delivered')
    await flush()
    expect(voice).toHaveBeenCalledTimes(2)
  })
  it('需求决策与权限请求都会提醒；委派完成默认静音', async () => {
    routeEventForSound({ type: 'user_decision_required', payload: { kind: 'prd_confirm' } })
    routeEventForSound({ type: 'permission_requested', payload: {} })
    routeEventForSound({ type: 'delegation_completed', payload: {} })
    await flush()
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2)
    expect(voice).toHaveBeenCalledTimes(2)
    saveSoundSettings({ ...loadSoundSettings(), notificationEnabled: true })
    routeEventForSound({ type: 'delegation_completed', payload: {} })
    await flush()
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(3)
    expect(voice).toHaveBeenCalledTimes(2)
  })
  it('总开关关闭同时关闭自动人声，手动试听仍可播放（含默认关闭的轻提醒）', async () => {
    saveSoundSettings({ ...loadSoundSettings(), enabled: false })
    routeEventForSound({ type: 'user_decision_required', payload: {} })
    routeEventForSound({ type: 'permission_requested', payload: {} })
    await flush()
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
    expect(voice).not.toHaveBeenCalled()
    expect(await playEventSound('notification', true)).toEqual({ ok: true })
    expect(await speakNotificationText('试听', true)).toEqual({ ok: true })
    expect(voice).toHaveBeenCalledWith(expect.objectContaining({ text: '试听', volume: 0.5, request_id: expect.any(String) }))
  })
  it('播放失败和音量为零返回可显示的原因', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new Error('CSP'))
    expect(await playEventSound('checkpoint', true)).toMatchObject({ ok: false, message: expect.stringContaining('播放') })
    saveSoundSettings({ ...loadSoundSettings(), volume: 0 })
    expect(await speakNotificationText('试听', true)).toMatchObject({ ok: false, message: expect.stringContaining('音量为 0') })
    expect(voice).not.toHaveBeenCalled()
  })
  it('本地引擎错误可显示；关闭自动人声不影响音效', async () => {
    voice.mockResolvedValue({ ok: false, error: { message: '未安装 Windows 中文嗓音' } })
    expect(await speakNotificationText('试听', true)).toEqual({ ok: false, message: '未安装 Windows 中文嗓音' })
    voice.mockClear()
    saveSoundSettings({ ...loadSoundSettings(), speakEnabled: false })
    routeEventForSound({ type: 'user_decision_required', payload: {} })
    await flush()
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
    expect(voice).not.toHaveBeenCalled()
  })
})
