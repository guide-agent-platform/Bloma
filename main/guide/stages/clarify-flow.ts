/**
 * 澄清流（PR4a 拆出）：轮次计数与自动收敛、点选回流与方向累积、选项归一、纾困卡、澄清卡发布、自由聊计数。
 * 纯机械搬移（零行为变化）；对外契约经 guide-agent-service re-export 保持不变。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { AgentEvent, AgentMessage, AgentSendMessageInput, MessageContentBlock, Project, ProjectMode, ResearchIdea } from '../../../shared/types'
import { getAgentSessionPath } from '../../../storage/config-paths'
import { appendJsonLine } from '../../../storage/json-store'
import { appendSessionMessage } from '../../platform/sessions/session-tree'
import { routeDialogue, type ClarificationOption } from '../dialogue-router'
import { loadPromptOverride } from '../../agent/prompting/prompt-config'
import { parseDecisionText, recordDecision } from '../../project/decision-log'
import { syncDocuments } from '../../project/document-engine'
import { researchMarketSimilar, normalizeResearchQuery, type MarketResearch } from '../guide-research'
import {
  PRD_REVIEW_OPTION_OVERRIDE,
  PRD_REVIEW_OPTION_SUPPLEMENT,
  publishPrdReviewCard,
  resolvePrdReviewAnswers,
  resumePrdReviewOverride,
  runPrdReviewGate,
  takePendingPrdReview,
  type PrdReviewIssue,
} from '../../review/prd-review'
import {
  PRD_CONFIRM_OPTION_ADJUST,
  PRD_CONFIRM_OPTION_CONFIRM,
  consumePrdConfirmAdjust,
  consumePrdConfirmDismiss,
  publishPrdConfirmCard,
  resolvePrdConfirmCardAnswer,
  resumePrdConfirmConfirmed,
} from '../prd-confirm'
import { resolveChannelEnv } from '../../platform/llm/runtime-fallback'
import { resolveRoutedChannelId } from '../../platform/llm/category-routing'
import { getChannelByIdRaw } from '../../platform/llm/channel-manager'
import type { ConversationTurn, GuideModelOptions, SDKQuery } from '../../orchestration/orchestrator'
import { trackAnalytics } from '../../delivery/track-analytics'
import { runAgentLoop } from '../../agent/loop/agent-loop'
import { buildGuideTools, type GuideDecision } from '../guide-tools'
import {
  detectOrphanEnrichmentClarification,
  hasPendingEnrichmentClarification,
  isEnrichmentClarificationAnswer,
  recordEnrichmentClarificationAnswered,
  recordEnrichmentClarificationExhausted,
  recordEnrichmentClarificationTimeout,
  readLastEnrichmentClarificationRequests,
  shouldSuspendForEnrichmentClarification,
  suspendForEnrichmentClarification,
  takePendingEnrichmentClarification,
  type EnrichmentClarificationRequest,
} from '../clarification'
import { resolvePrdBackplane, setProgrammingEventPublisher, nextRequirementId, refineModificationDescription } from '../../coding/programming-orchestrator'
import { normalizeRequirementUpdate, applyNormalization, resolveRoutedRequirementId } from '../requirement-normalizer'
import { buildReferenceSection } from '../web-reference-extractor'
import { findProject, updateProject, readLastSketchRequirements, recordSketchGenerated } from '../../project/project-service'
import { refineTemplateType } from '../template-inference'
import { buildClarifyInjection } from '../../agent/prompting/template-injection'
import { captureConstraints, extractConstraints, readProjectConstraints } from '../constraint-extractor'
import { isAutoDelegationText, readPrimaryIntent } from '../../platform/sessions/session-service'
import { ingestResearchIdeasAsCandidates } from '../../experience/ref-ui-source'
import type { PrdBackplane, SketchRequirement } from '../../coding/sketch-engine'
import { isRecord } from '../../../shared/validators'

type GuideEventPublisher = (event: AgentEvent) => void

import { AUTO_ESCAPE_OPTION, BLOCKED_DECISION_IDS, CARD_ANSWER_REQUIREMENTS, CLARIFICATION_ROUND_LIMIT, FIXED_CARD_LABELS, GuideParsed, extractText } from './guide-runtime'
import { freeChatStreaks, makeGuideEvent } from './guide-pipeline'

/** 疑问句/身份类短句判据（窄匹配，宁漏勿误）：这类文本是对向导的提问，不是需求主题——
 *  不得进入需求清单（2026-09-16 线上案例：用户问「你是谁」，三轮点选后熔断，主题句
 *  兜底把它酿成 F-001「你是谁」功能项）。只拦短疑问句与「你/您+是/叫」类身份问句；
 *  正常主题（做/写/帮我…）不受影响。 */
