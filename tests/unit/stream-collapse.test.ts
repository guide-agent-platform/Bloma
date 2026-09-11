import { describe, expect, it } from 'vitest'
import { collapseRepetitiveText } from '../../renderer/stream-collapse'

/**
 * 退行性重复折叠（2026-09-04「查。」墙案）：显示层防刷屏——落盘保留原始证据，
 * 仅渲染时折叠连续重复 ≥8 次的短单元。两例线上实测形态：「。。。。」与「查。查。查。」。
 *
 * 断言采用功能性不变量（前缀/后缀保留、计数标记、长度有界、阈值下零改动）——
 * 折叠单元的对齐细节（自然对齐）不属于契约。
 */

describe('collapseRepetitiveText — 退行重复折叠', () => {
  it('「查。」墙折叠：前缀保留、计数标注、长度大幅有界（线上 ddee1f39 形态）', () => {
    const wall = `看 hidden。读。查。检。视。读。${'查。'.repeat(190)}`
    const out = collapseRepetitiveText(wall)
    expect(out.startsWith('看 hidden。读。查。检。视。读。')).toBe(true)
    expect(out).toContain('重复 190 次已折叠')
    expect(out.length).toBeLessThan(wall.length / 10)
  })

  it('点号墙（a8c7d17d 形态）：前后文保留、计数正确', () => {
    const out = collapseRepetitiveText(`我正在生成${'。'.repeat(300)}完了`)
    expect(out).toContain('我正在生成')
    expect(out).toContain('完了')
    expect(out).toContain('重复 300 次已折叠')
    expect(out.length).toBeLessThan(80)
  })

  it('纯重复串整体折叠（无前缀后缀）', () => {
    const out = collapseRepetitiveText('查。'.repeat(200))
    expect(out).toContain('重复 200 次已折叠')
    expect(out.length).toBeLessThan(60)
  })

  it('居中运行：前后缀都保留', () => {
    const out = collapseRepetitiveText(`前置内容${'啊。'.repeat(40)}后置尾巴`)
    expect(out.startsWith('前置内容')).toBe(true)
    expect(out.endsWith('后置尾巴')).toBe(true)
    expect(out).toContain('重复 40 次已折叠')
  })

  it('ASCII 单元（ab 交替）同样折叠', () => {
    const out = collapseRepetitiveText('ab'.repeat(50))
    expect(out).toContain('重复 50 次已折叠')
  })

  it('正常文本零改动：重复不足 8 次不折叠', () => {
    for (const normal of [
      '先查看当前项目骨架，确定从零开始还是已有产物。',
      '好。好。好。', // 3 次
      'AAAA BBBB', // 各 4 次
      '按右方向键→车辆 x 坐标增加；按左方向键→车辆 x 坐标减小。',
      'ab'.repeat(7), // 7 次 < 8
    ]) {
      expect(collapseRepetitiveText(normal)).toBe(normal)
    }
  })

  it('短于 16 字符快速路径原样返回', () => {
    expect(collapseRepetitiveText('查。'.repeat(6))).toBe('查。'.repeat(6))
    expect(collapseRepetitiveText('')).toBe('')
  })

  it('系统决策行形态不受影响（无 ≥8 连续重复单元）', () => {
    const decision = '[decision] {"type":"agent_loop","title":"Agent Loop 结束（cancelled）","why":"24 轮、29 次工具调用"}'
    expect(collapseRepetitiveText(decision)).toBe(decision)
  })
})
