import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentSendMessageInput, MessageContentBlock } from '../shared/types'
import { routeDialogue } from './dialogue-router'
import type { ConversationTurn, GuideModelOptions } from './orchestrator'
import { trackAnalytics } from './platform-services'
import { runSketchTask, setProgrammingEventPublisher } from './programming-orchestrator'
import { findProject, updateProject } from './project-service'
import { readPrimaryIntent } from './session-service'
import type { SketchRequirement } from './sketch-engine'
import { isRecord } from './validators'

type GuideEventPublisher = (event: AgentEvent) => void

/** 引导对话给模型的结构化指令：模型只输出 JSON 二选一（对齐 A2-14a Step 3 模板）。 */
const GUIDE_SYSTEM_PROMPT = `你是「向导 Agent」，负责把用户的想法澄清成可生成草图的软件需求。只输出一个 JSON 对象，不要任何多余文字，不要 markdown 代码块围栏。

二选一输出：

【需求足够清晰 → 直接生成草图】
{"action":"generate_sketch",
 "reply":"给用户的简短确认话术（简体中文 ≤20 字，口语化，不含技术细节）",
 "requirements":[{"id":"F-001","description":"核心功能点（动词开头，用户原话提炼，≤40 字）"}]}

【需求不清晰 → 需要澄清】
{"action":"ask_clarification",
 "reply":"向用户澄清的引导语（简体中文一句话）",
 "questions":[{"id":"scope","label":"范围选项（≤6 字）","description":"解释含义（≤20 字）"}]}

约束：
- requirements 1~5 条；questions 0~3 条（0 条时表示直接在 reply 里追问，不弹选项）。
- id 用小写字母+连字符（如 daily-tool），不含空格。
- 只输出 JSON，其余一律不要。`

type GuideParsed =
  | { action: 'generate_sketch'; reply: string; requirements: { id: string; description: string }[] }
  | { action: 'ask_clarification'; reply: string; questions: { id: string; label: string; description?: string }[] }

/**
 * 澄清卡片已知选项 id → 草图需求描述。
 * 卡片答案是结构化决策：用户已选方向，直接生成草图（修复规则路由澄清死循环）。
 * 未知 id（如模型自定义问题）退回用户点选文案本身作为需求。
 */
const CARD_ANSWER_REQUIREMENTS: Record<string, string> = {
  daily: '日常生活工具：帮助管理日常事务，如记账、提醒、清单',
  work: '工作提效工具：帮助提升工作场景效率，如流程、协作、记录',
  auto: '通用实用软件工具，由向导按常见做法生成第一版',
}

/** 阻塞态让渡卡片的决策 id（accept/explain/continue）由 resumeBlockedFlow 处理，不得误入草图生成。 */
const BLOCKED_DECISION_IDS = new Set(['accept', 'explain', 'continue'])

interface CardAnswerRoute {
  prompt: string
  requirements: SketchRequirement[]
}

/**
 * 保证需求清单始终以"主题"为 F-001 锚点：澄清答案（如"网页端"）只是主题的属性，
 * 绝不能覆盖最初的主题（如"音乐合成器"）。清单已含主题时原样返回；否则把主题
 * 前置为 F-001，其余项顺延为 F-002/F-003…，避免"货不对板"。
 */
function ensurePrimaryIntent(
  requirements: SketchRequirement[],
  primaryIntent: string | undefined,
): SketchRequirement[] {
  if (!primaryIntent) return requirements
  const normalized = primaryIntent.replace(/\s+/g, ' ').trim()
  if (!normalized) return requirements
  const hasTheme = requirements.some((item) => {
    const description = item.description.replace(/\s+/g, ' ').trim()
    return description.includes(normalized) || normalized.includes(description)
  })
  if (hasTheme) return requirements
  const shifted = requirements.map((item, index) => ({
    ...item,
    id: `F-${String(index + 2).padStart(3, '0')}`,
  }))
  return [{ id: 'F-001', description: normalized }, ...shifted]
}

/** 卡片选项答案：metadata.source === 'card_option' 且非阻塞决策 id 时，视为已澄清，直接生成草图。 */
function resolveCardAnswer(input: AgentSendMessageInput, primaryIntent?: string): CardAnswerRoute | undefined {
  if (input.metadata?.source !== 'card_option') return undefined
  const optionId = input.metadata.selected_option_id
  if (BLOCKED_DECISION_IDS.has(optionId ?? '')) return undefined
  const description = CARD_ANSWER_REQUIREMENTS[optionId ?? ''] ?? input.content
  return {
    prompt: input.content,
    requirements: ensurePrimaryIntent([{ id: 'F-001', description }], primaryIntent),
  }
}

