import { restorePromaHome } from '../support/proma-home-guard'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel } from '../../shared/types'
import { createChannel, updateChannel } from '../../main/channel-manager'
import { setSafeStorageAdapter } from '../../main/safe-storage'
import { getCategoryRoutingPath } from '../../storage/config-paths'
import {
  buildCategoryRoutingViews,
  buildCategoryRoutingRoleViews,
  getCategoryFallbackChannelIds,
  loadCategoryRouting,
  resetCategoryRoutingForTests,
  resolveRoutedChannelId,
  roleForCategory,
  ROLE_CATEGORIES,
  ROUTABLE_ROLES,
  saveCategoryRouting,
  setCategoryRoutingForTests,
  updateCategoryRouting,
  updateCategoryRoutingRoles,
} from '../../main/category-routing'

/**
 * 类别 → 渠道路由（M5）：每个职责可固定走某家厂商渠道，未配置类别保持全局自动。
 * 锁定行为（§4/§6/§10）：
 * - 解析优先级（显式 channel_id > 路由表 > 全局兜底）由 resolveChannelEnv 集成，
 *   本文件锁 resolveRoutedChannelId 三态回退（悬空/禁用/非 Anthropic 协议）；
 * - 悬空（已删除）→ 回退 + console.warn（不静默）；禁用 → 回退不落警示（保留意图）；
 * - 保存护栏：结构非法抛错（VALIDATION_ERROR 口径），无效引用剥离 + warn 不阻塞其余；
 * - 往返持久化 + 损坏文件回退空表。
 */

function workingSafeStorage(): void {
  setSafeStorageAdapter({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
  })
}

function seedChannel(name: string, providerType: Channel['provider_type'] = 'anthropic'): Channel {
  return createChannel({
    name,
    provider_type: providerType,
    base_url: `https://${name}.example`,
    api_key: `key-${name}`,
    models: [{ id: `${name}-m1`, name: `model-${name}`, enabled: true }],
  })
}

