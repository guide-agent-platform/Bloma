import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, AgentSendMessageInput, MessageContentBlock, Project, ProjectMode, Snapshot, TemplateType } from '../shared/types'
import { getAgentSessionPath, getDocumentsDir } from '../storage/config-paths'
import { appendJsonLine } from '../storage/json-store'
import { buildPrdBackplane, readPrdBackplane, readUxContractSketch, syncDocuments } from './document-engine'
import { createSnapshot, runSandbox, trackAnalytics } from './platform-services'
import { DEFAULT_MAX_TOKENS, generateMvpLlm, type GenerateMvpLlmResult } from './mvp-engine-llm'
import { addScopeExclusion, findProject, readLastSketchRequirements, recordSketchGenerated, updateProject } from './project-service'
import { resolveChannelEnv } from './runtime-fallback'
import { generateSketch, type GenerateSketchResult, type PrdBackplane, type SketchRequirement } from './sketch-engine'
import { generateSketchLlm, SketchLlmError, type SketchAttemptDetail } from './sketch-engine-llm'
import { generatePrdLlm } from './prd-engine-llm'
import { applyNormalization, normalizeRequirementUpdate, recordRequirementNormalization } from './requirement-normalizer'
import { readTestReport, runGwtScenarios, writeTestReport, type GwtTestResult } from './gwt-service'
import { applyRepairPatch, REPAIR_CATEGORY_SUMMARY, runRepairCycle, type RepairCategory } from './repair-engine'
import { runJudge, type JudgeVerdict } from './judge-engine'
import { assertToolAllowed } from './permission-service'
import { recordDecision } from './decision-log'
import { CircuitBreakSettledError, circuitBreakRollback, isCircuitBreakSettled } from './recovery-service'
import { readPrimaryIntent } from './session-service'
import type { SDKQuery } from './orchestrator'

/**
 * 无人值守豁免（A2-12）：自动化管线内部 service 直连时显式传入 allow-all——
 * warning 工具自动放行（不弹 UI）、dangerous 拒绝。禁止隐式绕过，豁免必须显式传入。
 */
const AUTOMATED_PERMISSION_MODE = 'allow-all' as const

/** 项目已生成完成（ready）的统一话术：完成通知与 ready 护栏共用，避免两套语义相近的固定文案。 */
export const READY_COMPLETION_COPY =
  '已经生成好了，可以点右侧预览区的按键试用。有想调整的地方随时告诉我。'

/** 迭代/生成失败时如实告知用户的话术：不假装成功，也不把失败藏成「已经生成好了」。 */
export const GENERATION_FAILED_COPY =
  '这次修改没有成功（模型生成失败了），你可以再试一次，或者换个说法描述你的需求。'

type ProgrammingEventPublisher = (event: AgentEvent) => void

/** 被阻塞的编程操作类型（A2 resume 闭环，落盘到 Project.blocked_action） */
export type BlockedAction = 'mvp_repair' | 'test_repair' | 'judge_return'
/** 阻塞态让渡后用户回传的决策（A3：消费 metadata.selected_option_id 映射而来） */
export type BlockedDecision = 'continue' | 'accept' | 'explain'

/** 阻塞态让渡卡片（A1：统一带 `id`，与引导澄清路径 questions 形态一致） */
const BLOCKED_DECISION_QUESTIONS: { id: BlockedDecision; label: string; description: string }[] = [
  { id: 'continue', label: '继续尝试', description: '让我再修一次' },
  { id: 'accept', label: '接受现状', description: '保留当前 MVP 先看看' },
  { id: 'explain', label: '补充说明', description: '告诉向导哪里不对' },
]

export interface SketchTaskInput {
  request_id: string
  session_id: string
  project_id: string
  mode: ProjectMode
  prompt: string
  requirements?: SketchRequirement[]
  channel_id?: string
  query?: SDKQuery
}

export interface SketchTaskResult {
  preview_url: string
  snapshot: Snapshot
  summary: string
}

export interface MvpTaskInput {
  request_id: string
  session_id: string
  project_id: string
  mode: ProjectMode
  template_type?: TemplateType
  channel_id?: string
  query?: SDKQuery
  /** 停止生成信号（U5：迭代/生成期间点停止，abort 后中止 LLM 生成） */
  signal?: AbortSignal
}

export interface MvpTaskResult {
  preview_url: string
  snapshot: Snapshot
  run_command: string
}

let programmingEventPublisher: ProgrammingEventPublisher = () => undefined

export function setProgrammingEventPublisher(publisher: ProgrammingEventPublisher): void {
  programmingEventPublisher = publisher
}

export async function runSketchTask(input: SketchTaskInput): Promise<SketchTaskResult> {
  publish(input, 'stage_changed', { stage: 'generating_sketch' })
  updateProject(input.project_id, { current_stage: 'generating_sketch' })

  const requirements = input.requirements?.length
    ? input.requirements
    : [{ id: 'F-001', description: input.prompt }]
  const { result: sketch, source, fallbackReason, llmErrorCode, llmAttempts } = await resolveSketch(input, requirements)
  // 草图来源持久化（§4.2 质量门②判定依据）：source('llm'|'template') 原本只存在于生成
  // 时刻的内存与事件流，而 sketch_confirmed 常跨会话发生（重启后经 T1 收敛）、确认时无处
  // 可读——落 project 字段（sketch_source + sketch_generated_at）供质量门读取与刷新判定
  updateProject(input.project_id, { sketch_source: source, sketch_generated_at: new Date().toISOString() })
  if (source === 'template' && fallbackReason) {
    // 模板回退必须留痕：埋点 + 会话内如实说明（阶段如实性——不假装模型参与了生成）。
    // 此前完全静默，渠道瞬断时用户只看到「草图变成通用占位页」却无任何线索。
    trackAnalytics({
      request_id: input.request_id,
      event: {
        event_type: 'sketch_fallback',
        project_id: input.project_id,
        session_id: input.session_id,
        payload: { reason: fallbackReason, llm_error_code: llmErrorCode, llm_attempts: llmAttempts },
        privacy_level: 'research_safe',
      },
    })
    const copy = sketchFallbackCopy(fallbackReason)
    appendJsonLine(getAgentSessionPath(input.session_id), {
      role: 'assistant',
      content: [{ type: 'text', text: copy }],
      timestamp: Date.now(),
    })
    publish(input, 'message_delta', { text: copy })
  }
  recordSketchGenerated(input.project_id, requirements)
  await allowAutomatedTool('run_project', { project_id: input.project_id }, input.session_id, input.project_id)
  const sandbox = await runSandbox({ request_id: input.request_id, project_id: input.project_id })
  if (sandbox.status !== 'running' || !sandbox.preview_url) {
    publish(input, 'error', {
      code: 'SANDBOX_RUN_FAILED',
      message: sandbox.error_summary?.user_visible_summary ?? '预览暂时没有启动成功，我正在修复。',
    })
    const category = sandbox.error_summary?.category ?? 'unknown'
    throw new Error(`SANDBOX_RUN_FAILED:${category}`)
  }

  await allowAutomatedTool('create_snapshot', { project_id: input.project_id, kind: 'sketch' }, input.session_id, input.project_id)
  const snapshot = await createSnapshot({
    request_id: input.request_id,
    project_id: input.project_id,
    kind: 'sketch',
    summary: sketch.summary,
    include_documents: false,
    health_status: 'healthy',
  })

  trackAnalytics({
    request_id: input.request_id,
    event: {
      event_type: 'sketch_generated',
      project_id: input.project_id,
      session_id: input.session_id,
      payload: {
        mode: input.mode,
        snapshot_id: snapshot.snapshot_id,
        file_count: sketch.files.length,
      },
      privacy_level: 'research_safe',
    },
  })

  updateProject(input.project_id, {
    current_stage: 'sketch_ready',
    current_snapshot_id: snapshot.snapshot_id,
  })
  publish(input, 'stage_changed', { stage: 'sketch_ready' })
  publish(input, 'sketch_ready', {
    preview_url: sandbox.preview_url,
    snapshot_id: snapshot.snapshot_id,
    summary: sketch.summary,
  })

  return { preview_url: sandbox.preview_url, snapshot, summary: sketch.summary }
}

