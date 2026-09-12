import { describe, it, expect } from 'vitest'
import {
  backplaneHash, buildIntentList, intentListFresh, renderIntentListForPrompt,
} from '../../../main/coding/vision-intent'

/**
 * 意图提取器 v1（issue #10 追加裁定第 2 步）：
 * 只吃背板（唯一基准）；带 evidence_ref / backplane_hash；人工可审；确定性无 LLM。
 */

function backplane(over: Partial<Parameters<typeof buildIntentList>[0]> = {}) {
  return {
    project_id: 'p1',
    positioning: '做一个贪吃蛇小游戏，能玩起来',
    requirements: [
      { id: 'F-001', description: '有蛇、食物、分数，蛇吃到食物变长' },
      { id: 'F-002', description: '方向键控制蛇的移动' },
    ],
    out_of_scope: ['联机对战'],
    constraints: ['必须离线可用'],
    ...over,
  }
}

describe('buildIntentList（背板 → 意图清单）', () => {
  it('定位 + 每条功能项各成一项，带 evidence_ref 与 hash', () => {
    const list = buildIntentList(backplane())
    expect(list.items).toHaveLength(3)
    expect(list.items[0]).toMatchObject({ element_id: 'positioning', expected_role: 'positioning', evidence_ref: 'prd.json#positioning' })
    expect(list.items[1]).toMatchObject({ element_id: 'F-001', expected_role: 'feature', evidence_ref: 'prd.json#requirements/F-001' })
    expect(list.items[1].expected_text).toContain('蛇')
    expect(list.items[1].backplane_hash).toBe(list.backplane_hash)
    expect(list.sources_used).toEqual(['backplane.positioning', 'backplane.requirements'])
  })

  it('无背板内容 → 空清单（不猜）', () => {
    const list = buildIntentList(backplane({ positioning: '', requirements: [] }))
    expect(list.items).toEqual([])
    expect(renderIntentListForPrompt(list)).toContain('未声明任何可核对元素')
  })

  it('缺 id 的功能项被跳过（不给不稳定键）', () => {
    const list = buildIntentList(backplane({ requirements: [{ id: '', description: 'x' }, { id: 'F-009', description: 'y' }] as never }))
    expect(list.items.map((i) => i.element_id)).toEqual(['positioning', 'F-009'])
  })

  it('GWT 不出现在来源里（裁定 ⑫）', () => {
    const list = buildIntentList(backplane())
    expect(list.sources_used.join(' ')).not.toContain('gwt')
  })
})

describe('backplaneHash 与时效（裁定 ⑩）', () => {
  it('同内容哈希稳定；改功能项描述即变', () => {
    const a = backplaneHash(backplane())
    const b = backplaneHash(backplane())
    expect(a).toBe(b)
    const changed = backplaneHash(backplane({ requirements: [{ id: 'F-001', description: '改成：有蛇、食物、分数、关卡' }] as never }))
    expect(changed).not.toBe(a)
  })

  it('清单与当前背板不一致 → 失效（需重取）', () => {
    const list = buildIntentList(backplane())
    expect(intentListFresh(list, backplane())).toBe(true)
    expect(intentListFresh(list, backplane({ positioning: '换成了记账应用' }))).toBe(false)
    expect(intentListFresh(undefined, backplane())).toBe(false)
  })
})

describe('renderIntentListForPrompt（给对照审核者的基准文本）', () => {
  it('含每项 id/文本/期望状态/证据引用，且不泄露代码细节', () => {
    const text = renderIntentListForPrompt(buildIntentList(backplane()))
    expect(text).toContain('[feature] F-001')
    expect(text).toContain('期望状态：visible')
    expect(text).toContain('prd.json#requirements/F-002')
    expect(text).toContain('唯一基准')
    expect(text).not.toMatch(/\.ts:\d+/)
  })
})
