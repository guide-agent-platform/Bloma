import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { AgentEvent, AgentMessage, AgentSendMessageInput, MessageContentBlock, Project, ProjectMode, ResearchIdea } from '../../shared/types'
import { getAgentSessionPath } from '../../storage/config-paths'
import { appendJsonLine } from '../../storage/json-store'
import { routeDialogue, type ClarificationOption } from '../dialogue-router'
import { loadPromptOverride } from '../prompt-config'
import { parseDecisionText, recordDecision } from '../decision-log'
import { syncDocuments } from '../document-engine'
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
} from '../prd-review'
import {
  PRD_CONFIRM_OPTION_ADJUST,
  PRD_CONFIRM_OPTION_CONFIRM,
  consumePrdConfirmAdjust,
  consumePrdConfirmDismiss,
  publishPrdConfirmCard,
  resolvePrdConfirmCardAnswer,
  resumePrdConfirmConfirmed,
} from '../prd-confirm'
import { resolveChannelEnv } from '../runtime-fallback'
import { resolveRoutedChannelId } from '../category-routing'
import { getChannelByIdRaw } from '../channel-manager'
import type { ConversationTurn, GuideModelOptions, SDKQuery } from '../orchestrator'
import { trackAnalytics } from '../platform-services'
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
} from './clarification'
import { resolvePrdBackplane, runSketchTask, setProgrammingEventPublisher, nextRequirementId, refineModificationDescription } from '../programming-orchestrator'
import { normalizeRequirementUpdate, applyNormalization } from '../requirement-normalizer'
import { buildReferenceSection } from '../web-reference-extractor'
import { findProject, updateProject, readLastSketchRequirements, recordSketchGenerated } from '../project-service'
import { refineTemplateType } from '../template-inference'
import { buildClarifyInjection } from '../template-injection'
import { captureConstraints, extractConstraints, readProjectConstraints } from '../constraint-extractor'
import { isAutoDelegationText, readPrimaryIntent } from '../session-service'
import { ingestResearchIdeasAsCandidates } from '../experience/ref-ui-source'
import type { PrdBackplane, SketchRequirement } from '../sketch-engine'
import { isRecord } from '../validators'

type GuideEventPublisher = (event: AgentEvent) => void

/** 引导对话给模型的结构化指令：模型只输出 JSON 二选一（对齐 A2-14a Step 3 模板）。 */
export const DEFAULT_GUIDE_SYSTEM_PROMPT = `你是「向导 Agent」，一位经验丰富的产品向导，负责把用户的想法变成可以开工的软件需求。只输出一个 JSON 对象，不要任何多余文字，不要 markdown 代码块围栏。

你的提问策略完全由你根据这个需求的实际情况自主决定——像一个真正的产品经理拿到这个需求时自然会问的问题：它可能关于形态、场景、数据，或任何这个需求特有的疑点。没有任何预设清单或固定流程：需求说得够具体就少问甚至不问、直接整理确认；说得笼统就问到你能写出具体可验收的 PRD 为止。

判断标准只有一条：**你能否写出一份「主流程闭环」的可验收功能清单**——拿它做出来的东西，用户能完整走一遍「打开产品 → 输入/发起 → 拿到核心结果 → 查看 → 管理/留存」。清单不闭环就还不能收敛：能自己补的（查看/管理/留存这类闭环路径）直接补成 origin=guide 功能项，只有影响成品形态的缺口才需要问（ask_clarification）。问的质量标准：用户看完你的问题会想起自己没说出口的想法，而不是感觉在填表。

硬性底线（不可违反）：
- 用户表达不想答/没想法/让你定（「你定」「随便」「就这样吧」）→ 按合理理解收敛，不把问题抛回。
- 历史里已答过的信息不重复问；「上轮已向用户出示的选项」不得原样再出。
- 拿不准就问，但问必有目的（每个问题都指向一个影响成品形态的未知点）。

三选一输出（这是通信格式，不限制内容决策）：

【需求基本成型 → 交用户确认（平台会弹确认窗并附市调）】
{"action":"confirm_requirements",
 "reply":"给用户的说明（简体中文 ≤200 字）：若清单里有你在用户原话之外补充的条目，必须在这里明说补了什么、为什么；也可以加一句你自己的产品判断",
 "requirements":[{"id":"F-001","description":"核心功能点（动词开头，用户原话提炼，≤40 字）","origin":"user"}],
 "research_queries":["市调查询，如「记账 应用 推荐」","可选第二条"]}

【需求足够清晰且用户明确催开工 → 直接生成草图】
{"action":"generate_sketch",
 "reply":"给用户的确认话术（简体中文 ≤200 字，口语化）",
 "requirements":[{"id":"F-001","description":"核心功能点（动词开头，≤40 字）","origin":"user"}]}

【需要澄清 → 问一个你最想问的问题，并给出可点选的具体答案】
{"action":"ask_clarification",
 "reply":"一两句话、以问句收尾（≤80 字：可先用半句呼应用户刚说的，再问出你最想问的；措辞贴合已聊到的上下文，像真人接着聊）",
 "questions":[
   {"id":"answer-a","label":"这个问题的一个具体答案（名词短语 ≤12 字）","description":"选它之后会做成什么样（≤20 字）"},
   {"id":"answer-b","label":"另一个互斥的具体答案","description":"……"},
   {"id":"auto","label":"你帮我决定","description":"交给我，按常见做法先出一版"}
 ]}

格式细则：
- questions 是 reply 末尾问句的候选答案，不是新问题；选项互斥、贴合用户原话、具体到能想象成品（「悬浮球随时呼出」是好选项；「工具类」「好用」是坏选项）。
- questions 2~4 条，最后一条固定为 {"id":"auto","label":"你帮我决定","description":"交给我，按常见做法先出一版"}；确实无法给出具体选项时才 questions:[]（在 reply 里纯文本追问）。
- requirements 3~5 条（用户明确只要单一微工具时可更少）：以「一次完整使用」的主线组织——核心处理、结果查看、必要的管理（编辑/删除/分类）、留存；AI/自动化类产品必须有一条把「智能部分」的输入 → 输出 → 失败形态说清楚的功能项。id 用小写字母+连字符（如 daily-tool）。
- requirements 每条标 origin："user"=直接来自用户原话/点选；"guide"=你自主补充/具体化的。补充不是越少越好——把需求真正闭环所需的功能（如查看/管理/筛选路径）补齐是你的职责，但每条补充都要经得起「为什么需要它」的追问。
- 用户说的约束（「不含登录」「必须离线可用」这类必须/不要类要求）不要写成 requirements 功能项——平台会单独持久化并注入。
- research_queries 是市调检索词：要具体到产品形态+功能名词（如「记账 App 收入支出」「家庭记账 月度报表」），能直接搜到真实产品；不要口语、不要泛指词（“做一个”“类似的”“推荐”），最多 2 条。
- 只输出 JSON，其余一律不要。`

type GuideParsed =
  | { action: 'generate_sketch'; reply: string; requirements: GuideRequirementItem[] }
  | { action: 'ask_clarification'; reply: string; questions: { id: string; label: string; description?: string }[] }
  | { action: 'confirm_requirements'; reply: string; requirements: GuideRequirementItem[]; research_queries: string[] }

/** 向导输出的功能项：origin 标提出者（user/guide），需求确认弹窗据此标「向导补充」 */
interface GuideRequirementItem {
  id: string
  description: string
  origin?: 'user' | 'guide'
}

/**
 * 首轮硬护栏（附加到系统提示尾部）：需求确认是产品闭环的必经一环，不能因模型采样差异被跳过
 * （2026-08-16 赛车模拟器案例：同样输入一天前澄清、一天后直出草图，用户全程零确认）。
 */
const FIRST_TURN_RULE = `

本轮提示：这是用户在本次会话的第一条消息。绝大多数一句话想法都还不足以直接开工——若你对需求的理解还写不出具体可验收的功能清单，必须先输出 ask_clarification（问最影响成品形态的那个未知点）；只有用户首条消息已经足够具体时才可输出 confirm_requirements。无论哪种，都不允许跳过确认直接开工——平台有 PRD 确认门兜底。`

/**
 * 规则路由三张固定卡片（日常生活/工作提效/你帮我决定）→ 草图需求扩写。
 * 卡片答案是结构化决策：用户已选方向，直接生成草图（修复规则路由澄清死循环）。
 * 仅在点选文案与 FIXED_CARD_LABELS 完全一致时启用；其余一律以点选原文为需求。
 */
const CARD_ANSWER_REQUIREMENTS: Record<string, string> = {
  daily: '日常生活工具：帮助管理日常事务，如记账、提醒、清单',
  work: '工作提效工具：帮助提升工作场景效率，如流程、协作、记录',
  auto: '通用实用软件工具，由向导按常见做法生成第一版',
}

/**
 * 规则路由三张固定卡片的 label → 选项 id。只有点选文案与固定卡片完全一致时才用
 * 预置需求扩写；模型卡片可能复用同名 id（如 daily）但含义不同，一律以点选原文
 * 为准，防止 id 撞车把需求映射到毫不相干的预置文案上。
 */
const FIXED_CARD_LABELS: Record<string, string> = {
  daily: '日常生活工具',
  work: '工作提效工具',
  auto: '你帮我决定',
}

/** 阻塞态让渡卡片的决策 id（accept/explain/continue）由 resumeBlockedFlow 处理，不得误入草图生成。 */
const BLOCKED_DECISION_IDS = new Set([
  'accept',
  'explain',
  'continue',
  PRD_REVIEW_OPTION_OVERRIDE,
  PRD_REVIEW_OPTION_SUPPLEMENT,
  PRD_CONFIRM_OPTION_CONFIRM,
  PRD_CONFIRM_OPTION_ADJUST,
])