export async function handleGuideMessage(
  input: AgentSendMessageInput,
  publish: GuideEventPublisher,
  model?: GuideModelOptions,
  /** 规则路由下也把助手回复写入会话 JSONL，保证回访恢复与实时 UI 一致 */
  persistAssistant?: (text: string) => void,
): Promise<void> {
  const project = findProject(input.project_id)
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

  // 卡片答案：用户已通过选项给出方向，直接生成草图（修复澄清死循环）
  const cardAnswer = resolveCardAnswer(input, primaryIntent)
  if (cardAnswer) {
    const ack = '好的，按你选的方向开始生成草图。'
    persistAssistant?.(ack)
    publish(makeGuideEvent(input, 'message_delta', { text: ack }))
    await runSketchTask({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      prompt: cardAnswer.prompt,
      requirements: cardAnswer.requirements,
    })
    return
  }

  // 渠道可用 → 优先走真实模型；模型不可用 / 解析失败 → 回退规则路由
  if (model) {
    const handled = await tryModelDrivenGuide(input, publish, model, primaryIntent)
    if (handled) return
  }

  const route = routeDialogue(input.content, project)
  if (route.action === 'ask_clarification') {
    updateProject(input.project_id, { current_stage: 'blocked_for_user_decision' })
    publish(makeGuideEvent(input, 'stage_changed', { stage: 'blocked_for_user_decision' }))
    const reply = '我需要再确认几个关键点，这样草图会更接近你的想法。'
    persistAssistant?.(reply)
    publish(makeGuideEvent(input, 'message_delta', { text: reply }))
    publish(makeGuideEvent(input, 'user_decision_required', {
      kind: 'clarification',
      title: '先确认方向',
      questions: route.questions.slice(0, 3),
    }))
    return
  }

  await runSketchTask({
    request_id: input.request_id,
    session_id: input.session_id,
    project_id: input.project_id,
    mode: input.mode,
    prompt: input.content,
    requirements: ensurePrimaryIntent(route.requirements, primaryIntent),
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
async function tryModelDrivenGuide(
  input: AgentSendMessageInput,
  publish: GuideEventPublisher,
  model: GuideModelOptions,
  primaryIntent?: string,
): Promise<boolean> {
  const systemTurn: ConversationTurn = { role: 'system', content: GUIDE_SYSTEM_PROMPT }
  const history: ConversationTurn[] = [systemTurn, ...model.history]

  // 只做内部累积：模型流式吐的是原始 JSON，不发布 message_delta，避免结构泄露
  let accumulated = ''
  try {
    const stream = model.query(input.content, {
      env: model.env,
      signal: model.signal,
      sessionId: model.sessionId,
      history,
      maxTokens: model.maxTokens,
    })
    for await (const sdkMessage of stream) {
      if (sdkMessage.type !== 'assistant' || !sdkMessage.message) continue
      const text = extractText(sdkMessage.message.content)
      if (text) accumulated += text
    }
  } catch {
    // 模型不可用/网络错误：回退规则路由（不打断澄清流程）
    return false
  }

  const parsed = parseGuideJson(accumulated)
  if (!parsed) return false

  // 仅把对用户可读的 reply 上屏并落盘；缺省给通用兜底话术，绝不写回原始 JSON
  const reply =
    parsed.reply.trim() ||
    (parsed.action === 'ask_clarification'
      ? '想再多了解一点，方便我判断该怎么做。'
      : '好的，开始按你的想法生成草图。')
  model.persistAssistant(reply)
  publish(makeGuideEvent(input, 'message_delta', { text: reply }))
  publish(makeGuideEvent(input, 'message_completed', { subtype: 'success' }))

  if (parsed.action === 'ask_clarification') {
    updateProject(input.project_id, { current_stage: 'blocked_for_user_decision' })
    publish(makeGuideEvent(input, 'stage_changed', { stage: 'blocked_for_user_decision' }))
    publish(makeGuideEvent(input, 'user_decision_required', {
      kind: 'clarification',
      title: '先确认方向',
      // questions 0~3 条：0 条表示纯文本澄清，B 侧不弹卡片
      questions: parsed.questions,
    }))
    return true
  }

  // generate_sketch：不经 user_decision_required，直接进入草图生成（模板化 runSketchTask）
  await runSketchTask({
    request_id: input.request_id,
    session_id: input.session_id,
    project_id: input.project_id,
    mode: input.mode,
    prompt: parsed.reply || input.content,
    requirements: ensurePrimaryIntent(parsed.requirements, primaryIntent),
  })
  return true
}

function parseGuideJson(text: string): GuideParsed | undefined {
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
      .map((r) => ({ id: r.id as string, description: r.description as string }))
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
      .slice(0, 3)
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

  return undefined
}

function extractText(blocks: MessageContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

function makeGuideEvent(
  input: AgentSendMessageInput,
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