export function isQuestionLikeTheme(text: string): boolean {
  const t = text.replace(/\s+/g, '').trim()
  if (!t || t.length > 16) return false
  if (/[？?]$/.test(t)) return true
  if (/^[你您](是|叫|会|能).{0,6}(谁|什么|名字)/.test(t)) return true
  if (/(吗|呢)[！!。.]*$/.test(t)) return true
  return false
}

/** 澄清终止类决策：出现即代表澄清已收敛（开工/迭代/裁判/回滚），连续计数在此截断。
 * 2026-08-27 点选回流修订：clarification_answer（用户点选了某个选项）不再视为终点——
 * 回流模式下用户答完当前问题，向导可能继续追问下一未知点（持续跟踪），澄清结束
 * 由向导的 confirm/generate 决定（二者走的链路都会落终止类决策）。 */
export const CLARIFICATION_ENDING_DECISION_TYPES = new Set<string>([
  'clarification_forced_auto',
  'clarification_forced_confirm',
  'requirement_confirm_card',
  'requirement_confirmed',
  'modification_gate',
  'modification_decision',
  'requirement_normalized',
  'judge_return',
  'circuit_rollback',
  'enrichment_stats',
])

/**
 * 连续澄清轮次计数（D3 修复）：从会话 JSONL 尾部往前数连续尾随的 [decision-card] 行，
 * 遇到澄清终止类决策行即断（新会话/无卡片从 0 起）。user/assistant 轮与 [terminal]、
 * category_route/constraint_captured 等每轮都写的会话级噪声行透明——它们不代表澄清
 * 结束；纯文本澄清（无卡片）不计——没有卡片就没有「用户点不点」的轮次语义。
 *
 * Phase 7 U4 J1（2026-09-10，BLOMA_CLARIFY_AUTO_RESPECT 缺省 off=原逻辑）：on 时
 * 排除用户选择 auto（「你帮我决定」）的轮次——倒序扫描中刚扫过的最近一条
 * clarification_answer 即当前卡片的回答；回答是 auto 让渡（detail.source=
 * card_auto/free_text_auto 或 option_id='auto'）则该轮不计：「有效授权非不明确」，
 * 委托不当糊涂数（E3 咨询 J1；实施稿 §0 定案：原计数与用户选择无关）。
 */
export function countTrailingClarificationRounds(sessionId: string): number {
  const path = getAgentSessionPath(sessionId)
  if (!existsSync(path)) return 0
  const lines = readFileSync(path, 'utf8').split('\n')
  const respectAuto = clarifyAutoRespectEnabled()
  let rounds = 0
  let pendingAnswerIsAuto = false
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let message: AgentMessage
    try {
      message = JSON.parse(line) as AgentMessage
    } catch {
      continue // 损坏行跳过，不误断计数
    }
    if (message.role !== 'system') continue
    const text = extractText(message.content ?? []).trim()
    if (text.startsWith('[decision-card]')) {
      if (respectAuto && pendingAnswerIsAuto) {
        // 用户对该卡的回答是让渡：这轮不是「仍不明确」，不计入熔断计数
        pendingAnswerIsAuto = false
        continue
      }
      pendingAnswerIsAuto = false
      rounds += 1
      if (rounds >= CLARIFICATION_ROUND_LIMIT) return rounds // 阈值已到，更早的无需再数
      continue
    }
    if (text.startsWith('[decision]')) {
      const entry = parseDecisionText(text)
      if (entry && CLARIFICATION_ENDING_DECISION_TYPES.has(entry.type)) return rounds
      if (respectAuto && entry?.type === 'clarification_answer') {
        const detail = entry.detail as { source?: unknown; option_id?: unknown } | undefined
        pendingAnswerIsAuto =
          detail?.source === 'card_auto' ||
          detail?.source === 'free_text_auto' ||
          detail?.option_id === 'auto'
      }
    }
  }
  return rounds
}

