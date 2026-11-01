import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type {
  Channel,
  ChannelCreateInput,
  ChannelModel,
  ChannelTestResult,
  ChannelUpdateInput,
  ChannelDirectTestInput,
  FetchModelsInput,
  FetchModelsResult,
  ProviderType,
} from '../../../shared/types'
import { ANTHROPIC_PROTOCOL_PROVIDERS, isAnthropicProtocolProvider } from '../../../shared/types'
import { getBlomaChannelsPath, getChannelsPath } from '../../../storage/config-paths'
import { readJsonFile, writeJsonFile } from '../../../storage/json-store'
import { decryptSecret, encryptSecret } from '../storage/safe-storage'
import {
  normalizeAnthropicBaseUrlForSdk,
  resolveAnthropicMessagesUrl,
  resolveAnthropicModelsUrl,
  resolveOpenAIModelsUrl,
  normalizeBaseUrl,
} from './channel-url-utils'
import { normalizeHttpResponse, normalizeRequestError } from './channel-test-error'
import { attachModelLimits, validModelLimit } from './model-context'
import { ARK_CODING_PLAN_MODELS, ARK_CODING_PLAN_TEST_MODEL, PROVIDER_TEST_MODEL_PRESETS, QWEN_TOKEN_PLAN_PRESET_MODELS, XIAOMI_PRESET_MODELS, cloneModels, createPresetModelsResult, extractZhipuCodingTeamApiToken, parseZhipuTeamCredentials, resolveFirstTestModelId } from './channel-presets';

/** SDK 子进程环境白名单：仅透传运行 SDK 所需的基础环境，避免宿主机 ANTHROPIC_/CLAUDE_ 历史配置污染 Agent 渠道。 */
const SDK_ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TMP',
  'TEMP',
  'TMPDIR',
  'SystemRoot',
  'WINDIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
] as const

/**
 * 走 Anthropic Messages 协议（x-api-key 认证）的 provider 集合（消费 shared 的
 * ANTHROPIC_PROTOCOL_PROVIDERS 单一真相源；renderer 渠道下拉与 M5 路由校验共用）。
 * Bloma 运行时消费点（anthropicMessagesQuery）只拼接 `${baseUrl}/v1/messages`，
 * 因此这些 provider 的 base_url 需规范化为协议根（剥掉 /v1、/v1/messages 等后缀）。
 */
const ANTHROPIC_PROTOCOL_SET = new Set<ProviderType>(ANTHROPIC_PROTOCOL_PROVIDERS)

// M5：从 shared re-export（保持 §5#10「channel-manager 导出判定」的既有消费口径）
export { isAnthropicProtocolProvider }
export { isAgentProtocolProvider } from '../../../shared/types'

/**
 * 由解密后的渠道密钥构建 SDK 子进程环境（ANTHROPIC_AUTH_TOKEN/BASE_URL/MODEL + 白名单宿主环境）。
 *
 * providerType 可选：仅对 Anthropic 协议 provider 把 base_url 规范化为协议根
 * （normalizeAnthropicBaseUrlForSdk），修复 deepseek/minimax 等渠道当前
 * `base_url + /v1/messages` 拼错路径导致运行失败的问题；其他 provider 保持原样。
 */
export function buildSdkEnv(
  apiKey: string,
  baseUrl: string,
  model: string,
  providerType?: ProviderType,
  limits?: Pick<ChannelModel, 'context_window'|'max_output_tokens'>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of SDK_ENV_ALLOWLIST) {
    const value = (process.env as Record<string, string>)[key]
    if (value !== undefined) env[key] = value
  }
  const effectiveBaseUrl =
    providerType && ANTHROPIC_PROTOCOL_SET.has(providerType)
      ? normalizeAnthropicBaseUrlForSdk(baseUrl)
      : baseUrl
  env.ANTHROPIC_AUTH_TOKEN = apiKey
  env.ANTHROPIC_BASE_URL = effectiveBaseUrl
  env.ANTHROPIC_MODEL = model
  // provider 类型随 env 下发（2026-10-04）：主路调用方均不传 options.providerType，
  // 传输层拿不到就无法按渠道夹紧 max_tokens（zhipu 131072 硬校验，e99e6319 二次事故
  // 实锤：夹紧锁在不存在的信号上）。仅作传输层派生用途，不进请求头/子进程白名单。
  if (providerType) env.ANTHROPIC_PROVIDER_TYPE = providerType
  attachModelLimits(env, limits)
  return env
}

