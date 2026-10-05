/**
 * 向导运行时件（PR4a 拆出）：默认系统提示词、Guide JSON 解析、消息文本抽取、渠道主机判定。
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
import type { PrdBackplane, SketchRequirement } from '../../coding/sketch-engine'
import { isRecord } from '../../../shared/validators'

type GuideEventPublisher = (event: AgentEvent) => void

import { normalizeClarificationOptions } from './clarify-flow'

/** 引导对话给模型的结构化指令：模型只输出 JSON 二选一（对齐 A2-14a Step 3 模板）。 */
export const DEFAULT_GUIDE_SYSTEM_PROMPT = `你是「向导 Agent」，一位经验丰富的产品向导，负责把用户的想法变成可以开工的软件需求。只输出一个 JSON 对象，不要任何多余文字，不要 markdown 代码块围栏。

你的提问策略完全由你根据这个需求的实际情况自主决定——像一个真正的产品经理拿到这个需求时自然会问的问题：它可能关于形态、场景、数据，或任何这个需求特有的疑点。没有任何预设清单或固定流程：需求说得够具体就少问甚至不问、直接整理确认；说得笼统就问到你能写出具体可验收的 PRD 为止。

判断标准只有一条：**你能否写出一份「主流程闭环」的可验收功能清单**——拿它做出来的东西，用户能完整走一遍「打开产品 → 输入/发起 → 拿到核心结果 → 查看 → 管理/留存」。清单不闭环就还不能收敛：能自己补的（查看/管理/留存这类闭环路径）直接补成 origin=guide 功能项，只有影响成品形态的缺口才需要问（ask_clarification）。问的质量标准：用户看完你的问题会想起自己没说出口的想法，而不是感觉在填表。

硬性底线（不可违反）：
- 用户表达不想答/没想法/让你定（「你定」「随便」「就这样吧」）→ 按合理理解收敛，不把问题抛回。
- 历史里已答过的信息不重复问；「上轮已向用户出示的选项」不得原样再出。
- 拿不准就问，但问必有目的（每个问题都指向一个影响成品形态的未知点）。

【用户贴图时】（2026-10-06 体验批 D）：
用户消息可能附带界面截图或参考图。看到图片时：先在内部归纳图中界面的关键元素（布局、控件、功能区域），再结合文字需求理解意图；图与文字矛盾或图中有关键区域看不清时，把疑点纳入提问。「照这个做」类需求按图中界面提取结构与功能进 PRD（成品形态仍遵循桌面唯一品类）。若当前渠道不支持视觉（图片内容未能读取），必须如实告知并请用户文字描述关键界面，**严禁虚构对图片的理解**。

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

export type GuideParsed =
  | { action: 'generate_sketch'; reply: string; requirements: GuideRequirementItem[] }
  | { action: 'ask_clarification'; reply: string; questions: { id: string; label: string; description?: string }[] }
  | { action: 'confirm_requirements'; reply: string; requirements: GuideRequirementItem[]; research_queries: string[] }

/** 向导输出的功能项：origin 标提出者（user/guide），需求确认弹窗据此标「向导补充」 */
export interface GuideRequirementItem {
  id: string
  description: string
  origin?: 'user' | 'guide'
}

/**
 * 首轮硬护栏（附加到系统提示尾部）：需求确认是产品闭环的必经一环，不能因模型采样差异被跳过
 * （2026-08-16 赛车模拟器案例：同样输入一天前澄清、一天后直出草图，用户全程零确认）。
 */
export const FIRST_TURN_RULE = `

本轮提示：这是用户在本次会话的第一条消息。绝大多数一句话想法都还不足以直接开工——若你对需求的理解还写不出具体可验收的功能清单，必须先输出 ask_clarification（问最影响成品形态的那个未知点）；只有用户首条消息已经足够具体时才可输出 confirm_requirements。无论哪种，都不允许跳过确认直接开工——平台有 PRD 确认门兜底。`

/** 向导 loop 化附录（Phase 10，2026-09-16，BLOMA_GUIDE_LOOP=on 时追加到 system 尾部）：
 *  覆盖「只输出 JSON」旧格式指令——决策改由 guide_decide 工具提交，旁白可自然对话，
 *  可先用只读事实工具了解项目现状。护栏（确认门/熔断/让渡）不变，全部在宿主侧。 */
export const GUIDE_LOOP_ADDENDUM = `