/** 兜底选项：每张澄清卡片固定收尾，保证用户永远有「不选具体方向也能开工」的出口。 */
const AUTO_ESCAPE_OPTION: ClarificationOption = {
  id: 'auto',
  label: '你帮我决定',
  description: '交给我，按常见做法先出一版',
}

/** 澄清轮次熔断阈值：连续出示 N 张澄清卡仍不明确 → 代码级转入需求确认弹窗（D3 修订 2026-08-26；原「强制 auto 开工」语义已被弹窗化取代）。 */
const CLARIFICATION_ROUND_LIMIT = 3

/** 澄清终止类决策：出现即代表澄清已收敛（开工/迭代/裁判/回滚），连续计数在此截断。
 * 2026-08-27 点选回流修订：clarification_answer（用户点选了某个选项）不再视为终点——
 * 回流模式下用户答完当前问题，向导可能继续追问下一未知点（持续跟踪），澄清结束
 * 由向导的 confirm/generate 决定（二者走的链路都会落终止类决策）。 */
const CLARIFICATION_ENDING_DECISION_TYPES = new Set<string>([
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
 */
export function countTrailingClarificationRounds(sessionId: string): number {
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
      continue // 损坏行跳过，不误断计数
    }
    if (message.role !== 'system') continue
    const text = extractText(message.content ?? []).trim()
    if (text.startsWith('[decision-card]')) {
      rounds += 1
      if (rounds >= CLARIFICATION_ROUND_LIMIT) return rounds // 阈值已到，更早的无需再数
      continue
    }
    if (text.startsWith('[decision]')) {
      const entry = parseDecisionText(text)
      if (entry && CLARIFICATION_ENDING_DECISION_TYPES.has(entry.type)) return rounds
    }
  }
  return rounds
}

/** 审查确认轮次熔断阈值（2026-08-30 用户拍板）：裁判连续出示 N 轮逐题选择题仍不过 → 不再追问，直接转 PRD 确认门过目。 */
const PRD_REVIEW_ROUND_LIMIT = 2

