import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentSendMessageInput, MessageContentBlock, Project } from '../shared/types'
import { routeDialogue, type ClarificationOption } from './dialogue-router'
import { recordDecision } from './decision-log'
import type { ConversationTurn, GuideModelOptions } from './orchestrator'
import { trackAnalytics } from './platform-services'
import { runSketchTask, setProgrammingEventPublisher } from './programming-orchestrator'
import { findProject, updateProject } from './project-service'
import { captureConstraints, extractConstraints } from './constraint-extractor'
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

【需求不清晰 → 澄清：问一个问题，并给出这个问题可点选的答案】
{"action":"ask_clarification",
 "reply":"一个明确的问句（只问一个产品维度：做哪种类型/给谁用/核心场景，≤40 字，以？结尾）",
 "questions":[
   {"id":"answer-ledger","label":"这个问题的一个具体答案（名词短语 ≤8 字，如「记账本」）","description":"选它之后会做成什么样（≤20 字）"},
   {"id":"answer-todo","label":"另一个互斥的具体答案","description":"……"},
   {"id":"auto","label":"你帮我决定","description":"交给我，按常见做法先出一版"}
 ]}

澄清规则（重要）：
- questions 是 reply 那个问题的候选答案，不是新问题；用户点任何一个都能直接开工。
- 选项互斥、具体、贴合用户原话：用「记账本/待办清单/赛道计时赛」这类名词短语。
- 禁止抽象形容词当选项（「自由」「灵活」「好用」），禁止占位文案（「范围选项」「选项一」），label 不以「？」结尾。
- questions 2~4 条，最后一条固定为 {"id":"auto","label":"你帮我决定","description":"交给我，按常见做法先出一版"}。
- 确实无法给出具体选项时才 questions:[]（在 reply 里纯文本追问）。
- 用户已回答过 2 轮澄清仍不明确：选最接近的理解直接 generate_sketch，不要再追问。

约束：
- requirements 1~5 条。
- id 用小写字母+连字符（如 daily-tool），不含空格。
- 用户说的约束（「不含登录」「必须离线可用」「禁止联网」这类必须/不要类要求）不要写成 requirements 功能项——平台会单独持久化并注入，requirements 只放要做的事。
- 只输出 JSON，其余一律不要。`

type GuideParsed =
  | { action: 'generate_sketch'; reply: string; requirements: { id: string; description: string }[] }
  | { action: 'ask_clarification'; reply: string; questions: { id: string; label: string; description?: string }[] }

/**
 * 首轮硬护栏（附加到系统提示尾部）：需求确认是产品闭环的必经一环，不能因模型采样差异被跳过
 * （2026-08-16 赛车模拟器案例：同样输入一天前澄清、一天后直出草图，用户全程零确认）。
 */
const FIRST_TURN_RULE = `