interface ChannelsConfig {
  version: number
  channels: Channel[]
}

/**
 * 单条渠道归一化：`models` 在类型上必填，但 bloma-channels.json 是用户可手改、
 * 且从旧共享文件迁移过来的运行时数据——缺该字段时所有 `channel.models.length` 类读取都会抛错。
 * 迭代 #3 先在渲染层加 `?? []` 防御（当时用真缺字段数据实测崩），本轮从读取源头补齐。
 */
function normalizeChannelModels(raw: Channel): Channel {
  return Array.isArray(raw.models) ? raw : { ...raw, models: [] }
}

/** 整体读取归一化：`channels` 本身不是数组（手改坏文件）时降级为空列表而不是让 main 抛错。 */
function normalizeConfig(config: ChannelsConfig): ChannelsConfig {
  const channels = Array.isArray(config?.channels) ? config.channels : []
  return { version: config?.version ?? 1, channels: channels.map(normalizeChannelModels) }
}

function loadChannels(): ChannelsConfig {
  const path = getBlomaChannelsPath()
  if (!existsSync(path)) {
    // 一次性迁移（2026-08-26 渠道存储独立化）：Bloma 曾与 Proma 共用 channels.json，
    // 但 Proma(v9) 写入时会整体丢弃本项目 snake_case 条目（实测渠道反复被清空），
    // 故迁出至 bloma-channels.json。仅读取旧共享文件、绝不回写它（那已是 Proma 的地盘）。
    // 空迁移也落盘——文件存在即迁移完成标记，后续读写只走新文件。
    const legacy = readJsonFile<ChannelsConfig>(getChannelsPath(), { version: 1, channels: [] })
    const migrated: ChannelsConfig = { version: 1, channels: legacy.channels.filter(isOursChannel) }
    writeJsonFile(path, migrated)
    return normalizeConfig(migrated)
  }
  // 直接读文件而不是只信 readJsonFile 的 default：缺 models 的条目要补齐后再进内存
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, 'utf8')) as ChannelsConfig)
  } catch {
    return { version: 1, channels: [] }
  }
}

function saveChannels(config: ChannelsConfig): void {
  writeJsonFile(getBlomaChannelsPath(), config)
}

function redact(channel: Channel): Channel {
  return { ...channel, api_key: '***' }
}

/**
 * 判定一条 channels.json 里的原始条目是否属于本项目（snake_case 契约）。
 *
 * `~/.proma/channels.json` 与另一个 App（Proma）共用：Proma 用 camelCase
 * （`provider`/`baseUrl`/`apiKey`）且 key 是另一套加密（base64），本项目用
 * snake_case（`provider_type`/`base_url`/`api_key`）+ safeStorage hex。
 * 只认带 snake_case `provider_type` + `api_key` 的条目，其余视为外部渠道并跳过。
 */
function isOursChannel(raw: unknown): raw is Channel {
  if (!raw || typeof raw !== 'object') return false
  const r = raw as Record<string, unknown>
  return typeof r.provider_type === 'string' && typeof r.api_key === 'string'
}

export function getChannelByIdRaw(id: string): Channel | undefined {
  const channel = loadChannels().channels.find((c) => c.id === id)
  return channel && isOursChannel(channel) ? channel : undefined
}

/** 渠道内 enabled 模型列表（保持配置序），供 model-resolution 类别解析用（§6.4）。 */
export function listEnabledModels(channel: Pick<Channel, 'models'>): ChannelModel[] {
  return (channel.models ?? []).filter((item) => item.enabled)
}

export function getChannelById(id: string): Channel | undefined {
  const channel = getChannelByIdRaw(id)
  return channel ? redact(channel) : undefined
}

/**
 * 发送消息未显式指定 channel_id 时，回退到第一个启用的、且 api_key 可被 safeStorage 解密的项目渠道。
 * 跳过损坏条目，避免自动选中后 decryptApiKey 崩溃。
 */