/** 草图回退原因：模板路径必带其一，供日志/埋点/如实告知，杜绝静默降级。 */
type SketchFallbackReason = 'no_channel' | 'no_query' | 'decrypt_failed' | 'no_model' | 'llm_failed'

/** resolveSketch 的产物：结果 + 来源。模板路径必带 fallbackReason（LLM 路径不带）。 */
interface ResolvedSketch {
  result: GenerateSketchResult
  source: 'llm' | 'template'
  fallbackReason?: SketchFallbackReason
  /** llm_failed 时的粗粒度错误码（SKETCH_LLM_* / unknown），只进日志与埋点，不进 UI。 */
  llmErrorCode?: string
  /** llm_failed 时的逐次尝试明细（耗时/字符数/是否截断），进埋点供事后定位。 */
  llmAttempts?: SketchAttemptDetail[]
}

/**
 * resolveSketch — 草图生成来源分流。
 *
 * 渠道可用且调用方传入 query 时走 LLM 草图（generateSketchLlm，无交互纯外观、贴合功能项）；
 * 否则（无渠道 / 密钥不可解密 / LLM 生成失败）回退确定性模板 generateSketch。
 * 与 MVP 的「无模板兜底」不同：草图是低成本方向确认，不能因 LLM 故障卡死澄清流程。
 *
 * 回退不再静默（2026-08-15 赛车模拟器案例：渠道瞬断导致 18ms 内静默落模板，
 * 事件流里毫无痕迹，事后只能靠毫秒级时间差反推 LLM 未发起）——来源与原因
 * 一路带回给 runSketchTask 落日志/埋点/用户提示。
 */
async function resolveSketch(input: SketchTaskInput, requirements: SketchRequirement[]): Promise<ResolvedSketch> {
  if (!input.query) {
    console.error('[resolveSketch] 草图回退确定性模板: reason=no_query')
    return { result: generateSketch({ project_id: input.project_id, requirements, max_pages: 3 }), source: 'template', fallbackReason: 'no_query' }
  }
  // 渠道+类别统一收口（runtime-fallback，T9）：主渠道不可用时已按解析链尝试切备用渠道
  // （切换落决策日志），仍无可用才回退模板（草图是低成本方向确认，不能因选不出渠道/模型卡死澄清流程）
  const resolution = resolveChannelEnv({
    channelId: input.channel_id,
    category: 'sketch',
    projectId: input.project_id,
    sessionId: input.session_id,
  })
  if (!resolution.env || !resolution.channel) {
    const reason =
      resolution.unusableReason === 'decrypt_failed'
        ? 'decrypt_failed'
        : resolution.unusableReason === 'model_not_found'
          ? 'no_model'
          : 'no_channel'
    console.error(`[resolveSketch] 草图回退确定性模板: reason=${reason}（channel_id=${input.channel_id ?? 'auto'}，含备用渠道均不可用）`)
    return { result: generateSketch({ project_id: input.project_id, requirements, max_pages: 3 }), source: 'template', fallbackReason: reason }
  }
  const channel = resolution.channel
  const env = resolution.env
  try {
    const result = await generateSketchLlm({
      project_id: input.project_id,
      requirements,
      query: input.query,
      env,
      sessionId: input.session_id,
      maxTokens: channel.max_tokens ?? DEFAULT_MAX_TOKENS,
    })
    return { result, source: 'llm' }
  } catch (error) {
    // LLM 草图失败（超时/非 HTML/网络错误）回退模板，不阻断草图产出
    const llmErrorCode = error instanceof Error ? (error.message.match(/^([A-Z_]+):/)?.[1] ?? 'unknown') : 'unknown'
    const llmAttempts = error instanceof SketchLlmError ? error.attempts : undefined
    console.error(`[resolveSketch] 草图回退确定性模板: reason=llm_failed code=${llmErrorCode}（${error instanceof Error ? error.message : String(error)}）${llmAttempts ? ` attempts=${JSON.stringify(llmAttempts)}` : ''}`)
    return {
      result: generateSketch({ project_id: input.project_id, requirements, max_pages: 3 }),
      source: 'template',
      fallbackReason: 'llm_failed',
      llmErrorCode,
      llmAttempts,
    }
  }
}

/** 模板回退时给用户的如实话术：不假装模型参与了生成，并给可操作的去处。 */
function sketchFallbackCopy(reason: SketchFallbackReason): string {
  if (reason === 'llm_failed') {
    return '（草图说明：这次模型生成失败了，先用简化模板让你确认大方向。可以再让我生成一次，或直接描述想要的样子。）'
  }
  return '（草图说明：这次没有可用的模型渠道，先用简化模板让你确认大方向。在设置里配好渠道后再让我重新生成，外观就会贴合你的需求。）'
}

// ---------------------------------------------------------------------------
// 需求确认后自动命名（runMvpTask 首次生成时执行一次）
// ---------------------------------------------------------------------------

/** 项目名上限：历史项目列表按单行卡片展示，过长会撑坏布局。 */
const PROJECT_NAME_MAX_LENGTH = 12

const NAMING_SYSTEM_PROMPT = `你是产品命名助手。根据用户的原始需求和 PRD 摘要，给这个软件项目起一个简短的中文名。
硬性约束：
- 只输出项目名本身，不要任何解释、引号、标点或前后缀
- 2~12 个汉字，名词短语，体现产品用途（如「家庭记账本」「倒计时番茄钟」「模拟钢琴」）
- 不要带「工具」「应用」「项目」「软件」这类通用后缀，除非去掉后语义不完整`

