import { afterEach, describe, expect, it } from 'vitest'
import type { Channel } from '../../shared/types'
import {
  categoryForStage,
  categoryTemperature,
  DEFAULT_CATEGORY_CONFIGS,
  resolveCategoryModel,
  resetCategoryConfigsForTests,
  setCategoryConfigForTests,
  type DocumentCategory,
} from '../../main/model-resolution'

/**
 * 文档类别 → 模型路由（§6，M4）：代码里写类别不写模型名。
 * 解析管线：①preferredModel（仅渠道内生效）→ ②capability 默认（strongest=列表序
 * 首个 enabled）→ ③同 provider 降级链 → ④无可用模型明确报错（绝不硬编码兜底）。
 */

function makeChannel(models: Array<{ name: string; enabled?: boolean }>): Pick<Channel, 'models' | 'name'> {
  return {
    name: '测试渠道',
    models: models.map((model, index) => ({
      id: `m${index}`,
      name: model.name,
      enabled: model.enabled ?? true,
    })),
  }
}

const ALL_CATEGORIES: DocumentCategory[] = ['guide', 'prd', 'sketch', 'mvp', 'gwt', 'judge']

describe('model-resolution（类别 → 模型解析管线）', () => {
  afterEach(() => {
    resetCategoryConfigsForTests()
  })

  it('默认全类别 strongest：取渠道 models 列表序的首个 enabled（与改造前 find(enabled) 语义一致）', () => {
    const channel = makeChannel([
      { name: 'minimax-m2.7', enabled: false },
      { name: 'MiniMax-M3' },
      { name: 'minimax-highspeed' },
    ])
    for (const category of ALL_CATEGORIES) {
      expect(resolveCategoryModel(channel, category).model).toBe('MiniMax-M3')
    }
  })

  it('单模型渠道与多档模型渠道均正常（引擎不依赖具体模型名）', () => {
    expect(resolveCategoryModel(makeChannel([{ name: 'deepseek-chat' }]), 'mvp').model).toBe('deepseek-chat')
    const multi = resolveCategoryModel(makeChannel([{ name: 'a' }, { name: 'b' }, { name: 'c' }]), 'gwt')
    expect(multi.model).toBe('a')
  })

  it('①override：preferredModel 仅当在当前渠道 models 内时生效', () => {
    setCategoryConfigForTests({
      mvp: { category: 'mvp', capability: 'strongest', preferredModel: 'MiniMax-M3' },
    })
    // 在渠道内 → 生效
    expect(resolveCategoryModel(makeChannel([{ name: 'a' }, { name: 'MiniMax-M3' }]), 'mvp').model).toBe('MiniMax-M3')
    // 不在渠道内 → 忽略，落入 ②capability 默认
    expect(resolveCategoryModel(makeChannel([{ name: 'a' }, { name: 'b' }]), 'mvp').model).toBe('a')
  })

  it('③降级链：fallbackChain 取渠道内 enabled 条目（保序、排除主选）；一把 key 不跨 provider', () => {
    setCategoryConfigForTests({
      mvp: { category: 'mvp', capability: 'strongest', fallbackChain: ['x', 'b', 'c', 'a'] },
    })
    const resolved = resolveCategoryModel(makeChannel([{ name: 'a' }, { name: 'b', enabled: false }, { name: 'c' }]), 'mvp')
    expect(resolved.model).toBe('a')
    // 'x' 不在渠道、'b' 未启用、'a' 是主选 → 只剩 'c'
    expect(resolved.fallbacks).toEqual(['c'])
  })

  it('④无可用模型：明确报错，绝不硬编码模型名兜底', () => {
    const empty = makeChannel([{ name: 'a', enabled: false }])
    expect(() => resolveCategoryModel(empty, 'sketch')).toThrow('CHANNEL_MODEL_NOT_FOUND')
    expect(() => resolveCategoryModel(makeChannel([]), 'mvp')).toThrow('CHANNEL_MODEL_NOT_FOUND')
  })

  it('类别 → 权威阶段映射：引导/护栏类阶段 guide，草图 sketch，裁判 judge，编程 mvp', () => {
    expect(categoryForStage('clarifying')).toBe('guide')
    expect(categoryForStage('blocked_for_user_decision')).toBe('guide')
    expect(categoryForStage('sketch_ready')).toBe('guide')
    expect(categoryForStage('ready')).toBe('guide')
    expect(categoryForStage('completed')).toBe('guide')
    expect(categoryForStage('generating_sketch')).toBe('sketch')
    expect(categoryForStage('judge_review')).toBe('judge')
    expect(categoryForStage('generating_mvp')).toBe('mvp')
    expect(categoryForStage('iterating')).toBe('mvp')
    expect(categoryForStage('repairing')).toBe('mvp')
  })

  it('§7.7 类别温度表：guide 0.3（澄清发散），生成/判定类 0.1（严格可复现）', () => {
    expect(categoryTemperature('guide')).toBe(0.3)
    for (const category of ['prd', 'sketch', 'mvp', 'gwt', 'judge'] as DocumentCategory[]) {
      expect(categoryTemperature(category)).toBe(0.1)
    }
  })

  it('默认配置：除 audit 走 cheap（flash 级）外全类别 strongest、无手动档（行为可预期）', () => {
    for (const category of ALL_CATEGORIES) {
      expect(DEFAULT_CATEGORY_CONFIGS[category]).toEqual({ category, capability: 'strongest' })
    }
    expect(DEFAULT_CATEGORY_CONFIGS.summary).toEqual({ category: 'summary', capability: 'strongest' })
    // 决议 7：内审缺省 flash 级（cheap），顶配留给 MVP loop/spec 生成
    expect(DEFAULT_CATEGORY_CONFIGS.audit).toEqual({ category: 'audit', capability: 'cheap' })
  })

  it('②capability：balanced/cheap 优先 flash 级快模型，无匹配回退列表序首个（非破坏）', () => {
    const withFlash = makeChannel([{ name: 'deepseek-v4-pro' }, { name: 'deepseek-v4-flash' }])
    // audit 缺省 cheap → 命中 flash
    expect(resolveCategoryModel(withFlash, 'audit').model).toBe('deepseek-v4-flash')
    // 无 flash/lite/turbo 的渠道 → 回退列表序首个（单模型/多档渠道行为与改造前一致）
    const noFlash = makeChannel([{ name: 'MiniMax-M3' }, { name: 'minimax-highspeed' }])
    expect(resolveCategoryModel(noFlash, 'audit').model).toBe('MiniMax-M3')
  })

  it('②capability：cheap/balanced 也认 lite/turbo；strongest 不看名称只看列表序', () => {
    setCategoryConfigForTests({
      mvp: { category: 'mvp', capability: 'cheap' },
      gwt: { category: 'gwt', capability: 'balanced' },
    })
    const lite = makeChannel([{ name: 'doubao-seed-2.0-pro' }, { name: 'doubao-seed-2.0-lite' }])
    expect(resolveCategoryModel(lite, 'mvp').model).toBe('doubao-seed-2.0-lite')
    const turbo = makeChannel([{ name: 'glm-5.2' }, { name: 'glm-5-turbo' }])
    expect(resolveCategoryModel(turbo, 'gwt').model).toBe('glm-5-turbo')
    // strongest 依旧取列表序首个，即使后面跟着 flash
    const strong = makeChannel([{ name: 'a-pro' }, { name: 'a-flash' }])
    expect(resolveCategoryModel(strong, 'sketch').model).toBe('a-pro')
  })
})
