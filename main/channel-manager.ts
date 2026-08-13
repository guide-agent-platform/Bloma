import { randomUUID } from 'node:crypto'
import type { Channel, ChannelCreateInput } from '../shared/types'
import { getChannelsPath } from '../storage/config-paths'
import { readJsonFile, writeJsonFile } from '../storage/json-store'
import { decryptSecret, encryptSecret } from './safe-storage'

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
 * 由解密后的渠道密钥构建 SDK 子进程环境（ANTHROPIC_AUTH_TOKEN/BASE_URL/MODEL + 白名单宿主环境）。
 * 从 orchestrator 移入本模块：programming-orchestrator（LLM MVP 生成）需复用而不反向 import
 * orchestrator.ts，避免 orchestrator ⇄ programming-orchestrator 运行时循环依赖。
 */
export function buildSdkEnv(apiKey: string, baseUrl: string, model: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of SDK_ENV_ALLOWLIST) {
    const value = (process.env as Record<string, string>)[key]
    if (value !== undefined) env[key] = value
  }
  env.ANTHROPIC_AUTH_TOKEN = apiKey
  env.ANTHROPIC_BASE_URL = baseUrl
  env.ANTHROPIC_MODEL = model
  return env
}

interface ChannelsConfig {
  version: number
  channels: Channel[]
}

function loadChannels(): ChannelsConfig {
  return readJsonFile<ChannelsConfig>(getChannelsPath(), { version: 1, channels: [] })
}

function saveChannels(config: ChannelsConfig): void {
  writeJsonFile(getChannelsPath(), config)
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
 * 只认带 snake_case `provider_type` + `api_key` 的条目，其余视为外部渠道并跳过，
 * 避免 `testChannel` 读到 `api_key=undefined` 触发解密崩溃。
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

export function getChannelById(id: string): Channel | undefined {
  const channel = getChannelByIdRaw(id)
  return channel ? redact(channel) : undefined
}

/**
 * 发送消息未显式指定 channel_id 时，回退到第一个启用的、且 api_key 可被 safeStorage 解密的项目渠道。
 * 让真实模型在澄清对话中可用（否则 sendMessage 永远走规则路由）。
 * 跳过损坏条目（如跨平台迁移的 ciphertext：macOS 的 "v10" 前缀在 Windows DPAPI 下无法解密），
 * 避免自动选中后 decryptApiKey 崩溃。
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

export function createChannel(input: ChannelCreateInput): Channel {
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

export async function testChannel(channelId: string): Promise<{ ok: boolean; message: string }> {
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
    const res = await fetch(`${channel.base_url}/v1/models`, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(15_000),
    })
    return res.ok
      ? { ok: true, message: '连接成功' }
      : { ok: false, message: '模型配置需要重新验证' }
  } catch {
    // 网络不可达/超时：不抛原始错误，给用户可读文案
    return { ok: false, message: '连接失败，请检查网络或地址' }
  }
}