/**
 * 需求确认后自动命名：项目初始名是首句口述的前 32 字（如「帮我做个东西」），
 * 确认草图时需求已经收敛，此时用 LLM 按 PRD 背板起一个可辨识的名字；
 * LLM 不可用/产出不合格时，按首句口述做确定性前缀剥离兜底。
 * `auto_named` 标记保证只自动命名一次，之后（含未来手动改名）不再覆盖。
 */
export async function autoNameProject(input: MvpTaskInput): Promise<void> {
  const project = findProject(input.project_id)
  if (project.auto_named) return

  const name =
    (await nameByLlm(input)) ??
    deriveFallbackName(readPrimaryIntent(input.session_id) ?? '')
  if (name) {
    updateProject(input.project_id, { name, auto_named: true })
  } else {
    // 兜底也拿不到（首句口述剥完为空）：只落标记，避免每次生成都重试
    updateProject(input.project_id, { auto_named: true })
  }
}

/** LLM 起名：复用 MVP 同一套渠道解析与流式查询；任何失败返回 null 交给兜底。 */
async function nameByLlm(input: MvpTaskInput): Promise<string | null> {
  if (!input.query) return null
  // 命名是附属轻量任务（非文档类别），借 guide 类别解析；渠道解析收口 runtime-fallback
  // （主渠道不可用已尝试切备用）；任何失败返回 null 交确定性兜底（命名绝不阻断生成）
  const resolution = resolveChannelEnv({
    channelId: input.channel_id,
    category: 'guide',
    projectId: input.project_id,
    sessionId: input.session_id,
  })
  if (!resolution.env) return null
  const env = resolution.env

  const backplane = readPrdBackplane(input.project_id)
  const intent = readPrimaryIntent(input.session_id)
  const prompt = [
    '用户原始需求：',
    intent ?? '（无记录）',
    '',
    'PRD 摘要：',
    `定位：${backplane.positioning}`,
    `核心功能：${backplane.requirements.slice(0, 5).map((item) => item.description).join('；')}`,
    '',
    '请给这个项目起名，只输出名称本身。',
  ].join('\n')

  // 不设超时（2026-08-16 取消生成时间限制）：慢渠道下 30s 会把起名掐成静默兜底；
  // 起名失败本就有确定性兜底，等待与全局「无时间上限 + 停止按钮中止」策略一致。
  // controller 仅为满足 SDKQueryOptions 的必填 signal 保留，无 timer 不再主动 abort。
  const controller = new AbortController()
  try {
    let accumulated = ''
    for await (const message of input.query(prompt, {
      env,
      signal: controller.signal,
      sessionId: input.session_id,
      history: [{ role: 'system', content: NAMING_SYSTEM_PROMPT }],
      maxTokens: 64,
    })) {
      if (message.type !== 'assistant' || !message.message) continue
      accumulated += extractQueryText(message.message.content)
    }
    return sanitizeLlmName(accumulated)
  } catch {
    return null
  }
}

