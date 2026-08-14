/**
 * URL 规范化工具
 *
 * 从 Proma（@proma/core/src/providers/url-utils.ts）迁移，适配 Bloma 的
 * snake_case 渠道契约。各供应商 Base URL 的规范化处理统一收口在此文件。
 */

import type { ProviderType } from '../shared/types'

function trimTrailingUrlPathSlash(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  const separatorIndex = trimmed.search(/[?#]/)
  if (separatorIndex === -1) {
    return trimmed.replace(/\/+$/, '')
  }

  const pathPart = trimmed.slice(0, separatorIndex).replace(/\/+$/, '')
  return `${pathPart}${trimmed.slice(separatorIndex)}`
}

function hasPathSuffix(rawUrl: string, suffix: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim())
    return parsed.pathname.replace(/\/+$/, '').endsWith(suffix)
  } catch {
    const withoutQuery = rawUrl.trim().split(/[?#]/, 1)[0] ?? ''
    return withoutQuery.replace(/\/+$/, '').endsWith(suffix)
  }
}

function replacePathSuffix(rawUrl: string, suffix: string, replacement: string): string {
  const trimmed = rawUrl.trim()
  try {
    const parsed = new URL(trimmed)
    const pathname = parsed.pathname.replace(/\/+$/, '')
    if (!pathname.endsWith(suffix)) return trimTrailingUrlPathSlash(trimmed)
    parsed.pathname = `${pathname.slice(0, -suffix.length)}${replacement}`
    return parsed.toString()
  } catch {
    const separatorIndex = trimmed.search(/[?#]/)
    const pathPart = separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex)
    const tail = separatorIndex === -1 ? '' : trimmed.slice(separatorIndex)
    const normalizedPath = pathPart.replace(/\/+$/, '')
    if (!normalizedPath.endsWith(suffix)) return trimTrailingUrlPathSlash(trimmed)
    return `${normalizedPath.slice(0, -suffix.length)}${replacement}${tail}`
  }
}

function removePathSuffixForSdkBaseUrl(rawUrl: string, suffix: string): string {
  const trimmed = rawUrl.trim()
  try {
    const parsed = new URL(trimmed)
    const pathname = parsed.pathname.replace(/\/+$/, '')
    if (!pathname.endsWith(suffix)) return normalizeBaseUrl(trimmed)

    parsed.pathname = pathname.slice(0, -suffix.length) || '/'
    parsed.search = ''
    parsed.hash = ''
    return trimTrailingUrlPathSlash(parsed.toString())
  } catch {
    const pathPart = trimmed.split(/[?#]/, 1)[0] ?? trimmed
    const normalizedPath = pathPart.replace(/\/+$/, '')
    if (!normalizedPath.endsWith(suffix)) return normalizeBaseUrl(trimmed)
    return normalizedPath.slice(0, -suffix.length)
  }
}

/**
 * 规范化 Anthropic Base URL（用于直接拼接 /messages 发起请求）
 *
 * 去除尾部斜杠，去除误填的 /messages 后缀，如果没有版本路径则追加 /v1。
 */
export function normalizeAnthropicBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, '')
  url = url.replace(/\/messages$/, '')
  if (!url.match(/\/v\d+$/)) {
    // 仅对根路径或纯域名追加 /v1；已有路径（如 deepseek /anthropic）保持原样
    try {
      const pathname = new URL(url).pathname
      if (pathname === '/' || pathname === '') {
        url = `${url}/v1`
      }
    } catch {
      url = `${url}/v1`
    }
  }
  return url
}

/**
 * 规范化带版本路径的 Anthropic 兼容 Base URL。
 *
 * 某些网关以 `/anthropic` 作为协议根路径，但实际 API 仍位于 `/v1/messages`。
 * 没有版本路径时追加 `/v1`，已有版本路径（如 `/coding/v1`）则保持不变。
 */
export function normalizeVersionedAnthropicBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, '')
  url = url.replace(/\/messages$/, '')
  if (!url.match(/\/v\d+$/)) {
    url = `${url}/v1`
  }
  return url
}

/**
 * 规范化 Anthropic Base URL（用于 SDK 环境变量 ANTHROPIC_BASE_URL）
 *
 * SDK 内部会自动拼接 /v1/messages，所以这里需要去除用户误填的路径后缀，
 * 只保留根路径。
 */
export function normalizeAnthropicBaseUrlForSdk(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v\d+\/messages$/, '')
    .replace(/\/v\d+$/, '')
}

/**
 * 规范化通用 Base URL：仅去除尾部斜杠，适用于 OpenAI / Google 等。
 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

/**
 * 规范化 OpenAI 兼容 Base URL（用于 SDK）。
 *
 * custom / OpenAI Responses 渠道若保存的是完整端点，这里还原成协议根地址，
 * 避免重复拼接。
 */
export function normalizeOpenAIBaseUrlForSdk(baseUrl: string): string {
  if (hasPathSuffix(baseUrl, '/chat/completions')) {
    return removePathSuffixForSdkBaseUrl(baseUrl, '/chat/completions')
  }
  if (hasPathSuffix(baseUrl, '/responses')) {
    return removePathSuffixForSdkBaseUrl(baseUrl, '/responses')
  }
  return normalizeBaseUrl(baseUrl)
}