/** 审查确认终止类决策：出现即代表审查确认环节结束（转确认门/进入确认门），连续计数在此截断。 */
const PRD_REVIEW_ENDING_DECISION_TYPES = new Set<string>([
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
function isBadOptionLabel(label: string): boolean {
  const trimmed = label.trim()
  if (trimmed.length < 2) return true
  if (/[?？]$/.test(trimmed)) return true
  return /^(范围)?选项\s*[一二三四五六七八九十0-9a-c]?$|^option\s*[a-c]?$/i.test(trimmed)
}

const LABEL_MAX_LENGTH = 12
const DESCRIPTION_MAX_LENGTH = 30
/** 模型方向项上限：加 auto 兜底后单轮最多 4 张卡（对齐 CardOptions 契约）。 */
const MODEL_OPTION_MAX = 3

/**
 * 澄清选项纠偏：模型输出的 questions 一律不信任——占位/问句式 label 丢弃、
 * label 去重、超长截断；纠偏后非空必补「你帮我决定」兜底项；全军覆没则返回
 * 空数组（降级为 reply 纯文本追问），绝不把莫名其妙的光杆选项弹给用户。
 * 只处理用户可见文案的展示层截断，不触碰「代码型 JSON 不可修补」红线。
 */
function normalizeClarificationOptions(raw: ClarificationOption[]): ClarificationOption[] {
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

interface CardAnswerRoute {
  prompt: string
  requirements: SketchRequirement[]
}

/** 收集当前澄清序列内用户已点选的全部方向（2026-08-29 点选累积修复引入）。
 * 从会话 JSONL 尾部扫描（终止语义与 countTrailingClarificationRounds 一致：遇澄清
 * 终止类决策即断，[decision-card] 行透明），合并各轮 clarification_answer 快照中的
 * 功能项描述并去重，按点选时间正序返回（主题句最早出现、天然排首位）。线上案例：
 * 三轮点选「电脑专业软件/创意实验/实时演奏」后熔断，确认弹窗只剩主题句一句，
 * 后续 PRD 正文（从对话历史提取）与确认清单不一致，审查误判「擅自加戏」。 */
function collectClarificationAnswers(sessionId: string): string[] {
  const path = getAgentSessionPath(sessionId)
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').split('\n')
  const parseSystemLine = (line: string): { kind: 'card' } | { kind: 'decision'; entry: ReturnType<typeof parseDecisionText> } | undefined => {
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
function ensurePrimaryIntent(
  requirements: SketchRequirement[],
  primaryIntent: string | undefined,
): SketchRequirement[] {
  if (!primaryIntent) return requirements
  const normalized = primaryIntent.replace(/\s+/g, ' ').trim()
  if (!normalized) return requirements
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
function resolveCardAnswer(input: AgentSendMessageInput, primaryIntent?: string): CardAnswerRoute | undefined {
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
function resolveAutoDelegation(input: AgentSendMessageInput, primaryIntent?: string): CardAnswerRoute | undefined {
  if (!isAutoDelegationText(input.content)) return undefined
  return {
    prompt: input.content,
    requirements: ensurePrimaryIntent(
      [{ id: 'F-001', description: CARD_ANSWER_REQUIREMENTS.auto }],
      primaryIntent,
    ),
  }
}

export async function handleGuideMessage(
  input: AgentSendMessageInput,
  publish: GuideEventPublisher,
  model?: GuideModelOptions,
  /** 规则路由下也把助手回复写入会话 JSONL，保证回访恢复与实时 UI 一致 */
  persistAssistant?: (text: string) => void,
  /** 内部标记落盘（system role，回访恢复不展示）：决策卡片弹出时记录选项原文，供事后追溯 */
  persistSystem?: (text: string) => void,
): Promise<void> {
  const project = findProject(input.project_id)
  // 注入点①澄清轮修正（对用户透明，PRD 12.2）：后续话语带显式形态信号（网页/桌面）时
  // 更新类型推断；weak 信号不动已有判断。失败静默——推断是增强不是依赖，不阻断澄清链。
  try {
    const refined = refineTemplateType(project.template_type, input.content)
    if (refined) {
      updateProject(input.project_id, { template_type: refined })
      recordDecision({
        project_id: input.project_id,
        session_id: input.session_id,
        entry: {
          type: 'template_type_refined',
          title: '项目类型推断修正',
          why: '用户后续话语携带显式载体形态信号，自动修正模板类型推断（对用户透明）',
          detail: { from: project.template_type, to: refined, signal: input.content.slice(0, 80) },
        },
      })
    }
  } catch {
    // 推断修正失败不影响澄清链
  }
  setProgrammingEventPublisher(publish)
  trackAnalytics({
    request_id: input.request_id,
    event: {
      event_type: 'conversation_submitted',
      project_id: input.project_id,
      session_id: input.session_id,
      payload: {
        mode: input.mode,
        source: input.metadata?.source ?? 'chat',
        selected_option_id: input.metadata?.selected_option_id,
      },
      privacy_level: 'research_safe',
    },
  })

  // 主题锚点：首条用户消息（用户最初想做什么），澄清答案只能追加、不能覆盖主题
  const primaryIntent = readPrimaryIntent(input.session_id)

  // PRD 审查逐题选择题回传（2026-08-30 选择题化，必须在普通卡片答案分流之前：
  // 审查卡选项 id 专属，误入 resolveCardAnswer 会把按钮文案当需求开工）。
  // delegate_all → 全部交给向导决定，转 PRD 确认门（不过目不开工）；answers →
  // 逐题答案：全「这条没问题」= 等价忽略转确认门，否则收集点选方向归一化修订重走管线。
  const prdReviewAnswers = resolvePrdReviewAnswers(input)
  if (prdReviewAnswers?.kind === 'delegate_all') {
    await resumePrdReviewOverride(input, {
      logTitle: '用户全部交给向导决定，转入 PRD 过目',
      logWhy: '用户在审查逐题卡选择「全部交给向导决定」；交由向导修订不等于确认过 PRD，转入确认门过目后开工',
      reviewNote: '已交由向导决定审查问题',
    })
    return
  }
  if (prdReviewAnswers?.kind === 'answers') {
    const substantive = prdReviewAnswers.answers.filter((answer) => !answer.ignored)
    if (substantive.length === 0) {
      // 全部选了「这条没问题」→ 等价忽略，转 PRD 确认门
      await resumePrdReviewOverride(input)
      return
    }
    const pending = takePendingPrdReview(input.project_id)
    if (!pending) return
    const combined = substantive
      .map((answer) => answer.label || answer.option_id)
      .filter(Boolean)
      .join('；')
    // 定向修订指令（A6，2026-09-03）：issue 定位随答案进 normalizer，revise 目标不再靠猜。
    // 线上案例（058c86a3）：答案 label「前一天内容，早9点推送」被拼接后 append 成 F-006/F-007
    // 新功能项而非 revise F-003，冲突源永不消除。qN 按 buildReviewQuestions 的 index 对应
    // pending.issues[N]；拿不到 issue 时回退纯 label（与旧行为一致）。
    const locateReviewIssue = (issueId: string): PrdReviewIssue | undefined => {
      const idx = /^q(\d+)$/.exec(issueId)?.[1]
      if (idx === undefined) return undefined
      return pending.issues[Number(idx)]
    }
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'prd_review_answered',
        title: '用户逐题作答审查问题',
        why: `用户对 ${prdReviewAnswers.answers.length} 个审查问题作答（${substantive.length} 个选择修订方向）`,
        detail: {
          answers: prdReviewAnswers.answers.map((answer) => ({
            issue_id: answer.issue_id,
            option_id: answer.option_id,
            label: answer.label,
            ignored: answer.ignored,
          })),
        },
      },
    })
    const ack = `收到，按你的选择「${combined.slice(0, 40)}」修订 PRD，整理好后再请你确认。`
    persistAssistant?.(ack)
    publish(makeGuideEvent(input, 'message_delta', { text: ack }))
    publish(makeGuideEvent(input, 'message_completed', { subtype: 'success' }))
    // 答案回流后的生成 env：优先复用挂起时的 env（向导轮模型 env），缺失回退本次 model。
    // 2026-09-05「以撒地牢」实锤：env 传 undefined 会让 normalizer 走 fallback，把修订指令
    // 原样 append 成功能项 description 污染 PRD。补上 env 让 normalizer 走 LLM 正确 revise。
    const reviewEnv = pending.env ?? model?.env
    const existing = pending.requirements as SketchRequirement[]
    const requirementIds = new Set(existing.map((item) => item.id))
    // 逐 issue 处理（不再拼成一个字符串塞给 normalizer——单 decision 无法承载多 issue，且
    // fallback 会把 issue claim 全文污染成 description）。功能项类逐个 revise；章节类
    // （目标用户/术语表/API Spec 等非功能项）答案落盘 user 轮次，供 PRD 管线 readConversation 吸收。
    let current = existing
    const sectionAnswers: string[] = []
    for (const answer of substantive) {
      const issue = locateReviewIssue(answer.issue_id)
      const answerText = answer.label || answer.option_id
      if (!issue || !answerText) continue
      if (requirementIds.has(issue.location)) {
        const directive = `${issue.location} 的修改诉求：${answerText}`
        const normalization = await normalizeRequirementUpdate({
          session_id: input.session_id,
          existing: current,
          modification: refineModificationDescription(directive),
          constraints: readProjectConstraints(input.project_id),
          query: pending.query,
          env: reviewEnv,
        })
        current = applyNormalization(current, normalization, nextRequirementId(current), 'correction')
      } else {
        sectionAnswers.push(`${issue.location}：${answerText}`)
      }
    }
    if (sectionAnswers.length > 0) {
      appendJsonLine(getAgentSessionPath(input.session_id), {
        role: 'user',
        content: [{ type: 'text', text: `补充说明：${sectionAnswers.join('；')}` }],
        timestamp: Date.now(),
      })
    }
    await runPrdPipeline({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      channel_id: input.channel_id,
      requirements: current,
      query: pending.query,
      env: reviewEnv,
      publish,
      signal: model?.signal,
    })
    return
  }

  // PRD 确认卡回传（2026-08-26 改造 3，在审查卡之后/普通卡之前拦截）：
  // confirm → user_confirmed_at 落盘 + 开草图；adjust → 消费 pending：带实质文本时直接进
  // 修订闭环（归一化并入 → 重走 PRD 管线 → 新确认卡），不再把用户咐在提示上——
  // 线上案例 02239079：用户在弹窗输入「我想要更多有趣的功能」被提示「指出具体条目」
  // ② 加厚追问回答回传（2026-09-03）：答案已由 orchestrator sendMessage 统一落盘
  // 为 user 轮次（「答案落会话」——下一轮 enricher 接地守卫②的 userTexts 自动命中）；
  // 此处 consume 挂起上下文 → answered 决策行 → 整轮重跑（K-3：PRD 腿同轮吸收新答案）。
  if (isEnrichmentClarificationAnswer(input)) {
    const pendingClarification = takePendingEnrichmentClarification(input.project_id)
    const answer = input.content.trim()
    if (pendingClarification && answer) {
      const ack = '好的，按你的回答重新整理 PRD，稍后请你确认。'
      persistAssistant?.(ack)
      publish(makeGuideEvent(input, 'message_delta', { text: ack }))
      publish(makeGuideEvent(input, 'message_completed', { subtype: 'success' }))
      try {
        recordEnrichmentClarificationAnswered(input, answer)
      } catch {
        // 决策日志失败不阻断重跑
      }
      // A4（2026-09-03）：追问答案先定向 revise 目标功能项——拆 description 冻结死锁。
      // 此前新语义只能靠断言通道（被「不改写 description」拦住）+会话接地证据间接回流，
      // 目标项 description/story 永远是旧语义，缺口每轮重跑必然复发（058c86a3：F-003
      // 连续两轮被问同一时间点）。答案现直接驱动 revise：normalizer 失败或判定非
      // revise 目标项时回退原清单，答案仍作为会话接地证据（现状行为不丢）。
      let answeredRequirements = pendingClarification.requirements as SketchRequirement[]
      const targets = (readLastEnrichmentClarificationRequests(input.session_id) ?? [])
        .map((request) => request.for)
        .filter(Boolean)
      // 「你帮我决定」是让渡信号而非具体修改，跳过定向 revise（答案已落会话，enricher 按默认收敛）
      if (targets.length > 0 && pendingClarification.query && answer !== '你帮我决定') {
        const directedAnswer = `针对 ${targets.join('、')} 的追问，用户补充：「${answer.slice(0, 120)}」。据此修订这些功能项的描述与故事，使其反映该补充，不要新增功能项`
        try {
          const normalization = await normalizeRequirementUpdate({
            session_id: input.session_id,
            existing: answeredRequirements,
            modification: refineModificationDescription(directedAnswer),
            constraints: readProjectConstraints(input.project_id),
            query: pendingClarification.query,
            env: undefined,
          })
          if (
            normalization.action === 'revise' &&
            normalization.reviseId &&
            targets.includes(normalization.reviseId)
          ) {
            answeredRequirements = applyNormalization(
              answeredRequirements,
              normalization,
              nextRequirementId(answeredRequirements),
              'correction',
            )
          }
        } catch {
          // normalizer 失败回退原清单：答案仍已落会话成接地证据，重跑照常
        }
      }
      await runPrdPipeline({
        request_id: pendingClarification.request_id,
        session_id: pendingClarification.session_id,
        project_id: pendingClarification.project_id,
        mode: pendingClarification.mode,
        channel_id: pendingClarification.channel_id,
        requirements: answeredRequirements,
        query: pendingClarification.query,
        env: pendingClarification.env,
        publish,
        signal: pendingClarification.signal,
      })
    } else {
      // 卡片已过期（超时/重启后内存 pending 丢失）：答案仍已落会话成为未来接地证据，
      // 孤儿收敛（下方 detectOrphan）会补 timeout 决策行；如实告知不装作已采纳
      const hint = '这张追问卡已经过期（等待超时或应用重启），你的回答我已记录，会在后续整理需求时参考。'
      persistAssistant?.(hint)
      publish(makeGuideEvent(input, 'message_delta', { text: hint }))
      publish(makeGuideEvent(input, 'message_completed', { subtype: 'success' }))
    }
    return
  }

  // ② 孤儿挂起收敛（重启恢复）：尾部 requested 无 answered/timeout 终结且内存无
  // pending（应用重启丢了内存态）→ 按 timeout 语义落痕收敛，后续管线不再等待。
  // 注意 must 在追问回答分流之后：正常回答路径 take 已落 answered 终结行。
  if (
    !hasPendingEnrichmentClarification(input.project_id) &&
    detectOrphanEnrichmentClarification(input.session_id)
  ) {
    try {
      recordEnrichmentClarificationTimeout(input)
    } catch {
      // 日志失败不阻断
    }
  }

  // 啪住，困惑打「？」后整个需求流程重新澄清全链重跑（用户反馈「没法在原有基础上
  // 修改，是完全性重构」）；dismiss → 暂不确认，回对话继续不开工。
  const prdConfirmDecision = resolvePrdConfirmCardAnswer(input)
  if (prdConfirmDecision === 'confirm') {
    await resumePrdConfirmConfirmed(input)
    return
  }
  if (prdConfirmDecision === 'adjust') {
    const pendingAdjust = consumePrdConfirmAdjust(input)
    const adjustment = input.content.trim()
    if (pendingAdjust && adjustment) {
      const ack = `好的，按你的想法「${adjustment.slice(0, 40)}」修订 PRD，整理好后再请你确认。`
      persistAssistant?.(ack)
      publish(makeGuideEvent(input, 'message_delta', { text: ack }))
      publish(makeGuideEvent(input, 'message_completed', { subtype: 'success' }))
      // 归一化并入（env 缺省走词表 fallback；语义消化归后续 PRD 引擎重整）：
      // 「加个有趣的功能」类口语在原清单基础上 append/revise，而不是推倒重来
      const existing = pendingAdjust.requirements as SketchRequirement[]
      const normalization = await normalizeRequirementUpdate({
        session_id: input.session_id,
        existing,
        modification: refineModificationDescription(adjustment),
        constraints: readProjectConstraints(input.project_id),
        query: pendingAdjust.query,
        env: undefined,
      })
      const merged = applyNormalization(existing, normalization, nextRequirementId(existing), 'correction')
      await runPrdPipeline({
        request_id: input.request_id,
        session_id: input.session_id,
        project_id: input.project_id,
        mode: input.mode,
        channel_id: input.channel_id,
        requirements: merged,
        query: pendingAdjust.query,
        env: undefined,
        publish,
        signal: model?.signal,
      })
      return
    }
    const hint = '好的，你想调整哪里？指出具体条目（如「F-002 的验收不对：我想要的是导出 Excel」），我修订后再请你确认。'
    persistAssistant?.(hint)
    publish(makeGuideEvent(input, 'message_delta', { text: hint }))
    publish(makeGuideEvent(input, 'message_completed', { subtype: 'success' }))
    return
  }
  if (prdConfirmDecision === 'dismiss') {
    consumePrdConfirmDismiss(input)
    const hint = '好的，先不确认这份 PRD。你可以直接在对话里继续说想法或补充要求，我们理顺后我再来请你确认。'
    persistAssistant?.(hint)
    publish(makeGuideEvent(input, 'message_delta', { text: hint }))
    publish(makeGuideEvent(input, 'message_completed', { subtype: 'success' }))
    return
  }

  // 用户约束走门（T4-L1 写入侧）：约束语句（「不含登录」「必须离线可用」）确定性提取、
  // 持久化 project.constraints，随背板常驻注入——不依赖模型记忆，首轮约束历轮生效。
  // 在三条子路径（卡片答案/模型驱动/规则路由）分叉之前统一收口。
  captureConstraints({
    project_id: input.project_id,
    session_id: input.session_id,
    constraints: extractConstraints(input.content),
    source: 'guide_gate',
  })

  // 卡片答案：用户点选了选项（2026-08-27 语义升级：点选回流模型——向导持续跟踪用户选择）
  const cardAnswer = resolveCardAnswer(input, primaryIntent)
  if (cardAnswer) {
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'clarification_answer',
        title: '用户点选澄清答案',
        why: `用户点选「${input.content}」，以此作为已确认方向`,
        detail: {
          option_id: input.metadata?.selected_option_id,
          requirements: cardAnswer.requirements,
        },
      },
    })

    // 点选回流（2026-08-27 用户拍板「向导持续跟踪用户选择」）：点选不再被平台短路直接
    // 开工——答案已在对话历史里，回流向导模型，由它跟踪全部已选内容自主决定下一步：
    // 还缺关键信息→继续问；信息够了→confirm_requirements（弹窗确认）/generate_sketch
    // （PRD 确认门兑底）。防死循环：D3 熔断（连续 3 张卡不收敛转确认弹窗）仍然生效。
    // 例外：点选「你帮我决定」是让渡信号（用户明确不想再答），不回流，直接走下方收敛链。
    const isAutoDelegation = input.content.trim() === '你帮我决定' || input.metadata?.selected_option_id === 'auto'
    if (!isAutoDelegation && model) {
      const handledByModel = await tryModelDrivenGuide(input, publish, model, primaryIntent, persistSystem, project)
      if (handledByModel) return
    }

    const ack = '好的，按你选的方向整理成产品需求文档，请你过目确认后再画草图。'
    persistAssistant?.(ack)
    publish(makeGuideEvent(input, 'message_delta', { text: ack }))
    // 收敛链（让渡点选/无渠道降级/模型未处理）：统一进入 PRD 后置链
    // （PRD→六维审查→确认卡→草图）
    await runPrdPipeline({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      channel_id: input.channel_id,
      requirements: cardAnswer.requirements,
      query: model?.query,
      env: model?.env,
      publish,
      signal: model?.signal,
    })
    return
  }

  // 自由文本让渡（D1 修复）：打字版「你帮我决定」——出口与卡片 auto 路径完全一致，
  // 仅 decision detail 标 source='free_text_auto' 与点选区分（埋点/事后追溯可辨）
  const autoDelegation = resolveAutoDelegation(input, primaryIntent)
  if (autoDelegation) {
    // 让渡来源区分（2026-08-27 统一后点选 auto 卡也走这里）：card_auto=点选卡、free_text_auto=打字
    const viaCard = input.metadata?.source === 'card_option'
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'clarification_answer',
        title: viaCard ? '用户让渡决定权（点选卡片）' : '用户让渡决定权（自由文本）',
        why: `用户${viaCard ? '点选「你帮我决定」' : '说「' + input.content + '」'}，视为交由向导按常见做法决定，经 PRD 确认后生成草图`,
        detail: {
          source: viaCard ? 'card_auto' : 'free_text_auto',
          requirements: autoDelegation.requirements,
        },
      },
    })
    const ack = '好的，我来定方向，先整理成产品需求文档，请你过目确认后再画草图。'
    persistAssistant?.(ack)
    publish(makeGuideEvent(input, 'message_delta', { text: ack }))
    // 让渡与点选/模型判定同一后置链（排查报告 🔴2）：让渡场景「系统替你做的决定」最多，
    // PRD 确认卡（assumptions 段）价值最大
    await runPrdPipeline({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      channel_id: input.channel_id,
      requirements: autoDelegation.requirements,
      query: model?.query,
      env: model?.env,
      publish,
      signal: model?.signal,
    })
    return
  }

  // 渠道可用 → 优先走真实模型；模型不可用 / 解析失败 → 回退规则路由
  if (model) {
    const handled = await tryModelDrivenGuide(input, publish, model, primaryIntent, persistSystem, project)
    if (handled) return
  }

  const route = routeDialogue(input.content, project)
  if (route.action === 'ask_clarification') {
    updateProject(input.project_id, { current_stage: 'blocked_for_user_decision' })
    publish(makeGuideEvent(input, 'stage_changed', { stage: 'blocked_for_user_decision' }))
    const reply = '我需要再确认几个关键点，这样草图会更接近你的想法。'
    persistAssistant?.(reply)
    publish(makeGuideEvent(input, 'message_delta', { text: reply }))
    publishClarificationCard(input, publish, normalizeClarificationOptions(route.questions.slice(0, 3)), persistSystem, '我需要再确认几个关键点')
    return
  }

  await runSketchTask({
    request_id: input.request_id,
    session_id: input.session_id,
    project_id: input.project_id,
    mode: input.mode,
    prompt: input.content,
    requirements: ensurePrimaryIntent(route.requirements, primaryIntent),
    channel_id: input.channel_id,
    query: model?.query,
    signal: model?.signal,
  })
}