function extractQueryText(blocks: MessageContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

/**
 * 清洗模型输出：取首个非空行、剥包裹引号；长度异常或含句内标点
 * （说明性输出如「好的，我建议命名为：」）视为不合格交回兜底。
 */
function sanitizeLlmName(raw: string): string | null {
  const firstLine = raw
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return null
  const stripped = firstLine.replace(/^[「『"'“（]+|[」』"'”）]+$/g, '').trim()
  if (stripped.length < 2 || stripped.length > PROJECT_NAME_MAX_LENGTH + 4) return null
  if (/[：:，,。.！!？?；;、]/.test(stripped)) return null
  return stripped.slice(0, PROJECT_NAME_MAX_LENGTH)
}

/** 口述前缀（同族长前缀在前，避免短前缀抢占匹配），循环剥离最多 3 轮覆盖组合前缀。 */
const VERB_PREFIX_PATTERN =
  /^(?:麻烦(?:你)?帮我|请(?:你)?帮我|帮我|我想做一个|我想做个|我想要一个|我想要个|我想要|我想做|我想|我要一个|我要个|我要|做个|做一个|制作一个|制作个|开发一个|开发个|搭建一个|搭一个|生成一个|生成个|造一个|整一个|来一个|一个)/

/** 确定性兜底：剥掉「帮我制作一个」这类口述前缀与收尾语气词，剩余部分截断做项目名。 */
export function deriveFallbackName(intent: string): string | null {
  let current = intent.trim()
  for (let round = 0; round < 3; round += 1) {
    const next = current.replace(VERB_PREFIX_PATTERN, '').trim()
    if (next === current) break
    current = next
  }
  current = current.replace(/[。！？!?，,、~～\s]+$/g, '')
  if (!current) return null
  return current.slice(0, PROJECT_NAME_MAX_LENGTH)
}

/**
 * runMvpTask — 草图确认后无需再发消息，直接由 LLM 生成 MVP 并进入测试阶段。
 *
 * 顺序（对齐任务规划）：stage generating_mvp → 文档打点 sketch_confirmed /
 * mvp_before_generation → generateMvpLlm → 沙箱启动 → mvp 快照（含文档）→
 * analytics mvp_delivered → stage testing → 发布 mvp_ready。
 */
export async function runMvpTask(input: MvpTaskInput): Promise<MvpTaskResult> {
  publish(input, 'stage_changed', { stage: 'generating_mvp' })
  updateProject(input.project_id, { current_stage: 'generating_mvp' })

  const requirements = readLastSketchRequirements(input.project_id)
  await syncPrdCheckpoints(input, requirements)
  // 需求确认后自动命名（首次生成执行一次）：命名是附属能力，任何失败都不阻断生成
  try {
    await autoNameProject(input)
  } catch {
    // 命名异常（如项目并发更新）静默放过，MVP 生成照常继续
  }
  await allowAutomatedTool('generate_mvp', { project_id: input.project_id }, input.session_id, input.project_id)
  const mvp = await resolveMvp(input, requirements)
  // run_command 白名单式强制覆盖为 'npm start'（真实沙箱启动命令由 ensureSandboxRunning 硬编码为 node static-server）
  const runCommand = 'npm start'
  await allowAutomatedTool('run_project', { project_id: input.project_id, command: runCommand }, input.session_id, input.project_id)
  const sandbox = await ensureSandboxRunning(input)

  await allowAutomatedTool('create_snapshot', { project_id: input.project_id, kind: 'mvp' }, input.session_id, input.project_id)
  const snapshot = await createSnapshot({
    request_id: input.request_id,
    project_id: input.project_id,
    kind: 'mvp',
    summary: `MVP 已生成（LLM 生成，共 ${mvp.files.length} 个文件），进入测试阶段。`,
    include_documents: true,
    health_status: 'healthy',
  })

  trackAnalytics({
    request_id: input.request_id,
    event: {
      event_type: 'mvp_delivered',
      project_id: input.project_id,
      session_id: input.session_id,
      payload: {
        mode: input.mode,
        snapshot_id: snapshot.snapshot_id,
        file_count: mvp.files.length,
        run_command: runCommand,
      },
      privacy_level: 'research_safe',
    },
  })

  updateProject(input.project_id, {
    current_stage: 'testing',
    current_snapshot_id: snapshot.snapshot_id,
  })
  publish(input, 'stage_changed', { stage: 'testing' })
  publish(input, 'mvp_ready', {
    preview_url: sandbox.preview_url,
    snapshot_id: snapshot.snapshot_id,
    run_command: runCommand,
    summary: mvp.assumptions.join('；'),
  })

  return { preview_url: sandbox.preview_url, snapshot, run_command: runCommand }
}

/**
 * A2-14b：MVP 一律由 LLM 生成（无模板兜底）。
 * 无 query 句柄 / 无可用渠道 / 密钥不可解密，或 LLM 生成失败（超时/解析失败/路径非法）
 * 均抛错向上传播——不再静默降级为模板（模板重建仅保留在 repair-engine 的自动修复路径）。
 */
async function resolveMvp(input: MvpTaskInput, requirements: SketchRequirement[]): Promise<GenerateMvpLlmResult> {
  if (!input.query) {
    throw new Error('MVP_GENERATION_FAILED: 缺少模型调用句柄，无法生成 MVP')
  }
  // 渠道+类别统一收口（runtime-fallback，T9）：主渠道密钥不可解密/无启用模型时已按
  // 解析链切备用渠道；mvp 类别解析模型，仍无可用属配置错误，明确抛错（MVP 无模板兜底）
  const resolution = resolveChannelEnv({
    channelId: input.channel_id,
    category: 'mvp',
    projectId: input.project_id,
    sessionId: input.session_id,
  })
  if (!resolution.env || !resolution.channel) {
    throw new Error(
      resolution.unusableReason === 'decrypt_failed'
        ? 'API_KEY_DECRYPT_FAILED: 渠道 api_key 无法解密，请在设置中重新保存该渠道'
        : resolution.unusableReason === 'model_not_found'
          ? 'CHANNEL_MODEL_NOT_FOUND: 渠道没有启用的模型，请在设置中启用至少一个模型后再生成'
          : 'MVP_GENERATION_FAILED: 没有可用的模型渠道，请在设置中配置并验证渠道后再生成',
    )
  }
  const channel = resolution.channel
  const env = resolution.env
  // 生成侧读 PRD 背板（定位/功能项/行为断言/范围外/护栏），而非裸需求清单——主题锚点从 prompt 层压住"货不对板"。
  // 读 prd.json（syncPrdCheckpoints 已落盘，可能是 LLM 从对话提取、也可能模板兜底），
  // 保证生成用的是与文档面板/裁判同一份事实源，而非临时重建。
  const backplane = readPrdBackplane(input.project_id)
  // 双契约输入（§4.2）：背板带 ux_contract 时注入草图全文（不降采样），MVP 同时消费
  // PRD 行为契约 + 草图 UX 契约；无契约（模板草图/旧项目）退回 PRD-only
  const sketchHtml = readUxContractSketch(input.project_id, backplane)
  return generateMvpLlm({
    project_id: input.project_id,
    backplane,
    query: input.query,
    env,
    sessionId: input.session_id,
    maxTokens: channel.max_tokens ?? DEFAULT_MAX_TOKENS,
    signal: input.signal,
    sketchHtml,
  })
}

/**
 * 在 sketch_confirmed / mvp_before_generation 两个检查点写 PRD 文档（PRD §7.1「从对话提取」）。
 *
 * 优先用 LLM 从对话历史提取 PRD 背板（定位/验收/范围外/假设），失败/无渠道回退
 * `buildPrdBackplane` 确定性模板。功能项始终使用已冻结清单（F-001 主题锚点不变式）。
 */
async function syncPrdCheckpoints(input: MvpTaskInput, requirements: SketchRequirement[]): Promise<void> {
  const backplane = registerUxContract(input, await resolvePrdBackplane(input, requirements))
  syncDocuments(
    { request_id: input.request_id, project_id: input.project_id, session_id: input.session_id, checkpoint: 'sketch_confirmed' },
    backplane,
  )
  syncDocuments(
    { request_id: input.request_id, project_id: input.project_id, session_id: input.session_id, checkpoint: 'mvp_before_generation' },
    { ...backplane, frozen_at: new Date().toISOString() },
  )
}

/**
 * UX 契约登记（§4.2 草图升格为 UX 契约）：仅在 sketch_confirmed 检查点执行。
 *
 * 质量门 = ①用户确认（runMvpTask 只在 confirmSketch accepted 后进入，检查点本身即确认）
 * + ②非模板回退（project.sketch_source === 'llm'）。通过 → 把当前草图（磁盘 index.html，
 * 此刻 MVP 尚未生成、仍是草图本体）复制进 documents 冻结为 sketch.html 契约；未通过 →
 * ux_contract 为空，MVP 退回 PRD-only（模板草图不承载用户确认的视觉意图）。
 *
 * 刷新判定：草图重新生成（sketch_generated_at 更新）且 LLM 产物 → 重新登记覆盖旧契约；
 * 草图未再生成（迭代重跑 runMvpTask）→ 沿用既有契约（此时磁盘 index.html 已是 MVP，
 * 不能当草图复制）；新一轮草图是模板回退 → 契约作废（质量门未过）。
 */
export function registerUxContract(input: MvpTaskInput, backplane: PrdBackplane): PrdBackplane {
  const project = findProject(input.project_id)
  // 输出契约由本函数显式决定：先剥离入参携带的旧契约（入参可能是读盘背板），
  // 再按质量门判定登记/沿用/作废，消除对「入参必须是新鲜背板」的隐含假设
  const { ux_contract: _staleFromInput, ...fresh } = backplane
  const previous = readPrdBackplane(input.project_id).ux_contract
  const generatedAt = project.sketch_generated_at

  if (previous && generatedAt && new Date(previous.confirmed_at) >= new Date(generatedAt)) {
    return { ...fresh, ux_contract: previous }
  }
  if (project.sketch_source === 'llm') {
    const documentsDir = getDocumentsDir(project.workspace_slug, project.project_id)
    const sketchAbsolute = join(project.root_path, 'index.html')
    if (existsSync(sketchAbsolute)) {
      mkdirSync(documentsDir, { recursive: true })
      copyFileSync(sketchAbsolute, join(documentsDir, UX_CONTRACT_SKETCH_FILE))
      return {
        ...fresh,
        ux_contract: { sketch_rel_path: UX_CONTRACT_SKETCH_FILE, confirmed_at: new Date().toISOString() },
      }
    }
  }
  return fresh
}

/** UX 契约草图在 documents 目录下的固定文件名。 */
const UX_CONTRACT_SKETCH_FILE = 'sketch.html'

/** PRD 背板来源分流：渠道可用走 LLM 从对话提取，否则回退确定性模板。 */
async function resolvePrdBackplane(input: MvpTaskInput, requirements: SketchRequirement[]): Promise<PrdBackplane> {
  const template = (): PrdBackplane =>
    buildPrdBackplane(findProject(input.project_id), requirements, 'sketch_confirmed')

  if (!input.query) return template()
  // 渠道+类别统一收口（runtime-fallback，T9）；prd 类别解析模型，主渠道不可用已尝试
  // 切备用渠道，仍无可用回退确定性模板（PRD 提取失败不阻断生成）
  const resolution = resolveChannelEnv({
    channelId: input.channel_id,
    category: 'prd',
    projectId: input.project_id,
    sessionId: input.session_id,
  })
  if (!resolution.env || !resolution.channel) return template()
  const channel = resolution.channel
  const env = resolution.env

  const llm = await generatePrdLlm({
    project_id: input.project_id,
    session_id: input.session_id,
    requirements,
    query: input.query,
    env,
    maxTokens: channel.max_tokens ?? 2048,
    signal: input.signal,
  })
  if (!llm) return template()
  return { ...llm, name: findProject(input.project_id).name }
}

/**
 * ensureSandboxRunning — 启动 MVP 沙箱；启动失败时按错误类别进入自动修复循环
 * （dependency/syntax/runtime 可修复；timeout/端口等环境问题直接抛出，交由上层报错）。
 */
async function ensureSandboxRunning(input: MvpTaskInput): Promise<{ preview_url: string }> {
  let sandbox = await runSandbox({
    request_id: input.request_id,
    project_id: input.project_id,
    command: 'node static-server',
  })
  if (sandbox.status === 'running' && sandbox.preview_url) return { preview_url: sandbox.preview_url }

  let category = sandbox.error_summary?.category
  const repairable = (value: string | undefined): value is RepairCategory =>
    value === 'dependency_error' || value === 'syntax_error' || value === 'runtime_error'
  if (!repairable(category)) {
    throwSandboxFailure(input, sandbox.error_summary)
  }

  // 可修复 → 进入 runtime 修复循环（最多 3 次，内部熔断）
  while (true) {
    const cycle = await runRepairCycle({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      category: category as RepairCategory,
      publish: (type, payload) => publish(input, type, payload),
      query: input.query,
      channel_id: input.channel_id,
      signal: input.signal,
      error: { category, summary: sandbox.error_summary?.user_visible_summary ?? '' },
      verify: async () => {
        sandbox = await runSandbox({
          request_id: input.request_id,
          project_id: input.project_id,
          command: 'node static-server',
        })
        return { ok: sandbox.status === 'running', preview_url: sandbox.preview_url }
      },
    })
    if (cycle.blocked) {
      // 熔断回滚（T5）：修复耗尽不再只让渡——先回滚健康快照并按磁盘证据收敛，
      // 回滚不成才交 blocked_for_user_decision 让渡。回滚成功抛哨兵错误，
      // 上层（runAgent / ipc）识别后不再当普通失败处理。
      const outcome = await circuitBreakRollback({
        request_id: input.request_id,
        session_id: input.session_id,
        project_id: input.project_id,
        reason: `runtime 修复循环耗尽（mvp_repair，上限后仍无法启动沙箱）`,
        publish: (type, payload) => publish(input, type, payload),
      })
      if (outcome.rolled_back) throw new CircuitBreakSettledError()
      publishBlockedDecision(input, 'mvp_repair')
      throw new Error('SANDBOX_RUN_FAILED:blocked')
    }
    if (cycle.repaired && sandbox.status === 'running' && sandbox.preview_url) {
      return { preview_url: sandbox.preview_url }
    }
    const nextCategory = sandbox.error_summary?.category
    if (!repairable(nextCategory)) throwSandboxFailure(input, sandbox.error_summary)
    category = nextCategory
  }
}

function throwSandboxFailure(input: MvpTaskInput, errorSummary: { category: string; user_visible_summary: string } | undefined): never {
  publish(input, 'error', {
    code: 'SANDBOX_RUN_FAILED',
    message: errorSummary?.user_visible_summary ?? '预览暂时没有启动成功，我正在修复。',
  })
  throw new Error(`SANDBOX_RUN_FAILED:${errorSummary?.category ?? 'unknown'}`)
}

export interface GwtTestingInput {
  request_id: string
  session_id: string
  project_id: string
  mode: ProjectMode
  preview_url: string
  /** LLM 测试修复句柄（分析失败原因并重新生成）；缺省时回退模板重建。 */
  query?: SDKQuery
  channel_id?: string
  signal?: AbortSignal
}

export interface GwtTestingResult {
  verdict: 'ready' | 'blocked'
  test_result: GwtTestResult
  judge?: JudgeVerdict
}

/** 裁判退回计数上限（A2-11）：快消 2 次 / 长期 3 次（component-design §7）。 */
export const JUDGE_RETURN_QUICK_LIMIT = 2
export const JUDGE_RETURN_LONGTERM_LIMIT = 3

export interface JudgeReviewInput {
  request_id: string
  session_id: string
  project_id: string
}

export interface JudgeReviewResult {
  outcome: 'ready' | 'blocked'
  verdict: JudgeVerdict
}

/**
 * runJudgeReview — 裁判触发与退回计数（A2-11）。
 *
 * judge_review 阶段调用 JudgeEngine：`pass/suggest` → ready；
 * `return` → `judge_return_count +1`，未达上限则执行 constraint_error 修复
 * （重新生成 PRD/GWT 骨架，不改代码）后重新判定；达上限（quick=2/longterm=3）
 * → blocked_for_user_decision 让渡。
 */
export async function runJudgeReview(input: JudgeReviewInput): Promise<JudgeReviewResult> {
  let verdict = judgeOnce(input)
  while (verdict.verdict === 'return') {
    const project = findProject(input.project_id)
    const limit = project.mode === 'quick' ? JUDGE_RETURN_QUICK_LIMIT : JUDGE_RETURN_LONGTERM_LIMIT
    const returns = (project.judge_return_count ?? 0) + 1
    updateProject(input.project_id, { judge_return_count: returns })
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'judge_return',
        title: `裁判退回（第 ${returns} 次，上限 ${limit}）`,
        why: verdict.user_visible_summary,
        detail: {
          returns,
          limit,
          hard_failures: verdict.hard_constraints.filter((item) => !item.passed).map((item) => item.name),
        },
      },
    })

    if (returns > limit) {
      // U7：把 Judge 的具体退回原因（user_visible_summary，如「缺了按月统计功能」）带给让渡卡片
      publishBlockedDecision(input, 'judge_return', verdict.user_visible_summary)
      return { outcome: 'blocked', verdict }
    }

    // constraint_error 修复：重新生成 PRD/GWT 骨架，然后重新判定
    applyRepairPatch({ request_id: input.request_id, session_id: input.session_id, project_id: input.project_id }, 'constraint_error')
    updateProject(input.project_id, { current_stage: 'repairing' })
    publish(input, 'stage_changed', { stage: 'repairing' })
    publish(input, 'repairing', { attempt: returns, category: 'constraint_error', user_visible_summary: REPAIR_CATEGORY_SUMMARY.constraint_error })
    trackAnalytics({
      request_id: input.request_id,
      event: {
        event_type: 'self_repair_triggered',
        project_id: input.project_id,
        session_id: input.session_id,
        payload: { attempt: returns, category: 'constraint_error' },
        privacy_level: 'research_safe',
      },
    })
    verdict = judgeOnce(input)
  }

  updateProject(input.project_id, { current_stage: 'ready' })
  publish(input, 'stage_changed', { stage: 'ready' })
  // 软建议（suggest）不再静默忽略：把可读提示附在完成通知后反馈给用户（P1）
  const completion =
    verdict.verdict === 'suggest'
      ? `${READY_COMPLETION_COPY}\n\n补充提示：${verdict.user_visible_summary}`
      : READY_COMPLETION_COPY
  publishCompletionMessage(input, completion)
  return { outcome: 'ready', verdict }
}

