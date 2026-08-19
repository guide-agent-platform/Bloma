import { existsSync } from 'node:fs'
import type {
  CategoryRoutingConfig,
  CategoryRoutingListResult,
  CategoryRoutingView,
  DocumentCategory,
} from '../shared/types'
import { getCategoryRoutingPath } from '../storage/config-paths'
import { readJsonFile, writeJsonFile } from '../storage/json-store'
import { getChannelByIdRaw, getFirstEnabledChannel, isAnthropicProtocolProvider } from './channel-manager'
import { resolveCategoryModel } from './model-resolution'

/**
 * 类别 → 渠道路由（M5，2026-08-19 设计定稿）。
 *
 * 新增全局分工表 `~/.proma/category-routing.json`（snake_case）：每个职责
 * （DocumentCategory）可固定走某家厂商的渠道，未配置的类别保持「全局自动」。
 * 与 M4/T9 正交：
 * - M4 `resolveCategoryModel` 在赢家渠道内决定「哪个模型」；
 * - 本模块决定「哪个渠道」（主路由 `resolveRoutedChannelId` + 备用顺序
 *   `getCategoryFallbackChannelIds`）；
 * - T9 `runtime-fallback` 仍负责基础设施故障的跨渠道切换留痕（内容型失败不切）。
 *
 * 配置不进 channels.json——后者与 Proma 共用且走 camelCase，混入会破坏
 * isOursChannel 过滤与 Proma 兼容。无配置文件时行为与 M4/T9 现状完全一致。
 */

/** 参与渠道路由的类别（§1 映射表）；gwt 走浏览器探针/静态启发式、从不解析 LLM 渠道，不在列。 */
export const ROUTABLE_CATEGORIES: readonly DocumentCategory[] = ['sketch', 'mvp', 'guide', 'prd', 'judge', 'summary']

/** 类别 → 中文职责名（§1 职责列逐字一致，供视图模型与设置页共用）。 */
export const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  sketch: '草图生成',
  mvp: 'MVP 生成',
  guide: '向导澄清 / 意图判定',
  prd: 'PRD 提取 / 功能项加厚',
  judge: '裁判审查',
  summary: 'L3 蒸馏（默认关）',
  gwt: 'GWT 执行（不走 LLM 渠道）',
}

/** undefined = 尚未从磁盘加载（下次访问再读）；缓存与 M4 的 categoryConfigs 同模式。 */
let routingCache: CategoryRoutingConfig | undefined

function loadRoutingConfig(): CategoryRoutingConfig {
  if (routingCache) return routingCache
  // 无配置文件是正常态（fresh/存量用户）：空表直接生效，不落警告（§9.5 向后兼容）
  if (!existsSync(getCategoryRoutingPath())) {
    routingCache = {}
    return routingCache
  }
  try {
    const file = readJsonFile<{ version?: unknown; routing?: unknown }>(getCategoryRoutingPath(), {})
    if (file.version !== 1) {
      console.warn('[categoryRouting] category-routing.json version 不支持，回退空路由表')
      routingCache = {}
      return routingCache
    }
    const routing = file.routing
    routingCache = routing && typeof routing === 'object' ? (routing as CategoryRoutingConfig) : {}
  } catch (error) {
    console.warn('[categoryRouting] category-routing.json 损坏，回退空路由表：', error)
    routingCache = {}
  }
  return routingCache
}

/** 读取路由表（副本）；文件缺失/损坏/version 不符回退空表（损坏落 console.warn）。 */
export function loadCategoryRouting(): CategoryRoutingConfig {
  return { ...loadRoutingConfig() }
}

/** 固定以 version: 1 组装落盘，并刷新模块缓存。 */
export function saveCategoryRouting(routing: CategoryRoutingConfig): void {
  writeJsonFile(getCategoryRoutingPath(), { version: 1, routing })
  routingCache = { ...routing }
}