/**
 * 模型驱动的澄清对话：给模型下发结构化指令，流式收集回复并解析 JSON。
 *
 * 关键点：模型被要求"只输出 JSON"，所以流式内容是内部契约，绝不上屏、不落盘。
 * 只有解析出的用户可见 `reply` 才会发布 message_delta 并写入会话 JSONL——
 * 否则对话气泡会把 {"action":...} 原始 JSON 直接暴露给用户。
 *
 * 任何失败（网络 / 非 JSON / 校验不过）都返回 false，由调用方回退规则路由。
 */
async function tryModelDrivenGuide(
  input: AgentSendMessageInput,
  publish: GuideEventPublisher,
  model: GuideModelOptions,
  primaryIntent?: string,
  persistSystem?: (text: string) => void,
  project?: Project,
): Promise<boolean> {
  // 首轮判定：会话里还没有任何助手回复 = 用户尚未经历过一轮澄清（卡片答案路径不经过此处）
  const isFirstTurn = !model.history.some((turn) => turn.role === 'assistant')
  // 注入点②（周计划 §6）：模板章节框架切片——quick 只问必填章缺口（≤3 问纪律），
  // longterm 全章节框架；开关关闭/模板缺失时为 null，行为=现状
  let templateSection: string | null = null
  try {
    templateSection = buildClarifyInjection(project?.template_type ?? 'personal_tool', input.mode)
  } catch {
    templateSection = null
  }
  const baseSystem = isFirstTurn
    ? (loadPromptOverride('guide-system') ?? DEFAULT_GUIDE_SYSTEM_PROMPT) + FIRST_TURN_RULE
    : loadPromptOverride('guide-system') ?? DEFAULT_GUIDE_SYSTEM_PROMPT
  const systemTurn: ConversationTurn = {
    role: 'system',
    content: templateSection ? `${baseSystem}\n\n${templateSection}` : baseSystem,
  }
  const history: ConversationTurn[] = [systemTurn, ...model.history]

  // 只做内部累积：模型流式吐的是原始 JSON，不发布 message_delta，避免结构泄露
  let accumulated = ''
  try {
    const stream = model.query(input.content, {
      env: model.env,
      signal: model.signal,
      sessionId: model.sessionId,
      history,
      maxTokens: model.maxTokens,
      temperature: model.temperature,
    })
    for await (const sdkMessage of stream) {
      if (sdkMessage.type !== 'assistant' || !sdkMessage.message) continue
      const text = extractText(sdkMessage.message.content)
      if (text) accumulated += text
    }
  } catch {
    // 模型不可用/网络错误：回退规则路由（不打断澄清流程）
    return false
  }

  const parsed = parseGuideJson(accumulated)
  if (!parsed) return false

  // 首轮护栏（代码级，不信任提示词）：模型无视 FIRST_TURN_RULE 直接 generate_sketch 时降级为澄清，
  // 且不采用其「直接开工」话术（阶段如实性）。规则路由给得出选项就弹卡，否则纯文本追问。
  if (isFirstTurn && parsed.action === 'generate_sketch') {
    console.error('[guide] 首轮护栏生效：模型跳过澄清直接 generate_sketch，已降级为澄清追问')
    const route = project ? routeDialogue(input.content, project) : undefined
    const questions = route?.action === 'ask_clarification' ? route.questions.slice(0, 3) : []
    const reply = questions.length
      ? '开工前先确认一个关键点，这样做出来更接近你的想法：'
      : '开工前先确认一个关键点：你想要哪种类型、主要给谁用？'
    updateProject(input.project_id, { current_stage: 'blocked_for_user_decision' })
    publish(makeGuideEvent(input, 'stage_changed', { stage: 'blocked_for_user_decision' }))
    model.persistAssistant(reply)
    publish(makeGuideEvent(input, 'message_delta', { text: reply }))
    publish(makeGuideEvent(input, 'message_completed', { subtype: 'success' }))
    publishClarificationCard(input, publish, normalizeClarificationOptions(questions), persistSystem, reply)
    return true
  }

  // 澄清轮次熔断（D3，2026-08-26 语义修订：不再臆断开工）：已连续 N 轮出示卡片、模型仍要
  // ask_clarification 时，转入需求确认弹窗——「按最接近的理解整理清单」=主题+本轮
  // 序列内用户已点选的全部方向（2026-08-29 修复：旧逻辑只用主题句兜底，三轮点选
  // 方向全部丢失，确认弹窗只剩一句空壳，PRD 正文与清单不一致引发审查误判）。
  if (
    parsed.action === 'ask_clarification' &&
    countTrailingClarificationRounds(input.session_id) >= CLARIFICATION_ROUND_LIMIT
  ) {
    console.error(`[guide] 澄清轮次熔断：连续 ${CLARIFICATION_ROUND_LIMIT} 轮仍不明确，转入需求确认弹窗（不自动开工）`)
    const collected = collectClarificationAnswers(input.session_id)
    const fallbackRequirements = ensurePrimaryIntent(
      collected.length > 0
        ? collected.map((item, index) => ({ id: `F-${String(index + 1).padStart(3, '0')}`, description: item }))
        : primaryIntent
          ? []
          : [{ id: 'F-001', description: input.content.slice(0, 40) }],
      primaryIntent,
    )
    await startRequirementConfirmFlow(
      input,
      publish,
      model,
      fallbackRequirements,
      [primaryIntent ?? input.content.slice(0, 20)].filter((query) => query.trim().length > 0),
      persistSystem,
      true,
    )
    return true
  }

  // 仅把对用户可读的 reply 上屏并落盘；缺省给通用兜底话术，绝不写回原始 JSON
  const reply =
    parsed.reply.trim() ||
    (parsed.action === 'ask_clarification'
      ? '想再多了解一点，方便我判断该怎么做。'
      : '好的，我先把你的想法整理成产品需求文档，请你过目。')
  model.persistAssistant(reply)
  publish(makeGuideEvent(input, 'message_delta', { text: reply }))
  publish(makeGuideEvent(input, 'message_completed', { subtype: 'success' }))

  if (parsed.action === 'ask_clarification') {
    updateProject(input.project_id, { current_stage: 'blocked_for_user_decision' })
    publish(makeGuideEvent(input, 'stage_changed', { stage: 'blocked_for_user_decision' }))
    publishClarificationCard(input, publish, normalizeClarificationOptions(parsed.questions), persistSystem, parsed.reply.trim())
    return true
  }

  if (parsed.action === 'confirm_requirements') {
    await startRequirementConfirmFlow(input, publish, model, ensurePrimaryIntent(parsed.requirements, primaryIntent), parsed.research_queries, persistSystem, false)
    return true
  }

  // generate_sketch（2026-08-27 收口补全）：模型判定需求成型直接开工的第四条入口，
  // 与点选/让渡/弹窗统一走 PRD 后置链（前移→六维审查→确认卡→草图）——
  // 「不过目不开工」，不再直达 runSketchTask。
  await runPrdPipeline({
    request_id: input.request_id,
    session_id: input.session_id,
    project_id: input.project_id,
    mode: input.mode,
    channel_id: input.channel_id,
    requirements: ensurePrimaryIntent(parsed.requirements, primaryIntent),
    query: model.query,
    env: model.env,
    publish,
    signal: model.signal,
  })
  return true
}