describe('category-routing（M5 类别→渠道路由）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-category-routing-'))
    workingSafeStorage()
    resetCategoryRoutingForTests()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    resetCategoryRoutingForTests()
    vi.restoreAllMocks()
  })

  it('角色映射固定为向导/编程/裁判三组，gwt 不属于角色', () => {
    expect(ROUTABLE_ROLES).toEqual(['guide', 'programming', 'judge'])
    expect(ROLE_CATEGORIES.guide).toEqual(['guide', 'prd', 'summary'])
    expect(ROLE_CATEGORIES.programming).toEqual(['sketch', 'mvp'])
    expect(ROLE_CATEGORIES.judge).toEqual(['judge'])
    expect(roleForCategory('guide')).toBe('guide')
    expect(roleForCategory('prd')).toBe('guide')
    expect(roleForCategory('summary')).toBe('guide')
    expect(roleForCategory('sketch')).toBe('programming')
    expect(roleForCategory('mvp')).toBe('programming')
    expect(roleForCategory('judge')).toBe('judge')
    expect(roleForCategory('gwt')).toBeUndefined()
  })

  it('角色视图始终只有三行，旧类别配置一致时聚合为角色渠道', () => {
    const ds = seedChannel('ds', 'deepseek')
    const kimi = seedChannel('kimi', 'kimi-api')
    saveCategoryRouting({
      guide: { channel_id: ds.id },
      prd: { channel_id: ds.id },
      summary: { channel_id: ds.id },
      sketch: { channel_id: kimi.id },
      mvp: { channel_id: kimi.id },
    })

    const result = buildCategoryRoutingRoleViews()
    expect(result.version).toBe(2)
    expect(result.views.map((view) => view.role)).toEqual(['guide', 'programming', 'judge'])
    expect(result.views).toHaveLength(3)
    expect(result.views.find((view) => view.role === 'guide')).toMatchObject({
      label: '向导 Agent', channel_id: ds.id, effective: 'routed',
    })
    expect(result.views.find((view) => view.role === 'programming')).toMatchObject({
      label: '编程 Agent', channel_id: kimi.id, effective: 'routed',
    })
  })

  it('旧类别配置在同一角色内不一致时显示 mixed，不静默覆盖', () => {
    const ds = seedChannel('ds', 'deepseek')
    const kimi = seedChannel('kimi', 'kimi-api')
    saveCategoryRouting({ guide: { channel_id: ds.id }, prd: { channel_id: kimi.id } })
    const guide = buildCategoryRoutingRoleViews().views.find((view) => view.role === 'guide')!
    expect(guide.effective).toBe('mixed')
    expect(guide.channel_id).toBeUndefined()
  })

  it('角色保存会展开到全部关联类别，运行时类别解析随角色选择生效', () => {
    const ds = seedChannel('ds', 'deepseek')
    const kimi = seedChannel('kimi', 'kimi-api')
    updateCategoryRoutingRoles({
      guide: { channel_id: ds.id, fallback_channel_ids: [kimi.id] },
      programming: { channel_id: kimi.id },
      judge: { channel_id: ds.id },
    })
    expect(loadCategoryRouting()).toEqual({
      guide: { channel_id: ds.id, fallback_channel_ids: [kimi.id] },
      prd: { channel_id: ds.id, fallback_channel_ids: [kimi.id] },
      summary: { channel_id: ds.id, fallback_channel_ids: [kimi.id] },
      sketch: { channel_id: kimi.id },
      mvp: { channel_id: kimi.id },
      judge: { channel_id: ds.id },
    })
    expect(resolveRoutedChannelId('prd')).toBe(ds.id)
    expect(resolveRoutedChannelId('mvp')).toBe(kimi.id)
  })

  it('角色保存是全量覆盖，缺省角色会清除旧类别配置', () => {
    const ds = seedChannel('ds', 'deepseek')
    const kimi = seedChannel('kimi', 'kimi-api')
    saveCategoryRouting({ guide: { channel_id: ds.id }, sketch: { channel_id: kimi.id } })
    updateCategoryRoutingRoles({ guide: { channel_id: ds.id } })
    expect(loadCategoryRouting()).toEqual({
      guide: { channel_id: ds.id },
      prd: { channel_id: ds.id },
      summary: { channel_id: ds.id },
    })
  })

  it('路由命中：返回配置渠道 id', () => {
    const kimi = seedChannel('kimi', 'kimi-api')
    setCategoryRoutingForTests({ sketch: { channel_id: kimi.id } })
    expect(resolveRoutedChannelId('sketch')).toBe(kimi.id)
  })

  it('未配置类别返回 undefined（全局自动）', () => {
    seedChannel('any')
    expect(resolveRoutedChannelId('mvp')).toBeUndefined()
    expect(resolveRoutedChannelId('guide')).toBeUndefined()
  })

  it('悬空引用（渠道已删除）→ undefined + console.warn（不静默）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setCategoryRoutingForTests({ sketch: { channel_id: 'deleted-channel-id' } })
    expect(resolveRoutedChannelId('sketch')).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('已删除'))
  })

  it('禁用渠道 → undefined 且不落警示（保留意图，重启用后自动恢复）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const glm = seedChannel('glm', 'zhipu-coding')
    updateChannel(glm.id, { enabled: false })
    setCategoryRoutingForTests({ mvp: { channel_id: glm.id } })

    expect(resolveRoutedChannelId('mvp')).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()

    // 重新启用 → 路由自动恢复
    updateChannel(glm.id, { enabled: true })
    expect(resolveRoutedChannelId('mvp')).toBe(glm.id)
  })

  it('协议复核：指向 OpenAI 协议渠道（如 zhipu）→ undefined + console.warn（防运行时 404）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const zhipuOpenai = seedChannel('zhipu-openai', 'zhipu')
    setCategoryRoutingForTests({ mvp: { channel_id: zhipuOpenai.id } })

    expect(resolveRoutedChannelId('mvp')).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('非 Anthropic 协议'))
  })

  it('协议复核覆盖「保存后被 updateChannel 改协议」的场景（§4.3/§9.1）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const glm = seedChannel('glm', 'zhipu-coding')
    setCategoryRoutingForTests({ mvp: { channel_id: glm.id } })
    expect(resolveRoutedChannelId('mvp')).toBe(glm.id)

    // 保存后渠道被改成 OpenAI 协议 → 解析不再判 routed
    updateChannel(glm.id, { provider_type: 'zhipu' })
    expect(resolveRoutedChannelId('mvp')).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('非 Anthropic 协议'))
  })

  // ------------------------------------------------------------------
  // getCategoryFallbackChannelIds：过滤不存在/禁用条目
  // ------------------------------------------------------------------

  it('备用顺序：过滤不存在与禁用条目，保留有效项（保序）', () => {
    const ds = seedChannel('ds', 'deepseek')
    const disabled = seedChannel('disabled')
    updateChannel(disabled.id, { enabled: false })
    setCategoryRoutingForTests({
      sketch: { fallback_channel_ids: ['ghost', ds.id, disabled.id] },
    })
    expect(getCategoryFallbackChannelIds('sketch')).toEqual([ds.id])
  })

  it('未配置备用顺序返回空数组（退化为 T9 任意 enabled 渠道）', () => {
    seedChannel('any')
    expect(getCategoryFallbackChannelIds('judge')).toEqual([])
  })

  // ------------------------------------------------------------------
  // load/save 往返 + 损坏文件回退
  // ------------------------------------------------------------------

  it('saveCategoryRouting/loadCategoryRouting 往返（固定 version:1 落盘）', () => {
    const ds = seedChannel('ds', 'deepseek')
    const kimi = seedChannel('kimi', 'kimi-api')
    saveCategoryRouting({
      sketch: { channel_id: kimi.id, fallback_channel_ids: [ds.id] },
      guide: { channel_id: ds.id },
    })

    // 模块缓存在 save 后立即生效
    expect(resolveRoutedChannelId('sketch')).toBe(kimi.id)
    // 磁盘往返：复位缓存后重读
    resetCategoryRoutingForTests()
    expect(loadCategoryRouting()).toEqual({
      sketch: { channel_id: kimi.id, fallback_channel_ids: [ds.id] },
      guide: { channel_id: ds.id },
    })
    const raw = JSON.parse(readFileSync(getCategoryRoutingPath(), 'utf8')) as { version: number }
    expect(raw.version).toBe(1)
  })

  it('无 category-routing.json 时 loadCategoryRouting 返回空表（fresh/存量向后兼容）', () => {
    expect(loadCategoryRouting()).toEqual({})
    expect(existsSync(getCategoryRoutingPath())).toBe(false)
  })

  it('损坏文件回退空表 + 警告', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    writeFileSync(getCategoryRoutingPath(), '{not json', 'utf8')

    expect(loadCategoryRouting()).toEqual({})
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('损坏'), expect.anything())
  })

  it('version 不符回退空表 + 警告', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    writeFileSync(getCategoryRoutingPath(), JSON.stringify({ version: 99, routing: { sketch: { channel_id: 'x' } } }), 'utf8')

    expect(loadCategoryRouting()).toEqual({})
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('version'))
  })

  // ------------------------------------------------------------------
  // updateCategoryRouting：保存护栏（§6 全分支）
  // ------------------------------------------------------------------

  it('结构非法抛错：routing 非对象 / 条目非对象 / 字段类型错（走 VALIDATION_ERROR 口径）', () => {
    expect(() => updateCategoryRouting('nope' as unknown)).toThrow('CATEGORY_ROUTING_INVALID')
    expect(() => updateCategoryRouting(42 as unknown)).toThrow('CATEGORY_ROUTING_INVALID')
    expect(() => updateCategoryRouting({ sketch: 'bad' as unknown })).toThrow('CATEGORY_ROUTING_INVALID')
    expect(() => updateCategoryRouting({ sketch: { channel_id: 42 as unknown } })).toThrow('CATEGORY_ROUTING_INVALID')
    expect(() => updateCategoryRouting({ sketch: { fallback_channel_ids: 'nope' as unknown } })).toThrow('CATEGORY_ROUTING_INVALID')
    expect(() => updateCategoryRouting({ sketch: { fallback_channel_ids: [42 as unknown] } })).toThrow('CATEGORY_ROUTING_INVALID')
  })

  it('已删除/非本项目引用 → 剥离该引用 + console.warn，其余类别正常保存不被阻塞', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ds = seedChannel('ds', 'deepseek')

    const result = updateCategoryRouting({
      sketch: { channel_id: 'ghost-id', fallback_channel_ids: ['ghost-id'] },
      guide: { channel_id: ds.id },
    })

    // sketch 条目剥离后为空 → 整条不写（悬空不落盘）
    expect(loadCategoryRouting()).toEqual({ guide: { channel_id: ds.id } })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('不存在或非本项目渠道'))
    // 返回视图模型：guide routed、sketch auto
    const guideView = result.views.find((view) => view.category === 'guide')
    const sketchView = result.views.find((view) => view.category === 'sketch')
    expect(guideView?.effective).toBe('routed')
    expect(guideView?.channel_id).toBe(ds.id)
    expect(sketchView?.effective).toBe('auto')
    expect(sketchView?.channel_id).toBeUndefined()
  })

  it('非 Anthropic 协议引用（启用渠道）→ 剥离 + console.warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const zhipuOpenai = seedChannel('zhipu-openai', 'zhipu')

    updateCategoryRouting({ mvp: { channel_id: zhipuOpenai.id } })

    expect(loadCategoryRouting()).toEqual({})
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('非 Anthropic 协议'))
  })

  it('非 Anthropic 协议引用（禁用渠道）→ 同剥离 + console.warn（重启用后仍 404，保留意图无意义）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const zhipuOpenai = seedChannel('zhipu-openai', 'zhipu')
    updateChannel(zhipuOpenai.id, { enabled: false })

    updateCategoryRouting({ mvp: { channel_id: zhipuOpenai.id } })

    expect(loadCategoryRouting()).toEqual({})
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('非 Anthropic 协议'))
  })

  it('禁用且 Anthropic 协议渠道 → 保留条目（重新启用后自动恢复）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ds = seedChannel('ds', 'deepseek')
    updateChannel(ds.id, { enabled: false })

    updateCategoryRouting({ judge: { channel_id: ds.id } })

    expect(loadCategoryRouting()).toEqual({ judge: { channel_id: ds.id } })
  })

  it('未知类别键（如 "foo"）→ 剥离 + console.warn，不阻塞其余类别', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ds = seedChannel('ds', 'deepseek')

    updateCategoryRouting({ foo: { channel_id: ds.id }, guide: { channel_id: ds.id } } as unknown)

    expect(loadCategoryRouting()).toEqual({ guide: { channel_id: ds.id } })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('未知类别键「foo」'))
  })

  it('全量覆盖语义：缺省类别 = 未配置（旧行被清除）', () => {
    const ds = seedChannel('ds', 'deepseek')
    const kimi = seedChannel('kimi', 'kimi-api')
    updateCategoryRouting({ sketch: { channel_id: kimi.id }, guide: { channel_id: ds.id } })
    expect(loadCategoryRouting()).toEqual({ sketch: { channel_id: kimi.id }, guide: { channel_id: ds.id } })

    // 只带 sketch 的全量保存 → guide 被清除
    updateCategoryRouting({ sketch: { channel_id: kimi.id } })
    expect(loadCategoryRouting()).toEqual({ sketch: { channel_id: kimi.id } })
  })

  // ------------------------------------------------------------------
  // 视图模型（effective 三态 + label/模型预览）
  // ------------------------------------------------------------------

  it('buildCategoryRoutingViews：routed/auto/dangling 三态与模型预览、6 类职责齐全', () => {
    const ds = seedChannel('ds', 'deepseek')
    const kimi = seedChannel('kimi', 'kimi-api')
    const glm = seedChannel('glm', 'zhipu-coding')
    saveCategoryRouting({
      sketch: { channel_id: kimi.id },
      mvp: { channel_id: glm.id },
      guide: { channel_id: 'deleted-id' },
      judge: { channel_id: ds.id },
    })
    updateChannel(ds.id, { enabled: false }) // judge 渠道禁用 → auto（生效期）

    const result = buildCategoryRoutingViews()

    // 6 类职责（gwt 不参与路由）
    expect(result.views.map((view) => view.category)).toEqual(['sketch', 'mvp', 'guide', 'prd', 'judge', 'summary'])
    // label 与 §1 映射表逐字一致
    expect(result.views.find((view) => view.category === 'sketch')?.label).toBe('草图生成')
    expect(result.views.find((view) => view.category === 'mvp')?.label).toBe('MVP 生成')
    expect(result.views.find((view) => view.category === 'guide')?.label).toBe('向导澄清 / 意图判定')
    expect(result.views.find((view) => view.category === 'prd')?.label).toBe('PRD 提取 / 功能项加厚')
    expect(result.views.find((view) => view.category === 'judge')?.label).toBe('裁判审查')
    expect(result.views.find((view) => view.category === 'summary')?.label).toBe('L3 蒸馏（默认关）')

    const sketch = result.views.find((view) => view.category === 'sketch')!
    expect(sketch.effective).toBe('routed')
    expect(sketch.channel_name).toBe('kimi')
    expect(sketch.model_name).toBe('model-kimi')

    const mvp = result.views.find((view) => view.category === 'mvp')!
    expect(mvp.effective).toBe('routed')
    expect(mvp.channel_name).toBe('glm')

    // 悬空：保留原配置值供展示 + 显示全局默认渠道解析结果
    const guide = result.views.find((view) => view.category === 'guide')!
    expect(guide.effective).toBe('dangling')
    expect(guide.channel_id).toBe('deleted-id')
    expect(guide.channel_name).toBeDefined()

    // 禁用渠道生效期 → auto
    const judge = result.views.find((view) => view.category === 'judge')!
    expect(judge.effective).toBe('auto')
    expect(judge.channel_id).toBe(ds.id)

    // 未配置类别 → auto
    expect(result.views.find((view) => view.category === 'prd')?.effective).toBe('auto')
  })

  // ------------------------------------------------------------------
  // 测试 seam
  // ------------------------------------------------------------------

  it('测试 seam：注入即生效，复位后回到磁盘读取', () => {
    const kimi = seedChannel('kimi', 'kimi-api')
    setCategoryRoutingForTests({ sketch: { channel_id: kimi.id } })
    expect(resolveRoutedChannelId('sketch')).toBe(kimi.id)

    resetCategoryRoutingForTests()
    expect(resolveRoutedChannelId('sketch')).toBeUndefined() // 磁盘无文件 → 空表
  })
})