/**
 * 解析类别的主路由渠道 id（§4.1 ②）：
 * - 悬空（渠道已删除）→ undefined + console.warn（不静默，设置页同步警示）；
 * - 渠道禁用 → undefined 不落警示（保留意图，重新启用后自动恢复）；
 * - 非 Anthropic 协议 → undefined + console.warn（运行时固定 /v1/messages，防
 *   保存后 updateChannel 改协议或人工/旧版本写入 OpenAI 协议渠道 id 导致 404）。
 * 未配置/各类回退均返回 undefined，由调用方落入全局兜底（getFirstEnabledChannel）。
 */
export function resolveRoutedChannelId(category: DocumentCategory): string | undefined {
  const entry = loadRoutingConfig()[category]
  if (!entry?.channel_id) return undefined
  const channel = getChannelByIdRaw(entry.channel_id)
  if (!channel) {
    console.warn(`[categoryRouting] ${category} 类别路由指向的渠道 ${entry.channel_id} 已删除（悬空），回退全局默认渠道`)
    return undefined
  }
  if (!channel.enabled) return undefined
  if (!isAnthropicProtocolProvider(channel.provider_type)) {
    console.warn(
      `[categoryRouting] ${category} 类别路由指向的渠道「${channel.name}」非 Anthropic 协议（${channel.provider_type}），` +
        '运行时无法走 /v1/messages，回退全局默认渠道',
    )
    return undefined
  }
  return channel.id
}

/**
 * 类别的备用渠道优先顺序（§4.4）：读 fallback_channel_ids，过滤
 * 「不存在/非本项目/禁用」条目（getChannelByIdRaw 已含 isOursChannel 校验）。
 */
export function getCategoryFallbackChannelIds(category: DocumentCategory): string[] {
  const entry = loadRoutingConfig()[category]
  return (entry?.fallback_channel_ids ?? []).filter((id) => {
    const channel = getChannelByIdRaw(id)
    return channel !== undefined && channel.enabled
  })
}

// ---------------------------------------------------------------------------
// 视图模型（category-routing:list / update 返回值）
// ---------------------------------------------------------------------------

/**
 * 构建 6 类职责的视图模型（§6）：channel_name/model_name 供 UI 直接渲染；
 * effective 三态——routed=命中路由，auto=全局默认（含禁用渠道生效期），
 * dangling=指向已删除渠道（保留原配置值供展示，UI 行内警示 + 「恢复自动」）。
 */
export function buildCategoryRoutingViews(): CategoryRoutingListResult {
  const routing = loadCategoryRouting()
  const globalDefault = getFirstEnabledChannel()
  const views: CategoryRoutingView[] = ROUTABLE_CATEGORIES.map((category) => {
    const entry = routing[category]
    const configuredId = entry?.channel_id
    let effective: CategoryRoutingView['effective'] = 'auto'
    let channel = globalDefault
    if (configuredId) {
      const configured = getChannelByIdRaw(configuredId)
      if (!configured) {
        effective = 'dangling'
      } else if (configured.enabled && isAnthropicProtocolProvider(configured.provider_type)) {
        effective = 'routed'
        channel = configured
      }
      // 禁用（生效期）或非 Anthropic 协议：运行时按未设置回退 → auto（§6 口径）
    }
    let model_name: string | undefined
    if (channel) {
      try {
        model_name = resolveCategoryModel(channel, category).model
      } catch {
        model_name = undefined
      }
    }
    return {
      category,
      label: CATEGORY_LABELS[category],
      channel_id: configuredId,
      fallback_channel_ids: entry?.fallback_channel_ids,
      channel_name: channel?.name,
      model_name,
      effective,
    }
  })
  return { version: 1, views }
}

// ---------------------------------------------------------------------------
// 保存校验（category-routing:update）
// ---------------------------------------------------------------------------

