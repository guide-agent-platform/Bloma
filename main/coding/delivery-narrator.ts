/**
 * delivery-narrator — 最终交付文本改写（2026-09-11 交付话术改造）。
 *
 * 背景：MVP 生成完成后，用户在聊天里读到的"完成总结"是 agent loop 的最后一条
 * 自由文本（finalText）——受收口指令与【表达纪律】的旁白语境影响，天然是第一人称
 * 过程复盘腔（"我做了什么/哪些断言没过"），不是面向用户的最终交代。
 *
 * 本件在终验（judge）通过后、就绪卡弹出前，把**平台已算好的结构化事实**（功能项、
 * 测试/安全结果、裁判结论、遗留项）+ loop 过程文本（仅作素材）交向导渠道改写为
 * 一段通俗、用户视角的交付交代，经 delivery_message 事件发布。
 *
 * 纪律（对齐 delivery-status「全局交付状态由规则计算，Agent 只翻译人话」）：
 * - 事实唯一事实源来自平台结构化数据，改写只许换说法不许增删事实；
 * - LLM 失败/超时/退行 → 回退 READY_COMPLETION_COPY 固定话术，绝不阻断交付链；
 * - 走向导（guide）渠道族——交付话术是向导的职责域，不占用生成/判定渠道。
 */

import type { SDKQuery } from '../orchestrator'
import { callLlmForJson } from '../kernel/llm-call'
import { resolveChannelEnv } from '../runtime-fallback'
import { isDegenerateText } from './output-integrity'

/** 改写输入的事实包（全部由调用方从平台结构化数据组装，本模块不做事实发现）。 */
export interface DeliveryNarrationFacts {
  /** 产品名（背板 name） */
  productName: string
  /** 产品定位一句话（背板 positioning；可缺省） */
  positioning?: string
  /** 功能项白话清单（背板 requirements 的描述/故事，按优先级排序） */
  features: string[]
  /** 行为验证摘要（如「10 项行为验证全部通过」；无测试报告可缺省） */
  testSummary?: string
  /** 安全扫描摘要（可缺省） */
  securitySummary?: string
  /** 遗留/提示（裁判 suggest 结论、未验证项等；如实透传） */
  leftoverNotes: string[]
  /** agent loop 过程收尾文本（复盘腔素材；仅参考其提到的实际效果，禁止照抄口吻） */
  processText?: string
}

export interface DeliveryNarrationResult {
  /** 最终交付文本（改写成功）或空串（失败，由调用方走兜底话术） */
  text: string
  /** true = 走了兜底（LLM 不可用/失败），调用方据此决定是否附固定话术 */
  fallback: boolean
}

/** 交付改写系统提示词：把事实翻译成人话的硬纪律。 */
const DELIVERY_NARRATOR_SYSTEM = [
  '你是 Bloma 的交付向导。任务：把平台给你的结构化事实改写成一段面向用户（非技术者）的最终交付文本——这是产品交到用户手里那一刻的正式交代。',
  '',
  '【写作纪律】',
  '- 视角是「向用户交代」，不是工作汇报：禁止过程复盘，禁止「我做了什么 / 先做了A再做B / 第几轮 / 修复了几次」这类叙述。',
  '- 内容顺序：①这个产品现在能做什么（用白话描述能力，不讲实现细节）②怎么用（打开右侧预览试什么）③验证情况（行为验证/安全检查结果人话化）④遗留问题（如有，如实但不必吓人）⑤一句下一步建议。',
  '- 语言：中文、通俗、像产品经理对客户说话；禁止出现这些词：断言、探针、GWT、背板、骨架、PRD、P0/P1/P2、agent、loop、轮次、快照。功能名尽量用用户自己的原话。',
  '- 长度 150–300 字，2–4 个自然段；不要 markdown 标题、列表符号和 emoji。',
  '- 只输出交付文本本身：不要前后缀、不要解释你的改写思路、不要向用户提问。',
  '- 只能使用事实包里的信息，不得编造或推断任何未给出的功能、数字或承诺。',
].join('\n')

/** 改写质量下限：短于该值视为无效输出（走兜底）。 */
export const MIN_DELIVERY_TEXT_LENGTH = 40

