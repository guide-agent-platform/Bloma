/**
 * PRD 收敛链（PR4a 拆出）：runPrdPipeline 统一收口（需求工程腿+六维审查+熔断转确认）。
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

import { channelHostOf } from './guide-runtime'
import { PRD_REVIEW_ROUND_LIMIT, countTrailingPrdReviewRounds } from './clarify-flow'
import { makeGuideEvent } from './guide-pipeline'
import { buildWebLineRetiredCardPayload } from '../web-line-retired'
import { takePendingRequirementConfirm } from './requirement-confirm'
import { NO_QUERY_FALLBACK, PrdPipelineContext, buildResearchQueries, distillResearchIdeas, generateAgentIdeas, researchModeResolver } from './research-flow'

/**
 * PRD 后置链（收敛路径统一收口，2026-08-27）：
 * PRD 前移落盘（requirement_confirmed，早于草图，失败不阻断）→ 六维审查门 →
 * 通过则四段式确认卡挂起（「PRD 不过目不开工」不变式）/ 未过则审查决策卡 /
 * PRD 生成失败如实降级直接草图。
 * 三条收敛入口共用：模型判定（confirm_requirements 弹窗确认）、点选澄清卡、让渡。
 * 此前点选/让渡直接 runSketchTask（8-22 澄清死循环修复时代的捷径），绕过全套
 * 确认仪式——线上首测实测主路径 0 触发确认卡（排查报告 🔴1/🔴2，2026-08-27）。
 */
export async function runPrdPipeline(pending: PrdPipelineContext): Promise<{ started: boolean; prd_written: boolean }> {
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

  // 呈现层修复（2026-10-04 确认门批）：确认点击后 PRD 生成腿不再是零反馈黑盒——
  // 即时旁白 + 阶段脱离 blocked_for_user_decision（实测 glm 双调用 3 分钟+，期间
  // 界面停在「等待用户决策」且一字不发，用户视感「点确认没反应」）。
  gatedPublish(makeGuideEvent(eventInput, 'stage_changed', { stage: 'clarifying' }))
  gatedPublish(makeGuideEvent(eventInput, 'message_delta', {
    text: '已收到确认，正在整理需求文档（PRD）并交内审，全程约需一到三分钟，期间可以随时停止。',
  }))

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
        const seriousLeft = review.issues.filter((issue) => issue.severity === 'blocking' || issue.severity === 'major').length
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
          env: pending.env,
          publish,
          // 狗粮 a602709f 实证：盲过目确认漏掉用户亲答的「要，关掉还在」。答案已定向并入
          // 需求清单（resolveRoutedRequirementId），但残余未解问题数如实告知，提醒重点过目。
          reviewNote: `已连续 ${PRD_REVIEW_ROUND_LIMIT} 轮确认；你此前的逐题作答已并入下方需求清单，仍有 ${seriousLeft} 个较严重问题未解，请重点过目功能清单是否覆盖你的要求`,
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
      // R2：缺省 agent 模式（纯模型灵感建议，零网络请求）；scrape 逃生口保留原链路
      const demandText = `${backplaneForReview.name}：${backplaneForReview.requirements[0]?.description ?? ''}`.slice(0, 200)
      if (researchModeResolver() === 'agent') {
        reviewIdeas = await generateAgentIdeas(demandText, {
          query: pending.query ?? NO_QUERY_FALLBACK,
          env: reviewEnv,
          signal,
          sessionId: pending.session_id,
        })
      } else {
        // 顾问式（2026-08-30）：需求名+首条描述 → LLM 改写聚焦查询词（失败降级需求清洗）
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
      }
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
      // R2：模式随卡透出（agent=纯模型灵感建议）
      ideasMode: researchModeResolver(),
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
  // web 线拆除刀1/2（2026-10-01）：降级腿不再直接画草图（web 生成线已退役），
  // 改发形态引导卡（回传处理在 agent-dispatch 的 resolveWebLineRetiredCard）。
  publish(makeGuideEvent(eventInput, 'user_decision_required', buildWebLineRetiredCardPayload()))
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

  // P7-9b 后续批（2026-09-11）：decision_selected 其余卡接线④——需求确认弹窗
  //（confirm/delegate；独立 IPC 通道不走 runAgent card_option 链，在此单独埋）
  try {
    trackAnalytics({
      request_id: input.request_id,
      event: {
        event_type: 'decision_selected',
        project_id: input.project_id,
        session_id: input.session_id,
        payload: {
          stage: 'requirement_confirm',
          action: input.decision,
          selected_count: input.decision === 'delegate' ? undefined : (input.requirement_ids?.length ?? 0),
          adopted_ideas_count: input.adopted_ideas?.length ?? 0,
        },
        privacy_level: 'research_safe',
      },
    })
  } catch {
    // 埋点失败不影响确认链
  }

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