export function getFirstEnabledChannel(): Channel | undefined {
  const channels = loadChannels().channels
  for (const channel of channels) {
    if (!isOursChannel(channel) || !channel.enabled) continue
    try {
      decryptSecret(channel.api_key)
      return channel
    } catch {
      // 该渠道密钥损坏 / safeStorage 不可用：跳过，继续找下一个可用渠道
    }
  }
  return undefined
}

export function listChannels(): Channel[] {
  return loadChannels().channels.filter(isOursChannel).map(redact)
}

/**
 * 全部启用的本项目渠道（未脱敏，含真实 api_key 密文）。
 * 供运行时被动回退（T9）枚举备用渠道用；密钥仍只在 main 进程解密，不经 IPC 外泄。
 */
export function listEnabledRawChannels(): Channel[] {
  return loadChannels().channels.filter((channel) => isOursChannel(channel) && channel.enabled)
}

function validateModelLimits(models?: ChannelModel[]): void {
  for(const model of models??[])for(const field of ['context_window','max_output_tokens'] as const)
    if(model[field]!==undefined&&!validModelLimit(model[field]))throw Error('VALIDATION_ERROR: 模型窗口和输出上限须为1024到16777216之间的整数')
}
export function createChannel(input: ChannelCreateInput): Channel {
  validateModelLimits(input.models)
  const config = loadChannels()
  const channel: Channel = {
    id: randomUUID(),
    name: input.name,
    provider_type: input.provider_type,
    base_url: input.base_url,
    api_key: encryptSecret(input.api_key),
    models: input.models ?? [],
    enabled: true,
    max_tokens: input.max_tokens,
  }
  config.channels.push(channel)
  saveChannels(config)
  return redact(channel)
}

/**
 * 更新渠道。api_key 为空字符串表示不更新密钥（编辑表单留空时）。
 */
export function updateChannel(channelId: string, input: ChannelUpdateInput): Channel | undefined {
  validateModelLimits(input.models)
  const config = loadChannels()
  const index = config.channels.findIndex((c) => c.id === channelId && isOursChannel(c))
  if (index === -1) return undefined

  const existing = config.channels[index]!
  const updated: Channel = {
    ...existing,
    name: input.name ?? existing.name,
    provider_type: input.provider_type ?? existing.provider_type,
    base_url: input.base_url ?? existing.base_url,
    api_key: input.api_key ? encryptSecret(input.api_key) : existing.api_key,
    models: input.models ?? existing.models,
    enabled: input.enabled ?? existing.enabled,
    max_tokens: input.max_tokens ?? existing.max_tokens,
  }
  config.channels[index] = updated
  saveChannels(config)
  return redact(updated)
}

export function decryptApiKey(encryptedHex: string): string {
  return decryptSecret(encryptedHex)
}

export function deleteChannel(channelId: string): boolean {
  const config = loadChannels()
  const before = config.channels.length
  config.channels = config.channels.filter((channel) => channel.id !== channelId)
  if (config.channels.length === before) return false
  saveChannels(config)
  return true
}

// =========================================================================
// 连接测试（按 provider 细分）
// =========================================================================

const CHANNEL_TEST_TIMEOUT_MS = 15_000

function withTimeout(init: RequestInit, timeoutMs = CHANNEL_TEST_TIMEOUT_MS): RequestInit {
  return { ...init, signal: AbortSignal.timeout(timeoutMs) }
}

function resolveTestModelId(provider: ProviderType, modelId: string | undefined, models?: ChannelModel[]): string {
  if (modelId?.trim()) return modelId.trim()
  return resolveFirstTestModelId(models) ?? PROVIDER_TEST_MODEL_PRESETS[provider] ?? ''
}

/**
 * 测试已保存渠道连接。
 */