/** Phase 7 U4 J1 开关：BLOMA_CLARIFY_AUTO_RESPECT 缺省 off（计数原逻辑字节级）。 */
export function clarifyAutoRespectEnabled(): boolean {
  const raw = (process.env.BLOMA_CLARIFY_AUTO_RESPECT ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

/**
 * Phase 7 U5 J5：clarification_responded 埋点（回答方式 select|delegate|input|skip）。
 * 澄清疲劳漏斗中层数据（E3：低价值提问下降且「这不是我要的」不升的观测基础）；
 * 不记原文（脱敏，只记方式与当前澄清序列轮次）。
 */
export function trackClarificationResponded(
  input: AgentSendMessageInput,
  method: 'select' | 'delegate' | 'input' | 'skip',
): void {
  try {
    trackAnalytics({
      request_id: input.request_id,
      event: {
        event_type: 'clarification_responded',
        project_id: input.project_id,
        session_id: input.session_id,
        payload: {
          method,
          trailing_rounds: countTrailingClarificationRounds(input.session_id),
        },
        privacy_level: 'research_safe',
      },
    })
  } catch {
    // 埋点失败不影响澄清链
  }
}

// ---------------------------------------------------------------------------
// Phase 7 U4 J2（2026-09-10，E3 咨询 J2 / P7 实施稿 §5）：两层保护。
// ①同一问题最多换方式追问一次（同选项卡精确去重：序列内同选项集第 3 张不再注入，
//   宁可漏判不误拦——换措辞的不同题不算重复）；②第三张连续卡→对话内减负卡
//   替代强制弹窗（[先看方案][继续补充细节]，弹窗保留为最后兑底：已发过减负卡
//   再熔断→原弹窗）。开关 BLOMA_CLARIFY_TWO_LAYER 缺省 off=字节级现状。
//   注意：减负卡不落 [decision-card] 行（不计熔断轮次）、其 decision 类型不进
//   CLARIFICATION_ENDING_DECISION_TYPES（选「继续补充」后澄清序列不断）。
// ---------------------------------------------------------------------------

/** Phase 7 U4 J2 开关：BLOMA_CLARIFY_TWO_LAYER 缺省 off。 */
export function clarifyTwoLayerEnabled(): boolean {
  const raw = (process.env.BLOMA_CLARIFY_TWO_LAYER ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

/** 减负卡选项 id（回传经 send-message card_option 识别；不进通用卡答案分流）。 */
export const CLARIFY_RELIEF_OPTION_SEE_PLAN = 'clarify_relief_see_plan'
export const CLARIFY_RELIEF_OPTION_CONTINUE = 'clarify_relief_continue'

/** 当前澄清序列界定（与 countTrailingClarificationRounds 同口径）：终止类决策之后的区段。 */
export function clarificationSequenceLines(sessionId: string): string[] {
  const path = getAgentSessionPath(sessionId)
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').split('\n')
  let start = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseSystemLine(lines[i])
    if (parsed?.kind !== 'decision' || !parsed.entry) continue
    if (CLARIFICATION_ENDING_DECISION_TYPES.has(parsed.entry.type)) {
      start = i + 1
      break
    }
  }
  return lines.slice(start)
}

/** J2-②兑底判据：当前澄清序列内已发过减负卡（再熔断直接弹窗）。 */
export function hasRecentReliefCard(sessionId: string): boolean {
  return clarificationSequenceLines(sessionId).some((line) => {
    const parsed = parseSystemLine(line)
    return parsed?.kind === 'decision' && parsed.entry?.type === 'clarification_reduced_card'
  })
}

/** J2-①同主题判据（精确版，宁漏勿误）：序列内选项集与待发卡完全相同的 [decision-card] 张数。 */
export function countSameOptionCards(sessionId: string, labels: string[]): number {
  const key = [...labels].map((l) => l.trim()).sort().join('｜')
  if (!key) return 0
  return clarificationSequenceLines(sessionId).filter((line) => {
    try {
      const message = JSON.parse(line.trim()) as AgentMessage
      if (message.role !== 'system') return false
      const text = extractText(message.content ?? []).trim()
      if (!text.startsWith('[decision-card]')) return false
      const cardKey = text
        .replace(/^\[decision-card\]\s*/, '')
        .split('｜')
        .map((l) => l.trim())
        .sort()
        .join('｜')
      return cardKey === key
    } catch {
      return false
    }
  }).length
}

/** 发减负卡（J2-②）：对话内两选项替代强制弹窗；不落 [decision-card] 行防熔断计数膨胀。 */
export function publishClarificationReliefCard(
  input: AgentSendMessageInput,
  publish: GuideEventPublisher,
  reply: string,
): void {
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'clarification_reduced_card',
      title: '第三张连续卡转减负卡（先看方案/继续补充）',
      why: `连续追问达到上限，不再出选择题——给出方案出口（${reply.slice(0, 120)}）`,
      detail: { options: [CLARIFY_RELIEF_OPTION_SEE_PLAN, CLARIFY_RELIEF_OPTION_CONTINUE] },
    },
  })
  publish(makeGuideEvent(input, 'user_decision_required', {
    kind: 'clarification',
    title: '可以先给你一版方案',
    questions: [
      { id: CLARIFY_RELIEF_OPTION_SEE_PLAN, label: '先看方案', description: '按已了解的目标出 PRD 方案，其余按推荐补齐、确认时可修改' },
      { id: CLARIFY_RELIEF_OPTION_CONTINUE, label: '继续补充细节', description: '我还有想说的，继续聊' },
    ],
  }))
}

