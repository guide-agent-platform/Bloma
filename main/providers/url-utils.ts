/**
 * URL 规范化工具（照抄 Proma 上游 packages/core/src/providers/url-utils.ts @ bf3e98c，
 * 裁剪为 Anthropic 协议族子集——OpenAI/Google 侧 Bloma 未走本层）。
 *
 * 所有 Anthropic URL 规范化逻辑统一收口在此文件，避免分散重复。
 */

import type { ProviderType } from '../../shared/types'

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

/**
 * 规范化 Anthropic Base URL
 *
 * 去除尾部斜杠，去除误填的 /messages 后缀，如果没有版本路径则追加 /v1。
 * 结果用于直接拼接 /messages 发起请求。
 *
 * 例如：
 * - "https://api.anthropic.com" → "https://api.anthropic.com/v1"
 * - "https://api.anthropic.com/v1" → 不变
 * - "https://proxy.example.com/v2/" → "https://proxy.example.com/v2"
 * - "https://proxy.example.com/v1/messages" → "https://proxy.example.com/v1"
 * - "https://api.deepseek.com/anthropic" → 不变（已有非版本路径）
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
 * 例如：
 * - "https://api.minimaxi.com/anthropic" → "https://api.minimaxi.com/anthropic/v1"
 * - "https://api.deepseek.com/anthropic" → "https://api.deepseek.com/anthropic/v1"
 * - "https://api.kimi.com/coding/v1" → 不变（已有版本路径）
 */
export function normalizeVersionedAnthropicBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, '')
  url = url.replace(/\/messages$/, '')
  if (!url.match(/\/v\d+$/)) {
    url = `${url}/v1`
  }
  return url
}

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
 * Anthropic 兼容格式要求用户直接填写完整请求端点。
 * 内置 Anthropic 协议供应商仍允许填写协议根地址，例如：
 * - minimax: "https://api.minimaxi.com/anthropic" → ".../anthropic/v1/messages"
 * - anthropic-compatible: "https://gateway.example.com/v1/messages" → 原样使用
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