export async function testChannel(channelId: string): Promise<ChannelTestResult> {
  const channel = getChannelByIdRaw(channelId)
  if (!channel) return { ok: false, message: '渠道不存在' }

  let apiKey: string
  try {
    apiKey = decryptSecret(channel.api_key)
  } catch {
    // 解密失败（safeStorage 不可用 / key 格式不兼容）：给可读文案，不抛原始错误
    return { ok: false, message: '模型配置需要重新验证。' }
  }

  try {
    return await testProvider(channel.provider_type, channel.base_url, apiKey, resolveTestModelId(channel.provider_type, undefined, channel.models))
  } catch (error) {
    return normalizeRequestError(error)
  }
}

/**
 * 解析 API Key：优先用传入明文；为空时回退到已保存渠道的密钥（编辑表单不改 Key）。
 * 在 main 进程解密，明文不进入 renderer。解密失败返回 undefined（不抛错）。
 */
function resolveApiKey(apiKey: string, channelId?: string): string | undefined {
  const trimmed = apiKey?.trim()
  if (trimmed) return trimmed
  if (!channelId) return undefined
  const channel = getChannelByIdRaw(channelId)
  if (!channel) return undefined
  try {
    return decryptSecret(channel.api_key)
  } catch {
    return undefined
  }
}

/**
 * 保存前直接测试连接（无需已保存渠道，明文凭证）。
 * api_key 为空时通过 channel_id 回退到已保存渠道密钥。
 */
export async function testChannelDirect(input: ChannelDirectTestInput): Promise<ChannelTestResult> {
  const apiKey = resolveApiKey(input.api_key, input.channel_id)
  if (!apiKey) {
    return { ok: false, message: '请填写 API Key 后再测试' }
  }
  try {
    return await testProvider(input.provider_type, input.base_url, apiKey, input.model_id)
  } catch (error) {
    return normalizeRequestError(error)
  }
}

function isAnthropicProtocol(provider: ProviderType): boolean {
  return isAnthropicProtocolProvider(provider)
}

function isOpenAIProtocol(provider: ProviderType): boolean {
  return provider === 'openai'
    || provider === 'openai-responses'
    || provider === 'opencode-go-openai'
    || provider === 'zhipu'
    || provider === 'doubao'
    || provider === 'qwen'
    || provider === 'custom'
}

async function testProvider(
  provider: ProviderType,
  baseUrl: string,
  apiKey: string,
  modelId?: string,
): Promise<ChannelTestResult> {
  if (isAnthropicProtocol(provider)) {
    if (provider === 'deepseek') return testAnthropicMessages(baseUrl, apiKey, resolveTestModelId(provider, modelId), 'deepseek')
    if (provider === 'kimi-api') return testAnthropicMessages(baseUrl, apiKey, resolveTestModelId(provider, modelId), 'kimi-api')
    if (provider === 'xiaomi') return testXiaomiMessages(baseUrl, apiKey, resolveTestModelId(provider, modelId), 'xiaomi')
    if (provider === 'xiaomi-token-plan') return testXiaomiMessages(baseUrl, apiKey, resolveTestModelId(provider, modelId), 'xiaomi-token-plan')
    if (provider === 'qwen-token-plan') return testAnthropicMessages(baseUrl, apiKey, resolveTestModelId(provider, modelId), 'qwen-token-plan')
    if (provider === 'ark-coding-plan') return testArkCodingPlan(baseUrl, apiKey)
    if (provider === 'zhipu-coding-team') return testZhipuCodingTeam(apiKey, baseUrl)
    return testAnthropicCompatible(baseUrl, apiKey, provider)
  }
  if (isOpenAIProtocol(provider)) {
    return testOpenAICompatible(baseUrl, apiKey, provider)
  }
  if (provider === 'google') {
    return testGoogle(baseUrl, apiKey)
  }
  return { ok: false, message: `不支持的供应商: ${provider}` }
}

/**
 * Anthropic 兼容连接测试（Anthropic / DeepSeek / Kimi API / MiniMax 等）。
 * 发送极小 messages 请求，更贴近真实使用路径。
 */
