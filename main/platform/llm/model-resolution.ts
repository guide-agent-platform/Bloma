import type { Channel, ChannelModel, DocumentCategory, WorkflowStage } from '../../../shared/types'
import { listEnabledModels } from './channel-manager'

/**
 * 文档类别 → 模型路由（§6，2026-08-17 设计 M4）。
 *
 * 代码里不写模型名、写文档类别，由本模块单点解析到实际模型：
 * ①override（preferredModel，仅当在当前渠道 models 内时生效）
 * ②capability 默认（strongest = 渠道 models 列表序的首个 enabled，与改造前
 *   `find(item => item.enabled)` 语义一致；balanced/cheap = 优先 flash/lite/turbo 级
 *   快模型、无匹配回退 strongest——决议 7「审查用 flash 级」的名称启发式过渡，
 *   能力元数据 tier 字段落地前使用）
 * ③同 provider 降级链（fallbackChain ∩ enabled，供失败重试换模——一把 key 约束下
 *   不跨 provider）
 * ④无可用模型：抛 `CHANNEL_MODEL_NOT_FOUND`（明确错误，绝不硬编码模型名兜底）。
 *
 * 失败处理沿用各引擎现有重试策略（截断→升 maxTokens、带反馈重试），路由层只负责
 * 「选哪个模型」，不重复生成逻辑。
 */
// M5：DocumentCategory 迁移至 shared/types（renderer 设置页共用），此处 re-export 保持既有导入兼容。
export type { DocumentCategory } from '../../../shared/types'

export interface CategoryModelConfig {
  category: DocumentCategory
  /** 能力标签（质量优先默认 strongest）；'balanced'/'cheap' 优先 flash/lite/turbo 级
   *  快模型、无匹配回退 strongest（决议 7 降级方法论，名称启发式过渡） */
  capability: 'strongest' | 'balanced' | 'cheap'
  /** 手动档：指定模型名（仅当在当前渠道 models 内时生效，否则忽略落入 capability 默认） */
  preferredModel?: string
  /** 同 provider 降级链：首选不可用/失败时依次尝试（仅取渠道内 enabled 条目） */
  fallbackChain?: string[]
}

/** 质量优先默认：除内审 audit 走 cheap（flash 级，决议 7）外全类别 strongest、无手动档、无降级链（行为可预期）。测试可经 setCategoryConfigForTests 覆盖。 */
export const DEFAULT_CATEGORY_CONFIGS: Record<DocumentCategory, CategoryModelConfig> = {
  guide: { category: 'guide', capability: 'strongest' },
  prd: { category: 'prd', capability: 'strongest' },
  sketch: { category: 'sketch', capability: 'strongest' },
  mvp: { category: 'mvp', capability: 'strongest' },
  gwt: { category: 'gwt', capability: 'strongest' },
  judge: { category: 'judge', capability: 'strongest' },
  // 内审（2026-09-01 决议 4/7）：Attacker/Defender/复核轮专用审查腿。决议 7「审查用
  // flash 级、顶配留给 MVP loop/spec 生成」落地为缺省 cheap 档——优先取 audit 渠道内
  // flash/lite/turbo 级快模型；渠道无快模型时回退渠道首选（非强制，用户仍可按渠道
  // 选配 + 模型列表序覆盖）。
  audit: { category: 'audit', capability: 'cheap' },
  // T4-L3 蒸馏（memory.json）：后台整理型任务，不映射任何阶段（categoryForStage 不含）
  summary: { category: 'summary', capability: 'strongest' },
}

let categoryConfigs: Record<DocumentCategory, CategoryModelConfig> = { ...DEFAULT_CATEGORY_CONFIGS }

/** 测试注入类别配置（手动档/降级链用例）；resetCategoryConfigsForTests 复原。 */
export function setCategoryConfigForTests(configs: Partial<Record<DocumentCategory, CategoryModelConfig>>): void {
  categoryConfigs = { ...DEFAULT_CATEGORY_CONFIGS, ...configs }
}

