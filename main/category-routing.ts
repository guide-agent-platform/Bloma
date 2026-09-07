import { existsSync } from 'node:fs'
import type {
  AgentRoutingRole,
  CategoryRoutingConfig,
  CategoryRoutingEntry,
  CategoryRoutingListResult,
  CategoryRoutingRoleListResult,
  CategoryRoutingRoleView,
  CategoryRoutingView,
  DocumentCategory,
} from '../shared/types'
import { AGENT_ROLE_CATEGORIES, AGENT_ROUTING_ROLES } from '../shared/types'
import { getCategoryRoutingPath } from '../storage/config-paths'
import { readJsonFile, writeJsonFile } from '../storage/json-store'
import { getChannelByIdRaw, getFirstEnabledChannel, isAnthropicProtocolProvider } from './channel-manager'
import { resolveCategoryModel } from './model-resolution'

/**
 * 渠道运行时仍按 DocumentCategory 解析；设置层聚合为向导、编程、裁判三角色。
 * 历史 category-routing.json 保持类别级存储，所以旧配置与调用点无需迁移。
 */
export const ROLE_CATEGORIES: Record<AgentRoutingRole, readonly DocumentCategory[]> = AGENT_ROLE_CATEGORIES
export const ROUTABLE_ROLES: readonly AgentRoutingRole[] = AGENT_ROUTING_ROLES

export const ROLE_LABELS: Record<AgentRoutingRole, string> = {
  guide: '向导 Agent',
  programming: '编程 Agent',
  judge: '裁判 Agent',
}

export const ROLE_DESCRIPTIONS: Record<AgentRoutingRole, string> = {
  guide: '澄清需求、提取 PRD 与整理项目记忆',
  programming: '生成草图与完整可运行版本',
  judge: '审查需求与交付是否达到要求',
}

/** 运行时类别常量保留；设置页不再逐类显示。 */
export const ROUTABLE_CATEGORIES: readonly DocumentCategory[] = ['sketch', 'mvp', 'guide', 'prd', 'judge', 'audit', 'summary']

export const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  sketch: '草图生成',
  mvp: 'MVP 生成',
  guide: '向导澄清 / 意图判定',
  prd: 'PRD 提取 / 功能项加厚',
  judge: '裁判审查',
  audit: '内审（攻击 / 修订 / 复核）',
  summary: 'L3 蒸馏（默认关）',
  gwt: 'GWT 执行（不走 LLM 渠道）',
}

export function roleForCategory(category: DocumentCategory): AgentRoutingRole | undefined {
  return ROUTABLE_ROLES.find((role) => ROLE_CATEGORIES[role].includes(category))
}

let routingCache: CategoryRoutingConfig | undefined

function loadRoutingConfig(): CategoryRoutingConfig {
  if (routingCache) return routingCache
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
    routingCache = file.routing && typeof file.routing === 'object' ? file.routing as CategoryRoutingConfig : {}
  } catch (error) {
    console.warn('[categoryRouting] category-routing.json 损坏，回退空路由表：', error)
    routingCache = {}
  }
  return routingCache
}

/** 运行时/兼容代码读取类别级路由表。 */
export function loadCategoryRouting(): CategoryRoutingConfig {
  return { ...loadRoutingConfig() }
}

export function saveCategoryRouting(routing: CategoryRoutingConfig): void {
  writeJsonFile(getCategoryRoutingPath(), { version: 1, routing })
  routingCache = { ...routing }
}

/** 运行时按类别解析，角色 UI 保存时已将角色选择展开到所有关联类别。 */
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
    console.warn(`[categoryRouting] ${category} 类别路由指向的渠道「${channel.name}」非 Anthropic 协议（${channel.provider_type}），运行时无法走 /v1/messages，回退全局默认渠道`)
    return undefined
  }
  return channel.id
}

export function getCategoryFallbackChannelIds(category: DocumentCategory): string[] {
  return (loadRoutingConfig()[category]?.fallback_channel_ids ?? []).filter((id) => {
    const channel = getChannelByIdRaw(id)
    return channel !== undefined && channel.enabled
  })
}

function sameStringList(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? [])
}

function sameEntry(left: CategoryRoutingEntry | undefined, right: CategoryRoutingEntry | undefined): boolean {
  return left?.channel_id === right?.channel_id && sameStringList(left?.fallback_channel_ids, right?.fallback_channel_ids)
}

/** 裁判角色的附属内审类别（2026-09 内审闭环）：允许与主渠道不同渠道（厂商隔离），
 *  角色一致性判定（mixed）排除它，保存展开时可被 audit_channel_id 覆盖。 */
const ROLE_ATTACHED_AUDIT: Record<AgentRoutingRole, DocumentCategory | undefined> = { guide: undefined, programming: undefined, judge: 'audit' }

