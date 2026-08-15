import { existsSync, readFileSync } from 'node:fs'
import type { SDKQuery } from './orchestrator'
import { getAgentSessionPath } from '../storage/config-paths'
import type { AgentMessage, MessageContentBlock } from '../shared/types'
import type { PrdBackplane, SketchRequirement } from './sketch-engine'

/**
 * PrdEngineLlm — 从对话历史提取 PRD 背板（PRD §7.1「草图确认后从对话提取并生成 PRD 初稿」）。
 *
 * 功能项（requirements）已由向导 Agent 在澄清阶段从对话中提取并冻结，本模块不重排、
 * 不改写功能项（保住 F-001 主题锚点不变式，防"货不对板"）；而是用 LLM 从对话中提炼
 * **产品定位一句话、每个功能项的验收要点、明确不做的事（范围外）与后台假设**，这些
 * 是确定性模板（document-engine `buildPrdBackplane`）无法从对话里读出的语义信息。
 *
 * 优雅降级：无 query / 模型不可用 / 超时 / 非 JSON / 校验不过，一律返回 `null`，
 * 由调用方回退 `buildPrdBackplane` 确定性模板，绝不阻断 MVP 生成链路。
 */

export interface GeneratePrdLlmInput {
  project_id: string
  session_id: string
  /** 已冻结的功能项（F-001 主题锚点 + 澄清/纠错追加项），PRD 只做语义补全、不改写。 */
  requirements: SketchRequirement[]
  query: SDKQuery
  env: Record<string, string>
  maxTokens?: number
  signal?: AbortSignal
  timeoutMs?: number
}

/** 默认不设生成超时（2026-08-16 用户决策「取消时间限制」，与 sketch/mvp 引擎同步）；timeoutMs>0 才设 timer，供测试注入。 */
const DEFAULT_MAX_TOKENS = 2048

const SYSTEM_PROMPT = `你是「Bloma 需求分析师」，负责把一段用户对话提炼成结构化的 PRD 摘要。只输出一个 JSON 对象，不要任何多余文字，不要 markdown 代码块围栏。

输出结构：
{"positioning":"产品定位一句话（用户最初想做什么，≤40 字）",
 "acceptance":{"F-001":"该功能项的验收要点（可验证、不含实现细节）"},
 "out_of_scope":["本轮明确不做的事"],
 "assumptions":["后台做出的假设"]}

约束：
- 严格基于对话内容提炼，不要臆造用户没提过的功能或约束。
- acceptance 的 key 必须与给定的功能项 id 一一对应，每个功能项一条验收要点。
- out_of_scope / assumptions 可为空数组；无把握时给空数组，不要编。
- 只输出 JSON，其余一律不要。`

export async function generatePrdLlm(input: GeneratePrdLlmInput): Promise<PrdBackplane | null> {
  const conversation = readConversation(input.session_id)
  if (conversation.length === 0) return null

  const items = input.requirements.length
    ? input.requirements
    : [{ id: 'F-001', description: '一个可运行、可交互的功能页面' }]

  const controller = new AbortController()
  const timeoutMs = input.timeoutMs ?? 0
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined
  const signal = combineSignals(controller.signal, input.signal)

  try {
    const prompt = buildPrompt(items, conversation)
    let accumulated = ''
    const stream = input.query(prompt, {
      env: input.env,
      signal,
      sessionId: input.session_id,
      history: [{ role: 'system', content: SYSTEM_PROMPT }],
      maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    })
    for await (const sdkMessage of stream) {
      if (sdkMessage.type !== 'assistant' || !sdkMessage.message) continue
      const text = extractText(sdkMessage.message.content)
      if (text) accumulated += text
    }

    if (controller.signal.aborted) return null
    const parsed = parsePrdJson(accumulated)
    if (!parsed) return null

    const acceptance: Record<string, string> = {}
    for (const item of items) {
      acceptance[item.id] = parsed.acceptance[item.id]?.trim() || `${item.description}：核心路径可交互，边界与异常输入不崩溃。`
    }

    return {
      project_id: input.project_id,
      name: '', // name 由调用方回填（findProject），此处占位
      positioning: parsed.positioning.trim() || items[0].description,
      requirements: items,
      acceptance,
      out_of_scope: parsed.out_of_scope,
      assumptions: parsed.assumptions,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

interface ParsedPrd {
  positioning: string
  acceptance: Record<string, string>
  out_of_scope: string[]
  assumptions: string[]
}

function parsePrdJson(text: string): ParsedPrd | undefined {
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

  const acceptance: Record<string, string> = {}
  if (isRecord(parsed.acceptance)) {
    for (const [key, value] of Object.entries(parsed.acceptance)) {
      if (typeof value === 'string') acceptance[key] = value
    }
  }
  const stringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

  return {
    positioning: typeof parsed.positioning === 'string' ? parsed.positioning : '',
    acceptance,
    out_of_scope: stringArray(parsed.out_of_scope),
    assumptions: stringArray(parsed.assumptions),
  }
}

function buildPrompt(items: SketchRequirement[], conversation: string): string {
  const list = items.map((r) => `- ${r.id}: ${r.description}`).join('\n')
  return [
    `请从下面的对话历史中提取 PRD 摘要。`,
    ``,
    `【已冻结的功能项（不要改写，只为其补验收要点）】`,
    list,
    ``,
    `【对话历史】`,
    conversation,
  ].join('\n')
}

/** 读取会话 JSONL 中 user/assistant 可见轮次（排除内部 [terminal]/system 标记）。 */
function readConversation(sessionId: string): string {
  const path = getAgentSessionPath(sessionId)
  if (!existsSync(path)) return ''
  const lines: string[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let message: AgentMessage
    try {
      message = JSON.parse(line) as AgentMessage
    } catch {
      continue
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = extractText(message.content)
    if (!text || text.startsWith('[terminal]')) continue
    lines.push(`${message.role === 'user' ? '用户' : '助手'}：${text}`)
  }
  return lines.join('\n')
}

function combineSignals(self: AbortSignal, external?: AbortSignal): AbortSignal {
  if (!external) return self
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  self.addEventListener('abort', onAbort, { once: true })
  external.addEventListener('abort', onAbort, { once: true })
  if (self.aborted || external.aborted) controller.abort()
  return controller.signal
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function extractText(blocks: MessageContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}
