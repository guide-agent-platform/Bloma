import { existsSync, readFileSync } from 'node:fs'
import type { SDKQuery } from '../orchestrator'
import { getAgentSessionPath } from '../../storage/config-paths'
import { loadPromptOverride } from '../prompt-config'
import { buildPrdFewShotInjection, isInjectionEnabled } from '../template-injection'
import { callLlmForJson } from '../kernel/llm-call'
import type { AgentMessage, MessageContentBlock } from '../../shared/types'
import type { PrdBackplane, SketchRequirement } from '../model/prd-backplane'
import { buildPrdDocumentFallback } from '../model/prd-backplane'
import { categoryTemperature } from '../model-resolution'

/**
 * PrdEngineLlm — 向导群·需求工程腿（2026-09-03 架构调整：需求工程链归向导）。
 *
 * 形态：向导群内的独立工程子代理——干净上下文（不携带对话期 0.3 活性轮次）、
 * 温度 prd=0.1 确定性、输入=冻结对话快照+冻结功能项。对话期向导（澄清三选一）
 * 与本腿是同群两阶段：收集在前（人在环）、工程化在后（冻结边界内加工）。
 *
 * 产出双形态同源产物（dual-form，导师「PRD 齐备+真正约束工程」意见落地）：
 * - prd_document：长文本 PRD 全文（用户过目对象 + loop 锚定注入）；
 * - 结构化字段（positioning/acceptance/out_of_scope/assumptions）：下游
 *   GWT 派生/裁判校验/内审的机器契约，schema 不变、下游零改动。
 * 两者在同一调用内产出，prompt 强制同源一致（四/七/八节逐字取自结构化字段）。
 *
 * 功能项（requirements）已由向导 Agent 在澄清阶段从对话中提取并冻结，本腿不重排、
 * 不改写功能项（保住 F-001 主题锚点不变式，防"货不对板"）。
 *
 * 优雅降级：无 query / 模型不可用 / 超时 / 非 JSON / 校验不过，一律返回 `null`，
 * 由调用方回退 `buildPrdBackplane` 确定性模板（prd_document 由
 * buildPrdDocumentFallback 机械拼装兜底），绝不阻断 MVP 生成链路。
 */

export interface GeneratePrdLlmInput {
  project_id: string
  session_id: string
  /** 已冻结的功能项（F-001 主题锚点 + 澄清/纠错追加项），PRD 只做语义补全、不改写。 */
  requirements: SketchRequirement[]
  /** 注入点③：项目类型（few-shot 同类型样例路由）；缺省 personal_tool */
  template_type?: import('../../shared/types').TemplateType
  query: SDKQuery
  env: Record<string, string>
  maxTokens?: number
  signal?: AbortSignal
  timeoutMs?: number
}

/** 默认不设生成超时（2026-08-16 用户决策「取消时间限制」，与 sketch/mvp 引擎同步）；timeoutMs>0 才设 timer，供测试注入。 */
/** 2026-09-03 长文本 PRD：document 字段加入后 8192 必截断（对齐 sketch 引擎溢出教训），缺省放宽到 16384；渠道配置上限仍优先（orchestrator 传入）。 */
const DEFAULT_MAX_TOKENS = 16384

/**
 * 内置默认 system prompt。可被 `{PROMA_HOME}/prompts/prd-system.md` 全量覆盖
 * （见 prompt-config.ts），文件存在即生效、改完即时生效，无需重启。
 * export：供 prompt-service 在设置页展示「内置默认」当前内容。
 */
