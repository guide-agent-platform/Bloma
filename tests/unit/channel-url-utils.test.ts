import { describe, expect, it } from 'vitest'
import {
  normalizeAnthropicBaseUrlForSdk,
  normalizeAnthropicProviderUrl,
  resolveAnthropicMessagesUrl,
  resolveAnthropicModelsUrl,
  resolveOpenAIModelsUrl,
} from '../../main/channel-url-utils'

/**
 * URL 规范化纯函数测试（S2-AGENT）。
 * 覆盖 Anthropic 兼容 / OpenAI 兼容 / custom / anthropic-compatible 各分支。
 */
describe('normalizeAnthropicProviderUrl', () => {
  it('deepseek 协议根路径补 /v1', () => {
    expect(normalizeAnthropicProviderUrl('https://api.deepseek.com/anthropic', 'deepseek'))
      .toBe('https://api.deepseek.com/anthropic/v1')
  })

  it('已含版本路径不重复追加（kimi-coding）', () => {
    expect(normalizeAnthropicProviderUrl('https://api.kimi.com/coding/v1', 'kimi-coding'))
      .toBe('https://api.kimi.com/coding/v1')
  })

  it('anthropic 根路径补 /v1', () => {
    expect(normalizeAnthropicProviderUrl('https://api.anthropic.com', 'anthropic'))
      .toBe('https://api.anthropic.com/v1')
  })

  it('minimax anthropic 协议根补 /v1', () => {
    expect(normalizeAnthropicProviderUrl('https://api.minimaxi.com/anthropic', 'minimax'))
      .toBe('https://api.minimaxi.com/anthropic/v1')
  })
})

describe('resolveAnthropicMessagesUrl', () => {
  it('anthropic-compatible 完整端点原样使用', () => {
    expect(resolveAnthropicMessagesUrl('https://gateway.example.com/v1/messages', 'anthropic-compatible'))
      .toBe('https://gateway.example.com/v1/messages')
  })

  it('xiaomi 固定拼 /anthropic/v1/messages', () => {
    expect(resolveAnthropicMessagesUrl('https://api.xiaomimimo.com', 'xiaomi'))
      .toBe('https://api.xiaomimimo.com/anthropic/v1/messages')
  })

  it('deepseek 拼 /anthropic/v1/messages', () => {
    expect(resolveAnthropicMessagesUrl('https://api.deepseek.com/anthropic', 'deepseek'))
      .toBe('https://api.deepseek.com/anthropic/v1/messages')
  })

  it('已带 /messages 后缀的原样返回', () => {
    expect(resolveAnthropicMessagesUrl('https://api.anthropic.com/v1/messages', 'anthropic'))
      .toBe('https://api.anthropic.com/v1/messages')
  })
})

describe('resolveAnthropicModelsUrl', () => {
  it('deepseek 模型端点位于协议根 /models', () => {
    expect(resolveAnthropicModelsUrl('https://api.deepseek.com/anthropic', 'deepseek'))
      .toBe('https://api.deepseek.com/anthropic/v1/models')
  })

  it('anthropic 根路径模型端点', () => {
    expect(resolveAnthropicModelsUrl('https://api.anthropic.com', 'anthropic'))
      .toBe('https://api.anthropic.com/v1/models')
  })

  it('已带 /messages 时替换为 /models', () => {
    expect(resolveAnthropicModelsUrl('https://gateway.example.com/v1/messages', 'anthropic-compatible'))
      .toBe('https://gateway.example.com/v1/models')
  })
})

describe('resolveOpenAIModelsUrl', () => {
  it('OpenAI 兼容根路径拼 /models', () => {
    expect(resolveOpenAIModelsUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/models')
  })

  it('custom 完整 /chat/completions 端点回到同级 /models', () => {
    expect(resolveOpenAIModelsUrl('https://api.example.com/v1/chat/completions'))
      .toBe('https://api.example.com/v1/models')
  })
})

describe('normalizeAnthropicBaseUrlForSdk', () => {
  it('剥掉 /v1/messages 与 /v1 后缀还原协议根', () => {
    expect(normalizeAnthropicBaseUrlForSdk('https://api.deepseek.com/anthropic/v1/messages'))
      .toBe('https://api.deepseek.com/anthropic')
    expect(normalizeAnthropicBaseUrlForSdk('https://api.anthropic.com/v1'))
      .toBe('https://api.anthropic.com')
    expect(normalizeAnthropicBaseUrlForSdk('https://api.anthropic.com'))
      .toBe('https://api.anthropic.com')
  })
})