function resolvedAuditView(
  role: AgentRoutingRole,
  routing: CategoryRoutingConfig,
  globalDefault: ReturnType<typeof getFirstEnabledChannel>,
): CategoryRoutingRoleView['audit'] | undefined {
  const category = ROLE_ATTACHED_AUDIT[role]
  if (!category) return undefined
  const entry = routing[category]
  const configuredId = entry?.channel_id
  let effective: NonNullable<CategoryRoutingRoleView['audit']>['effective'] = 'auto'
  let channel = globalDefault
  if (configuredId) {
    const configured = getChannelByIdRaw(configuredId)
    if (!configured) effective = 'dangling'
    else if (configured.enabled && isAnthropicProtocolProvider(configured.provider_type)) {
      effective = 'routed'
      channel = configured
    }
  }
  let modelName: string | undefined
  if (channel) {
    try {
      modelName = resolveCategoryModel(channel, category).model
    } catch {
      modelName = undefined
    }
  }
  return {
    channel_id: configuredId,
    fallback_channel_ids: entry?.fallback_channel_ids,
    channel_name: channel?.name,
    model_name: modelName,
    effective,
  }
}

function resolvedRoleView(role: AgentRoutingRole, routing: CategoryRoutingConfig, globalDefault: ReturnType<typeof getFirstEnabledChannel>): CategoryRoutingRoleView {
  const categories = [...ROLE_CATEGORIES[role]]
  // 主类别 = 角色内除附属内审（audit）外的类别；audit 允许与主渠道不同，不参与 mixed 判定
  const mainCategories = categories.filter((category) => ROLE_ATTACHED_AUDIT[role] !== category)
  const entries = mainCategories.map((category) => routing[category])
  const first = entries[0]
  if (!entries.every((entry) => sameEntry(entry, first))) {
    return { role, label: ROLE_LABELS[role], description: ROLE_DESCRIPTIONS[role], categories, effective: 'mixed' }
  }

  const configuredId = first?.channel_id
  let effective: CategoryRoutingRoleView['effective'] = 'auto'
  let channel = globalDefault
  if (configuredId) {
    const configured = getChannelByIdRaw(configuredId)
    if (!configured) effective = 'dangling'
    else if (configured.enabled && isAnthropicProtocolProvider(configured.provider_type)) {
      effective = 'routed'
      channel = configured
    }
  }
  let modelName: string | undefined
  if (channel) {
    try {
      modelName = resolveCategoryModel(channel, mainCategories[0]!).model
    } catch {
      modelName = undefined
    }
  }
  return {
    role,
    label: ROLE_LABELS[role],
    description: ROLE_DESCRIPTIONS[role],
    categories,
    channel_id: configuredId,
    fallback_channel_ids: first?.fallback_channel_ids,
    channel_name: channel?.name,
    model_name: modelName,
    effective,
    audit: resolvedAuditView(role, routing, globalDefault),
  }
}

/** 设置页主接口：三角色视图。历史六类别配置若不一致，以 mixed 明示而不丢失。 */
export function buildCategoryRoutingRoleViews(): CategoryRoutingRoleListResult {
  const routing = loadCategoryRouting()
  const globalDefault = getFirstEnabledChannel()
  return { version: 2, views: ROUTABLE_ROLES.map((role) => resolvedRoleView(role, routing, globalDefault)) }
}

/** 历史类别级视图接口，供旧调用方兼容。 */
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
      if (!configured) effective = 'dangling'
      else if (configured.enabled && isAnthropicProtocolProvider(configured.provider_type)) {
        effective = 'routed'
        channel = configured
      }
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

const KNOWN_CATEGORIES = new Set<string>(['guide', 'prd', 'sketch', 'mvp', 'gwt', 'judge', 'audit', 'summary'])
const KNOWN_ROLES = new Set<string>(ROUTABLE_ROLES)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function keepChannelReference(scope: string, field: string, channelId: unknown): string | undefined {
  if (typeof channelId !== 'string' || !channelId) {
    throw new Error(`CATEGORY_ROUTING_INVALID: routing.${scope}.${field} 必须是非空字符串`)
  }
  const channel = getChannelByIdRaw(channelId)
  if (!channel) {
    console.warn(`[categoryRouting] 保存时剥离 ${scope}.${field}：渠道 ${channelId} 不存在或非本项目渠道`)
    return undefined
  }
  if (!isAnthropicProtocolProvider(channel.provider_type)) {
    console.warn(`[categoryRouting] 保存时剥离 ${scope}.${field}：渠道「${channel.name}」（${channel.provider_type}）非 Anthropic 协议，运行时固定请求 /v1/messages 会 404`)
    return undefined
  }
  return channelId
}

