/**
 * 桌面线整体开关测试（批次 A，2026-09-24）。
 *
 * 密闭性约定（项目陷阱 53）：BLOMA_* 环境变量显式设/还原——本测试经 env 参数
 * 注入，不触 process.env，天然密闭；另有一条锁定 process.env 直读路径的行为。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { DESKTOP_DISPATCH_SWITCH, isDesktopDispatchEnabled } from '../../../main/desktop/dispatcher-switch'

const BLOMA_DISPATCH_ENV_KEY = DESKTOP_DISPATCH_SWITCH

describe('BLOMA_DESKTOP_DISPATCH 开关（缺省 off 字节锁）', () => {
  const ORIGINAL = process.env[BLOMA_DISPATCH_ENV_KEY]

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env[BLOMA_DISPATCH_ENV_KEY]
    else process.env[BLOMA_DISPATCH_ENV_KEY] = ORIGINAL
  })

  it('未设置 → off', () => {
    expect(isDesktopDispatchEnabled({})).toBe(false)
  })

  it('显式开启值：1 / true / on（大小写敏感——仅小写）', () => {
    expect(isDesktopDispatchEnabled({ BLOMA_DESKTOP_DISPATCH: '1' })).toBe(true)
    expect(isDesktopDispatchEnabled({ BLOMA_DESKTOP_DISPATCH: 'true' })).toBe(true)
    expect(isDesktopDispatchEnabled({ BLOMA_DESKTOP_DISPATCH: 'on' })).toBe(true)
  })

  it('其余一切取值关闭（空串/yes/ON/0/false/off/随机值）', () => {
    for (const value of ['', '0', 'false', 'off', 'yes', 'ON', 'True', '开启']) {
      expect(isDesktopDispatchEnabled({ BLOMA_DESKTOP_DISPATCH: value }), JSON.stringify(value)).toBe(false)
    }
  })

  it('开关名单一真源导出', () => {
    expect(DESKTOP_DISPATCH_SWITCH).toBe('BLOMA_DESKTOP_DISPATCH')
  })

  it('缺省读 process.env（显式设/还原，验证接线路径）', () => {
    process.env[BLOMA_DISPATCH_ENV_KEY] = '1'
    expect(isDesktopDispatchEnabled()).toBe(true)
    process.env[BLOMA_DISPATCH_ENV_KEY] = ''
    expect(isDesktopDispatchEnabled()).toBe(false)
  })
})