/**
 * 解析 OpenAI Chat Completions 请求地址。
 *
 * OpenAI 兼容格式（custom）要求用户直接填写完整请求端点。
 * 内置 OpenAI 协议供应商仍允许填写协议根地址。
 */
export function resolveOpenAIChatCompletionsUrl(baseUrl: string, provider: ProviderType = 'openai'): string {
  if (provider === 'custom') {
    return trimTrailingUrlPathSlash(baseUrl)
  }
  if (hasPathSuffix(baseUrl, '/chat/completions')) {
    return trimTrailingUrlPathSlash(baseUrl)
  }
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`
}

/**
 * 解析 OpenAI Responses 请求地址。
 */
export function resolveOpenAIResponsesUrl(baseUrl: string, _provider: ProviderType = 'openai-responses'): string {
  if (hasPathSuffix(baseUrl, '/responses')) {
    return trimTrailingUrlPathSlash(baseUrl)
  }
  return `${normalizeBaseUrl(baseUrl)}/responses`
}

/**
 * 解析 OpenAI Models 地址。
 *
 * 当用户把兼容格式配置为完整 /chat/completions 或 /responses 端点时，
 * 模型列表需要回到同级 /models。
 */
export function resolveOpenAIModelsUrl(baseUrl: string): string {
  if (hasPathSuffix(baseUrl, '/chat/completions')) {
    return replacePathSuffix(baseUrl, '/chat/completions', '/models')
  }
  if (hasPathSuffix(baseUrl, '/responses')) {
    return replacePathSuffix(baseUrl, '/responses', '/models')
  }
  return `${normalizeBaseUrl(baseUrl)}/models`
}

/**
 * 根据 Anthropic 协议供应商类型选择对应的 URL 规范化策略。
 *
 * DeepSeek / Kimi 等以 `/anthropic` 为协议根路径的供应商，实际端点仍位于
 * `/anthropic/v1/messages`，因此统一走 normalizeVersionedAnthropicBaseUrl 按需补 `/v1`。
 */
export function normalizeAnthropicProviderUrl(baseUrl: string, provider: ProviderType): string {
  if (
    provider === 'minimax'
    || provider === 'xiaomi'
    || provider === 'xiaomi-token-plan'
    || provider === 'qwen-anthropic'
    || provider === 'qwen-token-plan'
    || provider === 'zhipu-coding'
    || provider === 'zhipu-coding-team'
    || provider === 'ark-coding-plan'
    || provider === 'deepseek'
    || provider === 'kimi-api'
    || provider === 'kimi-coding'
  ) {
    return normalizeVersionedAnthropicBaseUrl(baseUrl)
  }
  return normalizeAnthropicBaseUrl(baseUrl)
}

/**
 * 解析 Anthropic Messages 请求地址。
 *
 * anthropic-compatible 格式要求用户直接填写完整请求端点。
 * 内置 Anthropic 协议供应商仍允许填写协议根地址。
 */
export function resolveAnthropicMessagesUrl(baseUrl: string, provider: ProviderType): string {
  if (provider === 'anthropic-compatible') {
    return trimTrailingUrlPathSlash(baseUrl)
  }
  if (provider === 'xiaomi' || provider === 'xiaomi-token-plan') {
    return `${new URL(baseUrl.trim()).origin}/anthropic/v1/messages`
  }
  if (hasPathSuffix(baseUrl, '/messages')) {
    return trimTrailingUrlPathSlash(baseUrl)
  }
  return `${normalizeAnthropicProviderUrl(baseUrl, provider)}/messages`
}

/**
 * 解析 Anthropic Models 地址。
 */
export function resolveAnthropicModelsUrl(baseUrl: string, provider: ProviderType): string {
  if (hasPathSuffix(baseUrl, '/messages')) {
    return replacePathSuffix(baseUrl, '/messages', '/models')
  }
  return `${normalizeAnthropicProviderUrl(baseUrl, provider)}/models`
}

/**
 * 将旧版本（v1）存储的通用兼容渠道 Base URL 一次性迁移为完整请求端点。
 *
 * 幂等保证：空值、非 custom/anthropic-compatible、以及已经是完整端点的值都原样返回。
 */
export function migrateCompatibleChannelBaseUrl(baseUrl: string, provider: ProviderType): string {
  const trimmed = baseUrl.trim()
  if (trimmed === '') {
    return baseUrl
  }

  if (provider === 'custom') {
    if (hasPathSuffix(trimmed, '/chat/completions')) {
      return trimTrailingUrlPathSlash(trimmed)
    }
    return `${normalizeBaseUrl(trimmed)}/chat/completions`
  }

  if (provider === 'anthropic-compatible') {
    if (hasPathSuffix(trimmed, '/messages')) {
      return trimTrailingUrlPathSlash(trimmed)
    }
    return `${normalizeVersionedAnthropicBaseUrl(trimmed)}/messages`
  }

  return baseUrl
}