/**
 * 发布澄清决策卡片并落盘选项原文（[decision-card] 内部标记）+ 决策日志（T2）。
 * questions 为空表示纯文本澄清，不弹卡片；有选项时务必落盘——
 * user_decision_required 事件只存在渲染端内存，不落盘则事后无法追溯
 * 到底给用户弹过哪些选项（历史会话只能看到 reply 问句）。
 */
function publishClarificationCard(
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
interface PendingRequirementConfirm {
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

const pendingRequirementConfirms = new Map<string, PendingRequirementConfirm>()

export function takePendingRequirementConfirm(projectId: string): PendingRequirementConfirm | undefined {
  const pending = pendingRequirementConfirms.get(projectId)
  pendingRequirementConfirms.delete(projectId)
  return pending
}

/** 需求确认弹窗主流程：市调（增强不阻断）→ 落盘留痕 → pending 状态 → 弹窗事件。 */
async function startRequirementConfirmFlow(
  input: AgentSendMessageInput,
  publish: GuideEventPublisher,
  model: GuideModelOptions,
  requirements: SketchRequirement[],
  researchQueries: string[],
  persistSystem?: (text: string) => void,
  forcedByRoundBreaker = false,
): Promise<void> {
  updateProject(input.project_id, { current_stage: 'blocked_for_user_decision' })
  publish(makeGuideEvent(input, 'stage_changed', { stage: 'blocked_for_user_decision' }))

  // 市调：失败降级 available:false，弹窗照常出（增强不是依赖）
  // 顾问式（2026-08-30）：需求+候选词 → LLM 改写聚焦查询词（失败降级候选词/需求清洗）
  const demandText = requirements.map((item) => item.description).join('；').slice(0, 200)
  const marketQueries = await buildResearchQueries(demandText, researchQueries, model)
  let research: MarketResearch = { available: false, queries: marketQueries, results: [], summary: '' }
  try {
    research = await researchMarketSimilar(marketQueries)
  } catch {
    // researchMarketSimilar 内部已降级，此处双保险
  }

  persistSystem?.(`[decision-card] 需求确认：${requirements.map((item) => item.description).join('｜')}`)
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: forcedByRoundBreaker ? 'clarification_forced_confirm' : 'requirement_confirm_card',
      title: forcedByRoundBreaker ? '澄清轮次熔断，转入需求确认' : '需求确认弹窗',
      why: forcedByRoundBreaker
        ? `已连续 ${CLARIFICATION_ROUND_LIMIT} 轮澄清仍不明确，按主题与你已点选的方向整理清单，交用户确认/补充/让渡`
        : '需求基本成型，交用户在弹窗中确认、补充或让渡',
      detail: {
        requirements,
        research_available: research.available,
        research_queries: researchQueries,
      },
    },
  })

  const ideas = await distillResearchIdeas(research, { ...model, demand: demandText })

  // G3a 市调 UI 做法投喂入册（恒 candidate，用户 2026-09-07 裁定「做产品=做 UI」定向收割）：
  // fire-and-forget，BLOMA_EXPERIENCE off 时零副作用，失败不阻断确认弹窗。
  void ingestResearchIdeasAsCandidates({
    ideas,
    demand: demandText,
    projectId: input.project_id,
    sessionId: input.session_id,
  })

  pendingRequirementConfirms.set(input.project_id, {
    request_id: input.request_id,
    session_id: input.session_id,
    project_id: input.project_id,
    mode: input.mode,
    channel_id: input.channel_id,
    requirements,
    research,
    ideas,
    query: model.query,
    env: model.env,
    publish,
  })

  publish(makeGuideEvent(input, 'user_decision_required', {
    kind: 'requirement_confirm',
    title: '确认你的需求',
    requirements,
    ideas,
    research: {
      available: research.available,
      summary: research.summary,
      results: research.results.slice(0, 6),
    },
  }))
}

/** 市调想法提炼提示词：把搜索结果提炼成可勾选采纳的「市面上的做法」短句。 */
const RESEARCH_IDEA_SYSTEM_PROMPT = [
  '你是产品向导。根据【用户需求】，把调研结果里与之强相关的市面做法提炼成 3~5 条「市面上的做法/玩法」供用户参考勾选。',
  '每条：label（≤20 字玩法短句，如「虚拟键盘实时弹奏」）、note（≤40 字要点说明）、source（来源域名）。',
  '相关性是硬标准：与用户需求无关的搜索结果直接忽略，不要提炼；宁可少给，绝不硬凑不相关的做法。',
  '只提炼搜索结果里真实出现的做法，不臆造；结果不足 3 条时有多少给多少。',
  '输出严格 JSON：{"ideas":[{"label":"…","note":"…","source":"…"}]}，不要输出其他内容。',
].join('\n')

/**
 * 市调想法提炼（2026-08-29 灵感参考改造，用户拍板「向导整理提供给用户看、让他选择要不要」）：
 * 优先 LLM 把搜索结果提炼成玩法短句；失败/无模型/无结果降级用原始条目
 * （title 当 label、snippet 截断当 note）——零 LLM 也保证想法区可用。
 * 查询参数取最小面（query/env/signal/sessionId），需求确认弹窗（GuideModelOptions）
 * 与 PRD 确认卡（runPrdPipeline 只有裸 query/env）两处调用方都能供给。
 */
