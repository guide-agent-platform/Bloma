/**
 * 主编排分发（PR4b 拆出）：runAgent 意图分流与阶段推进主链。
 * 纯机械搬移（零行为变化）；对外契约经 orchestrator re-export 保持不变。
 */
import { randomUUID } from 'node:crypto'


import type { AgentEvent, AgentSendMessageInput, AgentSendMessageResult, SDKMessage, WorkflowStage } from '../../../shared/types';









export { buildSdkEnv } from '../../platform/llm/channel-manager'
import { resolveChannelEnv } from '../../platform/llm/runtime-fallback';
import { categoryForStage, categoryTemperature } from '../../platform/llm/model-resolution'
import { handleGuideMessage } from '../../guide/guide-agent-service'
import { handleDesktopDispatchMessage, isDesktopLineActive } from '../../desktop/desktop-route';
import type { SDKQuery } from './orchestration-contracts'


import { readPrdBackplane } from '../../project/document-engine'
import { runUxConfirmGate } from '../../guide/ux-confirm'


import { recordDecision } from '../../project/decision-log'
import { captureConstraints, scanSessionConstraints } from '../../guide/constraint-extractor';
import { WEB_TO_DESKTOP_OPTION_ID, isWebLineRetiredOption } from '../../guide/web-line-retired'
import { isCircuitBreakSettled } from '../../project/recovery-service'
import { findProject, updateProject } from '../../project/project-service';
import { recordSessionActivity } from '../../platform/sessions/session-service'



import { ConversationTurn, GuideModelOptions } from './orchestration-contracts'
import { ActiveRun, activeSessions, hasRunForProject, registerForegroundRun, releaseProjectRun, sessionMessageQueue } from './run-registry'
import { sdkQuery, streamPublisher } from './sdk-glue';

import { appendAgentMessage, isUserCancelled, makeEvent, persistAssistantMessages, persistTerminalMessage, publishRunEvent } from './persistence';
import { HISTORY_WINDOW_TURNS, loadConversationHistory, shouldUseGuideAgent } from './dispatch-support'
import { maybeRenameUnnamedProject } from '../../project/project-service'
import { isCurrentReceiptGeneration, updateReceipt } from '../../platform/attachments/send-inbox'
import { sessionMaterials } from '../../platform/attachments/material-context'

