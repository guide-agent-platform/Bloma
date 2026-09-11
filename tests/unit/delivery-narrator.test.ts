/**
 * delivery-narrator 单测（2026-09-11 交付话术改造 + 审计 P3-2 回归锁）：
 * ① 质检闸门只拒明确违规（术语堆砌 / 显式复盘句式），合法用户视角文本放行；
 * ② 无 query 通道时直接兜底（不重试、不阻断交付链）。
 */
import { describe, expect, it } from 'vitest'
import { composeDeliveryMessage, isAcceptableDeliveryText } from '../../main/coding/delivery-narrator'

const FACTS = {
  productName: '记账小工具',
  positioning: '帮你随手记录收支',
  features: ['记录一笔支出', '查看本月统计'],
  leftoverNotes: [],
}

describe('isAcceptableDeliveryText', () => {
  it('用户视角的合法交付文本放行', () => {
    expect(
      isAcceptableDeliveryText(
        '这个记账小工具已经可以用了：你能随手记下一笔支出，也能看到本月的收支汇总。打开右侧预览就能试用，记录会保存在本地。',
      ),
    ).toBe(true)
  })

  it('含机器术语（断言/探针/GWT/背板/轮次等）判违规', () => {
    expect(isAcceptableDeliveryText('所有 P0 断言已通过，探针全绿，背板功能项已覆盖，共 12 轮。')).toBe(false)
  })

  it('显式过程复盘句式判违规', () => {
    expect(isAcceptableDeliveryText('我先实现了记账功能，然后运行了一次检查，最后改好了统计页面。')).toBe(false)
  })

  it('合法第一人称表述不再被误拒（审计 P3-2）', () => {
    expect(
      isAcceptableDeliveryText('我们已经为你准备好了这个工具：可以记录支出，也能看本月汇总，打开右侧预览就能用。'),
    ).toBe(true)
  })

  it('过短/空文本判违规', () => {
    expect(isAcceptableDeliveryText('  好的。')).toBe(false)
  })
})

describe('composeDeliveryMessage', () => {
  it('无 query 通道 → 直接兜底，不抛错', async () => {
    const result = await composeDeliveryMessage({
      request_id: 'r1',
      session_id: 's1',
      project_id: 'p1',
      facts: FACTS,
    })
    expect(result).toEqual({ text: '', fallback: true })
  })
})
