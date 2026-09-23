/**
 * 意图路由（PR4b 拆出）：迭代决策流、修改意图判定、LLM 意图分类与提示构建。
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
import { isCircuitBreakSettled } from '../recovery-service'
import { addScopeExclusion, findProject, readLastSketchRequirements, recordSketchGenerated, updateProject } from '../../project/project-service'
import { recordSessionActivity } from '../../platform/sessions/session-service'
import { appendExperienceEvent } from '../../experience/event-log'
import { isThinkingLogEnabled, logThinking } from '../../agent/loop/thinking-log'
import { extractErrorMessage } from '../../platform/llm/channel-test-error'
import { anthropicMessagesQueryViaProviders, providerAdapterEnabled } from '../../platform/upstream/providers/loop-query'

import { SDKQuery } from './orchestration-contracts'
import { sdkQuery, streamPublisher } from './sdk-glue'
import { appendAgentMessage, makeEvent } from './persistence'

/**
 * MVP 就绪卡 / 二次确认卡的决策分发（2026-09-11 卡位改版）：
 * - keep            保持现状：回 ready，随后发「走向完整产物」引导卡（ready_next_steps）；
 * - optimize        局部优化：置 optimize 补充态 + 回 ready，等用户输入框说改哪里 → 局部修改；
 * - rebuild         整版重做：置 rebuild_direction 补充态 + 回 ready，等用户说重做方向 → 二次确认；
 * - rebuild_confirm 二次确认卡「确定整版重做」：取出已收集方向 → 整版重做（rebuild: true）；
 * - rebuild_cancel  二次确认卡「再想想」：清态回 ready，保持当前版本。
 * 任一决策都会把阶段收敛回 ready / iterating，绝不悬在 blocked_for_user_decision。
 */
