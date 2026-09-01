import type { Channel, ChannelModel, DocumentCategory, WorkflowStage } from '../shared/types'
import { listEnabledModels } from './channel-manager'

/**
 * 文档类别 → 模型路由（§6，2026-08-17 设计 M4）。
 *
 * 代码里不写模型名、写文档类别，由本模块单点解析到实际模型：
 * ①override（preferredModel，仅当在当前渠道 models 内时生效）
 * ②capability 默认（strongest = 渠道 models 列表序的首个 enabled，与改造前
 *   `find(item => item.enabled)` 语义一致；balanced/cheap 为预留档位，能力元数据
 *   落地前一律按 strongest 处理）
 * ③同 provider 降级链（fallbackChain ∩ enabled，供失败重试换模——一把 key 约束下
 *   不跨 provider）
 * ④无可用模型：抛 `CHANNEL_MODEL_NOT_FOUND`（明确错误，绝不硬编码模型名兜底）。
 *
 * 失败处理沿用各引擎现有重试策略（截断→升 maxTokens、带反馈重试），路由层只负责
 * 「选哪个模型」，不重复生成逻辑。
 */
// M5：DocumentCategory 迁移至 shared/types（renderer 设置页共用），此处 re-export 保持既有导入兼容。
export type { DocumentCategory } from '../shared/types'

export interface CategoryModelConfig {
  category: DocumentCategory
  /** 能力标签（质量优先默认 strongest）；'balanced'/'cheap' 为预留档位，落地前按 strongest 解析 */
  capability: 'strongest' | 'balanced' | 'cheap'
  /** 手动档：指定模型名（仅当在当前渠道 models 内时生效，否则忽略落入 capability 默认） */
  preferredModel?: string
  /** 同 provider 降级链：首选不可用/失败时依次尝试（仅取渠道内 enabled 条目） */
  fallbackChain?: string[]
}

/** 质量优先默认：全类别 strongest、无手动档、无降级链（行为可预期）。测试可经 setCategoryConfigForTests 覆盖。 */
export const DEFAULT_CATEGORY_CONFIGS: Record<DocumentCategory, CategoryModelConfig> = {
  guide: { category: 'guide', capability: 'strongest' },
  prd: { category: 'prd', capability: 'strongest' },
  sketch: { category: 'sketch', capability: 'strongest' },
  mvp: { category: 'mvp', capability: 'strongest' },
  gwt: { category: 'gwt', capability: 'strongest' },
  judge: { category: 'judge', capability: 'strongest' },
  // 内审（2026-09-01 决议 4/7）：Attacker/Defender/复核轮专用审查腿。闪消级成本
  // 纪律（决议 7：审查用 flash 级，顶配留给 MVP loop/spec 生成）——模型档位由用户
  // 在 audit 渠道上自行配置快模型，路由层不强制。缺省解析与其它类别一致取渠道首选。
  audit: { category: 'audit', capability: 'strongest' },
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

  // ②capability 默认：strongest = 渠道列表序首个 enabled（balanced/cheap 预留同档）
  const primary = enabled[0]
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
