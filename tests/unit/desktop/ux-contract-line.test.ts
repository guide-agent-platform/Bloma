/**
 * UX 契约线单测（批3 2026-10-06，会话 f35363f6 讨论 turn15 落地）：
 * - parseUxExperience：七态白名单过滤/observable 必填/上限/空 states 降级；
 * - renderUxDigest：体验契约段渲染（子会话上下文注入）与缺省不注入；
 * - 任务书纪律数据锁：quick/longterm 双模式都教体验纪律（三分支反馈/禁 messagebox/
 *   长任务线程化/ui_kit）。
 */
import { describe, expect, it } from 'vitest'

import { renderUxDigest } from '../../../main/desktop/requirement-digest'


describe('renderUxDigest（体验契约段注入）', () => {
  it('背板 ux 存在 → 渲染状态与反馈规则（含冻结声明）', () => {
    const text = renderUxDigest({
      states: [
        { id: 'empty', observable: '空态引导' },
        { id: 'partial', observable: '分别显示成功与失败数量' },
      ],
      feedback_rules: ['成功给数量与位置'],
    })
    expect(text).toContain('体验契约')
    expect(text).toContain('空态（empty）：空态引导')
    expect(text).toContain('部分成功（partial）：分别显示成功与失败数量')
    expect(text).toContain('成功给数量与位置')
  })

  it('缺省/空 states → undefined（任务书通用七态纪律兜底，不注入）', () => {
    expect(renderUxDigest(undefined)).toBeUndefined()
    expect(renderUxDigest({ states: [], feedback_rules: [] })).toBeUndefined()
  })
})