export async function resolveIterationDecisionFlow(
  input: AgentSendMessageInput,
  streamPublisher: (event: AgentEvent) => void,
  sdkQuery: SDKQuery | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const decision = input.metadata?.selected_option_id
  const pendingAction = takePendingReviewAction(input.project_id)

  // P7-9b 后续批：decision_selected 埋点（就绪卡与二次确认卡同通道）
  try {
    trackAnalytics({
      request_id: input.request_id,
      event: {
        event_type: 'decision_selected',
        project_id: input.project_id,
        session_id: input.session_id,
        payload: { stage: 'mvp_review', action: decision ?? null, has_pending_action: pendingAction !== undefined },
        privacy_level: 'research_safe',
      },
    })
  } catch {
    // 埋点失败不影响决策链
  }

  // 整版重做二次确认：确定 → 按已收集方向重做（方向并入需求清单，保留草图）
  if (decision === 'rebuild_confirm' && pendingAction?.direction) {
    const direction = pendingAction.direction
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'modification_decision',
        title: '用户确认整版重做',
        why: `二次确认通过，按方向「${direction}」整版重做（并入需求清单；保留草图；当前版本存快照）`,
        detail: { direction },
      },
    })
    setProgrammingEventPublisher(streamPublisher)
    // Phase 10 W4：整版重做=行为信号（J7 三通道之「同主题重做」可观测化）
    appendExperienceEvent({
      projectId: input.project_id,
      runId: input.session_id ?? input.project_id,
      eventType: 'behavior_signal',
      stage: 'ready',
      observations: [`full_redo：用户确认按方向「${direction.slice(0, 60)}」整版重做`],
    })
    updateProject(input.project_id, { current_stage: 'iterating' })
    streamPublisher(makeEvent(input, 'stage_changed', { stage: 'iterating' }))
    await runIterationTask({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      prompt: direction,
      channel_id: input.channel_id,
      query: sdkQuery,
      signal,
      rebuild: true,
    })
    return
  }

  // Phase 10 W4：一键反馈卡回传（fb_*；F 系列 4.1/4.2）——负面项=issue_hypothesis
  // 事件 + issue_reported 埋点（行为信号源=本卡）；处理完按选项语义收口（引导/输入框）。
  if (typeof decision === 'string' && decision.startsWith('fb_')) {
    setProgrammingEventPublisher(streamPublisher)
    const category =
      decision === 'fb_broken' ? 'cannot_run'
        : decision === 'fb_feature_broken' ? 'key_feature_broken'
          : decision === 'fb_unsatisfied' ? 'unsatisfied'
            : decision === 'fb_change_needs' ? 'requirement_change'
              : 'later'
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'feedback_reported',
        title: `用户反馈：${category}`,
        why: '一键反馈卡回传（行为信号，非意图识别）——负面项进 issue_hypothesis 事件与 issue_reported 埋点，供复盘成卡',
        detail: { category, source: 'delivery_feedback_card' },
      },
    })
    if (decision === 'fb_change_needs') {
      appendExperienceEvent({
        projectId: input.project_id,
        runId: input.session_id ?? input.project_id,
        eventType: 'behavior_signal',
        stage: 'ready',
        observations: ['requirement_change_requested：用户经反馈卡选择「改变需求」（去输入框表达）'],
      })
      const copy = '好，去输入框说说你想怎么改——加功能、改交互都行，我会先跟你确认再动。'
      appendAgentMessage(input.session_id, { role: 'assistant', content: [{ type: 'text', text: copy }], timestamp: Date.now() })
      streamPublisher(makeEvent(input, 'message_delta', { text: copy }))
      return
    }
    if (decision !== 'fb_later') {
      appendExperienceEvent({
        projectId: input.project_id,
        runId: input.session_id ?? input.project_id,
        eventType: 'issue_hypothesis',
        stage: 'ready',
        observations: [`${category}：用户经反馈卡报告（假设待证据坐实——终验/对账证据升 confirmed_failure）`],
        evidenceRefs: ['documents/test-report.json'],
      })
      try {
        trackAnalytics({
          request_id: input.request_id,
          event: {
            event_type: 'issue_reported',
            project_id: input.project_id,
            session_id: input.session_id,
            payload: { source: 'feedback_card', category },
            privacy_level: 'research_safe',
          },
        })
      } catch {
        // 埋点失败不阻断
      }
      const copy =
        category === 'cannot_run'
          ? '收到，无法运行这个问题我记下了。方便的话把看到的报错或现象发我，我来修。'
          : category === 'key_feature_broken'
            ? '收到，关键功能无效我记下了。告诉我是哪个功能、怎么操作的，我来修。'
            : '收到，效果不满意我记下了。说说哪里不符合预期，我来调。'
      appendAgentMessage(input.session_id, { role: 'assistant', content: [{ type: 'text', text: copy }], timestamp: Date.now() })
      streamPublisher(makeEvent(input, 'message_delta', { text: copy }))
      return
    }
    // fb_later：顺势发引导卡（keep 语义收尾）
    publishReadyNextStepsCard({ request_id: input.request_id, session_id: input.session_id, project_id: input.project_id })
    return
  }

  // 局部优化 / 整版重做：置补充态 + 回 ready，等用户在输入框补充（下一句消费）
  // W5（2026-09-18 本月流水账案）：熔断→ready 的 mvp_review 卡第四选项——定向修复已知
  // 未通过项（复用入口 B 修复轮 + 终验门禁收口，与「生成完整程序」skip 分支同链；
  // 判据读 test_completed 事件兑底，回滚清掉的 test-report.json 不再断粮）。
  if (decision === 'fix_now') {
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'modification_decision',
        title: '用户选择先修已知未通过项',
        why: '熔断回滚后的 mvp_review 卡 fix_now：定向修复轮（不改需求清单）+ 终验门禁收口',
        detail: { via: 'circuit_mvp_review' },
      },
    })
    setProgrammingEventPublisher(streamPublisher)
    updateProject(input.project_id, { current_stage: 'repairing' })
    streamPublisher(makeEvent(input, 'stage_changed', { stage: 'repairing' }))
    const previewUrl = await ensureResumePreview(input)
    await runBlockedTestRepair({ ...input, preview_url: previewUrl })
    await runAgentLoopPostTesting({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      preview_url: previewUrl,
      ...(findProject(input.project_id).via_agent_loop
        ? { loop: { status: findProject(input.project_id).agent_loop_status ?? 'completed', turns: 0, finalText: '', toolCalls: [] } satisfies AgentLoopJudgeMetadata }
        : {}),
    })
    return
  }

  if (decision === 'optimize' || decision === 'rebuild') {
    const kind = decision === 'optimize' ? 'optimize' : 'rebuild_direction'
    setPendingReviewAction(input.project_id, { kind })
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'modification_decision',
        title: decision === 'optimize' ? '用户选择局部优化' : '用户选择整版重做（待问方向）',
        why:
          decision === 'optimize'
            ? '就绪卡点「局部优化」；聚焦输入框，等用户说改哪里后走局部修改'
            : '就绪卡点「整版重做」；聚焦输入框，等用户说重做方向后转二次确认',
      },
    })
    const copy =
      decision === 'optimize'
        ? '好，说说你想改哪里——越具体越好，比如「把页面标题的文字改一下」「把这个按钮换成蓝色」。'
        : '好，说说你想往哪个方向重做——比如「改用卡片式布局」「把记账改成记时间」；说完我再跟你确认一次。'
    updateProject(input.project_id, { current_stage: 'ready' })
    streamPublisher(makeEvent(input, 'stage_changed', { stage: 'ready' }))
    appendAgentMessage(input.session_id, {
      role: 'assistant',
      content: [{ type: 'text', text: copy }],
      timestamp: Date.now(),
    })
    streamPublisher(makeEvent(input, 'message_delta', { text: copy }))
    return
  }

  // keep：保持现状 → 回 ready + 顺势发「走向完整产物」引导卡
  if (decision === 'keep') {
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'modification_decision',
        title: '用户保持现状',
        why: '就绪卡点「保持现状」；不改动，进入「走向完整产物」引导',
      },
    })
    const copy = '好，那就保持这个版本。'
    updateProject(input.project_id, { current_stage: 'ready' })
    streamPublisher(makeEvent(input, 'stage_changed', { stage: 'ready' }))
    appendAgentMessage(input.session_id, {
      role: 'assistant',
      content: [{ type: 'text', text: copy }],
      timestamp: Date.now(),
    })
    streamPublisher(makeEvent(input, 'message_delta', { text: copy }))
    // 引导卡走 programming-orchestrator 的 publish，需先接线事件发布器
    setProgrammingEventPublisher(streamPublisher)
    // Phase 10 W4：反馈卡开时先问反馈（fb_* 回传后顺势发引导卡）；off=直接引导卡（字节级现状）
    if (feedbackCardEnabled()) {
      publishDeliveryFeedbackCard({
        request_id: input.request_id,
        session_id: input.session_id,
        project_id: input.project_id,
      })
      return
    }
    publishReadyNextStepsCard({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
    })
    return
  }

  // rebuild_cancel（再想想）/ 待定状态丢失（如重启后点旧卡）
  const expired = decision === 'rebuild_confirm'
  const copy = expired
    ? '刚才的重做确认已过期，想重做的话请再说一次方向。'
    : '好，先保持现在的版本。'
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'modification_decision',
      title: expired ? '重做确认卡已过期' : '用户放弃/保持当前版本',
      why: expired
        ? '用户点了「确定整版重做」但已收集方向丢失（如重启后点旧卡），回 ready 请用户重说'
        : `决策 id=${decision ?? '空'}（如「再想想」），保持当前版本`,
    },
  })
  updateProject(input.project_id, { current_stage: 'ready' })
  streamPublisher(makeEvent(input, 'stage_changed', { stage: 'ready' }))
  appendAgentMessage(input.session_id, {
    role: 'assistant',
    content: [{ type: 'text', text: copy }],
    timestamp: Date.now(),
  })
  streamPublisher(makeEvent(input, 'message_delta', { text: copy }))
}

