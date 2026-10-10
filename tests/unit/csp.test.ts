import { describe, expect, it } from 'vitest'
import { MAIN_FRAME_CSP, shouldInjectMainFrameCsp } from '../../main/csp'

/**
 * 问题 B-2 针对性用例：主窗 CSP 只对 mainFrame 注入，不再污染沙箱 iframe 子帧。
 * 抽出 main/csp.ts 后，无需启动 Electron 即可断言收窄规则。
 */
describe('main CSP 收窄（问题 B-2）', () => {
  it('提示音允许本地文件与 Vite 内联音频，不允许外部音频源', () => {
    expect(MAIN_FRAME_CSP.match(/media-src[^;]*/)?.[0]).toBe("media-src 'self' data:")
  })
  it('仅对 mainFrame 注入主窗 CSP，子帧 / 脚本 / 样式 / XHR 一律放过', () => {
    expect(shouldInjectMainFrameCsp('mainFrame')).toBe(true)
    expect(shouldInjectMainFrameCsp('subFrame')).toBe(false)
    expect(shouldInjectMainFrameCsp('script')).toBe(false)
    expect(shouldInjectMainFrameCsp('stylesheet')).toBe(false)
    expect(shouldInjectMainFrameCsp('xhr')).toBe(false)
    expect(shouldInjectMainFrameCsp('image')).toBe(false)
  })

  it('主窗 script-src 不含 unsafe-inline，避免与沙箱 CSP 取交集后屏蔽生成页内联脚本', () => {
    expect(MAIN_FRAME_CSP).toContain("script-src 'self'")
    expect(MAIN_FRAME_CSP).not.toMatch(/script-src[^;]*unsafe-inline/)
  })

  it('frame-src 仅放开本地回环（localhost / 127.0.0.1）任意端口，不放任何外部 origin', () => {
    expect(MAIN_FRAME_CSP).toContain("frame-src 'self' http://localhost:* http://127.0.0.1:*")
    const frameSrc = MAIN_FRAME_CSP.match(/frame-src[^;]*/)?.[0] ?? ''
    expect(frameSrc).not.toContain('https://')
    // 不得出现 api.anthropic.com 等外部 origin 进入 frame-src（外联走 connect-src 白名单）
    expect(frameSrc).not.toContain('api.anthropic.com')
  })
})
