// ============================================================
// 推理档位管理（reasoning-profile）— 从 Proma v0.18.2 移植精简
// 来源：Proma packages/shared/src/types/reasoning-profile.ts
//      + packages/core/src/providers/thinking-capability.ts
// 蓝本提交：92a635fa（2026-08-26）；移植日期：2026-08-27
// 增强方案：.context/enhancements/reasoning-profile-port.md（P1）
//
// 解决的问题（2026-08-16 线上案例）：MiniMax-M3 等思考型渠道把 max_tokens
// 全耗在思考上（草图首试 56.5s 零字符），此前对一切模型一律 thinking:disabled。
// 代价是 judge/GWT normalizer 这类「判定/校验」任务无法用 DeepSeek v4 / GLM-5.3
// 的推理能力。本模块提供「渠道侧可控预算」：DeepSeek v4 用 output_config.effort
// 精确控制思考深度（独立深度控制，不吞 max_tokens）。
//
// 零回归契约：level 缺省 + 模型未识别 + providerType 不在 omit 黑名单 →
// 输出与改造前逐字节一致（thinking:{type:'disabled'}），400 降级与零正文防护保留兜底。
// ============================================================

/** Bloma 精简档位（Proma 7 档 → 4 档，教学产品够用） */
export const THINKING_LEVELS = ['off', 'low', 'high', 'max'] as const
export type ThinkingLevel = 'off' | 'low' | 'high' | 'max'

/** anthropic-messages 请求体片段 */
export interface ThinkingRequestFragment {
  /** 直接并入 body 的字段 */
  thinking?: { type: 'enabled' | 'disabled' }
  output_config?: { effort: string }
  /** true = 完全不发 thinking 字段（Token Plan 类渠道发 disabled 都会 400） */
  omit: boolean
}

export interface ReasoningProfile {
  id: string
  levels: readonly ThinkingLevel[]
  defaultLevel: ThinkingLevel
  normalize(level: ThinkingLevel | undefined): ThinkingLevel
  encode(level: ThinkingLevel): ThinkingRequestFragment
}

// ---- effort 映射表（逐条对齐 Proma 蓝本） ----
// Proma reasoning-profile.ts:108-115 DEEPSEEK_V4_FLASH_EFFORT_MAP
const DS4_FLASH_EFFORT: Record<Exclude<ThinkingLevel, 'off'>, string> = {
  low: 'low', high: 'high', max: 'max',
}
// Proma reasoning-profile.ts:117-124 DEEPSEEK_V4_PRO_EFFORT_MAP（low 直接给 high）
const DS4_PRO_EFFORT: Record<Exclude<ThinkingLevel, 'off'>, string> = {
  low: 'high', high: 'high', max: 'max',
}
// Proma reasoning-profile.ts:126-133 K3_EFFORT_MAP（anthropic 分支同表）
const K3_EFFORT: Record<Exclude<ThinkingLevel, 'off'>, string> = {
  low: 'low', high: 'high', max: 'max',
}
// Proma reasoning-profile.ts:143-152 GLM_53 无 off（强制思考，深度由 effort 控制）
const GLM53_EFFORT: Record<Exclude<ThinkingLevel, 'off'>, string> = {
  low: 'low', high: 'high', max: 'max',
}
// Proma reasoning-profile.ts:135-142 GLM_52（anthropic 分支：low 也有 high 保底）
const GLM52_EFFORT: Record<Exclude<ThinkingLevel, 'off'>, string> = {
  low: 'high', high: 'high', max: 'max',
}

function encodeEffortBased(effortMap: Record<Exclude<ThinkingLevel, 'off'>, string>): ReasoningProfile['encode'] {
  return (level) => {
    if (level === 'off') return { thinking: { type: 'disabled' }, omit: false }
    return { thinking: { type: 'enabled' }, output_config: { effort: effortMap[level] }, omit: false }
  }
}

function normalizeWith(defaultLevel: ThinkingLevel, fallback: (l: ThinkingLevel) => ThinkingLevel): ReasoningProfile['normalize'] {
  return (level) => (level === undefined ? defaultLevel : fallback(level))
}

