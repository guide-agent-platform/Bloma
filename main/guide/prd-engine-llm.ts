import { existsSync, readFileSync } from 'node:fs'
import type { SDKQuery } from '../orchestration/orchestrator'
import { getAgentSessionPath } from '../../storage/config-paths'
import { loadPromptOverride } from '../agent/prompting/prompt-config'
import { buildPrdFewShotInjection } from '../agent/prompting/template-injection'
import { callLlmForJson, type LlmAttemptFailure } from '../kernel/llm-call'
import type { AgentMessage, MessageContentBlock, TemplateType } from '../../shared/types'
import type { AiCapability, GameDesignDoc, InterfaceEndpoint, KeyTask, PrdBackplane, SketchRequirement } from '../model/prd-backplane'
import {
  buildPrdDocumentFallback,
  capContractEnabled,
  deriveAiCapabilities,
  finalizeKeyTasks,
  keyTasksEnabled,
  normalizePrdDocumentNewlines,
  reconcilePrdDocumentPriorities,
} from '../model/prd-backplane'
import { renderDocumentSectionSpec } from './prd-sections'
import { categoryTemperature } from '../platform/llm/model-resolution'
import { updateProject } from '../project/project-service'
import { recordDecision } from '../project/decision-log'

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
  /** 尝试失败观测（2026-10-03）：管线侧据此把真实原因写进 prd_backplane_fallback 决策日志。 */
  onAttemptFailure?: (failure: LlmAttemptFailure) => void
}

/** 默认不设生成超时（2026-08-16 用户决策「取消时间限制」，与 sketch/mvp 引擎同步）；timeoutMs>0 才设 timer，供测试注入。 */
/** 对齐全渠道 640000（防思考型渠道零正文）；渠道配置上限仍优先（orchestrator 传入）。 */
const DEFAULT_MAX_TOKENS = 640000

/**
 * 内置默认 system prompt。可被 `{PROMA_HOME}/prompts/prd-system.md` 全量覆盖
 * （见 prompt-config.ts），文件存在即生效、改完即时生效，无需重启。
 * export：供 prompt-service 在设置页展示「内置默认」当前内容。
 * ⚠️ 双写义务（2026-09-18 提示词稳健性评估拍板）：改本常量必须同步改
 * ~/.proma/prompts/prd-system.md 覆盖快照——覆盖存在时内置修改会被无声遮蔽
 * （静态快照陷阱，Phase 1 已知）；留存触发词表另与 prd-backplane.PERSISTENCE_SIGNAL_RE
 * 同步义务互指。
 */