async function testAnthropicCompatible(
  baseUrl: string,
  apiKey: string,
  provider: ProviderType = 'anthropic',
): Promise<ChannelTestResult> {
  const url = resolveAnthropicModelsUrl(baseUrl, provider)
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
  }
  if (provider === 'kimi-coding' || provider === 'zhipu-coding') {
    headers.Authorization = `Bearer ${extractZhipuCodingTeamApiToken(apiKey)}`
  } else if (provider === 'minimax' || provider === 'qwen-anthropic') {
    headers.Authorization = `Bearer ${apiKey}`
  } else {
    headers['x-api-key'] = apiKey
    headers.Authorization = `Bearer ${apiKey}`
  }

  const response = await fetch(url, withTimeout({ method: 'GET', headers }))
  return normalizeHttpResponse(response)
}

/**
 * DeepSeek / Kimi API / qwen-token-plan 的 /models 端点可用性与具体模型可用性不完全等价。
 * 连接测试使用第一个可用模型发极小 messages 请求。
 */
async function testAnthropicMessages(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  provider: 'deepseek' | 'kimi-api' | 'qwen-token-plan',
): Promise<ChannelTestResult> {
  const url = resolveAnthropicMessagesUrl(baseUrl, provider)
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  }
  if (provider === 'qwen-token-plan') {
    headers.Authorization = `Bearer ${apiKey}`
  } else {
    headers['x-api-key'] = apiKey
    headers.Authorization = `Bearer ${apiKey}`
  }

  const response = await fetch(url, withTimeout({
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelId,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  }))

  return normalizeHttpResponse(response)
}

/**
 * 小米 API 的模型可用性需要走真实 messages 请求验证。
 */
async function testXiaomiMessages(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  provider: 'xiaomi' | 'xiaomi-token-plan',
): Promise<ChannelTestResult> {
  const url = resolveAnthropicMessagesUrl(baseUrl, provider)
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  }
  if (provider === 'xiaomi-token-plan') {
    headers.Authorization = `Bearer ${apiKey}`
  } else {
    headers['api-key'] = apiKey
  }

  const response = await fetch(url, withTimeout({
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelId,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  }))

  return normalizeHttpResponse(response)
}

/**
 * 火山方舟 Coding Plan 没有可用的模型列表端点，改用极小 messages 请求。
 */
async function testArkCodingPlan(baseUrl: string, apiKey: string): Promise<ChannelTestResult> {
  const url = resolveAnthropicMessagesUrl(baseUrl, 'ark-coding-plan')
  const response = await fetch(url, withTimeout({
    method: 'POST',
    headers: {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': apiKey,
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: ARK_CODING_PLAN_TEST_MODEL,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  }))

  return normalizeHttpResponse(response)
}

/**
 * 智谱 Coding Plan 团队版：凭据可能是三段式 secret（apiKey/organization/project），
 * 需要走额度端点验证；普通 API Token 走 Anthropic 兼容测试。
 */
async function testZhipuCodingTeam(apiKey: string, baseUrl: string): Promise<ChannelTestResult> {
  const teamCredentials = parseZhipuTeamCredentials(apiKey)
  if (teamCredentials) {
    return { ok: true, message: '智谱 Coding Plan 团队版凭据有效' }
  }

  const authToken = extractZhipuCodingTeamApiToken(apiKey)
  if (!authToken) {
    return { ok: false, message: '请填写 API Token；组织 ID 和项目 ID 可选' }
  }

  return testAnthropicCompatible(baseUrl, apiKey, 'zhipu-coding-team')
}

/**
 * 测试 OpenAI 兼容 API 连接（OpenAI / Custom / 智谱 / 豆包 / 通义千问）。
 */
async function testOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  _provider: ProviderType = 'openai',
): Promise<ChannelTestResult> {
  const url = resolveOpenAIModelsUrl(baseUrl)
  const response = await fetch(url, withTimeout({
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  }))

  return normalizeHttpResponse(response)
}

/**
 * 测试 Google Generative AI API 连接。
 */
async function testGoogle(baseUrl: string, apiKey: string): Promise<ChannelTestResult> {
  const url = normalizeBaseUrl(baseUrl)
  const response = await fetch(`${url}/v1beta/models?key=${apiKey}`, withTimeout({ method: 'GET' }))
  return normalizeHttpResponse(response)
}

// =========================================================================
// 模型列表拉取
// =========================================================================

/**
 * 从供应商 API 拉取可用模型列表。
 * 针对不同供应商使用不同的 API 端点和响应解析；无列表端点的返回预设模型。
 */