export const PROFILES: readonly ReasoningProfile[] = [
  {
    id: 'deepseek-v4-flash',
    levels: ['off', 'low', 'high', 'max'],
    defaultLevel: 'high',
    // Proma normalizeDeepSeekV4Level:163-182（Bloma 4 档版）
    normalize: normalizeWith('high', (l) => (l === 'off' ? 'off' : l === 'low' ? 'low' : l)),
    encode: encodeEffortBased(DS4_FLASH_EFFORT),
  },
  {
    id: 'deepseek-v4-pro',
    levels: ['off', 'low', 'high', 'max'],
    defaultLevel: 'high',
    normalize: normalizeWith('high', (l) => (l === 'off' ? 'off' : l === 'low' ? 'low' : l)),
    encode: encodeEffortBased(DS4_PRO_EFFORT),
  },
  {
    id: 'kimi-k3',
    levels: ['off', 'low', 'high', 'max'],
    defaultLevel: 'high',
    normalize: normalizeWith('high', (l) => (l === 'off' ? 'off' : l === 'low' ? 'low' : l)),
    encode: encodeEffortBased(K3_EFFORT),
  },
  {
    id: 'glm-5.3',
    // 审查 P1-②：补充 off 档保持「缺省 off = 现状 disabled」零回归契约对全部模型成立；
    // 「强制思考」仅当调用方显式传 low/high/max 时生效（判定类任务试点）。
    levels: ['off', 'low', 'high', 'max'],
    defaultLevel: 'max',
    // Proma normalizeGlm53Level:201-215：off→off（Bloma 契约修正），其余低档→low，高档→high，max→max
    normalize: normalizeWith('max', (l) => (l === 'off' ? 'off' : l === 'max' ? 'max' : l === 'high' ? 'high' : 'low')),
    encode: (level) => {
      // GLM-5.3 anthropic 端点：思考深度用 effort 语义控制（显式 low/high/max 时）。
      // 注：Proma 经 Pi SDK forceAdaptiveThinking 传递；Bloma 直接构造 body，
      // 具体字段（output_config.effort vs thinking.effort）需渠道实测后定稿。
      if (level === 'off') return { thinking: { type: 'disabled' }, omit: false }
      return { thinking: { type: 'enabled' }, output_config: { effort: GLM53_EFFORT[level] }, omit: false }
    },
  },
  {
    id: 'glm-5.2',
    levels: ['off', 'high', 'max'],
    defaultLevel: 'high',
    normalize: normalizeWith('high', (l) => (l === 'off' ? 'off' : l === 'max' ? 'max' : 'high')),
    encode: encodeEffortBased(GLM52_EFFORT),
  },
]

/** 仅按模型 ID 匹配（Bloma 全走 anthropic-messages，无 transport 分叉） */
export function resolveProfile(modelId: string | undefined): ReasoningProfile | undefined {
  const id = modelId?.toLowerCase()
  if (!id) return undefined
  // 正则对齐 Proma resolveReasoningProfile:336-349（容忍 -latest/-exp 等后缀）
  if (/^deepseek-v4-flash(?:-|$)/.test(id)) return PROFILES[0]
  if (/^deepseek-v4-pro(?:-|$)/.test(id)) return PROFILES[1]
  if (/^(?:k3(?:-256k)?|kimi-k3)$/.test(id)) return PROFILES[2]
  if (id === 'glm-5.3') return PROFILES[3]
  if (id === 'glm-5.2') return PROFILES[4]
  return undefined
}

/**
 * Proma thinking-capability.ts:88-105 的渠道黑名单：
 * 这些 ProviderType 不接受 thinking 字段（连 disabled 都 400）→ omit。
 * Bloma 侧等价判断：providerType ∈ 集合时直接 omit（消灭 400+重试往返）。
 */
export const THINKING_OMIT_PROVIDERS = new Set([
  'kimi-api', 'kimi-coding', 'zhipu-coding-team',
  'ark-coding-plan', 'qwen-token-plan', 'xiaomi-token-plan',
])
// 注：Proma 蓝本含 'minimax'，但 Bloma 2026-08-16 事故证据（MiniMax-M3 思考烧光
// max_tokens 致零正文）证明 Bloma 的 MiniMax 渠道**接受** thinking:disabled 且必须
// 显式禁思考——omit 会让它恢复默认思考、正文为空，因此从黑名单移除（审查 P1）。
// 2026-10-09 'zhipu-coding' 移除：两晚狗粮零正文实锤（max_tokens=800 思考 791 正文 0；
// 131072 思考 3383 后断流）后，probe-glm.cjs / probe-glm-stream.cjs 在
// open.bigmodel.cn/api/anthropic 实测：thinking disabled / enabled+output_config.effort /
// tools 组合全形态 HTTP 200，disabled 下思考块真实消失（非流式 blocks=[text]，流式
// thinking_delta=0）且正文正常。智谱官方文档「GLM-5.3 传 disabled 报错」仅适用
// 原生 /api/paas/v4 端点，anthropic 端点不受此限。omit 才是零正文根因：默认思考
// 吃光小预算（需求清单 maxTokens=800 场景）。zhipu-coding-team 同域名端点未实测，
// 暂留黑名单，实测后同样移除。

/**
 * 主入口：给 anthropicMessagesQuery 消费。
 * 与现状兼容契约：level === 'off' 或模型未识别 → 行为与今天完全一致
 * （thinking:disabled + 既有 400 降级），保证零回归。
 */
export function buildThinkingFragment(
  modelId: string | undefined,
  providerType: string | undefined,
  level: ThinkingLevel | undefined,
): ThinkingRequestFragment {
  if (providerType && THINKING_OMIT_PROVIDERS.has(providerType)) return { omit: true }
  const profile = resolveProfile(modelId)
  if (!profile) {
    // 未识别模型（Claude 旧系、MiniMax-M3 等未知渠道）→ 维持现状全局 disabled
    return { thinking: { type: 'disabled' }, omit: false }
  }
  return profile.encode(profile.normalize(level))
}