/** 术语质检集：提示词硬禁的机器词，出现在交付文本里即判违规。 */
export const DELIVERY_JARGON =
  /(断言|探针|GWT|背板|骨架|PRD|P0|P1|P2|P3|agent\s*loop|轮次|快照|修复轮|行为验证脚本)/i

/** 过程复盘句式（明确信号，非宽泛第一人称）：如「我先实现…然后运行…」。 */
export const RECAP_PATTERN = /我(先|然后|接着|随后)[^。；\n]{0,30}(实现|修改|修复|运行|执行|检查|重试|加了|写|改)/

/** 交付文本质检（导出供单测；parse 内部同源）。违规返回 false。 */
export function isAcceptableDeliveryText(raw: string): boolean {
  const t = raw.trim()
  if (t.length < MIN_DELIVERY_TEXT_LENGTH || t.length > 2000) return false
  if (isDegenerateText(t)) return false
  if (DELIVERY_JARGON.test(t)) return false
  if (RECAP_PATTERN.test(t)) return false
  return true
}

/**
 * 组装并调用向导渠道改写最终交付文本。
 * 任何失败（渠道缺失/LLM 失败/超时/退行）返回 { text: '', fallback: true }，不抛错。
 */
export async function composeDeliveryMessage(input: {
  request_id: string
  session_id: string
  project_id: string
  channel_id?: string
  query?: SDKQuery
  signal?: AbortSignal
  facts: DeliveryNarrationFacts
}): Promise<DeliveryNarrationResult> {
  // 无 query 通道或向导渠道不可用 → 直接兜底（不重试不烧预算）
  if (!input.query) return { text: '', fallback: true }
  let env: Record<string, string> | undefined
  let providerType: string | undefined
  try {
    const resolution = resolveChannelEnv({
      channelId: input.channel_id,
      category: 'guide',
      projectId: input.project_id,
      sessionId: input.session_id,
      fallbackScope: 'routed-only',
    })
    env = resolution.env ?? undefined
    // providerType 透传（陷阱·omit 渠道互斥）：omit 类渠道（Token Plan 等）连
    // thinking:disabled 都 400，不传 providerType 会让 buildThinkingFragment 跳过 omit
    // 分支 → 两次尝试全 400 → 静默兜底（改写永远不生效）
    providerType = resolution.channel?.provider_type
  } catch {
    return { text: '', fallback: true }
  }
  if (!env) return { text: '', fallback: true }

  const facts = input.facts
  const factLines = [
    `产品名：${facts.productName}`,
    ...(facts.positioning ? [`产品定位：${facts.positioning}`] : []),
    '功能清单：',
    ...facts.features.map((f) => `- ${f}`),
    ...(facts.testSummary ? [`行为验证：${facts.testSummary}`] : []),
    ...(facts.securitySummary ? [`安全检查：${facts.securitySummary}`] : []),
    ...(facts.leftoverNotes.length ? ['遗留/提示：', ...facts.leftoverNotes.map((n) => `- ${n}`)] : []),
    ...(facts.processText ? [`生成过程笔记（素材参考，禁止照抄其口吻）：${facts.processText.slice(0, 800)}`] : []),
  ].join('\n')

  const text = await callLlmForJson<string>({
    systemPrompt: DELIVERY_NARRATOR_SYSTEM,
    prompt: `请把以下事实改写为最终交付文本：\n\n${factLines}`,
    query: input.query,
    env,
    sessionId: input.session_id,
    maxTokens: 2048,
    temperature: 0.4,
    attempts: 2,
    ...(providerType ? { providerType } : {}),
    signal: input.signal,
    // 交付话术不值得久等：judge 已过、用户在等就绪卡；单次 10s × 2 尝试 = 最坏 20s
    //（2026-09-11 审计 P2-2：原 30s × 2 = 最坏 60s 把就绪卡推得过久）
    timeoutMs: 10_000,
    parse: (raw) => (isAcceptableDeliveryText(raw) ? raw.trim() : undefined),
  })
  if (!text) return { text: '', fallback: true }
  return { text, fallback: false }
}
