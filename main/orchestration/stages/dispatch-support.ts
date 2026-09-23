/**
 * 分发支撑件（PR4b 拆出）：编程系统轮构建、会话历史装载、停滞检测、向导路由判定、重建确认卡。
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

import { ConversationTurn, SDKQueryOptions } from './orchestration-contracts'
import { streamPublisher } from './sdk-glue'
import { runAgent } from './agent-dispatch'
import { convertSDKMessage, extractText, makeEvent } from './persistence'

/**
 * 编程路径模型系统提示（问题 A / P1 纵深防御）。
 *
 * 模型在本路径没有任何写文件 / 跑沙箱的工具：给它的上下文必须是「如实汇报 + 引导确认」，
 * 而不是让它自由发挥——否则它既不知道项目真实阶段（编出「还没好」），
 * 又会把整段 HTML 贴进聊天冒充交付（用户看了却落不了盘）。
 */
export function buildProgrammingSystemTurn(stage: WorkflowStage): ConversationTurn {
  return {
    role: 'system',
    content:
      '你在「Bloma 项目生成平台」的编程阶段协助用户。' +
      '本次对话里你没有写文件、运行代码或启动沙箱的工具——项目的生成、测试与预览都' +
      '由平台在后台自动完成，你无法改变或加速它们。' +
      `当前项目阶段：${stage}。` +
      '规则：用户询问进度时，如实基于阶段回答；不知道就说不知道，绝不假装在后台干活。' +
      `阶段为 ${stage} 时按阶段如实说明：若阶段已是 ready 或 completed，应直接告知用户「项目已经生成好了，请看右侧预览区」，不要用「还没好」「还在生成」之类措辞。` +
      '不要在回复里贴出完整 HTML/JS/CSS 代码块冒充交付物（无工具路径下这些代码不会保存' +
      '到项目文件）。要交付/生成，引导用户点预览区上方的「生成完整功能」确认；要看效果，' +
      '引导用户看右侧预览区。',
  }
}

/**
 * 真实模型查询（SSE 流式 + 多轮历史）。
 *
 * - 对齐 Anthropic Messages API / MiniMax Anthropic 兼容端点（`x-api-key` 认证头）。
 * - 保持 `AsyncGenerator<SDKMessage>` 契约：逐个 `assistant` delta → `result`，
 *   调用方（runAgent/convertSDKMessage/UI）无需改动。
 * - 每个 assistant 消息只携带一段增量文本（非累积），renderer 按 delta 拼接。
 * - 历史经 options.history 传入，消息数组 = [...history, {role:'user', content: prompt}]。
 * - PR1：options.tools 携带工具定义时请求体加 tools，并解析 tool_use 流事件
 *   （input_json_delta 累积 → content_block_stop 产出完整 tool_use block 随当轮
 *   assistant 消息 yield）；message_delta 的 stop_reason / usage 记入 result 消息。
 *   不传 tools 时行为与改造前逐字节一致。导出供 SSE 解析单测直接驱动。
 */