function judgeOnce(input: JudgeReviewInput): JudgeVerdict {
  const project = findProject(input.project_id)
  const testResult = readTestReport(input.project_id)
  const verdict = runJudge({ project_id: input.project_id, mode: project.mode, test_result: testResult ?? undefined })
  publish(input, 'judge_result', {
    verdict: verdict.verdict,
    user_visible_summary: verdict.user_visible_summary,
    hard_constraints: verdict.hard_constraints,
    soft_constraints: verdict.soft_constraints,
  })
  trackAnalytics({
    request_id: input.request_id,
    event: {
      event_type: 'judge_verdict',
      project_id: input.project_id,
      session_id: input.session_id,
      payload: {
        verdict: verdict.verdict,
        hard_failures: verdict.hard_constraints.filter((item) => !item.passed).length,
        soft_failures: verdict.soft_constraints.filter((item) => !item.passed).length,
      },
      privacy_level: 'research_safe',
    },
  })
  return verdict
}

/**
 * runPostMvpTestingFlow — MVP 就绪后的测试与状态机后半段（A2-09）。
 *
 * testing →（GWT 执行 + 测试报告）→ 通过则进入 judge_review（A2-11 接入裁判判定）；
 * 失败则进入 repairing ↔ testing 自动修复循环（A2-08），达上限 blocked_for_user_decision 让渡。
 */
