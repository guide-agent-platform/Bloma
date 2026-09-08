import type { Channel } from '../shared/types'
import { appendJsonLine } from '../storage/json-store'
import { getAgentSessionPath } from '../storage/config-paths'
import { appendSessionMessage } from './session-tree'
import {
  buildSdkEnv,
  decryptApiKey,
  getChannelByIdRaw,
  getFirstEnabledChannel,
  listEnabledRawChannels,
} from './channel-manager'
import { getCategoryFallbackChannelIds, resolveRoutedChannelId } from './category-routing'
import { recordDecision } from './decision-log'
import { resolveCategoryModel, type DocumentCategory } from './model-resolution'

/**
 * 运行时被动渠道回退（长期型改造 T9，M4 补丁）。
 *
 * M4 的类别解析是「主动链」：运行前一次性选好模型。渠道瞬断（429/5xx/网络错误）
 * 或密钥损坏时，原行为是整次生成静默降级——引导落规则路由、草图落模板，
 * 违背长期型「死不了」的预期。本模块补「被动链」：
 *
 * - 构建期（resolveChannelEnv）：主渠道密钥不可解密/无启用模型时，按同一类别
 *   解析链切第一个可用备用渠道，而非直接降级；
 * - 请求期（orchestrator.queryWithRuntimeFallback 消费本模块）：首调基础设施
 *   故障且尚未流出正文时，切备用渠道重试一次。
 *
 * 内容型失败（截断/解析错）发生在引擎层，永远到不了这里的判定——切换救不了
 * 内容错，也避免行为漂移。每次切换都落 T2 决策日志并写一条用户可见系统行
 * （`[channel-switch]`，与 T1 `[reconcile]` 同一呈现模式），绝不静默。
 */

// ---------------------------------------------------------------------------
// 回退上下文随 env 携带（各引擎统一走 buildSdkEnv + resolveChannelEnv 构建 env，
// 引擎到 query 的入参链路深，显式透传需改动全部引擎接口；env 是 string record，
// 上下文字段恰全是字符串，挂保留键是最小侵入的载体。anthropicMessagesQuery
// 只读 ANTHROPIC_* 键，这些键不会进请求体。）
// ---------------------------------------------------------------------------

export const FALLBACK_ENV_CHANNEL_ID = 'BLOMA_FALLBACK_CHANNEL_ID'
export const FALLBACK_ENV_CATEGORY = 'BLOMA_FALLBACK_CATEGORY'
export const FALLBACK_ENV_PROJECT_ID = 'BLOMA_FALLBACK_PROJECT_ID'
export const FALLBACK_ENV_SESSION_ID = 'BLOMA_FALLBACK_SESSION_ID'

export interface RuntimeFallbackContext {
  /** 当前渠道 id（挑备用时排除自己） */
  channelId: string
  /** 备用渠道按同类别走 M4 解析链 */
  category: DocumentCategory
  /** 决策日志归属（缺省不落决策） */
  projectId?: string
  sessionId?: string
}

export function attachFallbackContext(env: Record<string, string>, context: RuntimeFallbackContext): Record<string, string> {
  env[FALLBACK_ENV_CHANNEL_ID] = context.channelId
  env[FALLBACK_ENV_CATEGORY] = context.category
  if (context.projectId) env[FALLBACK_ENV_PROJECT_ID] = context.projectId
  if (context.sessionId) env[FALLBACK_ENV_SESSION_ID] = context.sessionId
  return env
}

export function readFallbackContext(env: Record<string, string> | undefined): RuntimeFallbackContext | undefined {
  const channelId = env?.[FALLBACK_ENV_CHANNEL_ID]
  const category = env?.[FALLBACK_ENV_CATEGORY] as DocumentCategory | undefined
  if (!channelId || !category) return undefined
  return {
    channelId,
    category,
    projectId: env[FALLBACK_ENV_PROJECT_ID] || undefined,
    sessionId: env[FALLBACK_ENV_SESSION_ID] || undefined,
  }
}

// ---------------------------------------------------------------------------
// 构建期：渠道 + 类别 → env（主渠道基础设施故障时切第一个可用备用渠道）
// ---------------------------------------------------------------------------

export type ChannelUnusableReason = 'no_channel' | 'decrypt_failed' | 'model_not_found' | 'tools_unsupported'