export async function* anthropicMessagesQuery(prompt: string, options: SDKQueryOptions): AsyncGenerator<SDKMessage> {
  if (!options.env.PATH && !options.env.Path) throw new Error('SDK env missing PATH')
  if (options.signal.aborted) throw new Error('AGENT_CANCELLED')
  const apiKey = options.env.ANTHROPIC_AUTH_TOKEN
  if (!apiKey || apiKey === 'test-key-main-only') {
    throw new Error('CHANNEL_NOT_FOUND: configure a model channel before using the SDK')
  }
  const baseUrl = (options.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '')

  // Anthropic Messages API 的 messages 数组只允许 user/assistant 角色，
  // system 必须放顶层 system 字段。把 history 里的 system 消息提取到顶层，
  // 否则 messages 含 role:'system' 会触发 400（MVP 生成的 history 首条就是 system）。
  // PR1 扩展：options.messages 提供时数组原样作为请求 messages（Agent Loop 的
  // tool_result 回填需要把块数组 user 轮完整透传，不能走 prompt 追加拼装）；
  // content 为块数组的轮次直接透传（陷阱 11 扩展：混合 content 一律数组形态）。
  const history = options.messages ?? options.history ?? []
  const systemText = history
    .filter((turn) => turn.role === 'system')
    .map((turn) => (typeof turn.content === 'string' ? turn.content : extractText(turn.content)))
    .filter(Boolean)
    .join('\n')
  const nonSystemTurns = history.filter((turn) => turn.role !== 'system')
  // clipboard-paste P1（2026-08-29）：带图 prompt 组装 [text,...image 短引用] 块数组（畸形引用过滤防注入）
  const pastedRefs = (options.images ?? []).filter(
    (r) => r && typeof r.imageId === 'string' && /^[A-Za-z0-9_-]+\/[A-Za-z0-9-]+\.(png|jpeg|jpg|gif|webp)$/.test(r.imageId),
  )
  const promptTurn: ConversationTurn = pastedRefs.length
    ? {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: prompt },
          ...pastedRefs.map((r) => ({ type: 'image' as const, imageId: r.imageId, media_type: r.media_type })),
        ],
      }
    : { role: 'user' as const, content: prompt }
  // 水合统一入口：无论 options.messages（loop tool_result 回填）还是 history+prompt 拼装路径，
  // 请求体里的 image 块都在此统一转 base64（最近 4 图全量，更早降级；JSONL/内存全程短引用）
  const messages = hydrateMessagesImageBlocks(
    options.messages ? nonSystemTurns : [...nonSystemTurns, promptTurn],
  )

  // 开发插件：BLOMA_SHOW_THINKING=1 时启用 extended thinking 并把思考打印到终端。
  // Anthropic 要求 max_tokens > budget_tokens；预算取一半（封顶 1024，下限 256）。
  const showThinking = isThinkingLogEnabled()
  // 模型只经 env 传入（类别路由已删硬编码默认）：缺失即配置错误，明确抛错不静默猜模型
  const model = options.env.ANTHROPIC_MODEL
  if (!model) {
    throw new Error('SDK_MODEL_NOT_CONFIGURED: SDK env 缺少 ANTHROPIC_MODEL（模型路由未解析到模型）')
  }
  const body: Record<string, unknown> = {
    model,
    max_tokens: options.maxTokens ?? 640000,
    stream: true,
    messages,
  }
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (systemText) body.system = systemText
  if (options.tools?.length) body.tools = options.tools
  if (showThinking) {
    // omit 渠道互斥（2026-08-28 边界收口）：Token Plan 类渠道连 thinking:disabled 都 400，
    // 开发插件 showThinking 若照发 enabled 必 400——omit 时跳过 thinking 字段并留日志。
    const devFragment = buildThinkingFragment(model, options.providerType, 'off')
    if (devFragment.omit) {
      console.warn('[anthropicMessagesQuery] omit 渠道忽略 BLOMA_SHOW_THINKING（thinking 字段会 400）')
    } else {
      const maxTokens = options.maxTokens ?? 640000
      const budget = Math.min(1024, Math.floor(maxTokens / 2))
      body.thinking = { type: 'enabled', budget_tokens: Math.max(256, budget) }
    }
  } else {
    // 推理档位（reasoning-profile 2026-08-27）：判定/校验类任务（judge 等）可经
    // options.thinkingLevel 启用 DeepSeek v4 / GLM 系思考（output_config.effort 独立
    // 深度控制，不吞 max_tokens）；缺省 off = 显式禁思考（2026-08-16 线上案例：
    // MiniMax-M3 等思考型渠道把 max_tokens 全耗在思考上，草图首试 56.5s 零字符）。
    // omit 渠道（Token Plan 类连 disabled 都 400）→ 完全不发字段，消灭 400+重试往返。
    const fragment = buildThinkingFragment(
      model,
      options.providerType,
      options.thinkingLevel ?? 'off',
    )
    if (!fragment.omit) {
      if (fragment.thinking) body.thinking = fragment.thinking
      if (fragment.output_config) body.output_config = fragment.output_config
    }
  }

  const requestInit = (): RequestInit => ({
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  })
  let response = await fetch(`${baseUrl}/v1/messages`, requestInit())
  if (!response.ok) {
    // 诊断增强：读取有界响应体并把可读原因打进主进程日志（仅日志，不进 SDKMessage/UI）。
    // Error message 保持原样，避免 renderer error 事件暴露技术细节。
    let detail = ''
    try {
      const text = (await response.text()).slice(0, 2000)
      detail = extractErrorMessage(text)
    } catch {
      detail = ''
    }
    // 兼容性降级：个别渠道/模型不支持显式 thinking 参数（400 且错误提到 thinking/reasoning/
    // effort/output_config）——移除 thinking 与 output_config 重试一次。覆盖 disabled 档
    // （2026-08-16 前现状）与 enabled+output_config 档（reasoning-profile 试点，审查 P2-⑥：
    // glm-5.3 anthropic 端点对 output_config.effort 的接受度未实测）。思考开关是尽力而为
    // 的优化，绝不因它阻塞生成。
    const thinkingRejected = response.status === 400
      && (body.thinking as { type?: string } | undefined) !== undefined
      && /thinking|reasoning|effort|output_config/i.test(detail)
    // vision 降级（clipboard-paste P2 兑现，r74）：带图请求遇 400 且错误提 image——
    // 模型能力缺失非瞬时故障（重试无意义），包装为用户可读引导而非裸 SDK 400。
    // 三条件缺一不可：400 + 请求确实携带 image 块 + 错误提 image（避免无关 400 误伤）。
    const imageRejected = response.status === 400
      && JSON.stringify(body.messages ?? []).includes('"type":"image"')
      && /image|multimodal|vision|多模态/i.test(detail)
    if (thinkingRejected) {
      console.warn(`[anthropicMessagesQuery] 渠道拒绝 thinking 参数（${detail}），移除该参数后重试一次`)
      delete body.thinking
      delete body.output_config
      response = await fetch(`${baseUrl}/v1/messages`, requestInit())
    } else if (imageRejected) {
      throw Object.assign(
        new Error('当前模型不支持图片输入——请用文字描述内容，或在设置中更换支持视觉的模型后重试。'),
        { statusCode: response.status },
      )
    } else {
      console.error(
        `[anthropicMessagesQuery] model request failed: HTTP ${response.status}`
        + (detail ? ` — ${detail}` : ''),
      )
      throw Object.assign(new Error(`SDK request failed with ${response.status}`), { statusCode: response.status })
    }
  }
  if (!response.ok) {
    // 降级重试后仍失败：按原语义抛错
    let detail = ''
    try {
      detail = extractErrorMessage((await response.text()).slice(0, 2000))
    } catch {
      detail = ''
    }
    console.error(
      `[anthropicMessagesQuery] model request failed: HTTP ${response.status}`
      + (detail ? ` — ${detail}` : ''),
    )
    // 降级重试后仍失败：vision 判定同样生效（thinking 降级重试不移除 image 块；重算因作用域独立）
    const imageRejectedRetry = response.status === 400
      && JSON.stringify(body.messages ?? []).includes('"type":"image"')
      && /image|multimodal|vision|多模态/i.test(detail)
    if (imageRejectedRetry) {
      throw Object.assign(
        new Error('当前模型不支持图片输入——请用文字描述内容，或在设置中更换支持视觉的模型后重试。'),
        { statusCode: response.status },
      )
    }
    throw Object.assign(new Error(`SDK request failed with ${response.status}`), { statusCode: response.status })
  }
  if (!response.body) throw new Error('SDK request body unavailable')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // 事件类型计数（可观测性）：零正文 + 有思考 = 思考型模型把 max_tokens 预算耗在思考上
  // （2026-08-16 线上案例：草图首试 56s 零字符，重试才出正文——上层只能看到 chars=0 无法定位）
  let textDeltaCount = 0
  let thinkingDeltaCount = 0
  let otherDeltaCount = 0
  let toolUseCount = 0
  // PR1 tool use 流解析状态：input_json_delta 分片累积，content_block_stop 产出完整 tool_use
  let activeToolUse: { id: string; name: string; json: string } | null = null
  let stopReason: string | undefined
  let usageInfo: { input_tokens?: number; output_tokens?: number } | undefined
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE 事件以空行分隔；按 data: 行解析（兼容 \r\n 与 [DONE] 结束标记）
      for (;;) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary < 0) break
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const dataLine = rawEvent
          .split('\n')
          .find((line) => line.startsWith('data:'))
        if (!dataLine) continue
        const data = dataLine.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let parsed: {
          type?: string
          delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string; partial_json?: string }
          content_block?: { type?: string; id?: string; name?: string }
          message?: { usage?: { input_tokens?: number; output_tokens?: number } }
          usage?: { input_tokens?: number; output_tokens?: number }
        }
        try {
          parsed = JSON.parse(data) as typeof parsed
        } catch {
          continue
        }
        if (parsed.type === 'content_block_delta') {
          if (parsed.delta?.type === 'text_delta') textDeltaCount += 1
          else if (parsed.delta?.type === 'thinking_delta') thinkingDeltaCount += 1
          else otherDeltaCount += 1
        }
        // 思考过程增量：仅打印到主进程终端（BLOMA_SHOW_THINKING 时），不进 SDKMessage / 事件 / UI / JSONL
        if (
          showThinking &&
          parsed.type === 'content_block_delta' &&
          parsed.delta?.type === 'thinking_delta' &&
          typeof parsed.delta.thinking === 'string'
        ) {
          logThinking(options.sessionId, parsed.delta.thinking)
          continue
        }
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta' && typeof parsed.delta.text === 'string') {
          yield {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: parsed.delta.text }] },
          }
          continue
        }
        // ---- PR1 tool use 解析（无 tools 的请求不会出现这些事件，零行为变化）----
        if (parsed.type === 'message_start') {
          const inputTokens = parsed.message?.usage?.input_tokens
          if (typeof inputTokens === 'number') usageInfo = { ...usageInfo, input_tokens: inputTokens }
          continue
        }
        if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
          activeToolUse = {
            id: typeof parsed.content_block.id === 'string' ? parsed.content_block.id : '',
            name: typeof parsed.content_block.name === 'string' ? parsed.content_block.name : '',
            json: '',
          }
          continue
        }
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta') {
          // partial_json 分片累积（陷阱：绝不能逐片 JSON.parse，必须到 content_block_stop 一次性解析）
          if (activeToolUse && typeof parsed.delta.partial_json === 'string') {
            activeToolUse.json += parsed.delta.partial_json
          }
          continue
        }
        if (parsed.type === 'content_block_stop') {
          if (activeToolUse) {
            let input: Record<string, unknown>
            try {
              input = activeToolUse.json ? (JSON.parse(activeToolUse.json) as Record<string, unknown>) : {}
            } catch {
              // 累积 JSON 损坏（流中断/渠道脏数据）：不给模型残缺输入，置空对象由调用方按
              // 参数校验错误处理——正则修补违反「代码型 JSON 不做修补」约定（陷阱 7）
              input = {}
            }
            yield {
              type: 'assistant',
              message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: activeToolUse.id, name: activeToolUse.name, input }],
              },
            }
            toolUseCount += 1
            activeToolUse = null
          }
          continue
        }
        if (parsed.type === 'message_delta') {
          if (typeof parsed.delta?.stop_reason === 'string') stopReason = parsed.delta.stop_reason
          const outputTokens = parsed.usage?.output_tokens
          if (typeof outputTokens === 'number') usageInfo = { ...usageInfo, output_tokens: outputTokens }
          continue
        }
      }
    }
  } finally {
    // tool-only 轮次（模型只调工具不说话）是 Agent Loop 的正常形态，不算零正文
    if (textDeltaCount === 0 && toolUseCount === 0 && (thinkingDeltaCount > 0 || otherDeltaCount > 0)) {
      console.error(
        `[anthropicMessagesQuery] 零正文输出：model=${String(body.model)} max_tokens=${String(body.max_tokens)} `
        + `text_delta=${textDeltaCount} thinking_delta=${thinkingDeltaCount} other_delta=${otherDeltaCount}`
        + (thinkingDeltaCount > 0 ? '——思考型模型疑似把 max_tokens 预算耗在思考上，正文为零' : ''),
      )
    }
    try {
      reader.releaseLock()
    } catch {
      // 已取消/已释放时忽略
    }
  }

  yield {
    type: 'result',
    subtype: 'success',
    // stop_reason / usage 只在有值时携带（不传 tools 的响应也有 stop_reason——
    // end_turn 等，多带一个字段对既有消费者零影响，Agent Loop 据此判定续轮与埋点）
    ...(stopReason !== undefined ? { stop_reason: stopReason } : {}),
    ...(usageInfo !== undefined ? { usage: usageInfo } : {}),
  }
}