export const DEFAULT_SYSTEM_PROMPT = `你是「Bloma 向导 · 需求工程腿」（2026-09-03 架构调整：需求工程链归向导群；本调用是向导群内的独立工程子代理——干净上下文、低温确定性产出）。任务：把一段用户对话加工成两份同源产物——给用户看的长文本 PRD 全文（document）+ 给机器用的结构化字段（下游驱动 GWT 测试派生与裁判校验）。只输出一个 JSON 对象，不要任何多余文字，不要 markdown 代码块围栏。

输出结构：
{"document":"完整长文本 PRD（章节骨架见下；字符串内换行必须转义为 \\n、引号转义为 \\"，输出前自查括号引号完整闭合）",
 "positioning":"产品定位（≤120 字：目标用户 + 核心场景 + 核心价值）",
 "acceptance":{"F-001":"该功能项的验收要点 2~4 条，分号分隔（正常路径 + 边界/异常各至少 1 条）"},
 "out_of_scope":["本轮明确不做的事"],
 "assumptions":["后台做出的假设"]}

一、document（长文本 PRD 全文——用户过目与下游约束的正式形态）
章节骨架（按序，markdown 标题组织，中文）：
# PRD：{产品名或一句话主题}
## 一、产品定位与背景 —— 三要素（给谁用/什么场景/解决什么）+ 为什么做这件事（对话中用户表达的动机）
## 二、目标用户与使用场景 —— 从对话提炼；对话没说清的按常见合理预期补一句并保持克制
## 三、用户故事 —— 逐功能项一段：「作为<角色>，我想<功能>，以便<价值>」
## 四、功能需求详述 —— 逐项：编号、描述、优先级（P0/P1/P2）、验收要点（**与 acceptance 逐字同源**）
## 五、页面与交互约定 —— 对话能推出的界面形态与交互方式；推不出就写「待草图阶段确定」，不要编
## 六、用户约束与非功能要求 —— 用户说过的「必须/不要」类要求与性能/隐私类诉求；无则写「无特殊约束」
## 七、范围外 —— **与 out_of_scope 逐字同源**；为空时写「本轮无明确排除项」
## 八、后台假设 —— **与 assumptions 逐字同源**；为空时写「无」

质量标准：
- 篇幅自适应：对话信息薄则短（几百字即可），厚则详，以把事情说明白为上限，禁止注水。
- document 与结构化字段必须同源一致：四/七/八节分别逐字取自 acceptance/out_of_scope/assumptions，不得出现字段之外的新功能承诺。
- 严格基于对话内容与给定功能项，不臆造用户没提过的功能或约束；对话没细说的按同类产品常见合理预期补齐并克制表述。

二、positioning（产品定位）
- 三要素齐全：给谁用（目标用户）、在什么场景（核心场景）、解决什么问题（核心价值）。
- ≤120 字，一段连贯的表述，不是关键词堆砌。
- 以用户最初想做什么（F-001 主题）为锚，不因后续澄清追加项跑偏。

三、acceptance（验收要点，最重要）
- key 必须与给定的功能项 id 一一对应，每个功能项 2~4 条，用分号分隔写在同一个字符串里。
- 必须覆盖：正常路径至少 1 条（用户主流程怎么算成功）+ 边界/异常输入至少 1 条（空输入/非法值/极值时系统的预期行为）。
- 每条可观察、可判定（能转成 GWT 场景），不含实现细节（不提函数/存储/框架）。
- 从对话中用户明确表达过的要求优先提炼；对话没细说的边界，按同类产品的常见合理预期补齐，不臆造用户没提过的新功能。

四、out_of_scope（范围外）
- 用户明确拒绝、排除或表示"本轮不做"的；以及"你帮我决定"时按常见做法主动收敛掉的部分（如多用户/云同步）。
- 防止下游模型擅自扩功能，宁缺毋滥：无明确依据时给空数组，不要编。

五、assumptions（后台假设）
- 后台必须替用户做的技术/产品决策：数据单位、存储方式（如本地保存）、界面语言、排序/汇总规则、默认值等。
- 每条一句话说清"假设了什么"，供后续 decisions 回溯。

示例（家庭记账本，功能项 F-001 记录收入与支出 / F-002 展示本月结余；document 节选）：
{"document":"# PRD：家庭记账本\\n## 一、产品定位与背景\\n面向个人与家庭的记账工具：日常收支发生时快速记录，月底直观看到结余，帮助用户掌握花钱情况。用户想要一个比表格省事、随手能记的工具。\\n## 二、目标用户与使用场景\\n个人/家庭用户，在消费或收入发生当下快速记一笔，月底回看汇总。\\n## 三、用户故事\\n- 作为家庭成员，我想记录每笔收入与支出，以便月底清楚钱花在了哪里。\\n- 作为用户，我想按自然月看到结余，以便掌握当月收支状况。\\n## 四、功能需求详述\\n### [F-001]（P0）记录收入与支出\\n验收要点：正常：新增一笔收入或支出（金额+类型+备注）后列表立即可见并持久保存；边界：金额为空、为负或非数字时提示错误且不保存；边界：刷新或重开后已记录的账目仍在\\n### [F-002]（P0）展示本月结余\\n验收要点：正常：按自然月汇总收入与支出并显示结余金额；边界：本月无任何记录时结余显示 0 而非报错或空白\\n## 五、页面与交互约定\\n首页为记账列表+快速记一笔入口，顶部显示本月结余。\\n## 六、用户约束与非功能要求\\n无特殊约束\\n## 七、范围外\\n多用户协作；银行账户自动对接\\n## 八、后台假设\\n金额单位统一为人民币元；数据仅保存在本地，不提供云同步；结余=本月收入合计-本月支出合计",
 "positioning":"面向个人与家庭的记账工具，在日常收支发生时快速记录，并在月底直观看到本月结余，帮助用户掌握花钱情况。",
 "acceptance":{
   "F-001":"正常：新增一笔收入或支出（金额+类型+备注）后列表立即可见并持久保存；边界：金额为空、为负或非数字时提示错误且不保存；边界：刷新或重开后已记录的账目仍在",
   "F-002":"正常：按自然月汇总收入与支出并显示结余金额；边界：本月无任何记录时结余显示 0 而非报错或空白"},
 "out_of_scope":["多用户协作","银行账户自动对接"],
 "assumptions":["金额单位统一为人民币元","数据仅保存在本地，不提供云同步","结余=本月收入合计-本月支出合计"]}

约束：
- 严格基于对话内容提炼，不要臆造用户没提过的功能或约束。
- document 是给用户过目的正式 PRD：它将随确认卡全文展示，并全文注入编程 Agent 的项目锚（与结构化字段冲突时以结构化字段为准）。
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

  // 2026-09-03 R2：超时/abort/重试循环已下沉 kernel/llm-call（timeoutMs 透传，缺省 0 = 无超时）

  try {
    // 注入点③（周计划 §6）：同类型脱敏样例 few-shot（≤500 token 硬截断）+ 解析失败
    // 带反馈重试一次（陷阱 7：代码型 JSON 不正则修补，只走带反馈重试）；开关关闭=现状单试
    const fewShot = isInjectionEnabled('prd') ? buildPrdFewShotInjection(input.template_type ?? 'personal_tool') : null
    const prompt = [buildPrompt(items, conversation), fewShot].filter(Boolean).join('\n\n')
    // 2026-09-03 R2：调用循环收敛至 kernel/llm-call 标准件（stream/parse/带反馈重试/abort/超时一处实现）
    const parsed = await callLlmForJson({
      systemPrompt: getSystemPrompt(),
      prompt,
      query: input.query,
      env: input.env,
      sessionId: input.session_id,
      maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      // §7.7 类别温度：判定/提取要稳、可复现（0.1）
      temperature: categoryTemperature('prd'),
      attempts: PRD_GENERATION_ATTEMPTS,
      retryFeedback: PRD_RETRY_FEEDBACK,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      parse: parsePrdJson,
    })
    return parsed ? buildBackplaneFromParsed(parsed, items, input.project_id) : null
  } catch {
    return null
  }
}

/** PRD 生成尝试次数（注入点③：带反馈重试一次；开关关闭时首轮即返回与现状同构）。 */
const PRD_GENERATION_ATTEMPTS = 2

/** 解析失败反馈（陷阱 7：不修补内容，只要求重输出合法 JSON）。 */
const PRD_RETRY_FEEDBACK =
  '你上一次的输出无法解析为有效 JSON。请重新只输出一个 JSON 对象' +
  '（{"document":"长文本 PRD 全文","positioning":"…","acceptance":{"F-001":"…"},"out_of_scope":[…],"assumptions":[…]}），' +
  '不要 markdown 代码围栏与任何解释文字，确保括号引号完整闭合、document 内换行与引号已转义。'

function buildBackplaneFromParsed(parsed: ParsedPrd, items: SketchRequirement[], projectId: string): PrdBackplane {
  const acceptance: Record<string, string> = {}
  for (const item of items) {
    acceptance[item.id] = parsed.acceptance[item.id]?.trim() || `${item.description}：核心路径可交互，边界与异常输入不崩溃。`
  }
  const positioning = parsed.positioning.trim() || items[0].description
  // 长文本 PRD dual-form：document 缺失/空白时由结构化字段机械拼装兜底（确定性，不编内容），
  // 保证背板 prd_document 恒存在（确认卡/loop 锚定的消费假设）
  const prdDocument =
    parsed.document.trim() ||
    buildPrdDocumentFallback({
      positioning,
      requirements: items,
      acceptance,
      out_of_scope: parsed.out_of_scope,
      assumptions: parsed.assumptions,
    })
  return {
    project_id: projectId,
    name: '', // name 由调用方回填（findProject），此处占位
    positioning,
    prd_document: prdDocument,
    requirements: items,
    acceptance,
    out_of_scope: parsed.out_of_scope,
    assumptions: parsed.assumptions,
  }
}

interface ParsedPrd {
  document: string
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
    document: typeof parsed.document === 'string' ? parsed.document : '',
    acceptance,
    out_of_scope: stringArray(parsed.out_of_scope),
    assumptions: stringArray(parsed.assumptions),
  }
}

function buildPrompt(items: SketchRequirement[], conversation: string): string {
  const list = items.map((r) => `- ${r.id}: ${r.description}`).join('\n')
  return [
    `请从下面的对话历史中产出双形态同源 PRD：长文本全文（document）+ 结构化字段。`,
    ``,
    `任务要求：`,
    `- document：完整长文本 PRD（章节骨架：定位与背景/目标用户与场景/用户故事/功能详述/页面与交互约定/约束/范围外/后台假设），与结构化字段同源一致。`,
    `- 为每个功能项提炼 2~4 条验收要点（正常路径 + 边界/异常输入各至少 1 条），分号分隔写在同一个字符串里。`,
    `- positioning 覆盖三要素：给谁用、什么场景、解决什么问题（≤120 字）。`,
    `- 对话中信息不足的字段按约定给空数组或简短兜底，不要编造。`,
    ``,
    `【已冻结的功能项（不要改写，只为其补验收要点与叙事）】`,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function extractText(blocks: MessageContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}