export function resetCategoryConfigsForTests(): void {
  categoryConfigs = { ...DEFAULT_CATEGORY_CONFIGS }
}

/** 解析结果：主选模型 + 同 provider 降级链（enabled，按 fallbackChain 序）。 */
export interface ResolvedModel {
  model: string
  fallbacks: string[]
}

/** 经济档模型名特征（决议 7「审查用 flash 级」落地）：flash/lite/turbo 级快模型。
 *  能力元数据（tier 字段）落地前用名称启发式过渡；渠道无匹配时回退 strongest，
 *  绝不因缺元数据把渠道判死（单模型渠道行为与改造前完全一致）。 */
const ECONOMY_MODEL_PATTERN = /(flash|lite|turbo)/i

/** ②capability 默认解析：strongest 取列表序首个 enabled；balanced/cheap 优先
 *  flash/lite/turbo 级快模型（决议 7 降级方法论），无匹配回退 strongest。 */
function pickCapabilityModel(enabled: ChannelModel[], capability: CategoryModelConfig['capability']): ChannelModel | undefined {
  if (capability === 'strongest') return enabled[0]
  return enabled.find((model) => ECONOMY_MODEL_PATTERN.test(model.name)) ?? enabled[0]
}

/**
 * 解析类别 → 模型（§6.3 管线）。渠道无任何 enabled 模型时抛
 * `CHANNEL_MODEL_NOT_FOUND`——由调用方决定语义（引导路径回规则路由 / 编程路径报可读错误）。
 */
export function resolveCategoryModel(channel: Pick<Channel, 'models' | 'name'>, category: DocumentCategory): ResolvedModel {
  const config = categoryConfigs[category] ?? DEFAULT_CATEGORY_CONFIGS[category]
  const models = channel.models ?? []
  const enabled = listEnabledModels(channel)

  // ①手动档：仅当 preferredModel 确在当前渠道 models 内才生效（防配置指向别家模型名）
  if (config.preferredModel && models.some((item) => item.name === config.preferredModel)) {
    return { model: config.preferredModel, fallbacks: pickFallbacks(config, enabled, config.preferredModel) }
  }

  // ②capability 默认：strongest=列表序首个 enabled；balanced/cheap 优先 flash 级快模型
  const primary = pickCapabilityModel(enabled, config.capability)
  if (!primary) {
    throw new Error(`CHANNEL_MODEL_NOT_FOUND: 渠道「${channel.name}」没有启用的模型，无法解析 ${category} 类别`)
  }
  return { model: primary.name, fallbacks: pickFallbacks(config, enabled, primary.name) }
}

/** ③降级链：fallbackChain 中 enabled 且非主选的条目（保序）。 */
function pickFallbacks(config: CategoryModelConfig, enabled: ChannelModel[], primary: string): string[] {
  if (!config.fallbackChain?.length) return []
  return config.fallbackChain.filter((name) => name !== primary && enabled.some((item) => item.name === name))
}

/**
 * 权威阶段 → 文档类别（orchestrator 入口的 env 构建用，§6.4）。
 * 澄清/阻塞/草图与完成态护栏的意图判定走 guide；草图生成走 sketch；
 * 裁判审查走 judge；其余编程阶段走 mvp。
 */
export function categoryForStage(stage: WorkflowStage): DocumentCategory {
  if (stage === 'generating_sketch') return 'sketch'
  if (stage === 'judge_review') return 'judge'
  if (
    stage === 'clarifying' ||
    stage === 'blocked_for_user_decision' ||
    stage === 'sketch_ready' ||
    stage === 'ready' ||
    stage === 'completed'
  ) {
    return 'guide'
  }
  return 'mvp'
}