/**
 * 多轮历史窗口（T4-L2）：近 N 轮原文。显式配置常量（默认 10，不静默写死）——
 * 窗口内原文承载「最近在聊什么」；长期不变量（用户约束）不靠窗口，由
 * scanSessionConstraints 全量扫描 + project.constraints 背板注入承载。
 */
export const HISTORY_WINDOW_TURNS = 10

/**
 * 读取会话 JSONL 中最近 N 轮 user/assistant 对话文本，作为 SDK 多轮历史。
 * 排除内部终态标记（[terminal]）与 system 消息——唯一例外是 [decision-card]
 * 选项行（D2 修复）：转成模型可读措辞回灌，否则模型看不到自己上轮给过什么
 * 选项，会原样重问甚至把具体选项退化成抽象类目。其余 system 行
 * （[decision]/[reconcile]/[channel-switch]）维持过滤，防止历史污染模型上下文。
 */
export function loadConversationHistory(sessionId: string, limit = HISTORY_WINDOW_TURNS): ConversationTurn[] {
  const path = getAgentSessionPath(sessionId)
  if (!existsSync(path)) return []
  // 本函数产出的轮次 content 一律是提取后的纯文本（loop 的块数组轮次不经此路径）
  const turns: Array<{ role: ConversationTurn['role']; content: string }> = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let message: AgentMessage
    try {
      message = JSON.parse(line) as AgentMessage
    } catch {
      continue
    }
    if (message.role === 'system') {
      const text = extractText(message.content)
      if (text.startsWith('[decision-card]')) {
        turns.push({
          role: 'system',
          content: `【上轮已向用户出示的选项】${text.slice('[decision-card]'.length).trim()}`,
        })
      }
      continue
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = extractText(message.content)
    if (!text || text.startsWith('[terminal]')) continue
    turns.push({ role: message.role, content: text })
  }

  // 过滤「还没好/还在生成」类冗余助手轮次 + 去重连续相同助手回复（P1）：
  // 这些历史被回灌后会让模型延续「还没好/后台还在跑」的错误阶段认知（自我强化）。
  const filtered: ConversationTurn[] = []
  for (const turn of turns) {
    if (turn.role === 'assistant' && isStallReply(turn.content)) continue
    const previous = filtered[filtered.length - 1]
    if (previous && previous.role === turn.role && previous.content === turn.content) continue
    filtered.push(turn)
  }
  // 窗口只按 user/assistant 轮计数：decision-card 回灌行不占窗口名额，跟随相邻轮
  // 进出窗口——所附着的对话被挤出窗口时一并丢弃，防止孤立的选项行悬空无上下文
  let start = 0
  let keptTurns = 0
  for (let i = filtered.length - 1; i >= 0; i--) {
    if (filtered[i].role === 'system') continue
    keptTurns++
    if (keptTurns > limit) {
      start = i + 1
      break
    }
  }
  return filtered.slice(start)
}