export interface ChannelEnvResolution {
  env?: Record<string, string>
  /** env 实际使用的渠道（可能是切换后的备用渠道；max_tokens 等以它为准） */
  channel?: Channel
  /** 实际解析出的模型名（供调用方核对 supports_tools，免去再解析一次） */
  modelName?: string
  /** 实际解析出的模型是否支持 tool use（undefined = 能力位未标注，可探测） */
  supportsTools?: boolean
  /** 无可用渠道（含备用）时的原因；调用方按各自语义降级/报错 */
  unusableReason?: ChannelUnusableReason
}

type ChannelEnvAttempt =
  | { status: 'ok'; env: Record<string, string>; model: string; supportsTools: boolean | undefined }
  | { status: 'failed'; reason: 'decrypt_failed' | 'model_not_found' | 'tools_unsupported' }

/** 解析出的模型在渠道 models[] 上的 tool use 能力位（`supports_tools` 在 ChannelModel 上，不在 Channel 上）。 */
function readSupportsTools(channel: Channel, model: string): boolean | undefined {
  return channel.models?.find((candidate) => candidate.name === model)?.supports_tools
}

function tryBuildChannelEnv(channel: Channel, category: DocumentCategory, requireTools?: boolean): ChannelEnvAttempt {
  let apiKey: string
  try {
    apiKey = decryptApiKey(channel.api_key)
  } catch {
    return { status: 'failed', reason: 'decrypt_failed' }
  }
  let model: string
  try {
    model = resolveCategoryModel(channel, category).model
  } catch {
    return { status: 'failed', reason: 'model_not_found' }
  }
  const supportsTools = readSupportsTools(channel, model)
  // 路由层过滤（废旧管道方案 D2）：调用方要求 tool use 时，显式标记为不支持的模型直接
  // 判不可用交由备用链接手；undefined（未标注）放行——能力未知者由调用方探测。
  if (requireTools === true && supportsTools === false) return { status: 'failed', reason: 'tools_unsupported' }
  return { status: 'ok', env: buildSdkEnv(apiKey, channel.base_url, model, channel.provider_type), model, supportsTools }
}

// ---------------------------------------------------------------------------
// 主渠道选择（M5 §4.1 解析链）：①显式 channel_id > ②类别路由表 > ③全局兜底
// ---------------------------------------------------------------------------

interface PrimaryChannelSelection {
  channel?: Channel
  /** 主渠道是否来自类别路由表命中（视图模型 effective: 'routed' 的解析侧依据） */
  routed: boolean
}

function resolvePrimaryChannel(opts: { channelId?: string; category: DocumentCategory }): PrimaryChannelSelection {
  // ① 显式 channel_id（调用方传入，最高优先级；渲染端今天不发）
  if (opts.channelId) return { channel: getChannelByIdRaw(opts.channelId), routed: false }
  // ② 类别路由表（M5）：悬空/禁用/非 Anthropic 协议由 resolveRoutedChannelId 内部回退 undefined
  const routedId = resolveRoutedChannelId(opts.category)
  if (routedId) {
    const routed = getChannelByIdRaw(routedId)
    if (routed) return { channel: routed, routed: true }
  }
  // ③ 全局兜底（无路由/路由悬空/路由禁用时；与 M4 现状一致，向后兼容）
  return { channel: getFirstEnabledChannel(), routed: false }
}

/**
 * 备用渠道查找域（闭环 PR4）：'all'（缺省，现状）= 路由 fallback_channel_ids +
 * 全部启用渠道兜底；'routed-only' = 只走类别路由 fallback_channel_ids，找不到就
 * 如实返回不可用——judge 审查族专用，防「终审静默落到任意弱模型」。主渠道可用时
 * 两种 scope 行为完全一致（备用链不触发）。
 */
export type FallbackScope = 'all' | 'routed-only'

