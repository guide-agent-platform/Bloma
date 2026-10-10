import { describe, expect, it } from 'vitest'
import { initialWindowBounds } from '../../main/platform/shell/window-bounds'
describe('窗口适配工作区域', () => {
  it.each([{width:1920,height:1040},{width:1536,height:832},{width:1280,height:672},{width:800,height:600},{width:640,height:480}])('默认与最小尺寸均不会超过 DIP 工作区 $width×$height', area => {
    const bounds=initialWindowBounds(area)
    expect(bounds.width).toBeLessThan(area.width)
    expect(bounds.height).toBeLessThan(area.height)
    expect(bounds.minWidth).toBeLessThanOrEqual(bounds.width)
    expect(bounds.minHeight).toBeLessThanOrEqual(bounds.height)
    expect(bounds.width).toBeGreaterThan(0)
    expect(bounds.height).toBeGreaterThan(0)
  })
})