/**
 * 类别 → 温度（§7.7 校准表）：guide 澄清要发散（0.3），生成/判定类要稳（0.1）。
 * thinking 维持全局 disabled（0406db9：思考型渠道把 max_tokens 耗在思考上导致零正文），
 * 设计表 normalizer/gwt/judge 的「开启」暂不落地——零正文回归风险大于推理增益，
 * 渠道侧可控预算后再评估。
 */
export const CATEGORY_TEMPERATURES: Record<DocumentCategory, number> = {
  guide: 0.3,
  prd: 0.1,
  sketch: 0.1,
  mvp: 0.1,
  gwt: 0.1,
  judge: 0.1,
  // 内审攻击/复核要确定性（2026-09-01 设计：温度 0.1）
  audit: 0.1,
  // 蒸馏要忠实转写而非发散（§7.7 校准表新增，T4-L3）
  summary: 0.1,
}

export function categoryTemperature(category: DocumentCategory): number {
  return CATEGORY_TEMPERATURES[category] ?? 0.1
}

/**
 * 生成/修复类调用（MVP loop、修复轮）的单次输出上限缺省。
 * 对齐 Proma 渠道 maxOutputTokens=640000（2026-09-05 用户拍板全渠道统一）。
 * 根因（2026-09-04「地牢拾荒录」双次 MVP 生成失败）：deepseek-v4-pro 在 thinking
 * 开启时把 max_tokens 全耗在思考上，16384 被顶满后正文零字符 → loop 空转「completed」
 * → GWT 4 项全失败 → 熔断回滚。给足输出空间让思考自然结束再产出正文。
 */
export const GENERATION_MAX_TOKENS = 640000

/**
 * Provider 服务端 max_tokens 硬上限（传输层夹紧用，2026-10-03 e99e6319 事故后登记）。
 *
 * 事故：zhipu glm-5.3 anthropic 端点新增超限校验——640000 直接 400 code 1210
 * （「max_tokens参数非法：限制数值范围[1,131072]」）；灰度首夜部分网关实例表现为
 * 200 零内容流（被 loop 当正常完成 → no-marks 拒收/模板兜底，渠道故障伪装成行为问题）。
 * 上限只升不降：新渠道服务端限制须经探针实测后再登记，勿臆写。
 */
const PROVIDER_MAX_TOKENS_CAP: Record<string, number> = {
  'zhipu-coding': 131072,
  'zhipu-coding-team': 131072,
}

/**
 * 按渠道夹紧 max_tokens：无登记上限的 provider 原样返回（640000 统一值语义不变）。
 * 唯一夹紧点在传输层（loop-query 请求体构建），覆盖桌面线/loop-planner/记忆蒸馏
 * 等全部调用面——调用方仍可声明 640000 意图，超限渠道在出口统一收口。
 */
export function capMaxTokensForProvider(maxTokens: number, providerType?: string, modelId?: string): number {
  if (!providerType) return maxTokens
  // Official /models metadata and API schema, verified 2026-10-16: 384K = 393216.
  // Preserve the configured 640000 intent; clamp only the outgoing provider body.
  if (providerType === 'deepseek' && /^deepseek-(?:flash|v4-(?:flash|pro))(?:-|$)/i.test(modelId ?? '')) return Math.min(maxTokens, 393216)
  // Regular GLM-5.3 also advertises 128K output. Preserve the configured intent
  // in the experiment and apply the model's limit only at transport.
  if (providerType === 'zhipu' && ['glm-5.3', 'glm-5.3-flash'].includes(modelId?.toLowerCase() ?? '')) return Math.min(maxTokens, 131072)
  const cap = PROVIDER_MAX_TOKENS_CAP[providerType]
  return cap !== undefined ? Math.min(maxTokens, cap) : maxTokens
}

/**
 * 生成/修复类调用的 max_tokens 解析：渠道显式配置优先，缺省统一 640000（全渠道）。
 */
export function resolveGenerationMaxTokens(channel: { max_tokens?: number }): number {
  return channel.max_tokens ?? GENERATION_MAX_TOKENS
}