/**
 * L1 规则快速门——识别「修改/调整/纠错」类意图（毫秒级纯函数）。
 *
 * 用户在项目已生成后继续提的修改诉求（改、换、加、删、调整、重新等）应进入迭代
 * 重新生成流程，而非被 ready 护栏固定文案挡回。纯进度追问（好了吗 / 怎么样了）不命中。
 * 命中则直接 `modify`，不再走 L3（避免每条消息都付一次 LLM 往返的延迟）。
 */
export function isModificationIntent(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  // 显式修改动词 + 否定/货不对板/重述主题类表达（"啥意思，我要音乐合成器"、"这不是我想要的"）
  // + 缩小范围类平静陈述（"我只需要理财房贷的计算器"——无动词、无语气词，
  //   线上案例：曾连漏 L1/L2 两层被固定文案挡回）。注意「不需要」不含连续子串「不要」，须单列。
  // + 「完整」类诉求（"生成完整程序""做出完整程序""要完整版"）：2026-09-05「地牢遗物」
  //   实锤——completed 阶段用户说「生成完整程序」被 L1 漏、L3 判 other，固定文案挡回。
  return /(修改|改一改|改下|改一下|调整|纠错|重做|重来|重新|完整|补全|优化|修正|不要|不需要|只需要|只要|不用|就够了|去掉|删除|删掉|加一个|加个|加上|新增|变成|换成|改成|再来|换个|不对|不是|不满意|搞错|做错|错了|偏了|货不对板|啥意思|什么意思|这不是|我要的是|我想要的是|应该是)/.test(trimmed)
}

