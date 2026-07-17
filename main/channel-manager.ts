import { randomUUID } from 'node:crypto'
import type { Channel, ChannelCreateInput } from '../shared/types'
import { getChannelsPath } from '../storage/config-paths'
import { readJsonFile, writeJsonFile } from '../storage/json-store'
import { decryptSecret, encryptSecret } from './safe-storage'

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

export function getChannelById(id: string): Channel | undefined {
  return loadChannels().channels.find((channel) => channel.id === id)
}

export function listChannels(): Channel[] {
  return loadChannels().channels.map(redact)
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
  }
  config.channels.push(channel)
  saveChannels(config)
  return redact(channel)
}

export function decryptApiKey(encryptedHex: string): string {
  return decryptSecret(encryptedHex)
}

export async function testChannel(channelId: string): Promise<{ ok: boolean; message: string }> {
  const channel = getChannelById(channelId)
  if (!channel) return { ok: false, message: '渠道不存在' }

  const apiKey = decryptSecret(channel.api_key)
  const res = await fetch(`${channel.base_url}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })

  return res.ok
    ? { ok: true, message: '连接成功' }
    : { ok: false, message: '模型配置需要重新验证' }
}