async function distillResearchIdeas(
  research: MarketResearch,
  opts: { query: SDKQuery; env?: Record<string, string>; signal?: AbortSignal; sessionId?: string; demand?: string },
): Promise<ResearchIdea[]> {
  if (!research.available || research.results.length === 0) return []
  const demand = opts.demand?.trim() ?? ''
  // 兑底：原始条目直接当想法（LLM 失败时用户仍能看到并勾选）。
  // 温和收紧（2026-08-30）：只丢明显噪音标题（搜索结果与查询词天然相关，查询构造已从源头锚定需求）
  const fallback = research.results
    .slice(0, 4)
    .map((result) => ({
      label: result.title.replace(/\s+/g, ' ').trim().slice(0, 20),
      note: result.snippet.replace(/\s+/g, ' ').trim().slice(0, 40),
      source: safeHostname(result.url),
    }))
    .filter((idea) => {
      if (!idea.label || idea.label.length < 4) return false
      return !/^(官网|首页|下载|登录|注册|免费|教程|视频)/.test(idea.label)
    })
  try {
    let accumulated = ''
    const demandBlock = demand ? `【用户需求】\n${demand}\n\n` : ''
    const stream = opts.query(`${demandBlock}【调研结果】\n${research.summary}`, {
      env: opts.env ?? {},
      signal: opts.signal ?? new AbortController().signal,
      sessionId: opts.sessionId ?? '',
      history: [{ role: 'system', content: RESEARCH_IDEA_SYSTEM_PROMPT }],
      maxTokens: 800,
    })
    for await (const message of stream) {
      if (message.type === 'assistant' && message.message) {
        for (const block of message.message.content) {
          if (block.type === 'text') accumulated += block.text
        }
      }
    }
    const start = accumulated.indexOf('{')
    const end = accumulated.lastIndexOf('}')
    if (start < 0 || end <= start) return fallback
    const parsed = JSON.parse(accumulated.slice(start, end + 1)) as {
      ideas?: Array<{ label?: unknown; note?: unknown; source?: unknown }>
    }
    if (!Array.isArray(parsed.ideas)) return fallback
    const ideas = parsed.ideas
      .filter((item) => typeof item?.label === 'string' && item.label.trim().length > 0)
      .slice(0, 5)
      .map((item) => ({
        label: String(item.label).replace(/\s+/g, ' ').trim().slice(0, 20),
        note: typeof item.note === 'string' ? item.note.replace(/\s+/g, ' ').trim().slice(0, 40) : '',
        source: typeof item.source === 'string' ? item.source.replace(/^https?:\/\//, '').split('/')[0] : '',
      }))
    return ideas.length > 0 ? ideas : fallback
  } catch {
    return fallback
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** 市调查询词构造提示词（顾问式，2026-08-30）：需求理解 → 具体可检索查询词。 */
const RESEARCH_QUERY_SYSTEM_PROMPT = [
  '你是产品调研员。把【用户需求】和候选词改写成 2 个具体可检索的市调查询词。',
  '要求：查询词要具体到产品形态+核心功能名词（如「复音电子琴 教学 音色」），能直接搜到真实产品；',
  '不要口语、不要泛指词（“做一个”“类似的”“推荐”）；两个查询词覆盖不同侧面（功能/同类产品/目标人群）。',
  '候选词质量差也没关系，重写即可。',
  '输出严格 JSON：{"queries":["…","…"]}，不要输出其他内容。',
].join('\n')

/**
 * 顾问式查询构造：LLM 把需求+候选词改写为聚焦查询词；失败/无需求降级为候选词清洗 + 需求清洗（保证非空）。
 * 与 distill 同款降级纪律：市调是增强不是依赖，查询构造失败不影响弹窗。
 */
async function buildResearchQueries(
  demand: string,
  hints: string[],
  opts: { query: SDKQuery; env?: Record<string, string>; signal?: AbortSignal; sessionId?: string },
): Promise<string[]> {
  const demandText = demand.trim()
  // 规则兑底：候选词优先（模型输出通常比需求原文更可检索），需求清洗兜底
  const fallback = [...hints.map(normalizeResearchQuery), normalizeResearchQuery(demandText)]
    .filter((q) => q.length > 0)
    .slice(0, 2)
  if (!demandText) return fallback
  try {
    let accumulated = ''
    const hintBlock = hints.length > 0 ? `\n候选词：${hints.join(' / ')}` : ''
    const stream = opts.query(`【用户需求】\n${demandText}${hintBlock}`, {
      env: opts.env ?? {},
      signal: opts.signal ?? new AbortController().signal,
      sessionId: opts.sessionId ?? '',
      history: [{ role: 'system', content: RESEARCH_QUERY_SYSTEM_PROMPT }],
      maxTokens: 200,
    })
    for await (const message of stream) {
      if (message.type === 'assistant' && message.message) {
        for (const block of message.message.content) {
          if (block.type === 'text') accumulated += block.text
        }
      }
    }
    const start = accumulated.indexOf('{')
    const end = accumulated.lastIndexOf('}')
    if (start < 0 || end <= start) return fallback
    const parsed = JSON.parse(accumulated.slice(start, end + 1)) as { queries?: Array<unknown> }
    if (!Array.isArray(parsed.queries)) return fallback
    const queries = parsed.queries
      .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
      .map((q) => normalizeResearchQuery(q))
      .filter((q) => q.length > 0)
      .slice(0, 2)
    return queries.length > 0 ? queries : fallback
  } catch {
    return fallback
  }
}

/** PRD 后置链公共上下文：需求已收敛（无论哪条入口），统一走 PRD→审查→确认→草图。 */
interface PrdPipelineContext {
  request_id: string
  session_id: string
  project_id: string
  mode: AgentSendMessageInput['mode']
  channel_id?: string
  requirements: Array<{ id: string; description: string }>
  query: SDKQuery | undefined
  env?: Record<string, string>
  publish: GuideEventPublisher
  /** 可选参考网页链接（web-reference-extractor，2026-08-28）：仅 http(s)，提取失败静默降级 */
  reference_url?: string
  /** 主链路中止信号（AGENT_STOP）：分阶段检查，abort 后不再推进审查/卡片/草图 */
  signal?: AbortSignal
}

/** 规则路由等无模型场景的兑底查询：LLM 审查必然失败 → 如实降级规则门。 */
const NO_QUERY_FALLBACK: SDKQuery = async function* (): AsyncGenerator<never> {
  throw new Error('NO_MODEL_QUERY')
}

/**
 * PRD 后置链（收敛路径统一收口，2026-08-27）：
 * PRD 前移落盘（requirement_confirmed，早于草图，失败不阻断）→ 六维审查门 →
 * 通过则四段式确认卡挂起（「PRD 不过目不开工」不变式）/ 未过则审查决策卡 /
 * PRD 生成失败如实降级直接草图。
 * 三条收敛入口共用：模型判定（confirm_requirements 弹窗确认）、点选澄清卡、让渡。
 * 此前点选/让渡直接 runSketchTask（8-22 澄清死循环修复时代的捷径），绕过全套
 * 确认仪式——线上首测实测主路径 0 触发确认卡（排查报告 🔴1/🔴2，2026-08-27）。
 */
async function runPrdPipeline(pending: PrdPipelineContext): Promise<{ started: boolean; prd_written: boolean }> {
  const { requirements, publish } = pending
  const signal = pending.signal
  const aborted = () => signal?.aborted ?? false
  // 委派审查运行期间的事件（delegation_*/tool_call 等）经此门控：停止后不再漏事件；
  // 挂起卡存档的 publish 仍传原始版本（卡片选项由用户主动触发，理应发声）
  const gatedPublish: GuideEventPublisher = (event) => {
    if (!aborted()) publish(event)
  }
  const eventInput = { session_id: pending.session_id, project_id: pending.project_id }

  let prdWritten = false
  let backplaneForReview: PrdBackplane | undefined
  if (aborted()) return { started: false, prd_written: false }

  // ② 加厚追问通路（2026-09-03，挂起判定在 PRD 落盘前：answered 后整轮重跑会
  // 重新生成并落盘，挂起期间不写 prd.json）。K-1 仅主路：辅路（MVP 生成中途）
  // 不传 onClarification，信号自然丢弃。
  let clarificationRequests: EnrichmentClarificationRequest[] = []
  try {
    const backplane = await resolvePrdBackplane(
      {
        session_id: pending.session_id,
        project_id: pending.project_id,
        channel_id: pending.channel_id,
        query: pending.query,
        signal,
      },
      requirements as SketchRequirement[],
      (requests) => {
        clarificationRequests = requests
      },
    )
    if (clarificationRequests.length > 0 && shouldSuspendForEnrichmentClarification(pending.session_id)) {
      // 挂起：旁白先行（对齐内审旁白纪律——用户需要知道为什么还没出 PRD）+
      // requested 决策行（detail 存 requests 原文，孤儿恢复用）+ 追问卡 + 超时 timer；
      // 本轮管线到此为止，answered 经 sendMessage 新栈重跑（状态机图「挂起→回传→答案落会话」）
      gatedPublish(makeGuideEvent(eventInput, 'message_delta', {
        text: '整理 PRD 时发现几处不说清就没法写出可靠验收标准的地方，先问你两个小问题，回答后我马上出完整 PRD。',
      }))
      suspendForEnrichmentClarification(
        {
          request_id: pending.request_id,
          session_id: pending.session_id,
          project_id: pending.project_id,
          mode: pending.mode,
          channel_id: pending.channel_id,
          requirements,
          query: pending.query,
          env: pending.env,
          publish,
          signal,
        },
        clarificationRequests,
        (timeoutPending) => {
          // 超时回退（状态机图⑤）：按已确认输入重跑——轮次守卫里 hasTimeout 标记
          // 已使 shouldSuspend=false，本轮不再挂起，静默降级走完内审→确认卡
          try {
            recordEnrichmentClarificationTimeout(timeoutPending)
          } catch {
            // 日志失败不阻断回退
          }
          void runPrdPipeline({
            request_id: timeoutPending.request_id,
            session_id: timeoutPending.session_id,
            project_id: timeoutPending.project_id,
            mode: timeoutPending.mode,
            channel_id: timeoutPending.channel_id,
            requirements: timeoutPending.requirements as SketchRequirement[],
            query: timeoutPending.query,
            env: timeoutPending.env,
            publish: timeoutPending.publish,
            signal: timeoutPending.signal,
          }).catch(() => undefined)
        },
      )
      return { started: false, prd_written: false }
    }
    if (clarificationRequests.length > 0) {
      // 有缺口但轮次守卫不过（上限/超时后）→ 状态机图④：静默降级留痕，按现状继续
      try {
        recordEnrichmentClarificationExhausted(pending)
      } catch {
        // 日志失败不影响主线
      }
    }
    backplaneForReview = backplane
    syncDocuments(
      {
        request_id: pending.request_id,
        project_id: pending.project_id,
        session_id: pending.session_id,
        checkpoint: 'requirement_confirmed',
      },
      backplane,
    )
    prdWritten = true
  } catch (error) {
    console.error('[guide] PRD 前移生成失败（不阻断草图）:', error)
  }

  // PRD 内审门（AC-Lite，2026-09-01）：PRD 落盘后、草图前。攻击→修订→复核闭环，
  // 审查者≠生成者（渠道优先 audit 内审类别，未配时回退 prd 类别路由→入口 env）；
  // 厂商隔离事实如实判定（audit 与生成渠道 base_url host 不同才其隔离）。
  // PRD 本身生成失败（无背板）时跳过审查直接草图（降级语义不变）。
  if (prdWritten && backplaneForReview) {
    if (aborted()) return { started: true, prd_written: prdWritten }
    // 内审开始旁白（2026-08-29 线上教训：委派审查最长 120s 黑盒等待会被误读为
    // 「裁判没审完就开始做草图」；内审轮次更多，旁白必须先行，时序可循）。
    // 不落盘（状态性旁白，回访不需要）。
    gatedPublish(makeGuideEvent(eventInput, 'message_delta', {
      text: '需求已确认，正在内审这份 PRD（先攻击检查、有问题会自动修订并复核，约需一到两分钟），完成后请你定夺。',
    }))
    let reviewEnv: Record<string, string> | undefined = pending.env
    // 厂商隔离判定（设计稿 §4.3）：audit 渠道与生成渠道（prd 类别/入口渠道）
    // base_url host 不同 → vendor_isolated=true；未配 audit 或同厂商 → false（如实标注不冒充）
    let vendorIsolated: boolean | undefined
    const auditChannelId = resolveRoutedChannelId('audit')
    if (auditChannelId) {
      const prdRoutedId = resolveRoutedChannelId('prd')
      const auditHost = channelHostOf(getChannelByIdRaw(auditChannelId))
      const generateChannel = pending.channel_id ? getChannelByIdRaw(pending.channel_id) : prdRoutedId ? getChannelByIdRaw(prdRoutedId) : undefined
      const generateHost = channelHostOf(generateChannel)
      vendorIsolated = Boolean(auditHost && generateHost && auditHost !== generateHost)
      try {
        const resolution = resolveChannelEnv({
          category: 'audit',
          projectId: pending.project_id,
          sessionId: pending.session_id,
          fallbackScope: 'routed-only',
        })
        if (resolution.env) reviewEnv = resolution.env
      } catch {
        // audit 路由解析失败：回退 prd 类别解析
      }
    }
    if (!auditChannelId) {
      try {
        // 备用链限路由配置域（闭环 PR4）：审查不静默落到任意弱模型；主渠道坏且无配置
        // 备用时留 pending.env（向导轮同渠道）——请求失败自然走规则门降级，口径一致
        const resolution = resolveChannelEnv({
          channelId: pending.channel_id,
          category: 'prd',
          projectId: pending.project_id,
          sessionId: pending.session_id,
          fallbackScope: 'routed-only',
        })
        if (resolution.env) reviewEnv = resolution.env
      } catch {
        // 类别路由解析失败：用收敛入口轮 env 兑底
      }
    }
    const review = await runPrdReviewGate({
      backplane: backplaneForReview,
      confirmedRequirements: requirements,
      query: pending.query ?? NO_QUERY_FALLBACK,
      env: reviewEnv,
      sessionId: pending.session_id,
      projectId: pending.project_id,
      requestId: pending.request_id,
      publish: gatedPublish,
      signal,
      mode: pending.mode,
      vendorIsolated,
    })
    // 用户停止：不发卡、不开草图，管线就此终止（abb1a19f 断链修复）
    if (review.aborted || aborted()) return { started: true, prd_written: prdWritten }
    // 内审收敛且带修订稿：修订稿落盘 requirement_confirmed 检查点（不带确认状态，
    // 陷阱 19 口径——修订后「新 PRD 未确认」语义自洽，用户过目确认后才落
    // user_confirmed_at），后续确认卡/草图任务全部改用修订稿。
    if (review.internalAudit?.converged && review.internalAudit.revisedBackplane) {
      backplaneForReview = review.internalAudit.revisedBackplane
      try {
        syncDocuments(
          {
            request_id: pending.request_id,
            project_id: pending.project_id,
            session_id: pending.session_id,
            checkpoint: 'requirement_confirmed',
          },
          backplaneForReview,
        )
      } catch (error) {
        console.error('[guide] 内审修订稿落盘失败（不阻断确认卡）:', error)
      }
    }
    if (review.verdict === 'needs_revision') {
      if (aborted()) return { started: true, prd_written: prdWritten }
      // 审查确认轮次熔断（2026-08-30 用户拍板）：连续 N 轮逐题选择题仍不过 → 不再逐条追问，
      // 直接转 PRD 确认门让用户过目后开工，避免陷入确认细节循环。
      if (countTrailingPrdReviewRounds(pending.session_id) >= PRD_REVIEW_ROUND_LIMIT) {
        console.error(`[guide] 审查确认轮次熔断：连续 ${PRD_REVIEW_ROUND_LIMIT} 轮确认仍不过，直接转 PRD 确认门`)
        recordDecision({
          project_id: pending.project_id,
          session_id: pending.session_id,
          entry: {
            type: 'prd_review_round_limit',
            title: '审查确认轮次熔断，转入 PRD 过目',
            why: `裁判已连续出示 ${PRD_REVIEW_ROUND_LIMIT} 轮逐题选择题仍未收敛，停止逐条追问，转 PRD 确认门让用户过目后开工`,
            detail: {
              serious_count: review.issues.filter((issue) => issue.severity === 'blocking' || issue.severity === 'major').length,
            },
          },
        })
        const roundLimitCopy = `需求已确认，产品需求文档已形成。裁判已经连续检查了 ${PRD_REVIEW_ROUND_LIMIT} 轮，剩下的小问题不再逐条追问了——请你直接过目这份 PRD，有要改的直接说，确认无误我就开工。`
        publish(makeGuideEvent(eventInput, 'message_delta', { text: roundLimitCopy }))
        publish(makeGuideEvent(eventInput, 'message_completed', { subtype: 'success' }))
        publishPrdConfirmCard({
          input: {
            request_id: pending.request_id,
            session_id: pending.session_id,
            project_id: pending.project_id,
            mode: pending.mode,
            channel_id: pending.channel_id,
          },
          backplane: backplaneForReview,
          requirements,
          query: pending.query ?? NO_QUERY_FALLBACK,
          publish,
          reviewNote: `已连续 ${PRD_REVIEW_ROUND_LIMIT} 轮确认`,
          signal,
        })
        return { started: true, prd_written: prdWritten }
      }
      publish(makeGuideEvent(eventInput, 'message_delta', {
        text: `需求已确认，产品需求文档已形成。内审自动修订后仍有 ${review.issues.filter((issue) => issue.severity === 'blocking' || issue.severity === 'major').length} 个需要你定夺的问题，请看下面的卡片选择怎么处理。`,
      }))
      publish(makeGuideEvent(eventInput, 'message_completed', { subtype: 'success' }))
      publishPrdReviewCard({
        input: {
          request_id: pending.request_id,
          session_id: pending.session_id,
          project_id: pending.project_id,
          mode: pending.mode,
          channel_id: pending.channel_id,
        },
        requirements,
        issues: review.issues,
        outcome: review,
        backplane: backplaneForReview,
        query: pending.query ?? NO_QUERY_FALLBACK,
        publish,
        env: pending.env,
        signal,
      })
      return { started: true, prd_written: prdWritten }
    }
    // PRD 用户确认门（2026-08-26 改造 3）：内审通过后不直接开草图，先把背板四段式
    // 摊给用户确认（机器质量关已过，人语义关接力）；quick 折叠完整视图/longterm 展开。
    // 降级话术如实：规则门降级时不自称「已通过内审」；内审收敛且带修订稿时说明改了什么。
    const audit = review.internalAudit
    const reviewPassedCopy =
      review.mode === 'rules'
        ? '需求已确认，我把它整理成了产品需求文档。请你过目，确认无误后我开始画草图。'
        : audit?.revisedBackplane
          ? `需求已确认，我把它整理成了产品需求文档，内审发现并自动修订了几个问题（${audit.defenderSummary ?? '已复核通过'}），修订稿已复核通过。请你过目这份 PRD，确认无误后我开始画草图。`
          : '需求已确认，我把它整理成了产品需求文档（已通过内审）。请你过目这份 PRD，确认无误后我开始画草图。'
    if (aborted()) return { started: true, prd_written: prdWritten }
    publish(makeGuideEvent(eventInput, 'message_delta', { text: reviewPassedCopy }))
    publish(makeGuideEvent(eventInput, 'message_completed', { subtype: 'success' }))
    // 市调想法（2026-08-29 灵感参考，用户拍板「提供想法、让他选择要不要」）：收敛链的
    // 过目点是四段式确认卡——市调+提炼挂在此处，点选收敛/让渡/generate_sketch 等
    // 所有入口都能看到想法区（此前只挂需求确认弹窗，点选回流失败降级走收敛链时
    // 用户完全看不到市调）。市调失败/无结果 → ideas 空，卡面不显示想法区。
    let reviewIdeas: ResearchIdea[] = []
    try {
      // 顾问式（2026-08-30）：需求名+首条描述 → LLM 改写聚焦查询词（失败降级需求清洗）
      const demandText = `${backplaneForReview.name}：${backplaneForReview.requirements[0]?.description ?? ''}`.slice(0, 200)
      const marketQueries = await buildResearchQueries(demandText, [], {
        query: pending.query ?? NO_QUERY_FALLBACK,
        env: reviewEnv,
        signal,
        sessionId: pending.session_id,
      })
      const research = await researchMarketSimilar(marketQueries)
      reviewIdeas = await distillResearchIdeas(research, {
        query: pending.query ?? NO_QUERY_FALLBACK,
        env: reviewEnv,
        signal,
        sessionId: pending.session_id,
        demand: demandText,
      })
    } catch {
      // 市调/提炼是增强不是依赖：失败不阻断确认卡
    }
    // 市调+提炼可达数十秒（fetch 15s + LLM）：期间用户停止 → 不再发卡（对齐
    // 「停止后不推进」不变式；否则停止后弹窗仍出现，状态错乱）
    if (aborted()) return { started: true, prd_written: prdWritten }
    publishPrdConfirmCard({
      input: {
        request_id: pending.request_id,
        session_id: pending.session_id,
        project_id: pending.project_id,
        mode: pending.mode,
        channel_id: pending.channel_id,
      },
      backplane: backplaneForReview,
      requirements,
      query: pending.query ?? NO_QUERY_FALLBACK,
      publish,
      ideas: reviewIdeas,
      signal,
    })
    return { started: true, prd_written: prdWritten }
  } else {
    // PRD 前移失败降级（不阻断草图）：话术如实披露 PRD 没能生成，不偽装已整理
    publish(makeGuideEvent(eventInput, 'message_delta', {
      text: '需求已确认。产品需求文档这次没能生成（稍后可重试），我按需求清单直接画草图。',
    }))
  }
  publish(makeGuideEvent(eventInput, 'message_completed', { subtype: 'success' }))

  // 用户停止：不再启动草图任务（草图全程 20~60s，停不掉会继续偷跑）
  if (aborted()) return { started: true, prd_written: prdWritten }
  // 设计参考接线（web-reference-extractor，2026-08-28）：仅 http(s)，3s 预算，
  // 任何失败降级空串不阻断确认（对齐 autoName/distill 降级纪律）
  const referenceSection = await buildReferenceSection(pending.reference_url)
  await runSketchTask({
    request_id: pending.request_id,
    session_id: pending.session_id,
    project_id: pending.project_id,
    mode: pending.mode,
    prompt: `按确认的需求清单生成草图${referenceSection}`,
    requirements,
    channel_id: pending.channel_id,
    query: pending.query,
    signal,
  })
  return { started: true, prd_written: prdWritten }
}

/** 用户在弹窗中的决策回传入口（IPC agent:confirm-requirements 的服务侧实现）。
 * confirm：按勾选子集开工；delegate：用户主动让渡，按向导整理的清单全量开工。
 * 两条路径都进入 runPrdPipeline（PRD→审查→确认卡→草图）。 */
export async function resolveRequirementConfirm(
  input: {
    request_id: string
    session_id: string
    project_id: string
    decision: 'confirm' | 'delegate'
    requirement_ids?: string[]
    /** 用户勾选采纳的市调想法（2026-08-29 灵感参考）：并入需求清单追加 F-00N */
    adopted_ideas?: string[]
    /** 可选参考网页链接（web-reference-extractor，2026-08-28）：仅 http(s)，提取失败静默降级 */
    reference_url?: string
  },
  /** AGENT_STOP 可中止信号（由 ipc.ts 注册 backgroundRun 后传入） */
  signal?: AbortSignal,
): Promise<{ started: boolean; prd_written: boolean }> {
  const pending = takePendingRequirementConfirm(input.project_id)
  if (!pending) return { started: false, prd_written: false }
  const publish = pending.publish

  const selected = pending.requirements.filter((item) => input.requirement_ids?.includes(item.id))
  const requirements =
    input.decision === 'delegate' || selected.length === 0 ? pending.requirements : selected

  // 勾选采纳的市调想法并入清单（2026-08-29 灵感参考）：想法→功能项追加 F-00N；
  // 只认 pending 里真实存在的 label（防篡改），去重防重复采纳
  const adopted = (input.adopted_ideas ?? [])
    .filter((label) => pending.ideas.some((idea) => idea.label === label))
  const existingDescriptions = new Set(requirements.map((item) => item.description.replace(/\s+/g, ' ').trim()))
  const mergedRequirements = [...requirements]
  for (const label of adopted) {
    const normalized = label.replace(/\s+/g, ' ').trim()
    if (!normalized || existingDescriptions.has(normalized)) continue
    existingDescriptions.add(normalized)
    mergedRequirements.push({
      id: nextRequirementId(mergedRequirements),
      description: `参考市面做法：${normalized}`,
      origin: 'user',
    })
  }
  const finalRequirements = mergedRequirements

  recordDecision({
    project_id: input.project_id,
    session_id: pending.session_id,
    entry: {
      type: 'requirement_confirmed',
      title: input.decision === 'delegate' ? '用户让渡：由向导决定需求' : '用户确认需求清单',
      why:
        input.decision === 'delegate'
          ? '用户在确认弹窗选择「由向导决定」，按向导整理的清单开工'
          : `用户在确认弹窗勾选 ${finalRequirements.length} 条需求开工${adopted.length > 0 ? `（含采纳市调想法 ${adopted.length} 条）` : ''}`,
      detail: {
        decision: input.decision,
        selected_ids: input.decision === 'delegate' ? undefined : requirements.map((item) => item.id),
        adopted_ideas: adopted.length > 0 ? adopted : undefined,
        requirements: finalRequirements,
      },
    },
  })

  // 收敛路径统一收口（2026-08-27）：后半链抽为 runPrdPipeline，与点选/让渡入口共用
  return runPrdPipeline({
    request_id: pending.request_id,
    session_id: pending.session_id,
    project_id: pending.project_id,
    mode: pending.mode,
    channel_id: pending.channel_id,
    requirements: finalRequirements,
    query: pending.query,
    env: pending.env,
    publish,
    reference_url: input.reference_url,
    signal,
  })
}

function parseGuideJson(text: string): GuideParsed | undefined {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return undefined
  }

  if (parsed.action === 'generate_sketch') {
    const requirements = (Array.isArray(parsed.requirements) ? parsed.requirements : [])
      .filter(isRecord)
      .filter((r) => typeof r.id === 'string' && typeof r.description === 'string')
      .slice(0, 5)
      .map((r) => ({
        id: r.id as string,
        description: r.description as string,
        origin: r.origin === 'guide' ? ('guide' as const) : r.origin === 'user' ? ('user' as const) : undefined,
      }))
    if (requirements.length < 1) return undefined
    return {
      action: 'generate_sketch',
      reply: typeof parsed.reply === 'string' ? parsed.reply : '',
      requirements,
    }
  }

  if (parsed.action === 'ask_clarification') {
    const questions = (Array.isArray(parsed.questions) ? parsed.questions : [])
      .filter(isRecord)
      .filter((q) => typeof q.id === 'string' && typeof q.label === 'string')
      // 预截取放宽到 8 条：占位/问句式坏选项要在纠偏（normalizeClarificationOptions）时
      // 才被丢弃，先截 3 条会让坏选项占坑挤掉后面的合法项
      .slice(0, 8)
      .map((q) => ({
        id: q.id as string,
        label: q.label as string,
        description: typeof q.description === 'string' ? q.description : undefined,
      }))
    return {
      action: 'ask_clarification',
      reply: typeof parsed.reply === 'string' ? parsed.reply : '',
      questions,
    }
  }

  if (parsed.action === 'confirm_requirements') {
    const requirements = (Array.isArray(parsed.requirements) ? parsed.requirements : [])
      .filter(isRecord)
      .filter((r) => typeof r.id === 'string' && typeof r.description === 'string')
      .slice(0, 5)
      .map((r) => ({
        id: r.id as string,
        description: r.description as string,
        origin: r.origin === 'guide' ? ('guide' as const) : r.origin === 'user' ? ('user' as const) : undefined,
      }))
    if (requirements.length < 1) return undefined
    const researchQueries = (Array.isArray(parsed.research_queries) ? parsed.research_queries : [])
      .filter((query): query is string => typeof query === 'string' && query.trim().length > 0)
      .slice(0, 2)
    return {
      action: 'confirm_requirements',
      reply: typeof parsed.reply === 'string' ? parsed.reply : '',
      requirements,
      research_queries: researchQueries,
    }
  }

  return undefined
}

function extractText(blocks: MessageContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

/** 渠道 base_url 的 host（厂商隔离判定用；渠道缺失/非法 URL → undefined）。 */
function channelHostOf(channel: { base_url?: string } | undefined | null): string | undefined {
  if (!channel?.base_url) return undefined
  try {
    return new URL(channel.base_url.trim()).host
  } catch {
    return undefined
  }
}

function makeGuideEvent(
  input: Pick<AgentSendMessageInput, 'session_id' | 'project_id'>,
  type: AgentEvent['type'],
  payload: Record<string, unknown>,
): AgentEvent {
  return {
    event_id: randomUUID(),
    session_id: input.session_id,
    project_id: input.project_id,
    type,
    payload,
    created_at: new Date().toISOString(),
  }
}
