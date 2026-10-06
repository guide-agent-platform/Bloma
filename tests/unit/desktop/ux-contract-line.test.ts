/**
 * UX 契约线单测（批3 2026-10-06，会话 f35363f6 讨论 turn15 落地）：
 * - parseUxExperience：七态白名单过滤/observable 必填/上限/空 states 降级；
 * - renderUxDigest：体验契约段渲染（子会话上下文注入）与缺省不注入；
 * - 任务书纪律数据锁：quick/longterm 双模式都教体验纪律（三分支反馈/禁 messagebox/
 *   长任务线程化/ui_kit）。
 */
import { describe, expect, it } from 'vitest'
import { parseUxExperience } from '../../../main/guide/prd-engine-llm'
import { renderUxDigest } from '../../../main/desktop/requirement-digest'
import { getDesktopPhase } from '../../../main/desktop/dispatcher-phases'

describe('parseUxExperience（七态白名单解析）', () => {
  it('合法 states + feedback_rules 解析通过', () => {
    const ux = parseUxExperience({
      states: [
        { id: 'empty', observable: '空态引导' },
        { id: 'success', observable: '列表立即可见' },
        { id: 'failed', observable: '行内提示错误原因' },
      ],
      feedback_rules: ['操作即时反馈', '失败给原因与下一步'],
    })
    expect(ux).toEqual({
      states: [
        { id: 'empty', observable: '空态引导' },
        { id: 'success', observable: '列表立即可见' },
        { id: 'failed', observable: '行内提示错误原因' },
      ],
      feedback_rules: ['操作即时反馈', '失败给原因与下一步'],
    })
  })

  it('白名单外 id / observable 为空 / 重复 id 的条目被过滤；states 为空 → undefined（降级不 fail）', () => {
    expect(
      parseUxExperience({
        states: [
          { id: 'fancy_state', observable: '白名单外' },
          { id: 'success', observable: '  ' },
          { id: 'empty', observable: '有效' },
          { id: 'empty', observable: '重复' },
        ],
        feedback_rules: ['x'],
      }),
    ).toEqual({ states: [{ id: 'empty', observable: '有效' }], feedback_rules: ['x'] })
    expect(parseUxExperience({ states: [], feedback_rules: ['x'] })).toBeUndefined()
    expect(parseUxExperience({ states: [{ id: 'loading', observable: '白名单外' }] })).toBeUndefined()
    expect(parseUxExperience('not-an-object')).toBeUndefined()
    expect(parseUxExperience(undefined)).toBeUndefined()
  })

  it('上限防御：states ≤7、feedback_rules ≤6、非字符串规则被滤', () => {
    const allIds = ['empty', 'ready_input', 'validating', 'running', 'success', 'partial', 'failed']
    const states = allIds.map((id) => ({ id, observable: `${id} 表现` }))
    states.push({ id: 'empty', observable: '第 8 个会被截' })
    const ux = parseUxExperience({
      states,
      feedback_rules: ['1', '2', '3', '4', '5', '6', '7', 42, null],
    })
    expect(ux?.states.length).toBe(7)
    expect(ux?.feedback_rules).toEqual(['1', '2', '3', '4', '5', '6'])
  })
})

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

describe('任务书体验纪律数据锁（批3 2026-10-06；批8 下半 v2 化：tk 措辞→pywebview 口径）', () => {
  it('longterm implement：状态反馈 App.show/禁弹窗/长任务线程推送/组件手册引用都在任务书', () => {
    const implement = getDesktopPhase('desktop-implement')
    const text = implement?.taskTemplate ?? ''
    expect(text).toContain('体验纪律')
    expect(text).toContain('App.show')
    expect(text).toContain('evaluate_js')
    expect(text).toContain('ui/PATTERNS.md')
    expect(implement?.constraints.some((c) => c.includes('体验契约'))).toBe(true)
  })

  it('quick 任务书：体验纪律同权重（快速模式不豁免）', () => {
    const implement = getDesktopPhase('desktop-implement')
    const quick = implement?.quickTaskTemplate ?? ''
    expect(quick).toContain('体验纪律')
    expect(quick).toContain('App.show')
    expect(quick).toContain('evaluate_js')
    expect((implement?.quickConstraints ?? []).some((c) => c.includes('体验纪律不因快速模式豁免'))).toBe(true)
  })

  it('verify 任务书：状态触达场景（空态/成功/失败）+ 探索体验核对（弹窗含 alert 算缺陷）+ Logic 层断言对象', () => {
    const verify = getDesktopPhase('desktop-verify')
    const text = verify?.taskTemplate ?? ''
    expect(text).toContain('状态触达')
    expect(text).toContain('空态/初始、成功、失败')
    expect(text).toContain('体验面')
    expect(text).toContain('messagebox 弹窗或 JS alert')
    expect(text).toContain('Logic 逻辑层')
  })
})
