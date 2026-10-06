/**
 * C1 委派渠道覆盖解析（协作机制改造清单，2026-09-24；自 agent-collaboration 拆出守 R7 ≤800）。
 *
 * 职责：把 delegate_agent 的 channelId/modelId 参数解析为子会话专属 env 与元信息。
 * 依赖纪律：只依赖 platform/llm（agent → platform 向下合法）；不 import agent-loop。
 */

import {
  buildSdkEnv,
  decryptApiKey,
  getChannelByIdRaw,
  listChannels,
  listEnabledModels,
} from '../../platform/llm/channel-manager'

/** 委派渠道覆盖解析失败（渠道/模型不可用）——带教育文案的拒绝，不是裸抛。 */
export class DelegationChannelError extends Error {}

/** 渠道覆盖解析产物：env + 元信息（record 持有，子 loop 与 continue 续跑共用）。 */
export interface DelegationChannelOverride {
  env: Record<string, string>
  channelId: string
  channelName: string
  modelName: string
  providerType?: string
  maxTokens?: number
}

/**
 * 解析委派渠道覆盖：channelId 缺省返回 null（继承父会话渠道，零行为变化）；
 * 显式指定时解析子会话专属 env（SDKQueryOptions.env 是每次调用传入的参数，
 * query 函数原样复用——换 env 即换渠道）。
 *
 * 设计决策：
 * - **渠道钉死不降级**：覆盖 env 不携带 fallback 上下文（不 attach runtime-fallback
 *   的渠道切换标记）——跨渠道委派的目的就是异构性（异构审查/多模型协作），
 *   运行期自动切渠道会侵蚀该目的；失败即委派失败（可观测），由委派方决定重试。
 * - **拒绝必教育**：所有失败路径列出可用渠道/模型清单与正确动作。
 * - 已知限制：重启恢复的委派 continue 回退继承父渠道（env 仅存内存，密钥不落盘）。
 */
export function resolveDelegationChannelOverride(args: {
  channelId?: string
  modelId?: string
}): DelegationChannelOverride | null {
  const requestedChannel = args.channelId?.trim()
  if (!requestedChannel) return null

  // 2026-10-06：短名解析对称化——modelId 一直 name/id 双认，channelId 此前只认 UUID，
  // 编排器写「glm/kimi」短名被拒后靠错误教育里的 name(id) 清单自我纠正（当晚狗粮实锤
  // 空转两轮）。现在短名精确匹配已启用渠道（重名取首个已启用；找不到仍拒必教育）。
  const channel = getChannelByIdRaw(requestedChannel)
    ?? listChannels().find((item) => item.enabled && item.name === requestedChannel)
  if (!channel || !channel.enabled) {
    const available = listChannels()
      .filter((item) => item.enabled)
      .map((item) => `${item.name}(${item.id})`)
      .join('、')
    throw new DelegationChannelError(
      `委派渠道不可用：${requestedChannel}（不存在或未启用；channelId 接受完整 id 或渠道名）。`
      + `可用渠道：${available || '（无已启用渠道）'}。`
      + `请修正 channelId 后重试，或去掉 channelId 继承当前会话渠道。`,
    )
  }

  const enabledModels = listEnabledModels(channel)
  const requestedModel = args.modelId?.trim()
  const model = requestedModel
    ? enabledModels.find((item) => item.name === requestedModel || item.id === requestedModel)
    : enabledModels.find((item) => item.supports_tools !== false) ?? enabledModels[0]
  if (!model) {
    const reason = requestedModel
      ? `渠道「${channel.name}」上未找到已启用模型「${requestedModel}」`
      : `渠道「${channel.name}」没有任何已启用模型`
    throw new DelegationChannelError(
      `委派模型不可用：${reason}。`
      + `该渠道已启用模型：${enabledModels.map((item) => item.name).join('、') || '（无）'}。`
      + `请修正 modelId，或在渠道设置中启用模型后重试。`,
    )
  }
  if (model.supports_tools === false) {
    throw new DelegationChannelError(
      `委派模型不支持工具调用：${model.name}（supports_tools=false，子会话必须能调用工具）。`
      + `请选择该渠道其他已启用模型。`,
    )
  }

  let apiKey: string
  try {
    apiKey = decryptApiKey(channel.api_key)
  } catch {
    throw new DelegationChannelError(
      `委派渠道密钥不可解：${channel.name}(${channel.id})（safeStorage 解密失败）。`
      + `请在渠道设置中重新保存该渠道的 API Key 后重试。`,
    )
  }

  const env = buildSdkEnv(apiKey, channel.base_url, model.name, channel.provider_type)
  return {
    env,
    channelId: channel.id,
    channelName: channel.name,
    modelName: model.name,
    providerType: channel.provider_type,
    maxTokens: channel.max_tokens,
  }
}