/**
 * 「局部优化 / 整版重做」补充态的取消词（2026-09-11 卡位改版）：用户在卡上点了
 * 局部优化/整版重做后改主意，整句即取消/保持现状时清标记回 ready，不误入修改。
 * 整句锚定 + 词组可重复（覆盖「算了，不用了」类合并说法；避免「算了，改成蓝色」
 * 含取消词的真修改诉求被误拦）。
 */
export const REFINE_CANCEL_RE = /^((算了|不用了|不用改了|没事|没事了|保持现状|不改了|先不改|取消|暂时不用|就这样)[吧了。.!！~～，,\s]*)+$/

/** 纯进度追问（好了吗/怎么样了）——固定「other」，绝不进修改/LLM 判定（延迟立场）。 */
export const PROGRESS_QUERY_RE = /(好了吗|好了没|好没好|做完了吗|做完了没|完成了吗|完成了没|怎么样|怎么样了|进展|进度|状态)/

/** 纯应答寒暄（好的/谢谢/嗯，整句无其他信息）——不值得付一次 L3 LLM 往返。 */
export const TRIVIAL_ACK_RE = /^(好的?|嗯+|哦+|噢+|行|ok|okay|不用了|谢谢|感谢|多谢|收到|了解|明白|知道了?|不错|很好|挺好的?)[。.!！~～，,\s]*$/i

/**
 * 分层意图识别——规则快门 + LLM 兜底（改造 F）。
 *
 * 纯寒暄应答 → 固定 `other`；L1（isModificationIntent）毫秒级命中 → `modify`；纯进度
 * 追问（无修改词）→ 固定 `other`；其余一律 L3 用 LLM + PRD 背板上下文判定「是否表达不满/修改诉求」。
 * L1 先于进度门是放行一致化要求：进度子串门只能拦「纯」进度句，不得吞掉含修改动词的混合句。
 * 曾经的 L2 语气标记门（疑问/否定/困惑字词）已移除：它把「平静的陈述式修改诉求」
 * （如「我只需要理财房贷的计算器」，零语气标记）永远挡在 L3 之外，形成结构性盲区；
 * ready 阶段非进度、非寒暄的陈述句本来就是修改/反馈的高发区，默认交给 LLM 判定。
 * L3 无可用渠道时保守回退 `other`（固定完成文案），不因意图判定失败而误触发需要渠道的迭代流程。
 */
