/**
 * 向导主管线（PR4a 拆出）：handleGuideMessage 意图分流、guide loop 轮次（模型驱动澄清）、决策归一、事件发布。
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
import { resolvePrdBackplane, runSketchTask, setProgrammingEventPublisher, nextRequirementId, refineModificationDescription } from '../../coding/programming-orchestrator'
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

import { CLARIFICATION_ROUND_LIMIT, DEFAULT_GUIDE_SYSTEM_PROMPT, FIRST_TURN_RULE, GUIDE_LOOP_ADDENDUM, GuideParsed } from './guide-runtime'
import { GuideLoopOutcome, bumpFreeChatStreak, clarifyTwoLayerEnabled, collectClarificationAnswers, countSameOptionCards, countTrailingClarificationRounds, ensurePrimaryIntent, freeChatStreakOf, hasRecentReliefCard, normalizeClarificationOptions, normalizeGuideDecisionToParsed, publishClarificationCard, publishClarificationReliefCard, resetFreeChatStreak, resolveAutoDelegation, resolveCardAnswer, resolveClarificationReliefAnswer, trackClarificationResponded } from './clarify-flow'
import { startRequirementConfirmFlow } from './requirement-confirm'
import { runPrdPipeline } from './prd-pipeline'

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

  // Phase 7 U4 J2-②减负卡回答回流（2026-09-10，必须在普通卡片答案分流之前：选项 id
  // 专属，误入 resolveCardAnswer 会把按钮文案当需求开工）。先看方案→与熔断弹窗同一
  // 收敛链（已点选方向全量带上）；继续补充→如实 ack 等用户说，计数保留（再熔断弹窗兑底）。
  const reliefAnswer = resolveClarificationReliefAnswer(input)
  if (reliefAnswer) {
    // Phase 7 U5 J5：减负卡回答也入 clarification_responded（skip=先看方案不再答；
    // input=继续补充）
    trackClarificationResponded(input, reliefAnswer === 'see_plan' ? 'skip' : 'input')
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'clarification_relief_answer',
        title: reliefAnswer === 'see_plan' ? '减负卡：先看方案' : '减负卡：继续补充细节',
        why:
          reliefAnswer === 'see_plan'
            ? '用户在减负卡选择「先看方案」——按已了解目标整理清单进确认门，其余按推荐补齐、确认时可修改'
            : '用户在减负卡选择「继续补充细节」——澄清继续，计数保留（再熔断转弹窗兑底）',
        detail: { option: reliefAnswer },
      },
    })
    if (reliefAnswer === 'see_plan') {
      const collected = collectClarificationAnswers(input.session_id)
      const fallbackRequirements = ensurePrimaryIntent(
        collected.length > 0
          ? collected.map((item, index) => ({ id: `F-${String(index + 1).padStart(3, '0')}`, description: item }))
          : primaryIntent
            ? []
            : [{ id: 'F-001', description: input.content.slice(0, 40) }],
        primaryIntent,
      )
      if (fallbackRequirements.length === 0) {
        // 「你是谁」案补口：全疑问句被过滤 → 纯文本问目标，不弹空确认窗
        const askText = '我还不知道你想做什么——用一句话告诉我你想做的产品（比如「做一个记账本」），我们马上开始。'
        publish(makeGuideEvent(input, 'message_delta', { text: askText }))
        publish(makeGuideEvent(input, 'message_completed', { subtype: 'success' }))
        return
      }
      if (model) {
        await startRequirementConfirmFlow(
          input,
          publish,
          model,
          fallbackRequirements,
          [primaryIntent ?? input.content.slice(0, 20)].filter((query) => query.trim().length > 0),
          persistSystem,
          true,
        )
      } else {
        // 无模型配置（罕见）：降级直接进 PRD 后置链（自带确认门，不开工语义不变）
        await runPrdPipeline({
          request_id: input.request_id,
          session_id: input.session_id,
          project_id: input.project_id,
          mode: input.mode,
          channel_id: input.channel_id,
          requirements: fallbackRequirements,
          query: undefined,
          publish,
        })
      }
      return
    }
    const continueAck = '好的，请继续说，我在听；说完我帮你整理成方案过目。'
    persistAssistant?.(continueAck)
    publish(makeGuideEvent(input, 'message_delta', { text: continueAck }))
    publish(makeGuideEvent(input, 'message_completed', { subtype: 'success' }))
    return
  }

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
      const routedId = issue.location ? resolveRoutedRequirementId(issue.location, requirementIds) : undefined
      if (routedId) {
        const directive = `${routedId} 的修改诉求：${answerText}`
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
      appendSessionMessage(input.session_id, {
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
    // Phase 7 U5 J5：clarification_responded 埋点（回答方式=选择；漏斗中层数据）
    trackClarificationResponded(input, 'select')

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
    // Phase 7 U5 J5：clarification_responded 埋点（回答方式=委托；E3「委托是有效授权」度量基线）
    trackClarificationResponded(input, 'delegate')
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
// ---- 向导 loop 化（Phase 10，2026-09-16）：模型调用层的 loop 实现 ----

/** free_chat 连续计数（内存态：进程内有效；决策即清零——跨重启丢失可接受，防线只防当场聊天不收敛）。 */
export const freeChatStreaks = new Map<string, number>()