export const DEFAULT_SYSTEM_PROMPT = `你是「Bloma 向导 · 需求工程腿」（2026-09-03 架构调整：需求工程链归向导群；本调用是向导群内的独立工程子代理——干净上下文、低温确定性产出）。任务：把一段用户对话加工成两份同源产物——给用户看的长文本 PRD 全文（document）+ 给机器用的结构化字段（下游驱动 GWT 测试派生与裁判校验）。只输出一个 JSON 对象，不要任何多余文字，不要 markdown 代码块围栏。

输出结构：
{"document":"完整长文本 PRD（章节骨架见下；字符串内换行必须转义为 \\n、引号转义为 \\"，输出前自查括号引号完整闭合）",
 "positioning":"产品定位（≤120 字：目标用户 + 核心场景 + 核心价值）",
 "form":"交付形态自判：desktop | game | web。规则：游戏/复刻类（玩法为核心）=game；用户明确要求网站/网页/浏览器/小程序/在线平台形态=web；其余（含一切 Windows 桌面/单机/本地工具）一律 desktop",
 "acceptance":{"F-001":"该功能项的验收要点 2~4 条，分号分隔（正常路径 + 边界/异常各至少 1 条）"},
 "out_of_scope":["本轮明确不做的事"],
 "assumptions":["后台做出的假设"],
 "gdd":{"core_fantasy":"核心幻想","pillars":["支柱 1"],"core_loop":["阶段 1"],"numbers":["数值基准"]}}  // 仅 form=game 时输出，非游戏省略此字段

一、document（长文本 PRD 全文——用户过目与下游约束的正式形态）
章节骨架（按序，markdown 标题组织，中文；章节由 schema 驱动，空章节写「无/待确定」不编内容）：
# PRD：{产品名或一句话主题}
${renderDocumentSectionSpec()}

质量标准：
- 篇幅自适应：对话信息薄则短（几百字即可），厚则详，以把事情说明白为上限，禁止注水。
- document 与结构化字段必须同源一致：功能清单/范围外/后台假设分别逐字取自 acceptance/out_of_scope/assumptions，不得出现字段之外的新功能承诺。
- 严格基于对话内容与给定功能项，不臆造用户没提过的功能或约束；对话没细说的按同类产品常见合理预期补齐并克制表述。

二、positioning（产品定位）
- 三要素齐全：给谁用（目标用户）、在什么场景（核心场景）、解决什么问题（核心价值）。
- ≤120 字，一段连贯的表述，不是关键词堆砌。
- 以用户最初想做什么（F-001 主题）为锚，不因后续澄清追加项跑偏。

三、acceptance（验收要点，最重要）
- key 必须与给定的功能项 id 一一对应，每个功能项 2~4 条，用分号分隔写在同一个字符串里。
- 必须覆盖：正常路径至少 1 条（用户主流程怎么算成功）+ 边界/异常输入至少 1 条（空输入/非法值/极值时系统的预期行为）。
- 每条可观察、可判定（能转成 GWT 场景），不含实现细节（不提函数/存储/框架）。
- 【持久化措辞纪律（2026-09-18 裁判三连退实锤；2026-10-05 桌面唯一品类改口径）】凡功能涉及数据留存，description 与验收要点一律用行为语汇描述留存（如「关闭后重新打开仍在」「重启后数据不丢」），禁写任何实现机制（本地文件/JSON/localStorage/数据库等——实现由编程 Agent 按品类决定）；用户或向导原话含机制词时转写为行为表述，原话移入 assumptions 备查。
- 从对话中用户明确表达过的要求优先提炼；对话没细说的边界，按同类产品的常见合理预期补齐，不臆造用户没提过的新功能。
- **冲突裁决（重要）**：当对话中用户最新、更具体的表述与某功能项 description（冻结的旧措辞）不一致时，以用户最新表述为准撰写该功能项验收要点，并在 document 功能清单节的对应验收要点末尾加“（依据用户原话修订）”，不得为迁就 description 旧措辞而写出与用户意图相反的验收。positioning、acceptance、document 三处对同一件事的语义必须一致，不得出现“定位说前一天、验收写当日”的分裂。用户最新表述中的实现机制词（如存储方式）按【持久化措辞纪律】转写为行为表述，不原样固化进 description/验收。
- 语义重复或指向同一行为的功能项，验收要点不得互相矛盾，同一行为只描述一次。

四、out_of_scope（范围外）
- 用户明确拒绝、排除或表示"本轮不做"的；以及"你帮我决定"时按常见做法主动收敛掉的部分（如多用户/云同步）。
- 防止下游模型擅自扩功能，宁缺毋滥：无明确依据时给空数组，不要编。

五、assumptions（后台假设）
- 后台必须替用户做的技术/产品决策：数据单位、存储口径（如：数据保留在本机、不做云同步）、界面语言、排序/汇总规则、默认值等。
- 每条一句话说清"假设了什么"，供后续 decisions 回溯。

六、gdd（游戏设计文档，仅 form=game 输出；非游戏省略此字段）
- core_fantasy：核心幻想——玩家扮演什么、体验什么（一句话）。
- pillars：设计支柱 2~3 条——支撑核心幻想的可玩性原则。
- core_loop：核心循环——主玩法循环的阶段序列（如 探索→战斗→收集→升级）。
- numbers：数值基准——关键数值/范围（生命值/得分/关卡数/道具池范围等）。
- 从对话提炼；对话没说细的机制按同类游戏常见合理预期补齐并克制标注「（建议）」；document 的功能清单/行为断言从 gdd 核心循环切片，不发明 gdd 之外的机制。

七、数据留存（桌面品类口径，2026-10-05 web 线退役后改定）
- 当前版本只交付 Windows 桌面软件：数据留存一律本地实现（编程 Agent 自选本地文件等机制），**不设计后端/API**——不要输出 interface_spec 字段（旧版字段，当前版本不消费）。
- 需求出现跨端/服务端语义（多端同步、云端、共享给他人、账号、多人协作）时：如实写入 out_of_scope 并在 assumptions 注明「当前版本不支持，需后续版本」——不要编造 API 契约迁就需求。
- 市调灵感（「参考市面做法」类）只在本地产物能力内采纳（如纸带式记录 → 本地留存展示）。

示例（家庭记账本，功能项 F-001 记录收入与支出 / F-002 展示本月结余；document 节选关键章节）：
{"document":"# PRD：家庭记账本\\n## 一、产品定位 —— 面向个人与家庭的记账工具：日常收支发生时快速记录，月底直观看到结余。\\n## 二、功能清单 —— 作为家庭成员，我想记录每笔收入与支出，以便月底清楚钱花在了哪里。\\n### [F-001]（P0）记录收入与支出\\n验收要点：正常：新增一笔收入或支出后列表立即可见并持久保存；边界：金额为空或非数字时提示错误且不保存\\n### [F-002]（P0）展示本月结余\\n验收要点：正常：按自然月汇总并显示结余；边界：本月无任何记录时结余显示 0\\n## 三、页面清单 —— 首页为记账列表+快速记一笔入口，顶部显示本月结余。\\n## 六、范围外 —— 多用户协作；银行账户自动对接\\n## 八、后台假设 —— 金额单位统一为人民币元；数据仅保存在本地，不提供云同步",
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
  const base = loadPromptOverride('prd-system') ?? DEFAULT_SYSTEM_PROMPT
  // Phase 2 M1：开关 off → base 原样返回（字节级现状）；on → 追加 CAP 产出指令
  // （附在末尾不侵入既有结构，与外置覆盖叠加友好）。
  // Phase 7 U1 H2：同模式追加 key_tasks 产出指令（两开关独立，互不干扰字节级现状）。
  let prompt = base
  if (capContractEnabled()) prompt = `${prompt}\n\n${CAP_PROMPT_ADDENDUM}`
  if (keyTasksEnabled()) prompt = `${prompt}\n\n${KEY_TASKS_PROMPT_ADDENDUM}`
  return prompt
}

/**
 * 能力契约块产出指令（Phase 2 M1，仅在 BLOMA_CAP_CONTRACT=on 时追加到 system prompt 末尾）。
 * 三处消费（loop 锚定/裁判/确认卡）读背板 ai_capabilities，与本指令同 schema。
 */
export const CAP_PROMPT_ADDENDUM = [
  '【能力契约块（ai_capabilities，本段启用时必须输出）】',
  '输出结构新增字段（与上述字段同层级；纯展示/纯 CRUD 项目省略或给空数组）：',
  '"ai_capabilities":[{"capability_id":"CAP-01","task":"该能力承担的任务","keyProcessing":"关键处理依赖什么","ioDependency":"输入=…；输出=…；输入变化→输出如何相应变化","forbiddenSubstitutions":["固定模板冒充"],"evidence":["修改关键输入后输出变化"],"source":"user_explicit"}',
  '- 凡功能项涉及 AI/智能/语音/自动生成/总结整理等能力（输入→智能处理→输出），必须为每条此类能力输出一条 CAP，上限 4 条。',
  '- task 不得用「智能处理」「一键生成」类标签词代替；keyProcessing 说清该能力靠什么成立（模型调用/规则/检索）。',
  '- forbiddenSubstitutions 从对话与需求提炼写具体（如「固定模板冒充总结」「关键词匹配冒充分析」「降级为普通增删改查」）；evidence 为行为级可观察证据。',
  '- source：user_explicit=用户原话明确要求；confirmed_derived=从已确认需求派生；pending_assumption=未经确认的假设。',
  '- document 的功能清单与验收不得与 CAP 矛盾；CAP 的「不算完成」优先于任何局部测试通过。',
].join('\n')

/**
 * 关键任务块产出指令（Phase 7 U1 H2，仅在 BLOMA_KEY_TASKS=on 时追加到 system prompt 末尾）。
 * 消费方：PRD 确认卡展示 + delivery_status 计算（P7-2）读背板 key_tasks，与本指令同 schema。
 */
export const KEY_TASKS_PROMPT_ADDENDUM = [
  '【关键任务块（key_tasks，本段启用时必须输出）】',
  '输出结构新增字段（与上述字段同层级）：',
  '"key_tasks":[{"task_id":"KT-01","label":"用户语言的一句话任务（如：记一笔账，月底能看到这个月花了多少）","feature_ids":["F-001","F-002"],"must_deliver":true}]',
  '- 从已确认功能项提炼 2~4 个「做完才算这一版交付」的关键任务，用用户任务视角的语言写：动词开头、说清用户能完成什么，不用技术术语。',
  '- 每个 P0 功能项必须落入至少一个任务（硬约束；系统会自动补齐遗漏，但请尽量自己写好）。',
  '- label 不复制功能项描述原文，而是任务视角的合并表述（例：F-001 记账 + F-002 结余 →「记一笔账，月底能看到这个月花了多少」）。',
  '- must_deliver=true 表示必须做到（做不到这一版不能算完成）；确属锦上添花、可整体失败的才标 false；不确定时一律 true。',
  '- document 的功能清单与 key_tasks 不得矛盾；任务里承诺的功能项必须在功能清单内。',
].join('\n')

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
    const fewShot = buildPrdFewShotInjection(input.template_type ?? 'personal_tool')
    const prompt = [buildPrompt(items, conversation, input.template_type), fewShot].filter(Boolean).join('\n\n')
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
      onAttemptFailure: input.onAttemptFailure,
      parse: parsePrdJson,
    })
    if (!parsed) return null
    // 判型 LLM 化（2026-10-06 拍板）：引擎自判 form 回写项目品类——game（GDD 链）/
    // web_fullstack（PRD 确认后形态卡引导转桌面）。desktop 缺省不写（建项目即 desktop_tool）。
    // 回写失败不阻断 PRD 产出（品类仅下游路由参考，桌面线是唯一生成线）。
    const formType: TemplateType | undefined =
      parsed.form === 'game' ? 'game' : parsed.form === 'web' ? 'web_fullstack' : undefined
    if (formType && formType !== input.template_type) {
      try {
        updateProject(input.project_id, { template_type: formType })
      } catch {
        // 项目已删除等场景：品类回写失败不阻断背板产出
      }
      recordDecision({
        project_id: input.project_id,
        session_id: input.session_id,
        entry: {
          type: 'modification_decision',
          title: `PRD 引擎自判交付形态：${parsed.form}`,
          why: `判型 LLM 化（正则词表已退役）：引擎带完整对话上下文自判 form=${parsed.form}，回写品类 ${formType}`,
          detail: { form: parsed.form, from: input.template_type ?? null, to: formType },
        },
      })
    }
    return buildBackplaneFromParsed(parsed, items, input.project_id, formType ?? input.template_type)
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

export function buildBackplaneFromParsed(parsed: ParsedPrd, items: SketchRequirement[], projectId: string, templateType?: import('../../shared/types').TemplateType): PrdBackplane {  const acceptance: Record<string, string> = {}
  for (const item of items) {
    acceptance[item.id] = parsed.acceptance[item.id]?.trim() || `${item.description}：核心路径可交互，边界与异常输入不崩溃。`
  }
  const positioning = parsed.positioning.trim() || items[0].description
  // 长文本 PRD dual-form：document 缺失/空白时由结构化字段机械拼装兜底（确定性，不编内容），
  // 保证背板 prd_document 恒存在（确认卡/loop 锚定的消费假设）。
  // P1-4/P1-5（2026-09-04）：LLM 输出的 document 先还原双重转义换行（\\n→真换行），再按结构化
  // 字段校正 priority 标注（document 自标 P0/P1 与 requirements 冻结 priority 不一致时以结构化覆盖）。
  const rawDocument = parsed.document.trim()
  const prdDocument = rawDocument
    ? reconcilePrdDocumentPriorities(normalizePrdDocumentNewlines(rawDocument), items)
    : buildPrdDocumentFallback({
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
    // P1-7：game 类型 GDD（玩法真相源）随背板冻结；非 game 缺省 undefined。
    ...(parsed.gdd ? { gdd: parsed.gdd } : {}),
    // 后端契约派生腿已退役（2026-10-06 web 残留清理）：prompt 已明说不输出 interface_spec，
    // 此处仅兼容透传 LLM 异常输出（正常恒缺省），不再有确定性派生。
    ...(parsed.interface_spec && parsed.interface_spec.length > 0 ? { interface_spec: parsed.interface_spec } : {}),
    // Phase 2 M1：能力契约块随背板冻结——LLM 产出优先；漏报且命中 AI 信号 →
    // deriveAiCapabilities 确定性派生；开关 off 整段不挂（字节级现状）。
    ...(capContractEnabled()
      ? {
          ai_capabilities:
            parsed.ai_capabilities && parsed.ai_capabilities.length > 0
              ? parsed.ai_capabilities
              : (deriveAiCapabilities(items) ?? []),
        }
      : {}),
    // Phase 7 U1 H2：关键任务块随背板冻结——LLM 产出优先，finalizeKeyTasks 做
    // 白名单过滤+P0 补齐+重编号；开关 off 整段不挂（字节级现状）。
    ...(keyTasksEnabled() ? { key_tasks: finalizeKeyTasks(parsed.key_tasks ?? [], items) } : {}),
  }
}

interface ParsedPrd {
  document: string
  positioning: string
  /** 判型 LLM 化（2026-10-06）：引擎自判交付形态；desktop 缺省（解析容错：非法值→undefined）。 */
  form?: 'desktop' | 'game' | 'web'
  acceptance: Record<string, string>
  out_of_scope: string[]
  assumptions: string[]
  gdd?: GameDesignDoc
  interface_spec?: InterfaceEndpoint[]
  /** Phase 2 M1：能力契约块（开关 on 时 prompt 要求产出；解析容错同 interface_spec）。 */
  ai_capabilities?: AiCapability[]
  /** Phase 7 U1 H2：关键任务块（开关 on 时 prompt 要求产出；形状级清洗，定稿在 finalizeKeyTasks）。 */
  key_tasks?: KeyTask[]
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

  // P1-7：gdd 解析（game 类型；四要素齐备才采纳，缺任一视为无 GDD 降级）。
  const gdd = parseGdd(parsed.gdd)
  // 判型 LLM 化：form 白名单解析（非法/缺省 → undefined = 维持 desktop_tool 缺省）。
  const rawForm = typeof parsed.form === 'string' ? parsed.form : ''
  const form: ParsedPrd['form'] = rawForm === 'desktop' || rawForm === 'game' || rawForm === 'web' ? rawForm : undefined
  // 完整程序阶段 2：interface_spec 解析（前后端契约真相源；缺省/非法 → 空数组零注入）。
  const interfaceSpec = parseInterfaceSpec(parsed.interface_spec)
  // Phase 2 M1：ai_capabilities 解析（能力契约块；缺省/非法 → 空数组走派生兜底）。
  const aiCapabilities = parseAiCapabilities(parsed.ai_capabilities)
  // Phase 7 U1 H2：key_tasks 解析（关键任务块；缺省/非法 → 空数组走 P0 补齐兜底）。
  const keyTasks = parseKeyTasks(parsed.key_tasks)

  return {
    positioning: typeof parsed.positioning === 'string' ? parsed.positioning : '',
    document: typeof parsed.document === 'string' ? parsed.document : '',
    ...(form ? { form } : {}),
    acceptance,
    out_of_scope: stringArray(parsed.out_of_scope),
    assumptions: stringArray(parsed.assumptions),
    ...(gdd ? { gdd } : {}),
    ...(interfaceSpec.length > 0 ? { interface_spec: interfaceSpec } : {}),
    ...(aiCapabilities.length > 0 ? { ai_capabilities: aiCapabilities } : {}),
    ...(keyTasks.length > 0 ? { key_tasks: keyTasks } : {}),
  }
}

/**
 * 解析 ai_capabilities（Phase 2 M1）：capability_id 归一为 CAP-0N（接受 CAP-1/cap_01/1
 * 等变体）；task 必填（缺则弃条）；数组字段过滤空串并限量；source 白名单外归
 * pending_assumption（保守：来源不明不当作已确认）；上限 4 条。
 * export：供单测直测（契约清洗承重，同 parseInterfaceSpec 口径）。
 */
export function parseAiCapabilities(raw: unknown): AiCapability[] {
  if (!Array.isArray(raw)) return []
  const out: AiCapability[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const task = typeof entry.task === 'string' ? entry.task.trim() : ''
    if (!task) continue
    const idRaw = typeof entry.capability_id === 'string' ? entry.capability_id : ''
    const idMatch = idRaw.match(/(\d+)/)
    const capabilityId = `CAP-${String(idMatch ? Number(idMatch[1]) : out.length + 1).padStart(2, '0')}`
    const list = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim().slice(0, 160)).slice(0, 4)
        : []
    const sourceRaw = typeof entry.source === 'string' ? entry.source : ''
    const source: AiCapability['source'] =
      sourceRaw === 'user_explicit' || sourceRaw === 'confirmed_derived' || sourceRaw === 'pending_assumption'
        ? sourceRaw
        : 'pending_assumption'
    out.push({
      capability_id: capabilityId,
      task: task.slice(0, 200),
      keyProcessing: typeof entry.keyProcessing === 'string' ? entry.keyProcessing.trim().slice(0, 300) : '',
      ioDependency: typeof entry.ioDependency === 'string' ? entry.ioDependency.trim().slice(0, 300) : '',
      forbiddenSubstitutions: list(entry.forbiddenSubstitutions),
      evidence: list(entry.evidence),
      source,
    })
    if (out.length >= 4) break
  }
  return out
}

/**
 * 解析 key_tasks（Phase 7 U1 H2）：形状级清洗——label 必填（缺则弃条）；
 * feature_ids 过滤非字符串并去重（白名单校验与 P0 补齐在 finalizeKeyTasks，
 * 因 parse 阶段无 requirements 上下文）；must_deliver 非 false 一律归 true
 * （保守：关键任务缺省必交，与「从严 v0」一致）；上限 4 条。
 * export：供单测直测（契约清洗承重，同 parseAiCapabilities 口径）。
 */
export function parseKeyTasks(raw: unknown): KeyTask[] {
  if (!Array.isArray(raw)) return []
  const out: KeyTask[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const label = typeof entry.label === 'string' ? entry.label.trim() : ''
    if (!label) continue
    const featureIds = Array.isArray(entry.feature_ids)
      ? [...new Set(entry.feature_ids.filter((v): v is string => typeof v === 'string' && v.trim().length > 0))].slice(0, 6)
      : []
    if (featureIds.length === 0) continue
    out.push({
      task_id: typeof entry.task_id === 'string' ? entry.task_id : '',
      label: label.slice(0, 80),
      feature_ids: featureIds,
      must_deliver: entry.must_deliver !== false,
    })
    if (out.length >= 4) break
  }
  return out
}

/** 解析 interface_spec（完整程序阶段 2）：端点必须落在 /api/ 前缀下（平台自动挂载
 * server/routes），缺前缀自动补；方法白名单（缺省 GET）；上限 6 条，宁缺毋滥。
 * export：供单测直测（契约清洗规则承重，防下游挂载/探针被脏端点打穿）。 */
export function parseInterfaceSpec(raw: unknown): InterfaceEndpoint[] {
  if (!Array.isArray(raw)) return []
  const out: InterfaceEndpoint[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const endpointRaw = typeof record.endpoint === 'string' ? record.endpoint.trim() : ''
    if (!endpointRaw) continue
    // 缺 /api/ 前缀自动补：'api/records'（无斜杠但带 api 段）与 '/records' 同视为缺前缀
    const endpoint = endpointRaw.startsWith('/api/')
      ? endpointRaw
      : '/api/' + endpointRaw.replace(/^\/+/, '').replace(/^api\/+/, '')
    const methodRaw = typeof record.method === 'string' ? record.method.trim().toUpperCase() : 'GET'
    const method = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(methodRaw) ? methodRaw : 'GET'
    out.push({
      endpoint,
      method,
      ...(typeof record.request === 'string' && record.request.trim() ? { request: record.request.trim().slice(0, 200) } : {}),
      ...(typeof record.response === 'string' && record.response.trim() ? { response: record.response.trim().slice(0, 200) } : {}),
    })
    if (out.length >= 6) break
  }
  return out
}

/** 解析 gdd 四要素（核心幻想/支柱/核心循环/数值基准）；缺核心幻想或支柱或核心循环任一即 undefined。 */
function parseGdd(value: unknown): GameDesignDoc | undefined {
  if (!isRecord(value)) return undefined
  const coreFantasy = typeof value.core_fantasy === 'string' ? value.core_fantasy.trim() : ''
  const pillars = Array.isArray(value.pillars)
    ? value.pillars.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : []
  const coreLoop = Array.isArray(value.core_loop)
    ? value.core_loop.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : []
  const numbers = Array.isArray(value.numbers)
    ? value.numbers.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : []
  if (!coreFantasy || pillars.length === 0 || coreLoop.length === 0) return undefined
  return { core_fantasy: coreFantasy, pillars, core_loop: coreLoop, numbers }
}

function buildPrompt(items: SketchRequirement[], conversation: string, templateType?: import('../../shared/types').TemplateType): string {
  const list = items.map((r) => `- ${r.id}: ${r.description}`).join('\n')
  // 判型 LLM 化（2026-10-06 拍板，替代 template-inference 正则）：GDD 要求不再依赖
  // 预判型——引擎带着完整对话上下文自判 form；form=game 时输出 gdd。历史品类仅作
  // 存量项目兼容提示（game 存量补拍时仍可用），新单一律自判。
  const gddInstruction =
    templateType === 'game'
      ? [
          '',
          '【游戏设计文档（GDD）要求——本项目是游戏/复刻类，请额外输出 gdd 字段】',
          '- 从对话提炼：核心幻想（玩什么）、设计支柱 2~3 条、核心循环（阶段序列）、数值基准（关键数值/范围）。',
          '- 对话没说细的机制按同类游戏常见合理预期补齐并克制标注「（建议）」；不要凭空发明对话之外的大机制。',
          '- document 的功能清单/行为断言从 gdd 核心循环切片，不发明 gdd 之外的机制。',
        ].join('\n')
      : [
          '',
          '【gdd 自判规则】如果你判断本项目是游戏/复刻类（玩法为核心，如贪吃蛇/扫雷/射击/平台跳跃等），请额外输出 gdd 字段（结构见六）；非游戏一律省略 gdd，同时 form 填 "game"。',
        ].join('\n')
  return [
    `请从下面的对话历史中产出双形态同源 PRD：长文本全文（document）+ 结构化字段。`,
    ``,
    `任务要求：`,
    `- document：完整长文本 PRD（章节骨架见 system prompt，与结构化字段同源一致，空章节写「无/待确定」）。`,
    `- 为每个功能项提炼 2~4 条验收要点（正常路径 + 边界/异常输入各至少 1 条），分号分隔写在同一个字符串里。`,
    `- positioning 覆盖三要素：给谁用、什么场景、解决什么问题（≤120 字）。`,
    `- 对话中信息不足的字段按约定给空数组或简短兜底，不要编造。`,
    gddInstruction,
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