/**
 * 渠道 + 文档类别 → SDK env（原各编排器内 8 处重复的「选渠道→解密→类别解析→构建」块
 * 的统一收口）。主渠道按 M5 §4.1 解析链选择（显式 channel_id > 类别路由表 > 全局兜底）；
 * 主渠道密钥不可解密 / 无启用模型时按同一类别解析链切备用渠道（T9 构建期回退，
 * 备用顺序先按类别路由的 fallback_channel_ids，§4.4），并落决策日志；无备用可用时
 * 如实返回 unusableReason，调用方维持原有降级语义（草图回模板 / MVP 抛错 / 引导回规则路由）。
 *
 * `requireTools`（废旧管道方案 §4.2）：调用方要求模型支持 tool use（agent loop 唯一
 * 运行时后 MVP 类别必传）时，`supports_tools === false` 的模型按「不可用」走备用链；
 * 备用也全不支持则如实返回 `tools_unsupported`，绝不静默降级。不传时行为与改造前完全一致。
 */
export function resolveChannelEnv(opts: {
  channelId?: string
  category: DocumentCategory
  projectId?: string
  sessionId?: string
  requireTools?: boolean
  fallbackScope?: FallbackScope
}): ChannelEnvResolution {
  const primarySelection = resolvePrimaryChannel(opts)
  const primary = primarySelection.channel
  if (!primary) return { unusableReason: 'no_channel' }

  const context: RuntimeFallbackContext = {
    channelId: primary.id,
    category: opts.category,
    projectId: opts.projectId,
    sessionId: opts.sessionId,
  }
  const attempt = tryBuildChannelEnv(primary, opts.category, opts.requireTools)
  if (attempt.status === 'ok') {
    if (primarySelection.routed && opts.projectId && opts.sessionId) {
      recordCategoryRoute({
        projectId: opts.projectId,
        sessionId: opts.sessionId,
        category: opts.category,
        channelId: primary.id,
        channelName: primary.name,
        model: attempt.model,
      })
    }
    return {
      env: attachFallbackContext(attempt.env, context),
      channel: primary,
      modelName: attempt.model,
      supportsTools: attempt.supportsTools,
    }
  }

  const backup = pickBackupChannelEnv(context, opts.requireTools, opts.fallbackScope)
  if (backup) {
    recordChannelSwitch({ context, reason: attempt.reason, to: backup, fallbackScope: opts.fallbackScope })
    return {
      env: attachFallbackContext(backup.env, { ...context, channelId: backup.channel.id }),
      channel: backup.channel,
      modelName: backup.model,
      supportsTools: backup.supportsTools,
    }
  }
  return { unusableReason: attempt.reason }
}

// ---------------------------------------------------------------------------
// 备用渠道枚举（M5 §4.4：先按类别路由的 fallback_channel_ids 顺序，未命中回退
// channels.json 配置序；跳过当前主渠道，保序去重）
// ---------------------------------------------------------------------------

export interface BackupChannelEnv {
  channel: Channel
  model: string
  env: Record<string, string>
  /** 备用模型的 tool use 能力位（undefined = 未标注，可探测） */
  supportsTools?: boolean
}