本轮硬性要求：这是用户在本次会话的第一条消息，你必须输出 ask_clarification，禁止输出 generate_sketch——先就最影响成品形态的一个维度（做哪种类型/给谁用/核心场景）提问，并给出 2~3 个互斥的具体选项。`

/**
 * 规则路由三张固定卡片（日常生活/工作提效/你帮我决定）→ 草图需求扩写。
 * 卡片答案是结构化决策：用户已选方向，直接生成草图（修复规则路由澄清死循环）。
 * 仅在点选文案与 FIXED_CARD_LABELS 完全一致时启用；其余一律以点选原文为需求。
 */
const CARD_ANSWER_REQUIREMENTS: Record<string, string> = {
  daily: '日常生活工具：帮助管理日常事务，如记账、提醒、清单',
  work: '工作提效工具：帮助提升工作场景效率，如流程、协作、记录',
  auto: '通用实用软件工具，由向导按常见做法生成第一版',
}

/**
 * 规则路由三张固定卡片的 label → 选项 id。只有点选文案与固定卡片完全一致时才用
 * 预置需求扩写；模型卡片可能复用同名 id（如 daily）但含义不同，一律以点选原文
 * 为准，防止 id 撞车把需求映射到毫不相干的预置文案上。
 */
const FIXED_CARD_LABELS: Record<string, string> = {
  daily: '日常生活工具',
  work: '工作提效工具',
  auto: '你帮我决定',
}

/** 阻塞态让渡卡片的决策 id（accept/explain/continue）由 resumeBlockedFlow 处理，不得误入草图生成。 */
const BLOCKED_DECISION_IDS = new Set(['accept', 'explain', 'continue'])

/** 兜底选项：每张澄清卡片固定收尾，保证用户永远有「不选具体方向也能开工」的出口。 */
const AUTO_ESCAPE_OPTION: ClarificationOption = {
  id: 'auto',
  label: '你帮我决定',
  description: '交给我，按常见做法先出一版',
}

/** 占位/问题式 label：模型把模板占位文案或新问题当成选项输出时，直接丢弃。 */
function isBadOptionLabel(label: string): boolean {
  const trimmed = label.trim()
  if (trimmed.length < 2) return true
  if (/[?？]$/.test(trimmed)) return true
  return /^(范围)?选项\s*[一二三四五六七八九十0-9a-c]?$|^option\s*[a-c]?$/i.test(trimmed)
}

const LABEL_MAX_LENGTH = 12
const DESCRIPTION_MAX_LENGTH = 30
/** 模型方向项上限：加 auto 兜底后单轮最多 4 张卡（对齐 CardOptions 契约）。 */
const MODEL_OPTION_MAX = 3

/**
 * 澄清选项纠偏：模型输出的 questions 一律不信任——占位/问句式 label 丢弃、
 * label 去重、超长截断；纠偏后非空必补「你帮我决定」兜底项；全军覆没则返回
 * 空数组（降级为 reply 纯文本追问），绝不把莫名其妙的光杆选项弹给用户。
 * 只处理用户可见文案的展示层截断，不触碰「代码型 JSON 不可修补」红线。
 */
function normalizeClarificationOptions(raw: ClarificationOption[]): ClarificationOption[] {
  const seen = new Set<string>()
  const options: ClarificationOption[] = []
  for (const option of raw) {
    const label = option.label.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX_LENGTH)
    if (isBadOptionLabel(label) || seen.has(label)) continue
    seen.add(label)
    const description = option.description?.replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_MAX_LENGTH)
    options.push(description ? { id: option.id, label, description } : { id: option.id, label })
    if (options.length >= MODEL_OPTION_MAX) break
  }
  if (options.length === 0) return []
  const hasEscape = options.some(
    (option) => option.id === 'auto' || /帮你决定|你来定|你决定/.test(option.label),
  )
  return hasEscape ? options : [...options, AUTO_ESCAPE_OPTION]
}

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
  const isFixedCard = FIXED_CARD_LABELS[optionId ?? ''] === input.content.trim()
  const description = isFixedCard ? CARD_ANSWER_REQUIREMENTS[optionId ?? ''] : input.content
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
  /** 内部标记落盘（system role，回访恢复不展示）：决策卡片弹出时记录选项原文，供事后追溯 */
  persistSystem?: (text: string) => void,
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

  // 用户约束走门（T4-L1 写入侧）：约束语句（「不含登录」「必须离线可用」）确定性提取、
  // 持久化 project.constraints，随背板常驻注入——不依赖模型记忆，首轮约束历轮生效。
  // 在三条子路径（卡片答案/模型驱动/规则路由）分叉之前统一收口。
  captureConstraints({
    project_id: input.project_id,
    session_id: input.session_id,
    constraints: extractConstraints(input.content),
    source: 'guide_gate',
  })

  // 卡片答案：用户已通过选项给出方向，直接生成草图（修复澄清死循环）
  const cardAnswer = resolveCardAnswer(input, primaryIntent)
  if (cardAnswer) {
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'clarification_answer',
        title: '用户点选澄清答案',
        why: `用户点选「${input.content}」，以此作为已确认方向生成草图`,
        detail: {
          option_id: input.metadata?.selected_option_id,
          requirements: cardAnswer.requirements,
        },
      },
    })
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
      channel_id: input.channel_id,
      query: model?.query,
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
  persistSystem?: (text: string) => void,
  project?: Project,
): Promise<boolean> {
  // 首轮判定：会话里还没有任何助手回复 = 用户尚未经历过一轮澄清（卡片答案路径不经过此处）
  const isFirstTurn = !model.history.some((turn) => turn.role === 'assistant')
  const systemTurn: ConversationTurn = {
    role: 'system',
    content: isFirstTurn ? GUIDE_SYSTEM_PROMPT + FIRST_TURN_RULE : GUIDE_SYSTEM_PROMPT,
  }
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
      temperature: model.temperature,
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
    publishClarificationCard(input, publish, normalizeClarificationOptions(parsed.questions), persistSystem, parsed.reply.trim())
    return true
  }

  // generate_sketch：不经 user_decision_required，直接进入草图生成（渠道可用走 LLM，否则回退模板）
  await runSketchTask({
    request_id: input.request_id,
    session_id: input.session_id,
    project_id: input.project_id,
    mode: input.mode,
    prompt: parsed.reply || input.content,
    requirements: ensurePrimaryIntent(parsed.requirements, primaryIntent),
    channel_id: input.channel_id,
    query: model.query,
  })
  return true
}

/**
 * 发布澄清决策卡片并落盘选项原文（[decision-card] 内部标记）+ 决策日志（T2）。
 * questions 为空表示纯文本澄清，不弹卡片；有选项时务必落盘——
 * user_decision_required 事件只存在渲染端内存，不落盘则事后无法追溯
 * 到底给用户弹过哪些选项（历史会话只能看到 reply 问句）。
 */
function publishClarificationCard(
  input: AgentSendMessageInput,
  publish: GuideEventPublisher,
  questions: ClarificationOption[],
  persistSystem?: (text: string) => void,
  question?: string,
): void {
  if (questions.length > 0) {
    persistSystem?.(`[decision-card] ${questions.map((option) => option.label).join('｜')}`)
  }
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'clarification_card',
      title: '澄清提问',
      why: question ? `向用户提问：「${question}」` : '向用户追问澄清（纯文本，无选项卡片）',
      detail: { options: questions.map((option) => option.label) },
    },
  })
  publish(makeGuideEvent(input, 'user_decision_required', {
    kind: 'clarification',
    title: '先确认方向',
    // 0 条表示纯文本澄清，B 侧不弹卡片
    questions,
  }))
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
      // 预截取放宽到 8 条：占位/问句式坏选项要在纠偏（normalizeClarificationOptions）时
      // 才被丢弃，先截 3 条会让坏选项占坑挤掉后面的合法项
      .slice(0, 8)
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
