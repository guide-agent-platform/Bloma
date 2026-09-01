import { existsSync, readFileSync } from 'node:fs'
import type { SDKQuery } from './orchestrator'
import { getAgentSessionPath } from '../storage/config-paths'
import { loadPromptOverride } from './prompt-config'
import { buildPrdFewShotInjection, isInjectionEnabled } from './template-injection'
import type { AgentMessage, MessageContentBlock } from '../shared/types'
import type { PrdBackplane, SketchRequirement } from './sketch-engine'
import { categoryTemperature } from './model-resolution'

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
  /** 注入点③：项目类型（few-shot 同类型样例路由）；缺省 personal_tool */
  template_type?: import('../shared/types').TemplateType
  query: SDKQuery
  env: Record<string, string>
  maxTokens?: number
  signal?: AbortSignal
  timeoutMs?: number
}

/** 默认不设生成超时（2026-08-16 用户决策「取消时间限制」，与 sketch/mvp 引擎同步）；timeoutMs>0 才设 timer，供测试注入。 */
/** 2026-08-16 提示词增强：acceptance 每功能项要求多条（正常路径+边界）后，2048 必截断，对齐 mvp 引擎的溢出教训放宽到 8192。 */
const DEFAULT_MAX_TOKENS = 8192

/**
 * 内置默认 system prompt。可被 `{PROMA_HOME}/prompts/prd-system.md` 全量覆盖
 * （见 prompt-config.ts），文件存在即生效、改完即时生效，无需重启。
 * export：供 prompt-service 在设置页展示「内置默认」当前内容。
 */
export const DEFAULT_SYSTEM_PROMPT = `你是「Bloma 需求分析师」，负责把一段用户对话提炼成结构化的 PRD 摘要。这份摘要下游会驱动 MVP 生成、GWT 测试派生与裁判校验——提炼质量直接决定产品质量，请按下面的提取维度与质量标准认真产出。只输出一个 JSON 对象，不要任何多余文字，不要 markdown 代码块围栏。

输出结构：
{"positioning":"产品定位（≤120 字：目标用户 + 核心场景 + 核心价值）",
 "acceptance":{"F-001":"该功能项的验收要点 2~4 条，分号分隔（正常路径 + 边界/异常各至少 1 条）"},
 "out_of_scope":["本轮明确不做的事"],
 "assumptions":["后台做出的假设"]}

提取维度与质量标准：

一、positioning（产品定位）
- 三要素齐全：给谁用（目标用户）、在什么场景（核心场景）、解决什么问题（核心价值）。
- ≤120 字，一段连贯的表述，不是关键词堆砌。
- 以用户最初想做什么（F-001 主题）为锚，不因后续澄清追加项跑偏。

二、acceptance（验收要点，最重要）
- key 必须与给定的功能项 id 一一对应，每个功能项 2~4 条，用分号分隔写在同一个字符串里。
- 必须覆盖：正常路径至少 1 条（用户主流程怎么算成功）+ 边界/异常输入至少 1 条（空输入/非法值/极值时系统的预期行为）。
- 每条可观察、可判定（能转成 GWT 场景），不含实现细节（不提函数/存储/框架）。
- 从对话中用户明确表达过的要求优先提炼；对话没细说的边界，按同类产品的常见合理预期补齐，不臆造用户没提过的新功能。

三、out_of_scope（范围外）
- 用户明确拒绝、排除或表示"本轮不做"的；以及"你帮我决定"时按常见做法主动收敛掉的部分（如多用户/云同步）。
- 防止下游模型擅自扩功能，宁缺毋滥：无明确依据时给空数组，不要编。

四、assumptions（后台假设）
- 后台必须替用户做的技术/产品决策：数据单位、存储方式（如本地保存）、界面语言、排序/汇总规则、默认值等。
- 每条一句话说清"假设了什么"，供后续 decisions 回溯。

示例（家庭记账本，功能项 F-001 记录收入与支出 / F-002 展示本月结余）：
{"positioning":"面向个人与家庭的记账工具，在日常收支发生时快速记录，并在月底直观看到本月结余，帮助用户掌握花钱情况。",
 "acceptance":{
   "F-001":"正常：新增一笔收入或支出（金额+类型+备注）后列表立即可见并持久保存；边界：金额为空、为负或非数字时提示错误且不保存；边界：刷新或重开后已记录的账目仍在",
   "F-002":"正常：按自然月汇总收入与支出并显示结余金额；边界：本月无任何记录时结余显示为 0 而非报错或空白"},
 "out_of_scope":["多用户协作","银行账户自动对接"],
 "assumptions":["金额单位统一为人民币元","数据仅保存在本地，不提供云同步","结余=本月收入合计-本月支出合计"]}

约束：
- 严格基于对话内容提炼，不要臆造用户没提过的功能或约束。
- 只输出 JSON，其余一律不要。`

