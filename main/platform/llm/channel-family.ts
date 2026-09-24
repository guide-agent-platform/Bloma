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

/** 家族多样性断言输入：author 缺省表示无作者对照（单审查场景），此时不拦。 */
export interface ReviewFamilyDiversityInput {
  authorChannel?: ChannelFamilyInput
  reviewerChannel: ChannelFamilyInput
  /** 断言用途说明（写入拒绝文案，帮助定位配置问题）。 */
  context?: string
}

/**
 * 审查独立性断言：reviewer 家族 ≠ author 家族，违反抛错。
 *
 * 用途：异构审查（C3 攻防轮次）构建期拦截错误配置——同族审查在结构上无效，
 * 应在配置期炸掉而不是运行期产出不可信结论。author 为 undefined 时不拦
 * （单审查/无对照场景由调用方定义语义）。
 */
export function assertReviewFamilyDiversity(input: ReviewFamilyDiversityInput): void {
  if (!input.authorChannel) return
  const authorFamily = channelFamilyOf(input.authorChannel)
  const reviewerFamily = channelFamilyOf(input.reviewerChannel)
  if (authorFamily === reviewerFamily) {
    const where = input.context ? `（${input.context}）` : ''
    throw new Error(
      `审查独立性断言失败${where}：审查渠道与作者渠道属于同一家族（${reviewerFamily}），`
      + `同源模型互审存在同款幻觉互相确认的盲区。`
      + `请为审查方配置异族渠道（作者=${describeChannel(input.authorChannel)}，`
      + `审查=${describeChannel(input.reviewerChannel)}）。`,
    )
  }
}

function describeChannel(channel: ChannelFamilyInput): string {
  const provider = channel.provider_type?.trim() || '未知 provider'
  return `${channel.id}[${provider}]`
}