export async function runPostMvpTestingFlow(input: GwtTestingInput): Promise<GwtTestingResult> {
  updateProject(input.project_id, { current_stage: 'testing' })
  publish(input, 'stage_changed', { stage: 'testing' })

  let testResult = await runGwtScenarios({ project_id: input.project_id, session_id: input.session_id, preview_url: input.preview_url })
  writeTestReport({ request_id: input.request_id, session_id: input.session_id, project_id: input.project_id, result: testResult })
  syncDocuments({ request_id: input.request_id, project_id: input.project_id, session_id: input.session_id, checkpoint: 'mvp_tested' })

  while (testResult.failed_count > 0) {
    const cycle = await runRepairCycle({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      category: 'test_error',
      publish: (type, payload) => publish(input, type, payload),
      query: input.query,
      channel_id: input.channel_id,
      signal: input.signal,
      error: {
        category: 'test_error',
        summary: testResult.failure_summary.map((f) => `${f.scenario}：${f.reason}`).join('；'),
      },
      verify: async () => {
        testResult = await runGwtScenarios({ project_id: input.project_id, session_id: input.session_id, preview_url: input.preview_url })
        writeTestReport({ request_id: input.request_id, session_id: input.session_id, project_id: input.project_id, result: testResult })
        return { ok: testResult.failed_count === 0 }
      },
    })
    if (cycle.blocked) {
      // 熔断回滚（T5）：同 mvp_repair——先回滚再让渡，回滚成功由哨兵错误终结本流程
      const outcome = await circuitBreakRollback({
        request_id: input.request_id,
        session_id: input.session_id,
        project_id: input.project_id,
        reason: 'test 修复循环耗尽（test_repair，GWT 场景反复未过）',
        publish: (type, payload) => publish(input, type, payload),
      })
      if (outcome.rolled_back) throw new CircuitBreakSettledError()
      // U7：把未通过场景汇总成可读偏差描述，避免让渡卡片只有泛化文案
      const failureTitle =
        testResult.failure_summary.length > 0
          ? `测试未通过：${testResult.failure_summary.map((f) => f.scenario).join('、')}`
          : '自动修复多次后测试仍未通过'
      publishBlockedDecision(input, 'test_repair', failureTitle)
      return { verdict: 'blocked', test_result: testResult }
    }
    if (cycle.repaired) break
  }

  // 测试通过 → 进入裁判审查（A2-11）
  updateProject(input.project_id, { current_stage: 'judge_review' })
  publish(input, 'stage_changed', { stage: 'judge_review' })
  const judge = await runJudgeReview({
    request_id: input.request_id,
    session_id: input.session_id,
    project_id: input.project_id,
  })
  return { verdict: judge.outcome, test_result: testResult, judge: judge.verdict }
}

export interface IterationTaskInput {
  request_id: string
  session_id: string
  project_id: string
  mode: ProjectMode
  prompt: string
  channel_id?: string
  query?: SDKQuery
  /** 停止生成信号（U5：迭代期间点停止） */
  signal?: AbortSignal
}

/**
 * runIterationTask — 已生成完成后用户提出修改诉求（打字或点选纠错）时，重新生成一版 MVP。
 *
 * 打通 Sprint 3「纠错 → 重新生成 → 迭代」主线：此前 ready 护栏把修改请求一律挡回固定文案，
 * 且 submitCorrection 只落盘不触发再生成。这里把修改诉求作为新功能项并入需求清单，进入
 * iterating 态后复用 runMvpTask + runPostMvpTestingFlow 完整闭环（重新生成 → 测试 → 裁判 → ready）。
 */