/** 减负卡回答识别（J2-②回流）。 */
export function resolveClarificationReliefAnswer(input: AgentSendMessageInput): 'see_plan' | 'continue' | undefined {
  if (input.metadata?.source !== 'card_option') return undefined
  const optionId = input.metadata.selected_option_id
  if (optionId === CLARIFY_RELIEF_OPTION_SEE_PLAN) return 'see_plan'
  if (optionId === CLARIFY_RELIEF_OPTION_CONTINUE) return 'continue'
  return undefined
}

/** 审查确认轮次熔断阈值（2026-08-30 用户拍板）：裁判连续出示 N 轮逐题选择题仍不过 → 不再追问，直接转 PRD 确认门过目。 */
export const PRD_REVIEW_ROUND_LIMIT = 2

/** 审查确认终止类决策：出现即代表审查确认环节结束（转确认门/进入确认门），连续计数在此截断。 */
export const PRD_REVIEW_ENDING_DECISION_TYPES = new Set<string>([
  'prd_review_overridden',
  'prd_confirm',
])

/**
 * 连续审查确认轮次计数（2026-08-30）：从会话 JSONL 尾部往前数连续的 prd_review 发卡决策，
 * 遇到审查确认终止类决策即断。prd_review_answered（用户作答）不计数也不断——作答后
 * 再次发卡是同一确认序列的下一轮。计数即「已出示给用户的逐题选择题卡数」。
 */
export function countTrailingPrdReviewRounds(sessionId: string): number {
  const path = getAgentSessionPath(sessionId)
  if (!existsSync(path)) return 0
  const lines = readFileSync(path, 'utf8').split('\n')
  let rounds = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let message: AgentMessage
    try {
      message = JSON.parse(line) as AgentMessage
    } catch {
      continue
    }
    if (message.role !== 'system') continue
    const text = extractText(message.content ?? []).trim()
    if (!text.startsWith('[decision]')) continue
    const entry = parseDecisionText(text)
    if (!entry) continue
    if (entry.type === 'prd_review') {
      rounds += 1
      if (rounds >= PRD_REVIEW_ROUND_LIMIT) return rounds
      continue
    }
    if (PRD_REVIEW_ENDING_DECISION_TYPES.has(entry.type)) return rounds
  }
  return rounds
}