/**
 * 向导 loop 轮（BLOMA_GUIDE_LOOP=on）：一次用户消息 = 一次 loop run。
 * - 自由度：模型可先调只读事实工具、可自然对话（旁白经 message_delta 上屏并落 JSONL）；
 * - 收敛口：guide_decide 工具提交决策（onDecide 持有者带回）；
 * - 防线：free_chat 连续 ≥3 轮时，task 尾部注入宿主提醒（只影响本轮模型可见，不落盘）；
 * - 事件面：只转发 message_delta（渲染端零改动），tool_call/loop_* 事件不上屏；
 * - delegationDepth=1：退出主 loop 专属注入（steer/B3/W5/learnings 不适用向导）。
 * 任何异常/取消 → failed，调用方回退规则路由（与旧路径同款兜底）。
 */
export async function runGuideLoopTurn(
  input: AgentSendMessageInput,
  publish: GuideEventPublisher,
  model: GuideModelOptions,
  baseSystem: string,
): Promise<GuideLoopOutcome> {
  const holder: { decision: GuideDecision | null } = { decision: null }
  const tools = buildGuideTools(input.project_id, { onDecide: (decision) => { holder.decision = decision } })
  const reminder = freeChatStreakOf(input.session_id) >= 3
    ? '\n\n【宿主提醒】已连续多轮自由对话未收敛：请在本轮用 guide_decide 提交决策（问一个关键问题，或需求已闭环时整理清单确认）。'
    : ''
  let result: Awaited<ReturnType<typeof runAgentLoop>> | undefined
  try {
    result = await runAgentLoop({
      system: `${baseSystem}${GUIDE_LOOP_ADDENDUM}`,
      task: `${input.content}${reminder}`,
      historyTurns: model.history,
      tools,
      query: model.query,
      env: model.env,
      signal: model.signal,
      sessionId: model.sessionId,
      projectId: input.project_id,
      requestId: input.request_id,
      maxTokens: model.maxTokens,
      maxTurns: 6,
      permissionMode: 'allow-all',
      delegationDepth: 1,
      ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
      publish: (type, payload) => {
        if (type === 'message_delta') publish(makeGuideEvent(input, 'message_delta', payload))
      },
    })
  } catch {
    return { kind: 'failed' }
  }
  if (!result) return { kind: 'failed' }
  if (holder.decision) {
    try {
      recordDecision({
        project_id: input.project_id,
        session_id: input.session_id,
        entry: { type: 'guide_loop', title: `向导决策：${holder.decision.action}`, why: holder.decision.reply.slice(0, 120), detail: { via: 'loop', outcome: 'decision', action: holder.decision.action } },
      })
    } catch {
      /* 决策日志失败不影响流程 */
    }
    return { kind: 'decision', decision: normalizeGuideDecisionToParsed(holder.decision) }
  }
  if ((result.status === 'completed' || result.status === 'turn_limit') && result.finalText.trim()) {
    return { kind: 'free_chat', text: result.finalText }
  }
  return { kind: 'failed' }
}

