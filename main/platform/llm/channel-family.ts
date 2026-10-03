/**
 * 渠道家族判定与审查独立性断言（协作机制改造 C2，2026-09-24）。
 *
 * 家族语义：同家族 = 背后可能是同源模型（同厂商或同一模型系列）。用于「审查者不得
 * 与作者同家族」的独立性断言——同源模型互相审查存在同款幻觉互相确认的盲区
 * （参照 Proma-Easy E2E 实证：coding 与 testing 作者同族时同款幻觉互证）。
 *
 * 判定依据是渠道记录的 provider_type（比渠道 ID 前缀推断准确）；同厂商多接入形态
 * 归一为同一厂商族（zhipu/zhipu-coding/zhipu-coding-team → zhipu）。
 * 中转聚合类（anthropic-compatible/opencode-go-openai/ark-coding-plan）保守各自
 * 成独立族：中转背后可能是任何厂商，归并会产生假多样性（误判异族），独立成族最多
 * 产生假同族（断言更严），宁严勿松。
 * 未知/缺失 provider_type 的渠道以 channel.id 作为独立家族——与任何字面家族互异。
 */

/** provider_type → 厂商族归一表；未列出的 provider 按字面值成族。 */
const PROVIDER_FAMILY: Record<string, string> = {
  anthropic: 'anthropic',
  'anthropic-compatible': 'anthropic-compatible',
  openai: 'openai',
  'openai-responses': 'openai',
  deepseek: 'deepseek',
  google: 'google',
  'kimi-api': 'moonshot',
  'kimi-coding': 'moonshot',
  'zhipu': 'zhipu',
  'zhipu-coding': 'zhipu',
  'zhipu-coding-team': 'zhipu',
  'opencode-go-openai': 'opencode',
  'ark-coding-plan': 'ark',
  minimax: 'minimax',
  doubao: 'doubao',
}

/** 渠道家族判定的最小输入面（Channel 的结构子集，便于测试构造）。 */
export interface ChannelFamilyInput {
  id: string
  provider_type?: string
}

/**
 * 渠道家族：provider_type 归一 → 字面 provider → channel.id（未知 provider 独立族）。
 * 纯函数、不落盘、不抛错。
 */
export function channelFamilyOf(channel: ChannelFamilyInput | undefined): string {
  if (!channel) return '(none)'
  const provider = channel.provider_type?.trim()
  if (!provider) return channel.id
  return PROVIDER_FAMILY[provider] ?? provider
}

// （assertReviewFamilyDiversity/describeChannel 随死路径清尸删除，2026-10-03 删留执行：
//  生产零调用——adversarial-review.ts:67 用 channelFamilyOf 自行比较返回 same_family。）