/** 占位/问题式 label：模型把模板占位文案或新问题当成选项输出时，直接丢弃。 */
export function isBadOptionLabel(label: string): boolean {
  const trimmed = label.trim()
  if (trimmed.length < 2) return true
  if (/[?？]$/.test(trimmed)) return true
  return /^(范围)?选项\s*[一二三四五六七八九十0-9a-c]?$|^option\s*[a-c]?$/i.test(trimmed)
}

export const LABEL_MAX_LENGTH = 12
export const DESCRIPTION_MAX_LENGTH = 30
/** 模型方向项上限：加 auto 兜底后单轮最多 4 张卡（对齐 CardOptions 契约）。 */
export const MODEL_OPTION_MAX = 3

/**
 * 澄清选项纠偏：模型输出的 questions 一律不信任——占位/问句式 label 丢弃、
 * label 去重、超长截断；纠偏后非空必补「你帮我决定」兜底项；全军覆没则返回
 * 空数组（降级为 reply 纯文本追问），绝不把莫名其妙的光杆选项弹给用户。
 * 只处理用户可见文案的展示层截断，不触碰「代码型 JSON 不可修补」红线。
 */
export function normalizeClarificationOptions(raw: ClarificationOption[]): ClarificationOption[] {
  const seen = new Set<string>()
  const options: ClarificationOption[] = []
  for (const option of raw) {
    const label = option.label.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX_LENGTH)
    if (isBadOptionLabel(label) || seen.has(label)) continue
    seen.add(label)
    const description = option.description?.replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_MAX_LENGTH)
    options.push(description ? { id: option.id, label, description } : { id: option.id, label })
    if (options.length >= MODEL_OPTION_MAX) break
  }
  if (options.length === 0) return []
  const hasEscape = options.some(
    (option) => option.id === 'auto' || /帮你决定|你来定|你决定/.test(option.label),
  )
  return hasEscape ? options : [...options, AUTO_ESCAPE_OPTION]
}

export interface CardAnswerRoute {
  prompt: string
  requirements: SketchRequirement[]
}

/**
 * 会话 JSONL 系统行解析（[decision-card]/[decision] 前缀归类；供澄清序列扫描共用：
 * collectClarificationAnswers / clarificationSequenceLines / countSameOptionCards）。
 */
export function parseSystemLine(line: string): { kind: 'card' } | { kind: 'decision'; entry: ReturnType<typeof parseDecisionText> } | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  let message: AgentMessage
  try {
    message = JSON.parse(trimmed) as AgentMessage
  } catch {
    return undefined
  }
  if (message.role !== 'system') return undefined
  const text = extractText(message.content ?? []).trim()
  if (text.startsWith('[decision-card]')) return { kind: 'card' }
  if (!text.startsWith('[decision]')) return undefined
  return { kind: 'decision', entry: parseDecisionText(text) }
}

/** 收集当前澄清序列内用户已点选的全部方向（2026-08-29 点选累积修复引入）。
 * 从会话 JSONL 尾部扫描（终止语义与 countTrailingClarificationRounds 一致：遇澄清
 * 终止类决策即断，[decision-card] 行透明），合并各轮 clarification_answer 快照中的
 * 功能项描述并去重，按点选时间正序返回（主题句最早出现、天然排首位）。线上案例：
 * 三轮点选「电脑专业软件/创意实验/实时演奏」后熔断，确认弹窗只剩主题句一句，
 * 后续 PRD 正文（从对话历史提取）与确认清单不一致，审查误判「擅自加戏」。 */