function getSystemPrompt(): string {
  return loadPromptOverride('prd-system') ?? DEFAULT_SYSTEM_PROMPT
}

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
    // 注入点③（周计划 §6）：同类型脱敏样例 few-shot（≤500 token 硬截断）+ 解析失败
    // 带反馈重试一次（陷阱 7：代码型 JSON 不正则修补，只走带反馈重试）；开关关闭=现状单试
    const fewShot = isInjectionEnabled('prd') ? buildPrdFewShotInjection(input.template_type ?? 'personal_tool') : null
    const prompt = [buildPrompt(items, conversation), fewShot].filter(Boolean).join('\n\n')
    const systemPrompt = getSystemPrompt()
    let accumulated = ''
    for (let attempt = 0; attempt < PRD_GENERATION_ATTEMPTS; attempt += 1) {
      const history =
        attempt === 0
          ? [{ role: 'system' as const, content: systemPrompt }]
          : [
              { role: 'system' as const, content: systemPrompt },
              { role: 'user' as const, content: prompt },
              { role: 'assistant' as const, content: accumulated },
            ]
      const stream = input.query(attempt === 0 ? prompt : PRD_RETRY_FEEDBACK, {
        env: input.env,
        signal,
        sessionId: input.session_id,
        history,
        maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
        // §7.7 类别温度：判定/提取要稳、可复现（0.1）
        temperature: categoryTemperature('prd'),
      })
      let round = ''
      for await (const sdkMessage of stream) {
        if (sdkMessage.type !== 'assistant' || !sdkMessage.message) continue
        const text = extractText(sdkMessage.message.content)
        if (text) round += text
      }
      accumulated = round
      if (controller.signal.aborted) return null
      const parsedNow = parsePrdJson(accumulated)
      if (parsedNow) {
        return buildBackplaneFromParsed(parsedNow, items, input.project_id)
      }
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** PRD 生成尝试次数（注入点③：带反馈重试一次；开关关闭时首轮即返回与现状同构）。 */
const PRD_GENERATION_ATTEMPTS = 2

/** 解析失败反馈（陷阱 7：不修补内容，只要求重输出合法 JSON）。 */
const PRD_RETRY_FEEDBACK =
  '你上一次的输出无法解析为有效 JSON。请重新只输出一个 JSON 对象' +
  '（{"positioning":"…","acceptance":{"F-001":"…"},"out_of_scope":[…],"assumptions":[…]}），' +
  '不要 markdown 代码围栏与任何解释文字，确保括号引号完整闭合。'

function buildBackplaneFromParsed(parsed: ParsedPrd, items: SketchRequirement[], projectId: string): PrdBackplane {
  const acceptance: Record<string, string> = {}
  for (const item of items) {
    acceptance[item.id] = parsed.acceptance[item.id]?.trim() || `${item.description}：核心路径可交互，边界与异常输入不崩溃。`
  }
  return {
    project_id: projectId,
    name: '', // name 由调用方回填（findProject），此处占位
    positioning: parsed.positioning.trim() || items[0].description,
    requirements: items,
    acceptance,
    out_of_scope: parsed.out_of_scope,
    assumptions: parsed.assumptions,
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
    `任务要求：`,
    `- 为每个功能项提炼 2~4 条验收要点（正常路径 + 边界/异常输入各至少 1 条），分号分隔写在同一个字符串里。`,
    `- positioning 覆盖三要素：给谁用、什么场景、解决什么问题（≤120 字）。`,
    `- 对话中信息不足的字段按约定给空数组或简短兜底，不要编造。`,
    ``,
    `【已冻结的功能项（不要改写，只为其补验收要点）】`,
    list,
    ``,
    `【对话历史】`,
    conversation,
  ].join('\n')
}

/** 读取会话 JSONL 中 user/assistant 可见轮次（排除内部 [terminal]/system 标记）。 */
export function readConversation(sessionId: string): string {
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