export async function runAgent(input: AgentSendMessageInput): Promise<AgentSendMessageResult> {
  // 项目自动命名（2026-10-05 用户反馈修复）：「模式选择→建项目」路径无 initial_message
  // → 全部「未命名项目」；首条用户消息到达时补名（内部自防御，失败不阻断消息链路）。
  maybeRenameUnnamedProject(input.project_id, input.content)
  // 排队判定（全链路审查 P1-1 修复，2026-10-01）：升级为项目级——同会话活跃或同项目
  // 另一会话/后台审查（backgroundRuns）占锁时都入队，不再静默丢弃（旧逻辑只查 session，
  // PROJECT_BUSY 在 registerForegroundRun 抛出后不排队不落盘，渲染端乐观气泡刷新即丢）。
  // 派发重试安全网：若派发时项目仍忙，MAX_REQUEUES 耗尽后 onDropped 红泡告知（可重发，非静默）。
  if (activeSessions.has(input.session_id) || hasRunForProject(input.project_id)) {
    updateReceipt(input.client_message_id, 'queued', undefined, input.run_generation)
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
  const publishForRun = (event: AgentEvent): void => {
    if (input.client_message_id && !isCurrentReceiptGeneration(input.client_message_id, input.run_generation ?? 1)) return
    streamPublisher(input.client_message_id ? { ...event, payload: { ...event.payload, client_message_id: input.client_message_id, run_generation: input.run_generation ?? 1 } } : event)
  }
  const abortController = new AbortController()
  const run: ActiveRun = {
    abortController,
    projectId: input.project_id,
    runId,
    publisher: publishForRun,
  }
  registerForegroundRun(input, run)

  const received: SDKMessage[] = []
  // message-queue：run 终态收口判断用户是否主动停止（isUserCancelled 分支置 true）
  let stoppedByUser = false
  let receiptOutcome: 'completed' | 'failed' | 'cancelled' = 'completed'

  try {
    updateReceipt(input.client_message_id, 'running', undefined, input.run_generation)
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
    const recentHistory = loadConversationHistory(input.session_id, HISTORY_WINDOW_TURNS, { excludeClientMessageId: input.client_message_id })
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
      origin: input.metadata?.source === 'system_resume' ? 'system' : 'user',
      ...(input.client_message_id ? { client_message_id: input.client_message_id } : {}),
      ...(input.attachment_refs?.length ? { attachments: sessionMaterials(input.project_id, input.session_id).attachments.filter(info => input.attachment_refs!.some(ref => ref.attachment_id === info.attachment_id)) } : {}),
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

    if (input.client_message_id && !input.content.trim() && (input.images?.length || input.attachment_refs?.length)) {
      const notice = '材料已保存。你希望我把它用作界面参考、解释材料内容，还是补充已有需求？请说明用途后继续。'
      persistAssistant(notice)
      publishForRun(makeEvent(input, 'message_delta', { text: notice }))
      persistTerminalMessage(input.session_id, 'completed')
      publishForRun(makeEvent(input, 'completed', { subtype: 'success' }))
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // 引导路径的模型选项：渠道可用则切真实模型（不可用/解析失败回退规则），无渠道直接走规则，不阻塞澄清
    const guideOptions: GuideModelOptions | undefined = env
      ? {
          query: sdkQuery,
          materials: sessionMaterials(input.project_id, input.session_id),
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
          images: input.images,
          initialMessagePersisted: Boolean(input.client_message_id),
          cardOptionId: input.metadata?.source === 'card_option' ? input.metadata.selected_option_id : undefined,
          query: sdkQuery,
          env: env ?? {},
          maxTokens,
          signal: abortController.signal,
        },
        {
          publish: (_target, type, payload) => publishForRun(makeEvent(input, type, payload)),
          persistAssistant,
          persistSystem,
          complete: (sessionId, _projectId, outcome) => {
            if (outcome === 'incomplete') receiptOutcome = 'failed'
            persistTerminalMessage(sessionId, outcome === 'incomplete' ? 'incomplete' : 'completed',
              outcome === 'incomplete' ? { message: findProject(_projectId).desktop_blocked?.note } : undefined)
            // P2-01：未收口/取消不再冒充成功终态（subtype 供渲染端与下游区分）
            publishForRun(makeEvent(input, 'completed', { subtype: outcome === 'incomplete' ? 'incomplete' : 'success' }))
          },
        },
      )
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // ── web 生成线已下线守卫（2026-10-01 拆除刀1）：新项目已在 prd-confirm 断流
    //（非 desktop_tool 品类发形态引导卡，不再进 web 草图）；存量项目阶段停在 web
    // 专属枚举且桌面线未激活（上方未分流）→ 如实告知，不进任何 web 生成路径。
    // choosing_mode/clarinating 放行；blocked_for_user_decision 被向导澄清卡复用
    //（guide-pipeline ask_clarification 分支），同样放行。──
    if (WEB_LINE_RETIRED_STAGES.has(authoritativeStage)) {
      const notice = WEB_LINE_RETIRED_COPY
      persistAssistant(notice)
      publishForRun(makeEvent(input, 'message_delta', { text: notice }))
      persistTerminalMessage(input.session_id, 'completed')
      publishForRun(makeEvent(input, 'completed', { subtype: 'success' }))
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // web 线拆除刀1：非桌面品类 PRD 确认后的形态引导卡回传（web_to_desktop /
    // web_to_revise，卡由 prd-confirm 发放）。须在向导路径之前拦截，防止选项 id
    // 落入 resolveCardAnswer 澄清答案空间。
    if (input.metadata?.source === 'card_option'
      && isWebLineRetiredOption(input.metadata.selected_option_id)) {
      await resolveWebLineRetiredCard(input, publishForRun, makeEvent, sdkQuery, env ?? {})
      persistTerminalMessage(input.session_id, 'completed')
      publishForRun(makeEvent(input, 'completed', { subtype: 'success' }))
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    if (shouldUseGuideAgent(authoritativeStage)) {
      // UX confirmation can enter production within the guide call. Preserve a
      // later incomplete result even if the earlier confirmation itself succeeded.
      let guideIncomplete = false
      await handleGuideMessage(input, event => {
        if (event.type === 'error' || event.type === 'message_completed' && ['incomplete', 'error'].includes(String(event.payload.subtype))) guideIncomplete = true
        publishForRun(event)
      }, guideOptions, persistAssistant, persistSystem)
      if (guideIncomplete) receiptOutcome = 'failed'
      persistTerminalMessage(input.session_id, 'completed')
      publishForRun(makeEvent(input, 'completed', { subtype: guideIncomplete ? 'incomplete' : 'success' }))
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // 理论不可达：13 阶段已被上方守卫与向导判定全覆盖（桌面分流 / web 下线守卫 /
    // 向导三态）。防御兜底：不沉默吞消息。
    const unreachable = '这个请求我暂时无法处理（未识别的项目阶段）。可以新建项目重新开始。'
    persistAssistant(unreachable)
    publishForRun(makeEvent(input, 'message_delta', { text: unreachable }))
    persistTerminalMessage(input.session_id, 'completed')
    publishForRun(makeEvent(input, 'completed', { subtype: 'success' }))
    return { accepted: true, session_id: input.session_id, stream_started: true }
  } catch (error) {
    receiptOutcome = isUserCancelled(error) ? 'cancelled' : 'failed'
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
    // 审计 B-05（2026-10-04）：事件带上原始 message（截 200 字）——渲染端 globalUserError
    // 的优先级是 message > code，原先只有 code 时用户直接看到英文码 AGENT_SDK_ERROR。
    const errorMessageText = (error instanceof Error ? error.message : String(error)).slice(0, 200)
    publishForRun(makeEvent(input, 'error', { code, message: errorMessageText }))
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
    try { updateReceipt(input.client_message_id, receiptOutcome, undefined, input.run_generation) } catch (error) { console.error('[chat-receipt] 运行状态保存失败', error) }
  }
}


// ── web 线拆除刀1（2026-10-01）：存量 web 项目阶段集与下线话术 ──
const WEB_LINE_RETIRED_STAGES = new Set<WorkflowStage>([
  'generating_sketch',
  'sketch_ready',
  'generating_mvp',
  'testing',
  'judge_review',
  'repairing',
  'upgrading',
  'iterating',
  'ready',
  'completed',
])
const WEB_LINE_RETIRED_COPY =
  '这个项目由旧版网页生成线创建，该能力已在本版本下线。项目数据与产物完整保留，可继续查看或导出。如需以桌面软件形态实现类似需求，请新建项目。'

/** web 线拆除刀1：非桌面品类形态引导卡回传处理（卡由 prd-confirm 发放）。 */
async function resolveWebLineRetiredCard(
  input: AgentSendMessageInput,
  streamPublisher: (event: AgentEvent) => void,
  makeEvent: (input: AgentSendMessageInput, type: AgentEvent['type'], payload: Record<string, unknown>) => AgentEvent,
  sdkQuery: SDKQuery | undefined,
  env: Record<string, string>,
): Promise<void> {
  const decision = input.metadata?.selected_option_id
  if (decision === WEB_TO_DESKTOP_OPTION_ID) {
    if (!sdkQuery) {
      // 渠道不可用：如实告知，不进入桌面线（桌面调度员必需真实模型）
      const copy = '当前没有可用的模型渠道，无法按桌面形态起跑。请在设置中配置渠道后，再点一次「按桌面软件继续」。'
      appendAgentMessage(input.session_id, { role: 'assistant', content: [{ type: 'text', text: copy }], timestamp: Date.now() })
      streamPublisher(makeEvent(input, 'message_delta', { text: copy }))
      return
    }
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'modification_decision',
        title: '用户选择按桌面形态继续',
        why: '非桌面品类 PRD 确认后的形态引导卡：改 category=desktop_tool 并进入桌面调度员线',
      },
    })
    updateProject(input.project_id, { template_type: 'desktop_tool' })
    // UX 门对齐（2026-10-06，根因报告发现②修复）：形态卡改品类后与正常桌面品类同门——
    // PRD 确认后一律过 UX 草图门（确认门矩阵 quick=PRD+UX / longterm=PRD+UX+MVP），
    // 不再直调 enterDesktopLine（确认后由 ux-confirm 进桌面线），门矩阵不再有缝隙。
    const backplane = readPrdBackplane(input.project_id)
    await runUxConfirmGate({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: findProject(input.project_id)?.mode ?? 'longterm',
      channel_id: input.channel_id,
      query: sdkQuery,
      env,
      publish: (event) => streamPublisher(event),
      round: 1,
      positioning: backplane?.positioning ?? '',
      requirements: backplane?.requirements ?? [],
    })
    return
  }
  // web_to_revise：回向导调整需求
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'modification_decision',
      title: '用户选择回去调整需求',
      why: '非桌面品类 PRD 确认后的形态引导卡：回到对话调整需求形态',
    },
  })
  const copy = '好的，请直接描述想调整的地方（比如「做成桌面软件，支持离线使用」），我会按新的形态重新梳理需求。'
  appendAgentMessage(input.session_id, { role: 'assistant', content: [{ type: 'text', text: copy }], timestamp: Date.now() })
  streamPublisher(makeEvent(input, 'message_delta', { text: copy }))
}
