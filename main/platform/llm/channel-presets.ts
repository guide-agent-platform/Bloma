/**
 * 渠道预设模型与提供商辅助工具
 *
 * 从 Proma（channel-manager.ts + packages/shared/src/types/channel.ts）迁移。
 * PROVIDER_DEFAULT_URLS / PROVIDER_LABELS 常量定义在 shared/types.ts（renderer 与 main 共用）。
 */

import type { ChannelModel, ProviderType } from '../../../shared/types'

// =========================================================================
// 预设模型（无 /models 列表端点的 provider 使用）
// =========================================================================

export const DEEPSEEK_PRESET_MODELS: ChannelModel[] = [
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', enabled: true },
  { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', enabled: true },
]

export const KIMI_PRESET_MODELS: ChannelModel[] = [
  { id: 'k3', name: 'k3', enabled: true },
  { id: 'kimi-k2.6', name: 'kimi-k2.6', enabled: true },
]

export const XIAOMI_PRESET_MODELS: ChannelModel[] = [
  { id: 'mimo-v2.5-pro', name: 'mimo-v2.5-pro', enabled: true },
  { id: 'mimo-v2-pro', name: 'mimo-v2-pro', enabled: true },
  { id: 'mimo-v2.5', name: 'mimo-v2.5', enabled: true },
  { id: 'mimo-v2-omni', name: 'mimo-v2-omni', enabled: true },
  { id: 'mimo-v2-flash', name: 'mimo-v2-flash', enabled: true },
]

export const QWEN_TOKEN_PLAN_PRESET_MODELS: ChannelModel[] = [
  { id: 'qwen3.8-max-preview', name: 'qwen3.8-max-preview', enabled: true },
  { id: 'qwen3.7-max', name: 'qwen3.7-max', enabled: true },
  { id: 'qwen3.7-flash', name: 'qwen3.7-flash', enabled: true },
  { id: 'qwen3.6-flash', name: 'qwen3.6-flash', enabled: true },
]

export const ARK_CODING_PLAN_MODELS: ChannelModel[] = [
  { id: 'doubao-seed-2.0-code', name: 'doubao-seed-2.0-code', enabled: true },
  { id: 'doubao-seed-2.0-pro', name: 'doubao-seed-2.0-pro', enabled: true },
  { id: 'doubao-seed-2.0-lite', name: 'doubao-seed-2.0-lite', enabled: true },
  { id: 'glm-5.2', name: 'glm-5.2', enabled: true },
  { id: 'k3', name: 'k3', enabled: true },
  { id: 'kimi-k2.7-code', name: 'kimi-k2.7-code', enabled: true },
  { id: 'minimax-m3', name: 'minimax-m3', enabled: true },
  { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', enabled: true },
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', enabled: true },
]

/** 连接测试默认模型预设（按 provider）——不开放模型列表端点时用于 test-direct */
export const PROVIDER_TEST_MODEL_PRESETS: Partial<Record<ProviderType, string>> = {
  deepseek: 'deepseek-v4-flash',
  'kimi-api': 'k3',
  'opencode-go-openai': 'opencode-go-4-5',
  xiaomi: 'mimo-v2.5-pro',
  'xiaomi-token-plan': 'mimo-v2.5-pro',
  'qwen-token-plan': 'qwen3.8-max-preview',
}

export const ARK_CODING_PLAN_TEST_MODEL = 'doubao-seed-2.0-code'

// =========================================================================
// 模型列表处理辅助
// =========================================================================

export function cloneModels(models: ChannelModel[]): ChannelModel[] {
  return models.map((model) => ({ ...model }))
}

export function createPresetModelsResult(providerName: string, models: ChannelModel[]) {
  return {
    success: true,
    message: `${providerName} 未开放模型列表端点，已加载 ${models.length} 个预设模型`,
    models: cloneModels(models),
  }
}

export function resolveFirstTestModelId(models?: ChannelModel[]): string | undefined {
  // 测试连接用 name（真实模型 ID）：id 是渠道内唯一标识，不能作为 API 模型名
  return models?.find((model) => model.enabled)?.name ?? models?.[0]?.name
}

// =========================================================================
// 智谱 Coding Plan 团队版凭据解析
// =========================================================================

export interface ZhipuTeamCredentials {
  apiKey: string
  organization?: string
  project?: string
}

function normalizeZhipuCredentialKey(key: string): string {
  return key.trim().toLowerCase().replace(/[_-]/g, '')
}

export function parseZhipuTeamCredentials(secret: string): ZhipuTeamCredentials | null {
  const trimmed = secret.trim()
  if (!trimmed) return null

  const pick = (record: Record<string, unknown>): ZhipuTeamCredentials | null => {
    const normalized = new Map<string, string>()
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string' && value.trim()) {
        normalized.set(normalizeZhipuCredentialKey(key), value.trim())
      }
    }
    const apiKey = normalized.get('apikey')
      ?? normalized.get('apitoken')
      ?? normalized.get('token')
      ?? normalized.get('authorization')
      ?? normalized.get('auth')
      ?? normalized.get('bearer')
    const organization = normalized.get('bigmodelorganization') ?? normalized.get('organization') ?? normalized.get('org')
    const project = normalized.get('bigmodelproject') ?? normalized.get('project')
    if (!apiKey) return null
    return { apiKey, organization, project }
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return pick(parsed as Record<string, unknown>)
      }
    } catch {
      return null
    }
  }

  const entries: Record<string, string> = {}
  for (const part of trimmed.split(/[;\n]+/)) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    entries[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  return pick(entries)
}

export function extractZhipuCodingTeamApiToken(secret: string): string {
  const credentials = parseZhipuTeamCredentials(secret)
  if (credentials) return credentials.apiKey
  const trimmed = secret.trim()
  return trimmed || secret
}