export function collectClarificationAnswers(sessionId: string): string[] {
  const path = getAgentSessionPath(sessionId)
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').split('\n')
  // 第一遍：从尾往前定位当前澄清序列的起点（最近一个终止类决策行之后；无则从头）
  let start = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseSystemLine(lines[i])
    if (parsed?.kind !== 'decision' || !parsed.entry) continue
    if (CLARIFICATION_ENDING_DECISION_TYPES.has(parsed.entry.type)) {
      start = i + 1
      break
    }
  }
  // 第二遍：序列内正序收集（文件序即时间序，主题句在首轮快照中天然居首）
  const collected: string[] = []
  for (let i = start; i < lines.length; i++) {
    const parsed = parseSystemLine(lines[i])
    if (parsed?.kind !== 'decision' || parsed.entry?.type !== 'clarification_answer') continue
    const detail = parsed.entry.detail as { requirements?: Array<{ description?: unknown }> } | undefined
    if (!Array.isArray(detail?.requirements)) continue
    for (const item of detail.requirements) {
      const description =
        typeof item?.description === 'string' ? item.description.replace(/\s+/g, ' ').trim() : ''
      if (!description || collected.includes(description)) continue
      // 疑问句/身份类短句不是需求（「你是谁」案）：不进熔断兑底清单
      if (isQuestionLikeTheme(description)) continue
      collected.push(description)
    }
  }
  return collected
}

/**
 * 保证需求清单始终以"主题"为 F-001 锚点：澄清答案（如"网页端"）只是主题的属性，
 * 绝不能覆盖最初的主题（如"音乐合成器"）。清单已含主题时原样返回；否则把主题
 * 前置为 F-001，其余项顺延为 F-002/F-003…，避免"货不对板"。
 */
export function ensurePrimaryIntent(
  requirements: SketchRequirement[],
  primaryIntent: string | undefined,
): SketchRequirement[] {
  if (!primaryIntent) return requirements
  const normalized = primaryIntent.replace(/\s+/g, ' ').trim()
  if (!normalized) return requirements
  // 疑问句/身份类短句不能当主题锚点（「你是谁」案）：不前置为 F-001
  if (isQuestionLikeTheme(normalized)) return requirements
  const hasTheme = requirements.some((item) => {
    const description = item.description.replace(/\s+/g, ' ').trim()
    return description.includes(normalized) || normalized.includes(description)
  })
  if (hasTheme) return requirements
  const shifted = requirements.map((item, index) => ({
    ...item,
    id: `F-${String(index + 2).padStart(3, '0')}`,
  }))
  return [{ id: 'F-001', description: normalized }, ...shifted]
}

/** 卡片选项答案：metadata.source === 'card_option' 且非阻塞决策 id 时，视为已澄清，进入 PRD 后置链。 */
export function resolveCardAnswer(input: AgentSendMessageInput, primaryIntent?: string): CardAnswerRoute | undefined {
  if (input.metadata?.source !== 'card_option') return undefined
  const optionId = input.metadata.selected_option_id
  if (BLOCKED_DECISION_IDS.has(optionId ?? '')) return undefined
  // 让渡统一走 resolveAutoDelegation（点选/打字同一仪式：让渡留痕 + PRD 确认卡，
  // 排查报告 🔴2——不再用预置文案把让渡偷换成卡片答案开工）
  if (optionId === 'auto') return undefined
  const isFixedCard = FIXED_CARD_LABELS[optionId ?? ''] === input.content.trim()
  const description = isFixedCard ? CARD_ANSWER_REQUIREMENTS[optionId ?? ''] : input.content
  // 点选累积（2026-08-29 线上：每轮只带当轮答案导致 F-002 被覆盖，三轮点选只剩最后
  // 一个方向）：本轮答案并入当前澄清序列内已点选的全部方向，清单随轮次增长。
  const descriptions = [...collectClarificationAnswers(input.session_id), description]
    .filter((item, index, all) => all.indexOf(item) === index)
  return {
    prompt: input.content,
    requirements: ensurePrimaryIntent(
      descriptions.map((item, index) => ({ id: `F-${String(index + 1).padStart(3, '0')}`, description: item })),
      primaryIntent,
    ),
  }
}

/**
 * 自由文本让渡（D1 修复）：打字说「我还没想法/随便/你帮我决定」与点选 auto 卡片语义
 * 相同，但不带 card_option 元数据——不识别就会落回模型路径被原样重问（2026-08-22
 * 线上案例）。确定性判定（零模型依赖），出口完全复用卡片 auto 路径；让渡话术由
 * session-service 单点维护（readPrimaryIntent 的锚点豁免共用同一张表）。
 */