export async function runIterationTask(input: IterationTaskInput): Promise<MvpTaskResult> {
  updateProject(input.project_id, { current_stage: 'iterating' })
  publish(input, 'stage_changed', { stage: 'iterating' })

  // 修改诉求归一化后并入需求清单，供 runMvpTask 重新生成读取（含 GWT 骨架同步）。
  // 口语碎片原样入库会污染 PRD 背板（线上案例：「重新生成」被 acceptance 解释成功能、
  // 产品里长出重置按钮），归一化失败/无渠道时回退原样追加（改动前现状），不阻断迭代。
  const existing = readLastSketchRequirements(input.project_id)
  const requirements = await mergeIterationRequirements(input, existing)
  recordSketchGenerated(input.project_id, requirements)

  publishCompletionMessage(input, `好的，我按你的新想法「${truncateCopy(input.prompt, 20)}」重新生成一版。`)

  try {
    const mvp = await runMvpTask({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      channel_id: input.channel_id,
      query: input.query,
      signal: input.signal,
    })
    await runPostMvpTestingFlow({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      preview_url: mvp.preview_url,
      query: input.query,
      channel_id: input.channel_id,
      signal: input.signal,
    })
    return mvp
  } catch (error) {
    // 熔断回滚已完成收尾（T5）：阶段已按磁盘证据收敛、消息已发，不再覆盖为 ready
    if (isCircuitBreakSettled(error)) throw error
    // 迭代失败如实回滚：回到 ready（上一版 MVP 仍完整保留），并如实告知用户。
    // 否则项目会停在 iterating/generating_mvp，后续「好了吗」落入编程路径被模型
    // 编造成「已经生成好了」（阶段如实性）。
    // U5：用户主动停止（signal 已 abort）时不再补「生成失败」话术——渲染端已落
    // 「已停止生成」提示，避免两条相互矛盾的消息。
    const cancelled = input.signal?.aborted === true
    updateProject(input.project_id, { current_stage: 'ready' })
    publish(input, 'stage_changed', { stage: 'ready' })
    if (!cancelled) {
      // U12：记录本次失败的诉求，供「再试一次」一键重跑（避免用户重新打字描述）。
      setFailedIteration(input.project_id, input.prompt)
      appendJsonLine(getAgentSessionPath(input.session_id), {
        role: 'assistant',
        content: [{ type: 'text', text: GENERATION_FAILED_COPY }],
        timestamp: Date.now(),
      })
      publish(input, 'message_delta', { text: GENERATION_FAILED_COPY })
      // 失败文案旁附「再试一次」卡片（复用决策卡基建）：单选一张，点击回传 retry。
      publish(input, 'user_decision_required', {
        kind: 'retry',
        title: '这次修改没有成功',
        questions: [
          { id: 'retry', label: '再试一次', description: '用同样的诉求重新生成一版' },
        ],
      })
    }
    throw error
  }
}

/**
 * runIterationTask 专用：修改诉求 → 归一化 → 并入需求清单。
 * LLM 判定 revise（修订已有功能项，F-001 主题锚点除外）/ append（改写后追加新项）/
 * skip（操作指令不入清单，按原清单重生成），详见 requirement-normalizer。
 * 任何失败（无渠道/密钥/LLM/解析）回退改动前现状：清洗原文原样追加——归一化是旁路
 * 增强，绝不阻断迭代主线。导出供测试锁定归一化与回退行为。
 */
export async function mergeIterationRequirements(
  input: IterationTaskInput,
  existing: SketchRequirement[],
): Promise<SketchRequirement[]> {
  const appendRaw = (): SketchRequirement[] => [...existing, { id: nextRequirementId(existing), description: input.prompt }]
  if (!input.query) return appendRaw()
  try {
    // 渠道+类别统一收口（runtime-fallback，T9）：normalizer 归 prd 类别（§7.7 判定要
    // 稳 0.1）；失败由外层 catch 回退原样追加
    const resolution = resolveChannelEnv({
      channelId: input.channel_id,
      category: 'prd',
      projectId: input.project_id,
      sessionId: input.session_id,
    })
    if (!resolution.env) return appendRaw()
    const env = resolution.env
    const normalization = await normalizeRequirementUpdate({
      session_id: input.session_id,
      existing,
      modification: input.prompt,
      query: input.query,
      env,
      signal: input.signal,
    })
    if (normalization.action === 'out_of_scope' && normalization.outOfScope) {
      addScopeExclusion(input.project_id, normalization.outOfScope)
    }
    if (normalization.via === 'llm') {
      recordRequirementNormalization(input, 'iteration', input.prompt, normalization)
    }
    return applyNormalization(existing, normalization, nextRequirementId(existing), 'iteration')
  } catch {
    return appendRaw()
  }
}

/** 为追加的需求项生成不冲突的 id（F-xxx 序号递增，规避已有 id 碰撞）。导出供 orchestrator 草图阶段修改意见并入需求复用。 */
export function nextRequirementId(existing: SketchRequirement[]): string {
  const max = existing.reduce((acc, item) => {
    const match = /^F-(\d+)$/.exec(item.id)
    if (!match) return acc
    const num = Number(match[1])
    return Number.isFinite(num) && num > acc ? num : acc
  }, 0)
  return `F-${String(max + 1).padStart(3, '0')}`
}

// ==================== 修改确认门（与澄清卡片对称的两道门） ====================

/** 修改确认卡的决策 id（confirm/rephrase/cancel），由 orchestrator 在引导路径前拦截。 */
export type IterationDecisionId = 'confirm' | 'rephrase' | 'cancel'

export interface PendingIteration {
  /** 用户原话（确认卡 reply 展示用，保证用户认得出） */
  raw: string
  /** 清洗后的需求项描述（确认后并入 F-xxx，避免整句口水话污染 PRD 背板） */
  description: string
}

// 生命周期与决策卡一致（渲染端内存级）：卡片随重启消失，pending 也无须持久化
const pendingIterations = new Map<string, PendingIteration>()

export function setPendingIteration(projectId: string, pending: PendingIteration): void {
  pendingIterations.set(projectId, pending)
}

/** 取出并清除 pending（confirm/rephrase/cancel 任一决策都终结本次待确认修改）。 */
export function takePendingIteration(projectId: string): PendingIteration | undefined {
  const pending = pendingIterations.get(projectId)
  pendingIterations.delete(projectId)
  return pending
}

// ==================== 失败重试（U12） ====================

/**
 * 最近一次迭代失败时所用的诉求（按 project 内存级记录）。
 * 渲染端点「再试一次」时由 orchestrator 取出并原样重跑 runIterationTask，
 * 避免用户重新打字描述。与 pendingIterations 同生命周期：随进程重启失效。
 */
const failedIterations = new Map<string, string>()

export function setFailedIteration(projectId: string, prompt: string): void {
  failedIterations.set(projectId, prompt)
}

export function takeFailedIteration(projectId: string): string | undefined {
  const prompt = failedIterations.get(projectId)
  failedIterations.delete(projectId)
  return prompt
}

export function isIterationDecisionId(id: string | undefined): id is IterationDecisionId {
  return id === 'confirm' || id === 'rephrase' || id === 'cancel'
}

/**
 * 修改诉求 → 需求项描述：剥离否定引导与口语前缀（「啥意思，我要音乐合成器」→
 * 「音乐合成器」）。纯需求文案清洗，非代码修补；清洗后为空则保留原文，绝不改写语义。
 */
export function refineModificationDescription(text: string): string {
  let out = text.trim()
  out = out.replace(/^(不对|不是|搞错了|弄错了|错了|这不对|货不对板|什么意思|啥意思)[，,。！!～\s]*/, '')
  out = out.replace(/^(我要的是|我想要的是|我想要|我要|我希望(?:他|它|这个)?能?|我想|能不能|可以|请帮我|帮我)[，,。！!\s]*/, '')
  out = out.replace(/^[，,。！!\s]+/, '')
  return out.trim() || text.trim()
}