function cleanRoutingEntry(scope: string, entry: unknown): CategoryRoutingEntry | undefined {
  if (entry === undefined || entry === null) return undefined
  if (!isRecord(entry)) throw new Error(`CATEGORY_ROUTING_INVALID: routing.${scope} 必须是对象`)
  const cleaned: CategoryRoutingEntry = {}
  if (entry.channel_id !== undefined) {
    const kept = keepChannelReference(scope, 'channel_id', entry.channel_id)
    if (kept) cleaned.channel_id = kept
  }
  if (entry.fallback_channel_ids !== undefined) {
    if (!Array.isArray(entry.fallback_channel_ids)) throw new Error(`CATEGORY_ROUTING_INVALID: routing.${scope}.fallback_channel_ids 必须是字符串数组`)
    const kept = entry.fallback_channel_ids
      .map((id, index) => keepChannelReference(scope, `fallback_channel_ids[${index}]`, id))
      .filter((id): id is string => id !== undefined)
    if (kept.length) cleaned.fallback_channel_ids = kept
  }
  return cleaned.channel_id !== undefined || cleaned.fallback_channel_ids !== undefined ? cleaned : undefined
}

/** 历史类别级全量保存入口。 */
export function updateCategoryRouting(routing: unknown): CategoryRoutingListResult {
  if (!isRecord(routing)) throw new Error('CATEGORY_ROUTING_INVALID: routing 必须是对象')
  const cleaned: CategoryRoutingConfig = {}
  for (const [key, entry] of Object.entries(routing)) {
    if (!KNOWN_CATEGORIES.has(key)) {
      console.warn(`[categoryRouting] 保存时剥离未知类别键「${key}」`)
      continue
    }
    const cleanedEntry = cleanRoutingEntry(key, entry)
    if (cleanedEntry) cleaned[key as DocumentCategory] = cleanedEntry
  }
  saveCategoryRouting(cleaned)
  return buildCategoryRoutingViews()
}

/** 新三角色全量保存：每个角色选择展开写到其覆盖的所有运行时类别。
 *  裁判角色附属的 audit 类别缺省随主渠道展开；显式携带 audit_channel_id 时独立生效
 *  （2026-09 内审闭环：厂商隔离需要 audit 可指向不同厂商渠道）。 */
export function updateCategoryRoutingRoles(routing: unknown): CategoryRoutingRoleListResult {
  if (!isRecord(routing)) throw new Error('CATEGORY_ROUTING_INVALID: routing 必须是对象')
  const cleaned: CategoryRoutingConfig = {}
  for (const [key, entry] of Object.entries(routing)) {
    if (!KNOWN_ROLES.has(key)) {
      console.warn(`[categoryRouting] 保存时剥离未知角色键「${key}」`)
      continue
    }
    const role = key as AgentRoutingRole
    if (!isRecord(entry)) throw new Error(`CATEGORY_ROUTING_INVALID: routing.${key} 必须是对象`)
    const cleanedEntry = cleanRoutingEntry(key, entry)
    const attachedCategory = ROLE_ATTACHED_AUDIT[role]
    // 附属 audit 渠道：显式指定优先；校验口径与主渠道一致（存在 + Anthropic 协议）
    let auditChannelId: string | undefined
    let auditFallbackIds: string[] | undefined
    if (attachedCategory && entry.audit_channel_id !== undefined) {
      auditChannelId = keepChannelReference(key, 'audit_channel_id', entry.audit_channel_id)
    }
    if (attachedCategory && entry.audit_fallback_channel_ids !== undefined) {
      if (!Array.isArray(entry.audit_fallback_channel_ids)) throw new Error(`CATEGORY_ROUTING_INVALID: routing.${key}.audit_fallback_channel_ids 必须是字符串数组`)
      auditFallbackIds = entry.audit_fallback_channel_ids
        .map((id: unknown, index: number) => keepChannelReference(key, `audit_fallback_channel_ids[${index}]`, id))
        .filter((id: string | undefined): id is string => id !== undefined)
    }
    // 主渠道未配且无附属 audit 配置：整个角色无内容，跳过（与旧语义一致）
    if (!cleanedEntry && auditChannelId === undefined && !(auditFallbackIds?.length)) continue
    for (const category of ROLE_CATEGORIES[role]) {
      if (category === attachedCategory && (auditChannelId !== undefined || auditFallbackIds !== undefined)) {
        cleaned[category] = {
          ...(auditChannelId ? { channel_id: auditChannelId } : {}),
          ...(auditFallbackIds?.length ? { fallback_channel_ids: [...auditFallbackIds] } : {}),
        }
        continue
      }
      cleaned[category] = {
        ...(cleanedEntry?.channel_id ? { channel_id: cleanedEntry.channel_id } : {}),
        ...(cleanedEntry?.fallback_channel_ids?.length ? { fallback_channel_ids: [...cleanedEntry.fallback_channel_ids] } : {}),
      }
    }
  }
  saveCategoryRouting(cleaned)
  return buildCategoryRoutingRoleViews()
}

export function setCategoryRoutingForTests(config: CategoryRoutingConfig): void {
  routingCache = { ...config }
}

export function resetCategoryRoutingForTests(): void {
  routingCache = undefined
}