export function resolveAutoDelegation(input: AgentSendMessageInput, primaryIntent?: string): CardAnswerRoute | undefined {
  if (!isAutoDelegationText(input.content)) return undefined
  return {
    prompt: input.content,
    requirements: ensurePrimaryIntent(
      [{ id: 'F-001', description: CARD_ANSWER_REQUIREMENTS.auto }],
      primaryIntent,
    ),
  }
}

export function freeChatStreakOf(sessionId: string): number {
  return freeChatStreaks.get(sessionId) ?? 0
}

export function bumpFreeChatStreak(sessionId: string): void {
  freeChatStreaks.set(sessionId, freeChatStreakOf(sessionId) + 1)
}

export function resetFreeChatStreak(sessionId: string): void {
  freeChatStreaks.delete(sessionId)
}

/** GuideDecision（工具入参）→ GuideParsed（既有路由块输入）的轻量归一。 */
export function normalizeGuideDecisionToParsed(decision: GuideDecision): GuideParsed {
  if (decision.action === 'ask_clarification') {
    return { action: 'ask_clarification', reply: String(decision.reply ?? ''), questions: Array.isArray(decision.questions) ? decision.questions : [] }
  }
  if (decision.action === 'confirm_requirements') {
    return {
      action: 'confirm_requirements',
      reply: String(decision.reply ?? ''),
      requirements: Array.isArray(decision.requirements) ? decision.requirements : [],
      research_queries: Array.isArray(decision.research_queries) ? decision.research_queries : [],
    }
  }
  return { action: 'generate_sketch', reply: String(decision.reply ?? ''), requirements: Array.isArray(decision.requirements) ? decision.requirements : [] }
}

export type GuideLoopOutcome =
  | { kind: 'decision'; decision: GuideParsed }
  | { kind: 'free_chat'; text: string }
  | { kind: 'failed' }

/**
 * 发布澄清决策卡片并落盘选项原文（[decision-card] 内部标记）+ 决策日志（T2）。
 * questions 为空表示纯文本澄清，不弹卡片；有选项时务必落盘——
 * user_decision_required 事件只存在渲染端内存，不落盘则事后无法追溯
 * 到底给用户弹过哪些选项（历史会话只能看到 reply 问句）。
 */
export function publishClarificationCard(
  input: AgentSendMessageInput,
  publish: GuideEventPublisher,
  questions: ClarificationOption[],
  persistSystem?: (text: string) => void,
  question?: string,
): void {
  if (questions.length > 0) {
    persistSystem?.(`[decision-card] ${questions.map((option) => option.label).join('｜')}`)
  }
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'clarification_card',
      title: '澄清提问',
      why: question ? `向用户提问：「${question}」` : '向用户追问澄清（纯文本，无选项卡片）',
      detail: { options: questions.map((option) => option.label) },
    },
  })
  publish(makeGuideEvent(input, 'user_decision_required', {
    kind: 'clarification',
    title: '先确认方向',
    // 0 条表示纯文本澄清，B 侧不弹卡片
    questions,
  }))
}

// =========================================================================
// 需求确认弹窗（confirm_requirements，2026-08-26）
// =========================================================================

/** 弹窗待决状态（per project）：模型整理的需求清单 + 市调结果 + 续跑所需的模型上下文。 */
export interface PendingRequirementConfirm {
  request_id: string
  session_id: string
  project_id: string
  mode: AgentSendMessageInput['mode']
  channel_id?: string
  requirements: SketchRequirement[]
  research: MarketResearch
  /** 市调提炼想法（2026-08-29 灵感参考）：勾选采纳后并入需求清单 */
  ideas: ResearchIdea[]
  query: SDKQuery
  /** PRD 审查门（简化版 AC）复用：向导轮模型 env，prd 类别路由解析失败时的回退 */
  env: Record<string, string>
  publish: GuideEventPublisher
}

export const pendingRequirementConfirms = new Map<string, PendingRequirementConfirm>()