function truncateCopy(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function publish(input: Pick<SketchTaskInput, 'session_id' | 'project_id'>, type: AgentEvent['type'], payload: Record<string, unknown>): void {
  programmingEventPublisher({
    event_id: randomUUID(),
    session_id: input.session_id,
    project_id: input.project_id,
    type,
    payload,
    created_at: new Date().toISOString(),
  })
}

/**
 * 完成后主动通知（P0）：后台管线完成到 ready 时，把「已完成」沉淀为一条助手消息
 * 落盘到会话 JSONL，并下发 message_delta 上屏（随后 completed 收尾让渲染端把累积
 * 文本 flush 进消息列表）。此前只发 stage_changed/mvp_ready，用户没有任何「完成了」
 * 的信号，只能反复追问「好了吗」。
 */
function publishCompletionMessage(
  input: Pick<SketchTaskInput, 'session_id' | 'project_id'>,
  text: string,
): void {
  appendJsonLine(getAgentSessionPath(input.session_id), {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  })
  publish(input, 'message_delta', { text })
  publish(input, 'completed', { subtype: 'success' })
}

/** 无人值守自动化路径的工具门禁：显式传入豁免模式，不弹 UI，危险工具仍拒绝。 */
async function allowAutomatedTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId: string,
  projectId: string,
): Promise<void> {
  await assertToolAllowed(toolName, toolInput, sessionId, AUTOMATED_PERMISSION_MODE, projectId)
}

// =========================================================================
// A2/A3 — 阻塞态让渡 + resume 闭环
// =========================================================================

/**
 * 阻塞点统一入口：落盘 blocked_action（供 resume 恢复）+ 广播 stage_changed +
 * 发射带 id 的 user_decision_required（A1 统一 questions 形态）。
 */
function publishBlockedDecision(
  input: { session_id: string; project_id: string },
  action: BlockedAction,
  title?: string,
): void {
  updateProject(input.project_id, { current_stage: 'blocked_for_user_decision', blocked_action: action })
  publish(input, 'stage_changed', { stage: 'blocked_for_user_decision' })
  publish(input, 'user_decision_required', {
    kind: 'blocked',
    stage: 'blocked_for_user_decision',
    // U7：让渡卡片带上具体偏差描述（如「缺了按月统计功能」），落到 title 字段由渲染端展示
    title,
    questions: BLOCKED_DECISION_QUESTIONS,
  })
}

/**
 * 解析阻塞态回传的用户决策（A3：消费 metadata.selected_option_id）。
 *
 * 仅当项目处于 `blocked_for_user_decision` 且存在 `blocked_action`（编程阻塞）时返回决策；
 * 引导澄清态（无 blocked_action）返回 undefined，交由引导路径处理。
 */
export function resolveBlockedDecision(input: AgentSendMessageInput): BlockedDecision | undefined {
  if (input.current_stage !== 'blocked_for_user_decision') return undefined
  let project: Project
  try {
    project = findProject(input.project_id)
  } catch {
    return undefined
  }
  if (!project.blocked_action) return undefined

  if (input.metadata?.source === 'card_option') {
    const id = input.metadata?.selected_option_id
    if (id === 'accept' || id === 'explain' || id === 'continue') return id
    return 'continue'
  }

  // 自由文本兜底：阻塞态下用户可能直接打字（卡片是主路径，这里是容错）
  const text = input.content.trim()
  if (/接受|保留|现状|就这样|算了/.test(text)) return 'accept'
  if (/继续|重试|再试|再修/.test(text)) return 'continue'
  return 'explain'
}

export interface ResumeBlockedInput {
  request_id: string
  session_id: string
  project_id: string
  mode: ProjectMode
  decision: BlockedDecision
  content: string
  query?: SDKQuery
  channel_id?: string
}

/**
 * 恢复被阻塞的编程操作（A2 resume 闭环）。
 *
 * - `continue` → 重置对应计数，恢复被阻塞的操作（MVP 修复 / 测试修复 / 裁判退回）
 * - `accept`   → 接受当前 MVP，进入 ready
 * - `explain`  → 清阻塞 + 回澄清阶段（实际重新澄清由调用方走 handleGuideMessage）
 */
export async function resumeBlockedFlow(
  input: ResumeBlockedInput,
  eventPublisher: ProgrammingEventPublisher,
): Promise<void> {
  // 嵌套的 runMvpTask / runPostMvpTestingFlow / runJudgeReview 走同一发布通道
  setProgrammingEventPublisher(eventPublisher)

  const project = findProject(input.project_id)
  const action = project.blocked_action

  // 无论后续如何，先清除 blocked_action，避免重复触发阻塞分支
  updateProject(input.project_id, { blocked_action: undefined })

  if (input.decision === 'accept') {
    updateProject(input.project_id, {
      current_stage: 'ready',
      runtime_repair_count: 0,
      test_repair_count: 0,
      judge_return_count: 0,
    })
    publish(input, 'stage_changed', { stage: 'ready' })
    publishCompletionMessage(input, '好的，已保留当前版本。你可以点右侧预览区继续试用，有需要调整的随时告诉我。')
    return
  }

  if (input.decision === 'explain') {
    updateProject(input.project_id, { current_stage: 'clarifying' })
    publish(input, 'stage_changed', { stage: 'clarifying' })
    return
  }

  // decision === 'continue'：重置相关计数后恢复被阻塞的操作
  if (action === 'mvp_repair') {
    updateProject(input.project_id, { runtime_repair_count: 0 })
    const mvp = await runMvpTask({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      query: input.query,
      channel_id: input.channel_id,
    })
    await runPostMvpTestingFlow({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      preview_url: mvp.preview_url,
      query: input.query,
      channel_id: input.channel_id,
    })
    return
  }

  if (action === 'test_repair') {
    updateProject(input.project_id, { test_repair_count: 0 })
    const previewUrl = await ensureResumePreview(input)
    await runPostMvpTestingFlow({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      preview_url: previewUrl,
      query: input.query,
      channel_id: input.channel_id,
    })
    return
  }

  if (action === 'judge_return') {
    updateProject(input.project_id, { judge_return_count: 0 })
    await runJudgeReview({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
    })
    return
  }

  // 无明确 action（异常兜底）：进入 ready，避免卡死
  updateProject(input.project_id, { current_stage: 'ready' })
  publish(input, 'stage_changed', { stage: 'ready' })
}

/** 恢复测试/裁判前重新拉起沙箱，返回可用的 preview_url；起不来则抛错由上层报错。 */
async function ensureResumePreview(input: { request_id: string; project_id: string }): Promise<string> {
  const sandbox = await runSandbox({
    request_id: input.request_id,
    project_id: input.project_id,
    command: 'node static-server',
  })
  if (sandbox.status !== 'running' || !sandbox.preview_url) {
    throw new Error(`SANDBOX_RUN_FAILED:${sandbox.error_summary?.category ?? 'unknown'}`)
  }
  return sandbox.preview_url
}