export function pickBackupChannelEnv(
  context: Pick<RuntimeFallbackContext, 'channelId' | 'category'>,
  requireTools?: boolean,
  fallbackScope?: FallbackScope,
): BackupChannelEnv | undefined {
  const fallbackOrder = getCategoryFallbackChannelIds(context.category)
  // getChannelByIdRaw 已含 isOursChannel 校验、getCategoryFallbackChannelIds 已过滤禁用；
  // listEnabledRawChannels 全为启用项目渠道——候选只需跳过主渠道与已见过（保序去重）。
  // routed-only（闭环 PR4）：去掉全部启用渠道尾巴——审查族只信用户显式配置的备用链。
  const routedCandidates = fallbackOrder.map((id) => getChannelByIdRaw(id))
  const candidates = fallbackScope === 'routed-only' ? routedCandidates : [...routedCandidates, ...listEnabledRawChannels()]
  const seen = new Set<string>([context.channelId])
  for (const channel of candidates) {
    if (!channel || seen.has(channel.id)) continue
    seen.add(channel.id)
    let apiKey: string
    try {
      apiKey = decryptApiKey(channel.api_key)
    } catch {
      continue
    }
    let model: string
    try {
      model = resolveCategoryModel(channel, context.category).model
    } catch {
      continue
    }
    const supportsTools = readSupportsTools(channel, model)
    // 与主渠道同一口径：显式 false 跳过，undefined（未标注）放行留给调用方探测
    if (requireTools === true && supportsTools === false) continue
    return { channel, model, env: buildSdkEnv(apiKey, channel.base_url, model, channel.provider_type), supportsTools }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 故障分类：基础设施故障才切换；内容型/用户取消一律不切
// ---------------------------------------------------------------------------

/**
 * 基础设施故障判定（T9）：HTTP 429/529/5xx、渠道凭证失效（401/403）、网络层错误。
 * 与 orchestrator.shouldRetry（决定同渠道退避重试）口径一致但多覆盖「凭证级」故障——
 * key 被吊销时同渠道重试无意义，切渠道才有出路。
 * 400 等请求级失败、内容型错误（引擎层的截断/解析错不会流到此处）一律 false。
 */
export function isInfrastructureFailure(error: unknown): boolean {
  if (isUserCancelledQuery(error)) return false
  const statusCode = extractErrorStatusCode(error)
  if (statusCode !== undefined) {
    return statusCode === 429 || statusCode === 529 || (statusCode >= 500 && statusCode <= 599) || statusCode === 401 || statusCode === 403
  }
  return hasNetworkErrorSignal(error)
}

/** 用户主动停止（AbortError / AGENT_CANCELLED）：不是故障，绝不切渠道重试。 */
export function isUserCancelledQuery(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true
  return String(error).includes('AGENT_CANCELLED')
}

/**
 * 提取 HTTP 状态码：优先 statusCode 属性，其次消息里的 3 位数字
 * （anthropicMessagesQuery 抛 `SDK request failed with 500`）。
 * 只认 3 位数字词边界，避免误捕消息里的无关数字。
 */
export function extractErrorStatusCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const value = (error as { statusCode?: unknown }).statusCode
    if (typeof value === 'number') return value
  }
  const message = error instanceof Error ? error.message : String(error)
  const match = message.match(/\b(\d{3})\b/)
  return match ? Number(match[1]) : undefined
}

/** 网络层错误信号：消息或 cause 链里的 errno / undici 的 `fetch failed` 包装。 */
function hasNetworkErrorSignal(error: unknown): boolean {
  const seen = new Set<unknown>()
  const check = (candidate: unknown): boolean => {
    if (typeof candidate !== 'object' || candidate === null || seen.has(candidate)) return false
    seen.add(candidate)
    const message = candidate instanceof Error ? candidate.message : String(candidate)
    if (/\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|EHOSTUNREACH|ENETUNREACH|fetch failed)\b/i.test(message)) {
      return true
    }
    if ('cause' in candidate) return check((candidate as { cause?: unknown }).cause)
    return false
  }
  return check(error)
}

// ---------------------------------------------------------------------------
// 切换留痕：T2 决策日志（decisions.md 同步重导出）+ 用户可见 [channel-switch] 系统行
// ---------------------------------------------------------------------------

const SWITCH_LOG_THROTTLE_MS = 30_000
const recentSwitchLogs = new Map<string, number>()

/** 测试复位节流窗（生产不调用）。 */
export function resetChannelSwitchThrottleForTests(): void {
  recentSwitchLogs.clear()
}

function describeTrigger(record: { reason: string; statusCode?: number }): string {
  if (record.statusCode) return `请求失败（HTTP ${record.statusCode}）`
  if (record.reason === 'decrypt_failed') return 'api_key 无法解密'
  if (record.reason === 'model_not_found') return '没有启用的模型'
  if (record.reason === 'tools_unsupported') return '模型不支持工具调用'
  if (record.reason === 'network_error') return '网络错误'
  return `请求失败（${record.reason}）`
}

function channelDisplayName(channelId: string): string {
  return getChannelByIdRaw(channelId)?.name ?? channelId
}

/**
 * 落一次渠道切换的完整留痕。决策行/系统行按「项目+会话+from→to+原因」30s 节流——
 * 两侧渠道全挂时上层退避重试会反复触发切换，无节流会把决策日志刷成切换流水。
 * 导出供 orchestrator 的请求期回退包装器（queryWithRuntimeFallback）调用。
 */
