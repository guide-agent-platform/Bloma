/**
 * 需求确认流（PR4a 拆出）：待确认快照、确认启动流、resolveRequirementConfirm 出口。
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

import { CLARIFICATION_ROUND_LIMIT } from './guide-runtime'
import { PendingRequirementConfirm, pendingRequirementConfirms } from './clarify-flow'
import { makeGuideEvent } from './guide-pipeline'
import { buildResearchQueries, distillResearchIdeas, generateAgentIdeas, researchModeResolver } from './research-flow'

export function takePendingRequirementConfirm(projectId: string): PendingRequirementConfirm | undefined {
  const pending = pendingRequirementConfirms.get(projectId)
  pendingRequirementConfirms.delete(projectId)
  return pending
}

/** 挂起弹窗失效（全链路审查 P1-8，2026-10-02）：用户新消息进入 guide 对话即失效旧弹窗——
 *  防止「弹窗挂起期间继续聊改需求，之后回头点旧弹窗确认」把旧快照落盘、丢弃期间新需求
 *  （stale 覆盖）。失效后点旧弹窗返回 started:false（渲染端已有处理）；新对话收敛出新弹窗。 */
export function invalidatePendingRequirementConfirm(projectId: string, reason = 'new_user_message'): boolean {
  const had = pendingRequirementConfirms.delete(projectId)
  if (had) console.debug(`[requirement-confirm] 挂起弹窗失效（${reason}）：需求已继续演化，旧快照不再可确认`)
  return had
}

/** 挂起中查询（观察点，不消费——测试与诊断用）。 */
export function hasPendingRequirementConfirm(projectId: string): boolean {
  return pendingRequirementConfirms.has(projectId)
}

/** 需求确认弹窗主流程：市调（增强不阻断）→ 落盘留痕 → pending 状态 → 弹窗事件。 */
export async function startRequirementConfirmFlow(
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

  // 市调/灵感：R2（2026-09-12 用户拍板 cut 网络搜索）缺省纯模型灵感建议（零网络请求）；
  // BLOMA_RESEARCH_MODE='scrape' 回到现状搜索链路（增强不是依赖，失败降级弹窗照常出）
  const demandText = requirements.map((item) => item.description).join('；').slice(0, 200)
  let research: MarketResearch = { available: false, queries: [], results: [], summary: '' }
  let ideas: ResearchIdea[] = []
  const researchMode = researchModeResolver()
  if (researchMode === 'scrape') {
    // 顾问式（2026-08-30）：需求+候选词 → LLM 改写聚焦查询词（失败降级候选词/需求清洗）
    const marketQueries = await buildResearchQueries(demandText, researchQueries, model)
    research = { available: false, queries: marketQueries, results: [], summary: '' }
    try {
      research = await researchMarketSimilar(marketQueries)
    } catch {
      // researchMarketSimilar 内部已降级，此处双保险
    }
    ideas = await distillResearchIdeas(research, { ...model, demand: demandText })
  } else {
    ideas = await generateAgentIdeas(demandText, model)
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
        // R2：模式如实入账（agent=纯模型灵感建议，未发网络请求）
        research_mode: researchMode,
      },
    },
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
      // R2：模式标记（渲染端据此把想法区头切换为「AI 灵感建议」，不冒充市调）
      mode: researchMode,
    },
  }))
}

/** 市调想法提炼提示词：把搜索结果提炼成可勾选采纳的「市面上的做法」短句。 */
export const RESEARCH_IDEA_SYSTEM_PROMPT = [
  '你是产品向导。根据【用户需求】，把调研结果里与之强相关的市面做法提炼成 3~5 条「市面上的做法/玩法」供用户参考勾选。',
  '每条：label（≤20 字玩法短句，如「虚拟键盘实时弹奏」）、note（≤40 字要点说明）、source（来源域名）。',
  '相关性是硬标准：与用户需求无关的搜索结果直接忽略，不要提炼；宁可少给，绝不硬凑不相关的做法。',
  '只提炼搜索结果里真实出现的做法，不臆造；结果不足 3 条时有多少给多少。',
  '输出严格 JSON：{"ideas":[{"label":"…","note":"…","source":"…"}]}，不要输出其他内容。',
].join('\n')

// ---------------------------------------------------------------------------
// R2（2026-09-12 用户拍板「cut 掉网络搜索环节，只由 agent 提创造性建议」）：
// 大陆网络三大 scraping 引擎全线不可靠（DDG 封锁 / cn.bing 反爬罐头 / 百度限频，
// 见 R1 复盘），市调价值链改由模型自身产品知识承担：不发任何网络请求，向导直接
// 就需求提出灵感建议。BLOMA_RESEARCH_MODE 缺省 agent；'scrape' 逃生口保留
// （配好付费搜索 API/代理后可切回）。
// ---------------------------------------------------------------------------