【对话与决策（工具模式）】本段优先级最高，与上文格式指令冲突时以本段为准：
- 不要输出 JSON 文本。结构化决策用 guide_decide 工具提交（参数含义与旧格式一致）。
- 可以自然对话：呼应用户的想法、补充建议、回答追问；旁白写给用户看（简体中文），不要提前复述 guide_decide 里将提交的 reply。
- 需要了解项目现状时，先调用 read_prd_backplane / read_test_report / list_project_files 再决定问什么（迭代类需求尤其先看报告）。
- 除纯寒暄/纯答疑外，每轮应以一次 guide_decide 结束：问最影响成品形态的关键问题（ask_clarification），或需求已闭环时整理清单确认（confirm_requirements）。
- 决策提交后即等待用户回应，不要继续输出。`

/**
 * 规则路由三张固定卡片（日常生活/工作提效/你帮我决定）→ 草图需求扩写。
 * 卡片答案是结构化决策：用户已选方向，直接生成草图（修复规则路由澄清死循环）。
 * 仅在点选文案与 FIXED_CARD_LABELS 完全一致时启用；其余一律以点选原文为需求。
 */
export const CARD_ANSWER_REQUIREMENTS: Record<string, string> = {
  daily: '日常生活工具：帮助管理日常事务，如记账、提醒、清单',
  work: '工作提效工具：帮助提升工作场景效率，如流程、协作、记录',
  auto: '通用实用软件工具，由向导按常见做法生成第一版',
}

/**
 * 规则路由三张固定卡片的 label → 选项 id。只有点选文案与固定卡片完全一致时才用
 * 预置需求扩写；模型卡片可能复用同名 id（如 daily）但含义不同，一律以点选原文
 * 为准，防止 id 撞车把需求映射到毫不相干的预置文案上。
 */
export const FIXED_CARD_LABELS: Record<string, string> = {
  daily: '日常生活工具',
  work: '工作提效工具',
  auto: '你帮我决定',
}

/** 阻塞态让渡卡片的决策 id（accept/explain/continue/regenerate）由 resumeBlockedFlow 处理，不得误入草图生成。 */
export const BLOCKED_DECISION_IDS = new Set([
  'accept',
  'explain',
  'continue',
  'regenerate',
  PRD_REVIEW_OPTION_OVERRIDE,
  PRD_REVIEW_OPTION_SUPPLEMENT,
  PRD_CONFIRM_OPTION_CONFIRM,
  PRD_CONFIRM_OPTION_ADJUST,
])

/** 兜底选项：每张澄清卡片固定收尾，保证用户永远有「不选具体方向也能开工」的出口。 */
export const AUTO_ESCAPE_OPTION: ClarificationOption = {
  id: 'auto',
  label: '你帮我决定',
  description: '交给我，按常见做法先出一版',
}

/** 澄清轮次熔断阈值：连续出示 N 张澄清卡仍不明确 → 代码级转入需求确认弹窗（D3 修订 2026-08-26；原「强制 auto 开工」语义已被弹窗化取代）。 */
export const CLARIFICATION_ROUND_LIMIT = 3

export function parseGuideJson(text: string): GuideParsed | undefined {
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

export function extractText(blocks: MessageContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

/** 渠道 base_url 的 host（厂商隔离判定用；渠道缺失/非法 URL → undefined）。 */
export function channelHostOf(channel: { base_url?: string } | undefined | null): string | undefined {
  if (!channel?.base_url) return undefined
  try {
    return new URL(channel.base_url.trim()).host
  } catch {
    return undefined
  }
}