export function recordChannelSwitch(record: {
  context: RuntimeFallbackContext
  reason: string
  to: BackupChannelEnv
  statusCode?: number
  fallbackScope?: FallbackScope
}): void {
  const fromName = channelDisplayName(record.context.channelId)
  const why =
    `渠道「${fromName}」${describeTrigger(record)}，按 ${record.context.category} 类别解析链` +
    `自动切换到备用渠道「${record.to.channel.name}」（${record.to.model}）重试一次`
  console.warn(`[runtimeFallback] ${why}`)

  if (!record.context.projectId || !record.context.sessionId) return
  const dedupeKey =
    `${record.context.projectId}:${record.context.sessionId}:${record.context.channelId}` +
    `->${record.to.channel.id}:${record.reason}`
  const now = Date.now()
  const last = recentSwitchLogs.get(dedupeKey)
  if (last !== undefined && now - last < SWITCH_LOG_THROTTLE_MS) return
  if (recentSwitchLogs.size > 100) {
    for (const [key, at] of recentSwitchLogs) {
      if (now - at >= SWITCH_LOG_THROTTLE_MS) recentSwitchLogs.delete(key)
    }
  }
  recentSwitchLogs.set(dedupeKey, now)

  recordDecision({
    project_id: record.context.projectId,
    session_id: record.context.sessionId,
    entry: {
      type: 'runtime_channel_switch',
      title: '渠道故障自动切换',
      why,
      detail: {
        from_channel: fromName,
        to_channel: record.to.channel.name,
        model: record.to.model,
        category: record.context.category,
        reason: record.reason,
        status_code: record.statusCode,
        fallback_scope: record.fallbackScope ?? 'all',
      },
    },
  })
  // 用户可见系统行（与 T1 [reconcile] 同一呈现模式：ChatPanel 剥前缀渲染为胶囊，
  // 回访恢复时从磁盘加载可见）；[decision] 行按约定不进聊天流，用户面在 decisions.md
  appendSessionMessage(record.context.sessionId, {
    role: 'system',
    content: [{ type: 'text', text: `[channel-switch] 渠道「${fromName}」${describeTrigger(record)}，已自动切换到备用渠道「${record.to.channel.name}」重试` }],
    timestamp: Date.now(),
  })
}

// ---------------------------------------------------------------------------
// 类别路由留痕（M5 §8）：主渠道命中路由表时落 category_route 决策日志。
// 路由是静态配置非事件——不新增用户可见系统行（避免刷屏，与 [channel-switch] 语义区分）。
// ---------------------------------------------------------------------------

const CATEGORY_ROUTE_LOG_THROTTLE_MS = 30_000
const recentRouteLogs = new Map<string, number>()

/** 测试复位节流窗（生产不调用）。 */
export function resetCategoryRouteThrottleForTests(): void {
  recentRouteLogs.clear()
}

/**
 * 落一次「类别路由生效」决策日志（§8）：按「项目+会话+类别」30s 窗口节流（同键只落
 * 一次，非永久去重）。projectId/sessionId 缺失时与 recordChannelSwitch 一致直接跳过
 * 不落日志、节流键不进 Map（避免含 undefined 的键跨会话/项目碰撞误吞后续记录）。
 * 支撑回访/审计重建「哪一步用了哪家」。
 */
function recordCategoryRoute(record: {
  projectId: string
  sessionId: string
  category: DocumentCategory
  channelId: string
  channelName: string
  model: string
}): void {
  const dedupeKey = `${record.projectId}:${record.sessionId}:${record.category}`
  const now = Date.now()
  const last = recentRouteLogs.get(dedupeKey)
  if (last !== undefined && now - last < CATEGORY_ROUTE_LOG_THROTTLE_MS) return
  if (recentRouteLogs.size > 100) {
    for (const [key, at] of recentRouteLogs) {
      if (now - at >= CATEGORY_ROUTE_LOG_THROTTLE_MS) recentRouteLogs.delete(key)
    }
  }
  recentRouteLogs.set(dedupeKey, now)

  recordDecision({
    project_id: record.projectId,
    session_id: record.sessionId,
    entry: {
      type: 'category_route',
      title: '类别渠道路由生效',
      why: `${record.category} 类别按职责分工路由到渠道「${record.channelName}」（${record.model}）`,
      detail: {
        category: record.category,
        channel_id: record.channelId,
        channel_name: record.channelName,
        model: record.model,
        source: 'category_routing',
      },
    },
  })
}