export async function resolveModificationIntent(opts: {
  content: string
  project_id: string
  session_id: string
  query: SDKQuery
  env: Record<string, string> | undefined
  signal: AbortSignal
  maxTokens: number
  providerType?: string
}): Promise<'modify' | 'other'> {
  if (TRIVIAL_ACK_RE.test(opts.content.trim())) return 'other'
  // 顺序修正（放行一致化）：L1 修改词表先于进度子串门——纯进度句（好了吗/怎么样了）
  // 不含修改词、行为不变；但「进度词 + 修改动词」混合句（「做完了没？把按钮换成蓝色」）
  // 此前被子串进度门整句吞掉、永远到不了 L1/L3，被固定文案挡回（放行不一致）。
  if (isModificationIntent(opts.content)) return 'modify'
  if (PROGRESS_QUERY_RE.test(opts.content)) return 'other'
  if (!opts.env) return 'other'
  const env = opts.env
  try {
    return await classifyIntentViaLlm({ ...opts, env, providerType: opts.providerType })
  } catch {
    // L3 兜底失败不阻断对话：退回固定完成文案，绝不因意图判定异常让用户卡死
    return 'other'
  }
}

/**
 * L3 LLM 兜底——判定「是否表达不满/修改诉求」。
 *
 * 单句文本无法判断用户是否不满（锚点是「当前产物 vs 用户期望」的差），所以把
 * PRD 背板的定位 + 功能项喂给模型作为上下文锚点。输出只解析一个布尔：是否表达
 * 修改/不满诉求。这是唯一会产生 LLM 往返的意图判定路径，且仅在 L2 疑似时触发。
 */
export async function classifyIntentViaLlm(opts: {
  content: string
  project_id: string
  session_id: string
  query: SDKQuery
  env: Record<string, string>
  signal: AbortSignal
  maxTokens: number
  /** omit 推广（2026-08-27）：Token Plan 类渠道 off 档发 disabled 也 400——透传激活 omit（审查 P2-①） */
  providerType?: string
}): Promise<'modify' | 'other'> {
  const backplane = readPrdBackplane(opts.project_id)
  const prompt = buildIntentPrompt(backplane, opts.content)

  const texts: string[] = []
  for await (const sdk of opts.query(prompt, {
    env: opts.env,
    signal: opts.signal,
    sessionId: opts.session_id,
    maxTokens: opts.maxTokens,
    providerType: opts.providerType,
  })) {
    if (sdk.type !== 'assistant' || !sdk.message) continue
    for (const block of sdk.message.content) {
      if (block.type === 'text' && block.text) texts.push(block.text)
    }
  }

  // 应答解析（修复死正则）：JS 的 \b 基于 \w（仅 ASCII），中文字符间永远无边界，
  // 原式 /\b(...|修改|改|...)\b/ 的中文分支全部永不命中——模型答「修改」曾被误判
  // `other`，只因恰好答 ASCII「modify」而侥幸工作。归一化（trim/小写/去尾标点）后
  // 整 token 匹配，再保留 ASCII \b 兜底吸收「modify。附带解释」类应答。
  const raw = texts.join('').trim().toLowerCase()
  const verdict = raw.replace(/[。.!！~～,，?？\s]+$/g, '')
  if (verdict === 'modify' || ['修改', '调整', '改', '重做', '重新生成', '重新做', '换'].includes(verdict)) return 'modify'
  if (/\bmodify\b/.test(raw)) return 'modify'
  return 'other'
}

/** 组装 L3 意图判定的上下文 prompt：PRD 背板定位 + 功能项 + 用户最新消息。 */
export function buildIntentPrompt(backplane: { positioning: string; requirements: Array<{ id: string; description: string }> }, content: string): string {
  const items = backplane.requirements.length
    ? backplane.requirements.map((r) => `- ${r.id}: ${r.description}`).join('\n')
    : '- （无已确认功能项）'
  return [
    '你在判断用户对已生成项目的最新消息是否表达「不满或修改诉求」。',
    '',
    '【项目原本要什么（PRD 背板）】',
    `产品定位：${backplane.positioning}`,
    '功能项：',
    items,
    '',
    '【用户刚刚说】',
    content,
    '',
    '若用户在表达「货不对板 / 要改 / 要重做 / 要换 / 要更完整（如“生成完整程序”“要完整版”）/ 补充需求」请只回答「modify」；',
    '若只是「问进度 / 闲聊 / 确认状态」请只回答「other」。不要解释。',
  ].join('\n')
}