/** 检测「还没好/还在生成」类冗余助手回复（P1：自我强化源，需从历史中过滤）。 */
export function isStallReply(text: string): boolean {
  if (text.length > 50) return false
  return /(还没好|还没呢|还没完成|还没生成完|还在生成|还在跑|还在做|还在处理|后台还在|看不到进度|看不到后台|请稍等|稍等一下|马上就好)/.test(text)
}

export function shouldUseGuideAgent(stage: AgentSendMessageInput['current_stage']): boolean {
  return stage === 'clarifying' || stage === 'blocked_for_user_decision'
}

/** 用户可见文案截断（超长加省略号）。 */
export function truncateForCopy(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/**
 * 发「确认整版重做」二次确认卡（防误触，2026-09-11 卡位改版）。
 * rebuild_direction 收集到方向后与 rebuild_confirm 态更新方向后共用，保证两处
 * 卡文案/选项/阶段流转一致；阶段随卡进入 blocked_for_user_decision。
 */
export function publishRebuildConfirmCard(
  input: AgentSendMessageInput,
  streamPublisher: (event: AgentEvent) => void,
  direction: string,
  persistAssistant: (text: string) => void,
  persistSystem: (text: string) => void,
): void {
  updateProject(input.project_id, { current_stage: 'blocked_for_user_decision' })
  streamPublisher(makeEvent(input, 'stage_changed', { stage: 'blocked_for_user_decision' }))
  const confirmCopy = `你要按「${truncateForCopy(direction, 40)}」整版重做——确认吗？重做会保留已确认的需求与草图，当前版本也会存为快照。`
  persistAssistant(confirmCopy)
  persistSystem('[decision-card] 确定整版重做｜再想想')
  streamPublisher(makeEvent(input, 'message_delta', { text: confirmCopy }))
  streamPublisher(makeEvent(input, 'user_decision_required', {
    kind: 'rebuild_confirm',
    title: '确认整版重做',
    questions: [
      { id: 'rebuild_confirm', label: '确定整版重做', description: '换一种方式重做（保留需求与草图）' },
      { id: 'rebuild_cancel', label: '再想想', description: '先不重做，保持当前版本' },
    ],
  }))
}

