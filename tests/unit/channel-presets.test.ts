import { describe, expect, it } from 'vitest'
import { PROVIDER_DEFAULT_URLS, PROVIDER_LABELS } from '../../shared/types'
import {
  ARK_CODING_PLAN_MODELS,
  DEEPSEEK_PRESET_MODELS,
  KIMI_PRESET_MODELS,
  QWEN_TOKEN_PLAN_PRESET_MODELS,
  XIAOMI_PRESET_MODELS,
  extractZhipuCodingTeamApiToken,
  parseZhipuTeamCredentials,
  resolveFirstTestModelId,
} from '../../main/platform/llm/channel-presets'

/**
 * 渠道预设常量与智谱团队凭据解析测试（S2-AGENT）。
 */
describe('PROVIDER_DEFAULT_URLS / PROVIDER_LABELS 完整性', () => {
  it('每个 provider 都有默认 URL 与显示名', () => {
    const keys = Object.keys(PROVIDER_DEFAULT_URLS)
    expect(keys.length).toBeGreaterThanOrEqual(21)
    for (const key of keys) {
      expect(PROVIDER_LABELS).toHaveProperty(key)
    }
  })

  it('订阅类 provider（openai-codex/xai）不在集合内（Bloma 只支持填 API Key 型）', () => {
    expect(PROVIDER_DEFAULT_URLS).not.toHaveProperty('openai-codex')
    expect(PROVIDER_DEFAULT_URLS).not.toHaveProperty('xai')
  })
})

describe('预设模型常量', () => {
  it('预设模型结构合法（id/name/enabled）', () => {
    for (const models of [DEEPSEEK_PRESET_MODELS, KIMI_PRESET_MODELS, XIAOMI_PRESET_MODELS, QWEN_TOKEN_PLAN_PRESET_MODELS, ARK_CODING_PLAN_MODELS]) {
      expect(models.length).toBeGreaterThan(0)
      for (const m of models) {
        expect(typeof m.id).toBe('string')
        expect(typeof m.name).toBe('string')
        expect(m.enabled).toBe(true)
      }
    }
  })
})

describe('parseZhipuTeamCredentials / extractZhipuCodingTeamApiToken', () => {
  it('解析 JSON 对象格式的三段式 secret', () => {
    const creds = parseZhipuTeamCredentials(JSON.stringify({ apiKey: 'tok-1', organization: 'org-1', project: 'proj-1' }))
    expect(creds?.apiKey).toBe('tok-1')
    expect(creds?.organization).toBe('org-1')
    expect(creds?.project).toBe('proj-1')
  })

  it('解析 key=value 分号格式的 secret（key 大小写/横线归一化）', () => {
    const creds = parseZhipuTeamCredentials('API-TOKEN=tok-2; BigModel-Organization=org-2; project=proj-2')
    expect(creds?.apiKey).toBe('tok-2')
    expect(creds?.organization).toBe('org-2')
    expect(creds?.project).toBe('proj-2')
  })

  it('extractZhipuCodingTeamApiToken 从团队 secret 提取 API Token', () => {
    expect(extractZhipuCodingTeamApiToken('apiKey=tok-3;organization=org-3')).toBe('tok-3')
    expect(extractZhipuCodingTeamApiToken('plain-token')).toBe('plain-token')
  })
})

describe('resolveFirstTestModelId', () => {
  it('返回第一个启用模型的 name（真实模型 ID），否则第一个模型的 name，否则 undefined', () => {
    expect(resolveFirstTestModelId([{ id: 'a', name: 'A', enabled: false }, { id: 'b', name: 'B', enabled: true }])).toBe('B')
    expect(resolveFirstTestModelId([{ id: 'a', name: 'A', enabled: false }])).toBe('A')
    expect(resolveFirstTestModelId(undefined)).toBeUndefined()
  })
})
