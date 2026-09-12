/**
 * 表达适配层（Phase 3 B5 MVP，2026-09-09，P1 稿 §3 M5 / 咨询 B 缺口 7/8）。
 *
 * 三层 prompt 架构成文（构件映射，代码即结构）：
 * - 契约层（必须共享、不可降级、渠道间字节不变）：rules-registry（R-* 四段式）+
 *   renderCapSection（能力契约）+ renderBackplaneAnchor（背板锚定/完成标准）+
 *   renderRoundAnchorBlock（本轮锚）——均为独立构件，任何渠道/模型消费同一份。
 * - 角色层（同角色共享）：向导/编程/裁判各角色的流程性 prompt 主体。
 * - 表达适配层（本模块，按模型微调）：只改理解成本，不改验收口径——
 *   不许把「必须读取」改成「建议读取」、不许把核心能力改可选（微调纪律成文）。
 *
 * 开关 BLOMA_EXPRESSION_LAYER：off（缺省）=字节级现状；'thinking'=思考型模型适配段
 * 注入 loop system prompt 尾部。自动探测钩子 detectExpressionLayer 预留给渠道配置
 * （思考型渠道标记），v1 以显式 env 为准。
 */

export type ExpressionLayer = 'standard' | 'thinking'

/** 表达层选择：BLOMA_EXPRESSION_LAYER 显式指定（thinking/standard）；缺省 off=不注入。 */
export function expressionLayerEnabled(): ExpressionLayer | null {
  const raw = (process.env.BLOMA_EXPRESSION_LAYER ?? '').trim().toLowerCase()
  if (raw === 'thinking') return 'thinking'
  if (raw === 'standard') return 'standard'
  return null
}

/**
 * 思考型模型表达适配段（P1 稿 M5 原文落地）：不写「穷尽/深入思考/反复验证」；
 * 写「明确即执行、终轮必出摘要」——配合既有 thinking 参数与 maxTokens 640000 修复
 * （09-05 4b77be6：思考型渠道把 token 烧在思考上导致零正文）。
 */
export const THINKING_EXPRESSION_SECTION = [
  '【表达适配（思考型模型）】',
  '- 对已明确且满足前置条件的操作直接执行，不在正文重复推演；推理放思考通道。',
  '- 不输出内部推理过程；旁白只说意图与结论（每轮一句，关键决策一至两句）。',
  '- 阻塞及时报告：无法推进时明确说阻塞点与需要的输入，不用长篇分析代替行动。',
  '- 终轮即使未完成也输出规定的结果摘要（做了什么/未通过什么/遗留什么），绝不以空正文或纯思考收尾。',
  '- 不追求「穷尽思考/反复验证」——满足终止条件即收口，把预算留给实现与验证本身。',
].join('\n')

/**
 * 渲染表达适配段（append 到角色层 prompt 尾部；off/standard 返回空串=字节级现状）。
 * 微调纪律硬约束：本函数只输出表达适配文本，永不触碰契约层构件的任何字节。
 */
export function renderExpressionSection(layer: ExpressionLayer | null = expressionLayerEnabled()): string {
  return layer === 'thinking' ? THINKING_EXPRESSION_SECTION : ''
}
