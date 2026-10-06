/**
 * 市调流（PR4a 拆出）：模式解析、Agent 想法生成、提炼降级、检索词构建。
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
import { buildClarifyInjection } from '../../agent/prompting/template-injection'
import { captureConstraints, extractConstraints, readProjectConstraints } from '../constraint-extractor'
import { isAutoDelegationText, readPrimaryIntent } from '../../platform/sessions/session-service'
import type { PrdBackplane, SketchRequirement } from '../../coding/sketch-engine'
import { isRecord } from '../../../shared/validators'

type GuideEventPublisher = (event: AgentEvent) => void

import { RESEARCH_IDEA_SYSTEM_PROMPT } from './requirement-confirm'
import { runPrdPipeline } from './prd-pipeline'

/** 市调模式解析：'scrape'=现状搜索链路；其余（未设/'agent'）=纯模型灵感建议。 */
export function researchModeResolver(): 'agent' | 'scrape' {
  const raw = (process.env.BLOMA_RESEARCH_MODE ?? '').trim().toLowerCase()
  if (raw === 'scrape' || raw === 'search' || raw === '1' || raw === 'on') return 'scrape'
  return 'agent'
}

/** agent 灵感建议提示词：基于模型自身产品知识，不搜索、不臆造不存在的具体产品。 */
export const AGENT_IDEA_SYSTEM_PROMPT = [
  '你是产品灵感顾问。根据【用户需求】，基于你掌握的产品与设计知识（不搜索网络）提出 3~5 条创造性灵感建议，供用户参考勾选。',
  '方向：同类产品的经典玩法/交互模式、差异化设计点、可借鉴的成熟机制——要具体到能落进这个需求，不要泛泛而谈。',
  '每条：label（≤20 字玩法/设计短句，如「Boss 血量阶段化弹幕」）、note（≤40 字说明参考什么与为什么值得借鉴）。',
  '硬标准：与需求强相关、不与需求已有内容重复、宁可少给绝不硬凑；可以引经典同类产品名（如雷电、Ikaruga），但不要编造不存在的具体产品。',
  '输出严格 JSON：{"ideas":[{"label":"…","note":"…"}]}，不要输出其他内容。',
].join('\n')

/**
 * R2 agent 灵感建议：单轮 LLM 调用（与 distillResearchIdeas 同款管道风格）；
 * 失败/解析失败/空数组 → []（想法区隐藏，弹窗照常——与市调降级同纪律）。
 * idea.source 固定 'AI 建议'（渲染端来源标签如实区分，不冒充市调来源）。
 */
export async function generateAgentIdeas(
  demand: string,
  opts: { query: SDKQuery; env?: Record<string, string>; signal?: AbortSignal; sessionId?: string },
): Promise<ResearchIdea[]> {
  const demandText = demand.trim()
  if (!demandText) return []
  try {
    let accumulated = ''
    const stream = opts.query(`【用户需求】\n${demandText}`, {
      env: opts.env ?? {},
      signal: opts.signal ?? new AbortController().signal,
      sessionId: opts.sessionId ?? '',
      history: [{ role: 'system', content: AGENT_IDEA_SYSTEM_PROMPT }],
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
    if (start < 0 || end <= start) return []
    const parsed = JSON.parse(accumulated.slice(start, end + 1)) as { ideas?: Array<{ label?: unknown; note?: unknown }> }
    if (!Array.isArray(parsed.ideas)) return []
    const ideas = parsed.ideas
      .filter((item) => typeof item?.label === 'string' && item.label.trim().length > 0)
      .slice(0, 5)
      .map((item) => ({
        label: String(item.label).replace(/\s+/g, ' ').trim().slice(0, 20),
        note: typeof item.note === 'string' ? String(item.note).replace(/\s+/g, ' ').trim().slice(0, 40) : '',
        source: 'AI 建议',
      }))
    return ideas
  } catch {
    return []
  }
}

/**
 * 市调想法提炼（2026-08-29 灵感参考改造，用户拍板「向导整理提供给用户看、让他选择要不要」）：
 * 优先 LLM 把搜索结果提炼成玩法短句；失败/无模型/无结果降级用原始条目
 * （title 当 label、snippet 截断当 note）——零 LLM 也保证想法区可用。
 * 查询参数取最小面（query/env/signal/sessionId），需求确认弹窗（GuideModelOptions）
 * 与 PRD 确认卡（runPrdPipeline 只有裸 query/env）两处调用方都能供给。
 */
export async function distillResearchIdeas(
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

export function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** 市调查询词构造提示词（顾问式，2026-08-30）：需求理解 → 具体可检索查询词。 */
export const RESEARCH_QUERY_SYSTEM_PROMPT = [
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
export async function buildResearchQueries(
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
export interface PrdPipelineContext {
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
export const NO_QUERY_FALLBACK: SDKQuery = async function* (): AsyncGenerator<never> {
  throw new Error('NO_MODEL_QUERY')
}

