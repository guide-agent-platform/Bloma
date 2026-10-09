/**
 * P1-4/P1-5/P1-6 纯函数单测（2026-09-04）。
 *
 * 覆盖：
 * - normalizePrdDocumentNewlines：字面「反斜杠+n」还原为真换行（双重转义）；已真换行不误伤；
 * - reconcilePrdDocumentPriorities：document 自标 priority 与结构化字段不一致时以结构化覆盖；
 * - isPlaceholderAssertion：默认断言及变体识别为占位；真实「触发→可观察状态」断言非占位。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BEHAVIOR_ASSERTION,
  isPlaceholderAssertion,
  normalizePrdDocumentNewlines,
  reconcilePrdDocumentPriorities,
  requirementPriority,
} from '../../main/model/prd-backplane'
import type { SketchRequirement } from '../../main/model/prd-backplane'
import { renderPrdJson } from '../../main/project/prd-store'
import type { PrdBackplane } from '../../main/model/prd-backplane'

const items: SketchRequirement[] = [
  { id: 'F-001', description: '核心玩法', priority: 'P0' },
  { id: 'F-002', description: '暂停菜单', priority: 'P1' },
  { id: 'F-003', description: '道具收集' }, // 无 priority → 读取侧缺省 P2
]

describe('normalizePrdDocumentNewlines（P1-4 双重转义还原）', () => {
  it('字面「反斜杠+n」还原为真换行', () => {
    const input = '# PRD：以撒复刻\\n## 一、产品定位\\n复刻一款肉鸽游戏。'
    const output = normalizePrdDocumentNewlines(input)
    expect(output).toBe('# PRD：以撒复刻\n## 一、产品定位\n复刻一款肉鸽游戏。')
    expect(output.includes('\\n')).toBe(false)
  })

  it('已含真换行的正常输出不误伤', () => {
    const input = '# PRD：以撒复刻\n## 一、产品定位\n复刻一款肉鸽游戏。'
    expect(normalizePrdDocumentNewlines(input)).toBe(input)
  })

  it('不含换行的文本原样返回', () => {
    expect(normalizePrdDocumentNewlines('产品定位：复刻游戏。')).toBe('产品定位：复刻游戏。')
  })
})

describe('reconcilePrdDocumentPriorities（P1-5 priority 同源校正）', () => {
  it('document 自标 P0 与结构化 P2 不一致时以结构化覆盖', () => {
    const doc =
      '## 四、功能需求详述\n### [F-001]（P0）核心玩法\n### [F-002]（P0）暂停菜单\n### [F-003]（P1）道具收集'
    const result = reconcilePrdDocumentPriorities(doc, items)
    expect(result).toContain('### [F-001]（P0）核心玩法')
    expect(result).toContain('### [F-002]（P1）暂停菜单')
    expect(result).toContain('### [F-003]（P2）道具收集')
  })

  it('priority 一致时不改写（保持原标注形态）', () => {
    const doc = '### [F-001]（P0）核心玩法\n### [F-002]（P1）暂停菜单'
    expect(reconcilePrdDocumentPriorities(doc, items)).toBe(doc)
  })

  it('半角括号标注同样被校正', () => {
    const doc = '### [F-002](P0)暂停菜单'
    expect(reconcilePrdDocumentPriorities(doc, items)).toBe('### [F-002]（P1）暂停菜单')
  })

  it('document 无 priority 标注时不新增也不破坏', () => {
    const doc = '### [F-002] 暂停菜单'
    expect(reconcilePrdDocumentPriorities(doc, items)).toBe(doc)
  })
})

describe('isPlaceholderAssertion（P1-6 占位断言识别）', () => {
  it('默认占位断言被识别', () => {
    expect(isPlaceholderAssertion(DEFAULT_BEHAVIOR_ASSERTION)).toBe(true)
  })

  it('占位变体被识别（换词偷懒绕过格式守卫①）', () => {
    expect(isPlaceholderAssertion('该功能在页面中可见')).toBe(true)
    expect(isPlaceholderAssertion('功能项在产物中可访问')).toBe(true)
    expect(isPlaceholderAssertion('页面能正常使用')).toBe(true)
    expect(isPlaceholderAssertion('该功能已实现')).toBe(true)
    expect(isPlaceholderAssertion('提供功能入口')).toBe(true)
  })

  it('真实「触发→可观察状态」断言非占位', () => {
    expect(isPlaceholderAssertion('点击保存按钮→列表新增一条记录')).toBe(false)
    expect(isPlaceholderAssertion('按右方向键→车辆 x 坐标增加')).toBe(false)
    expect(isPlaceholderAssertion('点击暂停→菜单显示')).toBe(false)
    expect(isPlaceholderAssertion('输入关键词后显示匹配结果')).toBe(false)
  })

  it('空串视为占位', () => {
    expect(isPlaceholderAssertion('')).toBe(true)
    expect(isPlaceholderAssertion('   ')).toBe(true)
  })
})

describe('requirementPriority 缺省口径（P1-5 结构化真相源）', () => {
  it('reconciles late enrichment at the persistence boundary without changing confirmed facts', () => {
    const backplane: PrdBackplane = { project_id: 'p', name: 'ledger', positioning: 'local', requirements: items, acceptance: {}, assumptions: [], out_of_scope: [], user_confirmed_at: '2026-10-09', prd_document: '### [F-002]（P2）暂停菜单\\n下一节' }
    const stored = JSON.parse(renderPrdJson(backplane))
    expect(stored.prd_document).toBe('### [F-002]（P1）暂停菜单\n下一节')
    expect(stored.requirements).toEqual(items)
    expect(stored.user_confirmed_at).toBe('2026-10-09')
    expect(backplane.prd_document).toContain('（P2）')
  })
  it('缺省 F-001=P0、其余 P2', () => {
    expect(requirementPriority({ id: 'F-001', description: 'x' })).toBe('P0')
    expect(requirementPriority({ id: 'F-002', description: 'x' })).toBe('P2')
    expect(requirementPriority({ id: 'F-002', description: 'x', priority: 'P1' })).toBe('P1')
  })
})