export async function fetchModels(input: FetchModelsInput): Promise<FetchModelsResult> {
  const { provider_type, base_url } = input
  const apiKey = resolveApiKey(input.api_key, input.channel_id)
  if (!apiKey) {
    return { success: false, message: '请填写 API Key 后再拉取模型', models: [] }
  }

  try {
    if (isAnthropicProtocol(provider_type)) {
      if (provider_type === 'deepseek') return fetchDeepSeekModels(base_url, apiKey)
      if (provider_type === 'kimi-api') return fetchKimiModels(base_url, apiKey)
      if (provider_type === 'xiaomi' || provider_type === 'xiaomi-token-plan') {
        return createPresetModelsResult('小米 API', XIAOMI_PRESET_MODELS)
      }
      if (provider_type === 'qwen-token-plan') {
        return createPresetModelsResult('通义千问 Token Plan', QWEN_TOKEN_PLAN_PRESET_MODELS)
      }
      if (provider_type === 'ark-coding-plan') {
        return {
          success: true,
          message: `火山方舟 Coding Plan 未开放模型列表端点，已加载 ${ARK_CODING_PLAN_MODELS.length} 个预设模型`,
          models: cloneModels(ARK_CODING_PLAN_MODELS),
        }
      }
      return fetchAnthropicCompatibleModels(base_url, apiKey, provider_type)
    }
    if (isOpenAIProtocol(provider_type)) {
      return fetchOpenAICompatibleModels(base_url, apiKey, provider_type)
    }
    if (provider_type === 'google') {
      return fetchGoogleModels(base_url, apiKey)
    }
    return { success: false, message: `不支持的供应商: ${provider_type}`, models: [] }
  } catch (error) {
    console.error('[渠道管理] 拉取模型列表失败:', error)
    const result = normalizeRequestError(error)
    return { success: false, message: result.message, models: [] }
  }
}

interface AnthropicModelItem {
  id: string
  display_name?: string
  type?: string
}

interface OpenAIModelItem {
  id: string
  owned_by?: string
}

interface GoogleModelItem {
  name: string
  displayName?: string
  description?: string
  supportedGenerationMethods?: string[]
}

/**
 * 从 DeepSeek 原生模型 API 拉取模型列表（模型端点固定在 /models）。
 */
/**
 * 模型列表拉取失败的统一出口：404 在兼容渠道上是常态（如阿里云 compatible-mode 未开放列表端点），
 * 不是密钥错——补一句可执行下一步（设置页有「手动添加模型」入口），避免用户退回「测连接」反复试错。
 * 迭代 #4 先只覆盖 OpenAI 兼容分支，本轮把同一口径铺到 deepseek/kimi/anthropic 兼容/google。
 */
function modelsFetchFailure(response: Response, result: ChannelTestResult): FetchModelsResult {
  const hint = response.status === 404 ? '——该服务地址可能未开放模型列表端点，可改用手动添加模型' : ''
  return { success: false, message: `${result.message}${hint}`, models: [] }
}

async function fetchDeepSeekModels(baseUrl: string, apiKey: string): Promise<FetchModelsResult> {
  const url = `${new URL(baseUrl.trim()).origin}/models`
  const response = await fetch(url, withTimeout({
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
  }))

  if (!response.ok) {
    return modelsFetchFailure(response, await normalizeHttpResponse(response))
  }

  const data = await response.json() as { data?: OpenAIModelItem[] }
  const items = data.data ?? []
  const models: ChannelModel[] = items
    .map((item) => ({ id: item.id, name: item.id, enabled: true, source: 'fetched' as const }))
    .sort((a, b) => a.id.localeCompare(b.id))

  return { success: true, message: `成功获取 ${models.length} 个模型`, models }
}

/**
 * 从 Kimi OpenAI-compatible 模型列表端点拉取模型（官方 /v1/models）。
 */