export async function tryModelDrivenGuide(
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

  // —— 模型调用层（Phase 10 向导 loop 化，2026-09-16；旧单次 JSON 路径已删 2026-10-01）——
  // runAgentLoop + 向导工具面（自由对话 + 只读事实 + guide_decide 决策工具）；
  // 决策经工具原生入参提交（根治 parseGuideJson 的 PARSE_FAILED/截断旧病），
  // 下游路由/熔断/确认门零改动。
  let parsed: GuideParsed | null = null
  const loop = await runGuideLoopTurn(input, publish, model, baseSystem)
  if (loop.kind === 'decision') {
    parsed = loop.decision
    resetFreeChatStreak(input.session_id)
  } else if (loop.kind === 'free_chat') {
    // 纯聊天：旁白已由 loop 上屏+落 JSONL，这里只收口事件；阶段不动，等下一条用户消息
    bumpFreeChatStreak(input.session_id)
    try {
      recordDecision({
        project_id: input.project_id,
        session_id: input.session_id,
        entry: { type: 'guide_loop', title: '向导自由对话轮（未决策）', why: `free_chat 连续 ${freeChatStreakOf(input.session_id)} 轮`, detail: { via: 'loop', outcome: 'free_chat' } },
      })
    } catch {
      /* 决策日志失败不影响对话 */
    }
    publish(makeGuideEvent(input, 'message_completed', { subtype: 'success' }))
    return true
  } else {
    // 失败/取消：回退规则路由（与旧路径同款兜底）
    return false
  }
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
    // Phase 7 U4 J2-②（BLOMA_CLARIFY_TWO_LAYER on 且未发过减负卡）：第三张连续卡
    // 先转对话内减负卡（[先看方案][继续补充细节]）；「先看方案」走同款收敛链，
    // 「继续补充」后计数保留——再熔断直接弹窗兑底（弹窗仍是最后兑底）。
    if (clarifyTwoLayerEnabled() && !hasRecentReliefCard(input.session_id)) {
      const reliefReply =
        '我已了解主要目标，可以先给你一版方案，其余按推荐补齐、确认时可以修改。也可以继续补充细节。'
      model.persistAssistant(reliefReply)
      publish(makeGuideEvent(input, 'message_delta', { text: reliefReply }))
      publish(makeGuideEvent(input, 'message_completed', { subtype: 'success' }))
      publishClarificationReliefCard(input, publish, reliefReply)
      return true
    }
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
    if (fallbackRequirements.length === 0) {
      // 「你是谁」案补口：主题与点选全是疑问句被过滤 → 不弹空清单确认窗，纯文本问一句目标
      const askText = '我还不知道你想做什么——用一句话告诉我你想做的产品（比如「做一个记账本」），我们马上开始。'
      model.persistAssistant(askText)
      publish(makeGuideEvent(input, 'message_delta', { text: askText }))
      publish(makeGuideEvent(input, 'message_completed', { subtype: 'success' }))
      return true
    }
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
    // Phase 7 U4 J2-①（BLOMA_CLARIFY_TWO_LAYER on）：同一问题最多换方式追问一次——
    // 序列内选项集与待发卡完全相同且已有 2 张（这是第 3 张）→ 不再注入同主题卡，
    // 转减负卡出口（精确去重宁漏勿误，换措辞的不同题不算重复）。
    const normalizedQuestions = normalizeClarificationOptions(parsed.questions)
    if (
      clarifyTwoLayerEnabled() &&
      normalizedQuestions.length > 0 &&
      !hasRecentReliefCard(input.session_id) &&
      countSameOptionCards(input.session_id, normalizedQuestions.map((q) => q.label)) >= 2
    ) {
      const sameTopicReply = '这个问题我们已经讨论过一轮了——我先按已有信息出方案，其余按推荐补齐、确认时可以修改。'
      model.persistAssistant(sameTopicReply)
      publish(makeGuideEvent(input, 'message_delta', { text: sameTopicReply }))
      publish(makeGuideEvent(input, 'message_completed', { subtype: 'success' }))
      publishClarificationReliefCard(input, publish, sameTopicReply)
      return true
    }
    // 已发过减负卡：同主题不再单独拦截——熔断计数兑底（trailing 到 3 必弹窗）
    updateProject(input.project_id, { current_stage: 'blocked_for_user_decision' })
    publish(makeGuideEvent(input, 'stage_changed', { stage: 'blocked_for_user_decision' }))
    publishClarificationCard(input, publish, normalizedQuestions, persistSystem, parsed.reply.trim())
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

export function makeGuideEvent(
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

