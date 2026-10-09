import { describe, expect, it } from 'vitest'
import { isDegenerateText } from '../../../main/coding/output-integrity'

/**
 * 输出完整性守卫（P0，2026-09-06「地牢清怪录」案）：工具调用协议原文漏进正文 /
 * 退行重复墙不得被判为「模型声明收工」；正常总结不得误伤。
 */
describe('isDegenerateText', () => {
  it('工具调用协议原文漏进正文 → 判退行（d066eb92 DSML 案形态）', () => {
    const leaked = [
      '<｜｜DSML｜｜tool_calls>',
      '<｜｜DSML｜｜invoke name="grep">',
      '<tool_calls>',
      '</tool_calls>',
      '<invoke name="grep">',
      '</parameter>',
    ]
    for (const markup of leaked) {
      expect(isDegenerateText(`正在检查代码。${markup}`)).toBe(true)
    }
  })

  it('退行重复墙 → 判退行（glm「查。×385」案形态）', () => {
    const wall = '看 hidden。读。' + '查。'.repeat(385)
    expect(isDegenerateText(wall)).toBe(true)
  })

  it('detects the dogfood long-phrase loop beyond eight characters', () => {
    expect(isDegenerateText('完成前仍需核对。' + '停止空转。真正执行。'.repeat(80))).toBe(true)
  })

  it('正常完成总结 → 不判退行', () => {
    const summary =
      '已完成「地牢清怪录」可运行 MVP：房间式地牢循环、WASD 移动、自动瞄准射击、' +
      '受伤无敌反馈、死亡与复活流程、最高分存档。全部 P0 断言通过 5/5，安全扫描无高危。'
    expect(isDegenerateText(summary)).toBe(false)
  })

  it('正常文本里短促省略号不误伤（运行占比低于门槛）', () => {
    const withEllipsis = Array.from({ length: 12 }, (_, i) => `第${i}项已核对，功能与测试结果如下。`).join('') + '…'.repeat(8)
    expect(isDegenerateText(withEllipsis)).toBe(false)
  })

  it('重复未达次数阈值（<8 次）不判退行', () => {
    const text = '查。'.repeat(7) + '随后核对了渲染入口，确认实体绘制链路完整，测试全绿收尾。'
    expect(isDegenerateText(text)).toBe(false)
  })
})