const KNOWN_CATEGORIES = new Set<string>(['guide', 'prd', 'sketch', 'mvp', 'gwt', 'judge', 'summary'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 单个渠道引用的剥离判定：返回保留该引用时对应的渠道 id，否则 undefined。 */
function keepChannelReference(category: string, field: string, channelId: unknown): string | undefined {
  if (typeof channelId !== 'string' || !channelId) {
    throw new Error(`CATEGORY_ROUTING_INVALID: routing.${category}.${field} 必须是非空字符串`)
  }
  const channel = getChannelByIdRaw(channelId)
  if (!channel) {
    console.warn(`[categoryRouting] 保存时剥离 ${category}.${field}：渠道 ${channelId} 不存在或非本项目渠道`)
    return undefined
  }
  if (!isAnthropicProtocolProvider(channel.provider_type)) {
    // 含启用与禁用的 OpenAI 协议渠道：重启用后仍 404，保留意图无意义
    console.warn(
      `[categoryRouting] 保存时剥离 ${category}.${field}：渠道「${channel.name}」（${channel.provider_type}）非 Anthropic 协议，` +
        '运行时固定请求 /v1/messages 会 404',
    )
    return undefined
  }
  // 禁用 + Anthropic 协议：保留（重新启用后自动恢复）
  return channelId
}

/**
 * 全量覆盖保存（§6 护栏）：
 * - 结构非法（routing 非对象 / 条目非对象 / 字段类型错）→ 抛错走 VALIDATION_ERROR；
 * - 引用已删除/非本项目/非 Anthropic 协议渠道 → 剥离该引用 + console.warn，不阻塞其余保存；
 * - 禁用且 Anthropic 协议的引用 → 保留意图；
 * - 未知类别键（如 "foo"）→ 剥离 + console.warn；
 * - 剥离后条目为空则整条不写（悬空不落盘）。
 */
export function updateCategoryRouting(routing: unknown): CategoryRoutingListResult {
  if (!isRecord(routing)) {
    throw new Error('CATEGORY_ROUTING_INVALID: routing 必须是对象')
  }
  const cleaned: CategoryRoutingConfig = {}
  for (const [key, entry] of Object.entries(routing)) {
    if (!KNOWN_CATEGORIES.has(key)) {
      console.warn(`[categoryRouting] 保存时剥离未知类别键「${key}」`)
      continue
    }
    if (entry === undefined || entry === null) continue
    if (!isRecord(entry)) {
      throw new Error(`CATEGORY_ROUTING_INVALID: routing.${key} 必须是对象`)
    }
    const category = key as DocumentCategory
    const cleanedEntry: { channel_id?: string; fallback_channel_ids?: string[] } = {}
    if (entry.channel_id !== undefined) {
      const kept = keepChannelReference(key, 'channel_id', entry.channel_id)
      if (kept) cleanedEntry.channel_id = kept
    }
    if (entry.fallback_channel_ids !== undefined) {
      if (!Array.isArray(entry.fallback_channel_ids)) {
        throw new Error(`CATEGORY_ROUTING_INVALID: routing.${key}.fallback_channel_ids 必须是字符串数组`)
      }
      const keptList = entry.fallback_channel_ids
        .map((id, index) => keepChannelReference(key, `fallback_channel_ids[${index}]`, id))
        .filter((id): id is string => id !== undefined)
      if (keptList.length > 0) cleanedEntry.fallback_channel_ids = keptList
    }
    if (cleanedEntry.channel_id !== undefined || cleanedEntry.fallback_channel_ids !== undefined) {
      cleaned[category] = cleanedEntry
    }
  }
  saveCategoryRouting(cleaned)
  return buildCategoryRoutingViews()
}

// ---------------------------------------------------------------------------
// 测试 seam（同 M4 的 categoryConfigs 模式）
// ---------------------------------------------------------------------------

/** 测试注入路由表（不经磁盘）；resetCategoryRoutingForTests 复位为「未加载」。 */
export function setCategoryRoutingForTests(config: CategoryRoutingConfig): void {
  routingCache = { ...config }
}

export function resetCategoryRoutingForTests(): void {
  routingCache = undefined
}