async function fetchKimiModels(baseUrl: string, apiKey: string): Promise<FetchModelsResult> {
  const origin = new URL(baseUrl.trim()).origin
  const url = `${origin}/v1/models`
  const response = await fetch(url, withTimeout({
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
  }))

  if (!response.ok) {
    return modelsFetchFailure(response, await normalizeHttpResponse(response))
  }

  const data = await response.json() as { data?: OpenAIModelItem[] }
  const items = data.data ?? []
  const models: ChannelModel[] = items
    .map((item) => ({ id: item.id, name: item.id, enabled: true, source: 'fetched' as const }))
    .sort((a, b) => a.id.localeCompare(b.id))

  return { success: true, message: `成功获取 ${models.length} 个模型`, models }
}

/**
 * 从 Anthropic 兼容 API 拉取模型列表（Anthropic / MiniMax / 智谱 Coding Plan 等）。
 */
async function fetchAnthropicCompatibleModels(
  baseUrl: string,
  apiKey: string,
  provider: ProviderType = 'anthropic',
): Promise<FetchModelsResult> {
  const url = resolveAnthropicModelsUrl(baseUrl, provider)
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
  }
  if (provider === 'kimi-coding' || provider === 'zhipu-coding' || provider === 'zhipu-coding-team') {
    const authToken = provider === 'zhipu-coding-team' ? extractZhipuCodingTeamApiToken(apiKey) : apiKey
    headers.Authorization = `Bearer ${authToken}`
  } else if (provider === 'xiaomi-token-plan') {
    headers.Authorization = `Bearer ${apiKey}`
  } else if (provider === 'minimax' || provider === 'qwen-anthropic') {
    headers.Authorization = `Bearer ${apiKey}`
  } else {
    headers['x-api-key'] = apiKey
    headers.Authorization = `Bearer ${apiKey}`
  }

  const response = await fetch(url, withTimeout({ method: 'GET', headers }))

  if (!response.ok) {
    return modelsFetchFailure(response, await normalizeHttpResponse(response))
  }

  const data = await response.json() as { data?: AnthropicModelItem[] }
  const items = data.data ?? []
  const models: ChannelModel[] = items.map((item) => ({
    // name 必须是真实模型 ID（API 调用用）：display_name 是显示名，不能被当作模型名传给 API
    id: item.id,
    name: item.id,
    enabled: true,
    source: 'fetched' as const,
  }))

  return { success: true, message: `成功获取 ${models.length} 个模型`, models }
}

/**
 * 从 OpenAI 兼容 API 拉取模型列表（OpenAI / Custom / 智谱 / 豆包 / 通义千问）。
 */
async function fetchOpenAICompatibleModels(
  baseUrl: string,
  apiKey: string,
  _provider: ProviderType = 'openai',
): Promise<FetchModelsResult> {
  const url = resolveOpenAIModelsUrl(baseUrl)
  const response = await fetch(url, withTimeout({
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  }))

  if (!response.ok) {
    return modelsFetchFailure(response, await normalizeHttpResponse(response))
  }

  const data = await response.json() as { data?: OpenAIModelItem[] }
  const items = data.data ?? []
  const models: ChannelModel[] = items
    .map((item) => ({ id: item.id, name: item.id, enabled: true, source: 'fetched' as const }))
    .sort((a, b) => a.id.localeCompare(b.id))

  return { success: true, message: `成功获取 ${models.length} 个模型`, models }
}

/**
 * 从 Google Generative AI API 拉取模型列表（仅含支持 generateContent 的模型）。
 */
async function fetchGoogleModels(baseUrl: string, apiKey: string): Promise<FetchModelsResult> {
  const url = normalizeBaseUrl(baseUrl)
  const response = await fetch(`${url}/v1beta/models?key=${apiKey}`, withTimeout({ method: 'GET' }))

  if (!response.ok) {
    return modelsFetchFailure(response, await normalizeHttpResponse(response))
  }

  const data = await response.json() as { models?: GoogleModelItem[] }
  const items = data.models ?? []
  const chatModels = items.filter((item) =>
    item.supportedGenerationMethods?.includes('generateContent'),
  )

  const models: ChannelModel[] = chatModels.map((item) => {
    const id = item.name.replace(/^models\//, '')
    return { id, name: item.displayName || id, enabled: true, source: 'fetched' as const }
  })

  return { success: true, message: `成功获取 ${models.length} 个模型`, models }
}
