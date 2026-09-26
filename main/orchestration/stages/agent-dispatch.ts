/**
 * 主编排分发（PR4b 拆出）：runAgent 意图分流与阶段推进主链。
 * 纯机械搬移（零行为变化）；对外契约经 orchestrator re-export 保持不变。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentCancelInput,
  AgentCancelResult,
  AgentEvent,
  AgentLoopJudgeMetadata,
  AgentMessage,
  AgentSendMessageInput,
  AgentSendMessageResult,
  MessageContentBlock,
  PastedImageRef,
  SDKMessage,
  WorkflowStage,
} from '../../../shared/types'
import { getAgentSessionPath } from '../../../storage/config-paths'
import { appendJsonLine } from '../../../storage/json-store'
import { appendSessionMessage } from '../../platform/sessions/session-tree'
import { buildThinkingFragment, type ThinkingLevel } from '../../../shared/reasoning-profile'
import { SessionMessageQueue, type QueueEntry } from '../../platform/sessions/message-queue'
import { clearSteerQueue, rejectPendingSteer, steerConfirmEnabled, type SteerLedgerEntry } from '../../agent/loop/steer-queue'
import { emitAgentEvent } from '../../platform/events/agent-event-bus'
import { hydrateMessagesImageBlocks } from '../../platform/shell/pasted-images'
import { trackAnalytics } from '../../delivery/track-analytics'
export { buildSdkEnv } from '../../platform/llm/channel-manager'
import {
  extractErrorStatusCode,
  isInfrastructureFailure,
  isUserCancelledQuery,
  pickBackupChannelEnv,
  readFallbackContext,
  recordChannelSwitch,
  resolveChannelEnv,
} from '../../platform/llm/runtime-fallback'
import { categoryForStage, categoryTemperature } from '../../platform/llm/model-resolution'
import { handleGuideMessage } from '../../guide/guide-agent-service'
import { handleDesktopDispatchMessage, isDesktopLineActive } from '../../desktop/desktop-route'
import {
  READY_COMPLETION_COPY,
  clearPendingReviewAction,
  feedbackCardEnabled,
  isIterationDecisionId,
  nextRequirementId,
  publishDeliveryFeedbackCard,
  publishReadyNextStepsCard,
  refineModificationDescription,
  resolveBlockedDecision,
  resumeBlockedFlow,
  runBlockedTestRepair,
  ensureResumePreview,
  runAgentLoopPostTesting,
  runIterationTask,
  runSketchTask,
  setPendingReviewAction,
  setProgrammingEventPublisher,
  takeFailedIteration,
  takePendingReviewAction,
} from '../../coding/programming-orchestrator'
import { applyNormalization, normalizeRequirementUpdate, recordRequirementNormalization } from '../../guide/requirement-normalizer'
import { readPrdBackplane } from '../../project/document-engine'
import { backplaneInterfaceSpec } from '../../model/prd-backplane'
import { isDegenerateText } from '../../coding/output-integrity'
import { createWhitespaceArtifactCleaner } from '../../agent/loop/agent-loop'
import { recordDecision } from '../../project/decision-log'
import { captureConstraints, extractConstraints, readProjectConstraints, scanSessionConstraints } from '../../guide/constraint-extractor'
import { isCircuitBreakSettled } from '../../project/recovery-service'
import { addScopeExclusion, findProject, readLastSketchRequirements, recordSketchGenerated, updateProject } from '../../project/project-service'
import { recordSessionActivity } from '../../platform/sessions/session-service'
import { appendExperienceEvent } from '../../experience/event-log'
import { isThinkingLogEnabled, logThinking } from '../../agent/loop/thinking-log'
import { extractErrorMessage } from '../../platform/llm/channel-test-error'
import { anthropicMessagesQueryViaProviders, providerAdapterEnabled } from '../../platform/upstream/providers/loop-query'

import { ConversationTurn, GuideModelOptions } from './orchestration-contracts'
import { ActiveRun, activeSessions, registerForegroundRun, releaseProjectRun, sessionMessageQueue } from './run-registry'
import { runWithRetry, sdkQuery, streamPublisher } from './sdk-glue'
import { buildReadyChatFacts, buildReadyChatSystem, readyChatEnabled, runReadyStageChat } from './ready-chat'
import { cancelAgent } from './lifecycle'
import { appendAgentMessage, convertSDKMessage, detectCodeDelivery, extractAssistantText, isUserCancelled, makeEvent, persistAssistantMessages, persistTerminalMessage, publishRunEvent } from './persistence'
import { HISTORY_WINDOW_TURNS, buildProgrammingSystemTurn, loadConversationHistory, publishRebuildConfirmCard, shouldUseGuideAgent, truncateForCopy } from './dispatch-support'
import { PROGRESS_QUERY_RE, REFINE_CANCEL_RE, TRIVIAL_ACK_RE, resolveIterationDecisionFlow, resolveModificationIntent } from './intent-routing'

export async function runAgent(input: AgentSendMessageInput): Promise<AgentSendMessageResult> {
  if (activeSessions.has(input.session_id)) {
    // message-queue（message-queue-port.md P1，2026-08-27）：生成期间消息排队不丢——
    // 排队中仅 UI 投影（queued 态），run 完成后自动派发；用户可撤回。
    sessionMessageQueue.enqueue(input.session_id, {
      queueMessageId: input.request_id,
      userMessage: input.content,
      input,
    })
    return { accepted: true, session_id: input.session_id, stream_started: false, queued: true }
  }
  const runId = randomUUID()
  const abortController = new AbortController()
  const run: ActiveRun = {
    abortController,
    projectId: input.project_id,
    runId,
    publisher: streamPublisher,
  }
  registerForegroundRun(input, run)

  const received: SDKMessage[] = []
  // message-queue：run 终态收口判断用户是否主动停止（isUserCancelled 分支置 true）
  let stoppedByUser = false

  try {
    // 权威项目阶段（工作项 1）：以项目存储为准，渲染端上报阶段仅为回退。
    // 前移到渠道解析之前——类别路由（§6.4）需要按阶段选文档类别。
    let authoritativeStage: WorkflowStage = input.current_stage
    try {
      authoritativeStage = findProject(input.project_id).current_stage
    } catch {
      // 项目索引缺失（如测试环境）时退回渲染端上报的阶段
    }

    // 渠道 + 类别 → env 统一收口（runtime-fallback）：类别路由（§6.4）按权威阶段解析
    // 模型（模型名用 name 真实模型 ID）；主渠道密钥不可解密/无启用模型时按 T9 切备用
    // 渠道（切换已落决策日志），无备用才降级。env 携带回退上下文供请求期被动切换。
    const resolution = resolveChannelEnv({
      channelId: input.channel_id,
      category: categoryForStage(authoritativeStage),
      projectId: input.project_id,
      sessionId: input.session_id,
    })
    const channel = resolution.channel
    const env = resolution.env
    if (env) {
      console.debug?.(`[runAgent] channel ${channel?.id} (${channel?.name}) 解析成功（类别 ${categoryForStage(authoritativeStage)}）`)
    } else if (resolution.unusableReason === 'no_channel') {
      // 无可用渠道（无启用渠道 / 密钥均不可解密且无备用）：引导回规则路由、草图落模板，
      // 全链路静默降级。必须留日志——2026-08-15 赛车模拟器案例正是这一支无声
      // 瞬断（模型缺席 18ms 出模板草图），事后只能靠毫秒级时间差反推。
      console.error('[runAgent] 未解析到可用渠道（input.channel_id='
        + `${input.channel_id ?? 'auto'}，getFirstEnabledChannel 无可用项），本次模型不参与：引导走规则路由、草图走模板`)
    } else {
      // 主渠道不可用且无备用（decrypt_failed / model_not_found，切换未遂的原因已在
      // runtime-fallback 记录）：引导路径回规则路由，编程路径报可读错误。
      console.error(`[runAgent] 渠道不可用（reason=${resolution.unusableReason}，channel_id=${input.channel_id ?? 'auto'}），本次模型不参与：引导走规则路由、草图走模板`)
    }
    const maxTokens = channel?.max_tokens ?? 640000
    // 多轮历史（T4-L2 窗口改造）：近 N 轮原文（显式常量，默认 10——不再静默写死 20；
    // 窗口只管「最近在聊什么」）+ 全量约束扫描回灌（约束是长期不变量，来自全量 JSONL，
    // 第 1 轮说的约束在 30 轮后依然注入）。漏网的约束在此回填 project.constraints。
    const recentHistory = loadConversationHistory(input.session_id, HISTORY_WINDOW_TURNS)
    const sessionConstraints = scanSessionConstraints(input.session_id)
    if (sessionConstraints.length > 0) {
      captureConstraints({
        project_id: input.project_id,
        session_id: input.session_id,
        constraints: sessionConstraints,
        source: 'session_scan',
      })
    }
    const constraintTurn: ConversationTurn[] = sessionConstraints.length
      ? [
          {
            role: 'system',
            content:
              '【用户已声明的约束（历轮全量扫描，长期有效）】\n' +
              sessionConstraints.map((constraint) => `- ${constraint}`).join('\n') +
              '\n理解需求、澄清提问与功能设计都不得违反以上约束；与约束冲突的功能一律不做。',
          },
        ]
      : []
    const history = [...recentHistory, ...constraintTurn]

    appendAgentMessage(input.session_id, {
      role: 'user',
      // clipboard-paste P1（2026-08-29）：带图消息落 [text, ...image 短引用] 块数组（JSONL 无 base64）
      content: input.images?.length
        ? [
            { type: 'text', text: input.content },
            ...input.images.map((r) => ({ type: 'image' as const, imageId: r.imageId, media_type: r.media_type })),
          ]
        : [{ type: 'text', text: input.content }],
      timestamp: Date.now(),
    })
    // 维护会话索引并回填 Project.last_session_id，支撑历史对话回访恢复
    recordSessionActivity(input.session_id, input.project_id)

    // 权威项目阶段已在函数顶部解析（categoryForStage 类别路由依赖它）；渲染端
    // workflowStageAtom 由 stage_changed 事件驱动，MVP/测试/ready 阶段的事件若丢失
    // 或乱序会导致渲染端阶段滞后（如项目已 ready 仍上报 sketch_ready），护栏/引导
    // 路径/编程路径注入必须统一读 findProject 的真实阶段，避免据此错报进度。

    // 助手回复落盘（模型路径与规则路径共用，保证回访恢复时对话完整）
    const persistAssistant = (text: string) =>
      appendAgentMessage(input.session_id, {
        role: 'assistant',
        content: [{ type: 'text', text }],
        timestamp: Date.now(),
      })

    // 内部标记落盘（system role，回访恢复不展示）：决策卡片选项原文等追溯信息
    const persistSystem = (text: string) =>
      appendAgentMessage(input.session_id, {
        role: 'system',
        content: [{ type: 'text', text }],
        timestamp: Date.now(),
      })

    // 引导路径的模型选项：渠道可用则切真实模型（不可用/解析失败回退规则），无渠道直接走规则，不阻塞澄清
    const guideOptions: GuideModelOptions | undefined = env
      ? {
          query: sdkQuery,
          env,
          signal: abortController.signal,
          sessionId: input.session_id,
          history,
          maxTokens,
          temperature: categoryTemperature('guide'),
          persistAssistant,
        }
      : undefined

    // ── 桌面调度员线分流（BLOMA_DESKTOP_DISPATCH 字节锁；off 时 isDesktopLineActive
    // 恒 false 零行为变化）：桌面线接管后全部消息（含确认卡回传）归桌面路由——
    // 卡回传凭据链/阶段推进/拒收闭环都在路由内闭环，不落入下方 web 线护栏与编程路径。
    // 防御读取：项目索引缺失（测试环境）不阻断主链（与上方权威阶段解析同容错）。 ──
    let desktopProject: ReturnType<typeof findProject> | undefined
    try {
      desktopProject = findProject(input.project_id)
    } catch {
      // 项目记录缺失：桌面线不可能激活，继续原路径
    }
    if (isDesktopLineActive(desktopProject)) {
      await handleDesktopDispatchMessage(
        {
          projectId: input.project_id,
          sessionId: input.session_id,
          requestId: input.request_id,
          content: input.content,
          cardOptionId: input.metadata?.source === 'card_option' ? input.metadata.selected_option_id : undefined,
          query: sdkQuery,
          env: env ?? {},
          maxTokens,
          signal: abortController.signal,
        },
        {
          publish: (_target, type, payload) => streamPublisher(makeEvent(input, type, payload)),
          persistAssistant,
          persistSystem,
          complete: (sessionId) => {
            persistTerminalMessage(sessionId, 'completed')
            streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
          },
        },
      )
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // 阻塞态决策回传（A2/A3）：blocked_action 存在时优先恢复被阻塞的编程操作
    const blockedDecision = resolveBlockedDecision(input)
    if (blockedDecision !== undefined) {
      // F-A 修复（2026-09-11 审计）：用户转点阻塞卡说明已离开「局部优化/整版重做」
      // 补充流，残留标记会让下一句普通诉求被误当局部修改，先清
      clearPendingReviewAction(input.project_id)
      if (blockedDecision === 'explain') {
        // 补充说明：清阻塞 + 回澄清，内容交给引导路径重新理解
        await resumeBlockedFlow(
          { request_id: input.request_id, session_id: input.session_id, project_id: input.project_id, mode: input.mode, decision: 'explain', content: input.content, query: sdkQuery, channel_id: input.channel_id, signal: abortController.signal },
          streamPublisher,
        )
        await handleGuideMessage(input, streamPublisher, guideOptions, persistAssistant, persistSystem)
      } else {
        await resumeBlockedFlow(
          { request_id: input.request_id, session_id: input.session_id, project_id: input.project_id, mode: input.mode, decision: blockedDecision, content: input.content, query: sdkQuery, channel_id: input.channel_id, signal: abortController.signal },
          streamPublisher,
        )
      }
      persistTerminalMessage(input.session_id, 'completed')
      streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // 修改确认卡回传（keep/refine/regenerate，2026-09-11 三按钮改版）：必须在引导路径
    // 之前拦截——此刻权威阶段是 blocked_for_user_decision，若落入 handleGuideMessage
    // 会被 resolveCardAnswer 当成澄清卡答案误入草图生成。
    if (input.metadata?.source === 'card_option' && isIterationDecisionId(input.metadata.selected_option_id)) {
      await resolveIterationDecisionFlow(input, streamPublisher, sdkQuery, abortController.signal)
      persistTerminalMessage(input.session_id, 'completed')
      streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // P7-9b 后续批（2026-09-11）：decision_selected 其余卡接线③——就绪引导卡
    //（next_backend 进迭代通道；export_handoff 走特调导出 IPC 不进本链零记录）。
    // 窄判定零误记：只认 ready_next_steps 的专属选项 id，不碰澄清卡答案空间。
    if (input.metadata?.source === 'card_option' && input.metadata.selected_option_id === 'next_backend') {
      // F-A 修复：同上——用户转点引导卡，清残留补充态
      clearPendingReviewAction(input.project_id)
      try {
        trackAnalytics({
          request_id: input.request_id,
          event: {
            event_type: 'decision_selected',
            project_id: input.project_id,
            session_id: input.session_id,
            payload: { stage: 'ready_next_steps', action: 'next_backend' },
            privacy_level: 'research_safe',
          },
        })
      } catch {
        // 埋点失败不影响迭代链（后续正常消息链路继续）
      }
    }

    // U12：失败重试卡回传（selected_option_id === 'retry'）——取出上次失败诉求原样重跑，
    // 在引导路径/ready 护栏之前拦截（与修改确认卡同理），实现「一键重试」而非重新打字。
    if (input.metadata?.source === 'card_option' && input.metadata.selected_option_id === 'retry') {
      const failedPrompt = takeFailedIteration(input.project_id)
      // P7-9b 后续批（2026-09-11）：decision_selected 其余卡接线②——失败重试卡
      //（埋点在消费性 take 之后，用局部变量——先埋会拿走 failedPrompt）
      try {
        trackAnalytics({
          request_id: input.request_id,
          event: {
            event_type: 'decision_selected',
            project_id: input.project_id,
            session_id: input.session_id,
            payload: { stage: 'iteration_retry', action: 'retry', has_failed_prompt: failedPrompt !== undefined },
            privacy_level: 'research_safe',
          },
        })
      } catch {
        // 埋点失败不影响重试链
      }
      if (failedPrompt) {
        setProgrammingEventPublisher(streamPublisher)
        await runIterationTask({
          request_id: input.request_id,
          session_id: input.session_id,
          project_id: input.project_id,
          mode: input.mode,
          prompt: failedPrompt,
          channel_id: input.channel_id,
          query: sdkQuery,
          signal: abortController.signal,
        })
      } else {
        // 重试诉求已失效（如重启后点旧卡）：如实说明，收敛回 ready
        const copy = '这次重试的诉求已经失效，想调整的话请再描述一次。'
        updateProject(input.project_id, { current_stage: 'ready' })
        streamPublisher(makeEvent(input, 'stage_changed', { stage: 'ready' }))
        appendAgentMessage(input.session_id, {
          role: 'assistant',
          content: [{ type: 'text', text: copy }],
          timestamp: Date.now(),
        })
        streamPublisher(makeEvent(input, 'message_delta', { text: copy }))
      }
      persistTerminalMessage(input.session_id, 'completed')
      streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // F-B 修复（2026-09-11 审计）：二次确认态（blocked）下用户打字 = 补充/修改重做方向，
    // 更新方向并重发确认卡——绝不落入引导路径（否则确认卡悬挂、用户被引去澄清对话、
    // 补充的话被当无关输入）。取消词清态回 ready；进度/寒暄放回标记交回常规。
    if (authoritativeStage === 'blocked_for_user_decision' && input.metadata?.source !== 'card_option') {
      const pendingReview = takePendingReviewAction(input.project_id)
      if (pendingReview?.kind === 'rebuild_confirm') {
        const trimmed = input.content.trim()
        if (REFINE_CANCEL_RE.test(trimmed)) {
          const copy = '好，先保持现在的版本。想改的时候再说。'
          persistAssistant(copy)
          streamPublisher(makeEvent(input, 'message_delta', { text: copy }))
          persistTerminalMessage(input.session_id, 'completed')
          streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
          return { accepted: true, session_id: input.session_id, stream_started: true }
        }
        if (!PROGRESS_QUERY_RE.test(trimmed) && !TRIVIAL_ACK_RE.test(trimmed)) {
          const direction = refineModificationDescription(trimmed) || trimmed
          setPendingReviewAction(input.project_id, { kind: 'rebuild_confirm', direction })
          recordDecision({
            project_id: input.project_id,
            session_id: input.session_id,
            entry: {
              type: 'modification_decision',
              title: '整版重做方向已更新，重新确认',
              why: `二次确认态下用户补充方向：「${direction}」；更新方向并重发确认卡（不打断确认流）`,
            },
          })
          publishRebuildConfirmCard(input, streamPublisher, direction, persistAssistant, persistSystem)
          persistTerminalMessage(input.session_id, 'completed')
          streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
          return { accepted: true, session_id: input.session_id, stream_started: true }
        }
        // 进度/寒暄：放回标记，交回常规（后续走 blocked 引导应答）
        setPendingReviewAction(input.project_id, pendingReview)
      } else if (pendingReview) {
        setPendingReviewAction(input.project_id, pendingReview)
      }
    }

    if (shouldUseGuideAgent(authoritativeStage)) {
      await handleGuideMessage(input, streamPublisher, guideOptions, persistAssistant, persistSystem)
      persistTerminalMessage(input.session_id, 'completed')
      streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // 转移阶段护栏（问题 A / P1）：sketch_ready 阶段的消息不得落入无工具的编程路径。
    // 后端已产出草图，模型拿不到工具上下文只会「假装交付」/把 HTML 贴进聊天。
    // 意图分流（2026-08-16 用户反馈「无法对草图提修改意见」）：此前该阶段所有输入
    // 一律回固定文案，文案却承诺「直接告诉我哪里要改」——修改意见实际无处理路径，
    // 用户唯一出路是点「生成完整功能」直接进 MVP。现在与 ready 护栏同理做意图
    // 分流：识别到修改诉求 → 清洗后并入需求清单，重新生成草图（落回 sketch_ready）。
    // 草图重生成是低成本方向确认，与 ready 阶段的修改确认门不同——不过门直接改，
    // 改错了也能低成本再改。其余输入（确认/进度/闲聊）维持固定引导走按钮。
    // 判断用权威阶段：项目已推进到 ready 时（渲染端阶段可能滞后）不得误入此护栏，
    // 否则会把「项目已好」错报成「还在草图阶段」。
    if (authoritativeStage === 'sketch_ready') {
      const intent = await resolveModificationIntent({
        content: input.content,
        project_id: input.project_id,
        session_id: input.session_id,
        query: sdkQuery,
        env,
        signal: abortController.signal,
        maxTokens,
        providerType: channel?.provider_type,
      })
      if (intent === 'modify') {
        const description = refineModificationDescription(input.content)
        // 约束走门（T4-L1 修改门）：修改意见里的约束语句入库（「不含登录」类），
        // 归一化判定 out_of_scope 是语义层的；这里是关键词层的确定性兜底
        captureConstraints({
          project_id: input.project_id,
          session_id: input.session_id,
          constraints: extractConstraints(description),
          source: 'sketch_ready_modification',
        })
        const existing = readLastSketchRequirements(input.project_id)
        // 修改诉求归一化后并入需求清单：口语碎片原样入库会污染 PRD 背板（线上案例
        // 「重新生成」被 acceptance 解释成功能、产品里长出重置按钮；「车的运行方向不对」
        // 只能生成最小满足版）。归一化失败/无渠道回退改动前现状（原样追加），不阻断草图重生成。
        const normalization = await normalizeRequirementUpdate({
          session_id: input.session_id,
          existing,
          modification: description,
          constraints: readProjectConstraints(input.project_id),
          query: sdkQuery,
          env,
          signal: abortController.signal,
          // omit 推广（reasoning-profile 2026-08-27）：Token Plan 类渠道即使 off 档也
          // 发 disabled 会 400——透传 providerType 激活 omit，免 400+重试往返
          providerType: channel?.provider_type,
        })
        const requirements = applyNormalization(existing, normalization, nextRequirementId(existing), 'correction')
        if (normalization.action === 'out_of_scope' && normalization.outOfScope) {
          addScopeExclusion(input.project_id, normalization.outOfScope)
        }
        if (normalization.via === 'llm') {
          recordRequirementNormalization(input, 'sketch_ready', description, normalization)
        }
        recordSketchGenerated(input.project_id, requirements)
        recordDecision({
          project_id: input.project_id,
          session_id: input.session_id,
          entry: {
            type: 'modification_gate',
            title: '草图阶段修改意见',
            why: `用户对草图提出「${input.content}」，清洗为「${description}」并入需求清单（${normalization.action}${normalization.reviseId ? ` ${normalization.reviseId}` : ''}），重新生成草图`,
            detail: {
              stage: 'sketch_ready',
              normalization: { action: normalization.action, revise_id: normalization.reviseId, description: normalization.description },
              requirements,
            },
          },
        })
        // ack 如实（2026-08-29 线上案例：点选纠错圈选标题说「换个名字」，归一化判 skip
        // 但旧 ack 仍说「按…调整草图」，用户体感「我说改名它说改了结果没改」）。
        // skip 意味着诉求未入需求，必须告知而非假装采纳（与 runIterationTask 口径一致）。
        const ack =
          normalization.action === 'skip'
            ? `收到「${truncateForCopy(input.content, 40)}」——这句我没当作需求改动（判为操作指令），按原样重新生成了一版。想改哪里请直接说，比如「把页面标题的文字改一下」。`
            : `好的，按「${truncateForCopy(description, 40)}」调整草图，重新生成一版。`
        persistAssistant(ack)
        streamPublisher(makeEvent(input, 'message_delta', { text: ack }))
        setProgrammingEventPublisher(streamPublisher)
        await runSketchTask({
          request_id: input.request_id,
          session_id: input.session_id,
          project_id: input.project_id,
          mode: input.mode,
          prompt: description,
          requirements,
          channel_id: input.channel_id,
          query: sdkQuery,
          signal: abortController.signal,
        })
        persistTerminalMessage(input.session_id, 'completed')
        streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
        return { accepted: true, session_id: input.session_id, stream_started: true }
      }
      const guidance =
        '草图已经生成好了。你可以点预览区上方的「生成完整功能」确认并继续；' +
        '想调整的话，点预览区「纠错」按钮标记不满意的位置，或直接告诉我哪里要改。'
      persistAssistant(guidance)
      streamPublisher(makeEvent(input, 'message_delta', { text: guidance }))
      persistTerminalMessage(input.session_id, 'completed')
      streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // 完成阶段护栏（P0）：ready/completed 阶段跳过 LLM、走规则直答。
    // 此前依赖「注入权威阶段 + 硬 prompt」让模型如实汇报，但实测模型仍会延续历史里
    // 的「还没好/后台还在跑」惯性持续幻觉。这里与 sketch_ready 护栏同理：直接规则
    // 回答「已经生成好了」，彻底不依赖模型服从，杜绝「还没好」编造。
    // 但必须做意图分流：识别到修改/调整/纠错类输入时，进入迭代重新生成流程，
    // 而不是一律返回固定文案——否则「已生成后继续改」会被挡成「修改黑洞」。
    if (authoritativeStage === 'ready' || authoritativeStage === 'completed') {
      // 「局部优化 / 整版重做」补充态（2026-09-11 卡位改版）：用户在就绪三按钮卡上点了
      // 局部优化/整版重做后，这一句就是他要说的话——
      //  - optimize          → 直接走局部修改（localOnly，不弹卡）；
      //  - rebuild_direction → 收集方向后转二次确认卡（不直接重做）；
      //  - rebuild_confirm   → 等用户点二次确认卡，文不消费；
      //  - 取消词            → 清标记回 ready。
      const pendingReview = takePendingReviewAction(input.project_id)
      if (pendingReview && pendingReview.kind === 'rebuild_confirm') {
        // rebuild_confirm 态的主处理在 blocked 阶段拦截（见 guide 路由前）——
        // publishRebuildConfirmCard 会把阶段置为 blocked_for_user_decision，用户打字
        // 到不了这里；此处仅兼容异常残留（阶段被外部改回 ready），放回交回常规处理
        setPendingReviewAction(input.project_id, pendingReview)
      } else if (pendingReview) {
        const trimmed = input.content.trim()
        if (REFINE_CANCEL_RE.test(trimmed)) {
          const copy = '好，先保持现在的版本。想改的时候再说。'
          persistAssistant(copy)
          streamPublisher(makeEvent(input, 'message_delta', { text: copy }))
          persistTerminalMessage(input.session_id, 'completed')
          streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
          return { accepted: true, session_id: input.session_id, stream_started: true }
        }
        // 纯进度追问/寒暄不是具体诉求：不误起迭代，交回下方常规处理
        if (!PROGRESS_QUERY_RE.test(trimmed) && !TRIVIAL_ACK_RE.test(trimmed)) {
          if (pendingReview.kind === 'optimize') {
            const localPrompt = refineModificationDescription(trimmed) || trimmed
            recordDecision({
              project_id: input.project_id,
              session_id: input.session_id,
              entry: {
                type: 'modification_decision',
                title: '局部优化（用户补充诉求）',
                why: `就绪卡「局部优化」后补充的诉求：「${localPrompt}」；按局部修改处理（其余功能项保持现状）`,
              },
            })
            setProgrammingEventPublisher(streamPublisher)
            await runIterationTask({
              request_id: input.request_id,
              session_id: input.session_id,
              project_id: input.project_id,
              mode: input.mode,
              prompt: localPrompt,
              channel_id: input.channel_id,
              query: sdkQuery,
              signal: abortController.signal,
              localOnly: true,
            })
            persistTerminalMessage(input.session_id, 'completed')
            streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
            return { accepted: true, session_id: input.session_id, stream_started: true }
          }
          // rebuild_direction：收集重做方向 → 二次确认卡（防误触），先不重做
          const direction = refineModificationDescription(trimmed) || trimmed
          setPendingReviewAction(input.project_id, { kind: 'rebuild_confirm', direction })
          recordDecision({
            project_id: input.project_id,
            session_id: input.session_id,
            entry: {
              type: 'modification_decision',
              title: '整版重做方向已收集，等待二次确认',
              why: `就绪卡「整版重做」后补充的方向：「${direction}」；已转二次确认卡，确认后才重做`,
            },
          })
          publishRebuildConfirmCard(input, streamPublisher, direction, persistAssistant, persistSystem)
          persistTerminalMessage(input.session_id, 'completed')
          streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
          return { accepted: true, session_id: input.session_id, stream_started: true }
        }
      }

      const intent = await resolveModificationIntent({
        content: input.content,
        project_id: input.project_id,
        session_id: input.session_id,
        query: sdkQuery,
        env,
        signal: abortController.signal,
        maxTokens,
        providerType: channel?.provider_type,
      })
      if (intent === 'modify') {
        // 用户直接打字提修改（未走就绪卡）：一律按「局部优化」处理（轻量局部修改），
        // 不再弹确认卡——是轻量还是整版重做只由用户在就绪卡上的选项决定
        //（2026-09-11 定案：分流只看用户选项，不看用户在输入框里说的话）。
        const localPrompt = refineModificationDescription(input.content) || input.content.trim()
        recordDecision({
          project_id: input.project_id,
          session_id: input.session_id,
          entry: {
            type: 'modification_decision',
            title: '用户提修改（默认局部优化）',
            why: `ready 阶段直接打字提修改「${input.content}」；按局部优化处理（其余功能项保持现状）`,
          },
        })
        setProgrammingEventPublisher(streamPublisher)
        await runIterationTask({
          request_id: input.request_id,
          session_id: input.session_id,
          project_id: input.project_id,
          mode: input.mode,
          prompt: localPrompt,
          channel_id: input.channel_id,
          query: sdkQuery,
          signal: abortController.signal,
          localOnly: true,
        })
        persistTerminalMessage(input.session_id, 'completed')
        streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
        return { accepted: true, session_id: input.session_id, stream_started: true }
      }
      // other（进度追问/闲聊）：模型直答 + 事实校验，模板兜底（P1 自由度归还，2026-09-06）。
      // 渠道不可用/校验不过（重试一次后仍败）回退 READY_COMPLETION_COPY + 修改出口引导
      //（=原规则直答，反幻觉底线不降级）；直答成功则用户得到针对这句话的自然回答。
      const fallbackCopy = `${READY_COMPLETION_COPY}\n\n想调整哪里直接告诉我，比如“加一个历史记录”。`
      let guidance = fallbackCopy
      if (env && readyChatEnabled()) {
        const chat = await runReadyStageChat({
          query: sdkQuery,
          env,
          signal: abortController.signal,
          sessionId: input.session_id,
          history,
          maxTokens,
          ...(channel?.provider_type !== undefined ? { providerType: channel.provider_type } : {}),
          system: buildReadyChatSystem(
            buildReadyChatFacts(
              input.project_id,
              authoritativeStage,
              Boolean(env?.ANTHROPIC_BASE_URL && env?.ANTHROPIC_AUTH_TOKEN && env?.ANTHROPIC_MODEL),
            ),
          ),
          userContent: input.content,
        })
        if (chat.ok) guidance = chat.text
      }
      persistAssistant(guidance)
      streamPublisher(makeEvent(input, 'message_delta', { text: guidance }))
      persistTerminalMessage(input.session_id, 'completed')
      streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // 编程路径：必须真实模型，无渠道 / 密钥不可解密 / 无启用模型（且无备用渠道可切）
    // 直接抛明确错误（不留测试占位 key）
    if (!channel || !env) {
      throw new Error(
        resolution.unusableReason === 'decrypt_failed'
          ? 'API_KEY_DECRYPT_FAILED: 已配置渠道但 api_key 无法解密，请在设置中重新保存该渠道'
          : resolution.unusableReason === 'model_not_found'
            ? 'CHANNEL_MODEL_NOT_FOUND: 渠道没有启用的模型，请在设置中启用至少一个模型'
            : 'CHANNEL_NOT_FOUND: configure a model channel before using the SDK',
      )
    }

    // 编程路径模型上下文（问题 A / P1 纵深防御）：模型没有写文件/跑沙箱的工具，
    // 若只给聊天历史，它既不知道项目当前阶段，也误以为可以把 HTML 贴进聊天当交付物——
    // 于是「好了吗」会被编成「还没好」，追问多了就整段贴代码。注入真实项目阶段 +
    // 「无工具」约束，把模型从「假装交付」引导回「如实汇报 + 引导确认」。
    // authoritativeStage 已在函数顶部以 findProject 为准解析（渲染端上报仅作回退）。
    const programmingHistory: ConversationTurn[] = [buildProgrammingSystemTurn(authoritativeStage), ...history]

    await runWithRetry(input, async () => {
      // clipboard-paste P1（2026-08-29）：澄清对话带图——模型在草图澄清期即可看见用户贴的截图
      const stream = sdkQuery(input.content, { env, signal: abortController.signal, sessionId: input.session_id, history: programmingHistory, images: input.images, maxTokens })
      run.iterator = stream[Symbol.asyncIterator]()

      for (;;) {
        const next = await run.iterator.next()
        if (next.done) break

        const sdkMessage = next.value
        received.push(sdkMessage)
        const event = convertSDKMessage(input, sdkMessage)
        if (event) streamPublisher(event)

        if (sdkMessage.type === 'result') {
          break
        }
      }

      await run.iterator.return?.()
      run.iterator = undefined
    })

    persistAssistantMessages(input.session_id, received)

    // 编程路径无工具：若模型输出里出现完整 HTML / 代码块（贴代码式「交付」），
    // 追加一条显式提示。注意：无工具路径下模型贴出的代码从未落盘到项目文件，
    // 绝不能声称「代码已生成到项目文件里」——那会误导用户去预览找不存在的代码
    // （实测「右侧没有啊」正是被这条假提示带偏）。如实说明并引导到确认/预览。
    const assistantText = extractAssistantText(received)
    if (detectCodeDelivery(assistantText)) {
      const hint =
        '（你在对话里贴出的代码不会自动保存进项目文件。要生成真正可运行、可保存的版本，' +
        '请点预览区上方的「生成完整功能」确认生成；已生成的版本请直接看右侧预览。）'
      persistAssistant(hint)
      streamPublisher(makeEvent(input, 'message_delta', { text: hint }))
    }

    persistTerminalMessage(input.session_id, 'completed')
    streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))

    return { accepted: true, session_id: input.session_id, stream_started: true }
  } catch (error) {
    // 如果 cancelAgent 已按 runId 发过终态，旧任务只负责收尾，不能再覆盖 UI/日志。
    const stillOwnsRun = activeSessions.get(input.session_id)?.runId === runId
    if (!stillOwnsRun && isUserCancelled(error)) {
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }
    // 熔断回滚已完成收尾（T5）：阶段收敛、如实消息、completed 事件都在回滚内发过，
    // 这里不得再当普通失败处理（不覆盖阶段、不发 error 事件）。
    if (isCircuitBreakSettled(error)) {
      persistTerminalMessage(input.session_id, 'completed')
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }
    persistAssistantMessages(input.session_id, received)
    // 用户主动停止（T3）：终止流并落盘终态，但不作为错误向上抛——
    // 会话仍可用（activeSessions 已在 cancelAgent 清除，可继续发消息）。
    if (isUserCancelled(error)) {
      stoppedByUser = true
      publishRunEvent(input, run, 'error', { code: 'AGENT_CANCELLED' })
      persistTerminalMessage(input.session_id, 'error', { code: 'AGENT_CANCELLED', message: '用户停止了本次生成' })
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }
    const code = String(error).includes('AGENT_SESSION_BUSY') ? 'AGENT_SESSION_BUSY' : 'AGENT_SDK_ERROR'
    streamPublisher(makeEvent(input, 'error', { code }))
    persistTerminalMessage(input.session_id, 'error', {
      code,
      message: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    await run.iterator?.return?.()
    const current = activeSessions.get(input.session_id)
    if (current?.runId === runId) {
      activeSessions.delete(input.session_id)
      releaseProjectRun(input.project_id, runId)
      // message-queue：run 收口——自然完成自动派发排队消息；用户停止不派发（违背停止意图）
      sessionMessageQueue.onRunComplete(input.session_id, input.request_id, stoppedByUser)
    }
  }
}

