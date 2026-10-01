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
  clearPendingReviewAction,
  isIterationDecisionId,
  nextRequirementId,
  refineModificationDescription,
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
import { anthropicMessagesQueryViaProviders } from '../../platform/upstream/providers/loop-query'

import { SDKQuery } from './orchestration-contracts'
import { sdkQuery, streamPublisher } from './sdk-glue'
import { appendAgentMessage, makeEvent } from './persistence'

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

