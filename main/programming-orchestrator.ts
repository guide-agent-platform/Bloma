import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, AgentLoopJudgeMetadata, AgentSendMessageInput, Channel, ChannelModel, MessageContentBlock, Project, ProjectMode, Snapshot, TemplateType } from '../shared/types'
import { getAgentSessionPath, getDocumentsDir } from '../storage/config-paths'
import { appendJsonLine } from '../storage/json-store'
import { buildPrdBackplane, readPrdBackplane, readUxContractSketch, syncDocuments, updateRequirementStatus, writeSecurityScanDocument } from './document-engine'
import { appendProjectLearning, renderLearningsSection } from './learnings-log'
import { createSnapshot, runSandbox, trackAnalytics } from './platform-services'
import { renderPackageJson, renderStaticServer } from './project-scaffold'
import { addScopeExclusion, findProject, readLastSketchRequirements, recordSketchGenerated, updateProject } from './project-service'
import { resolveChannelEnv } from './runtime-fallback'
import { captureConstraints, extractConstraints, readProjectConstraints } from './constraint-extractor'
import { distillProjectMemorySafely } from './memory-distiller'
import { generateSketch, requirementAssertions, requirementPriority, requirementStatusLabel, requirementStory, type GenerateSketchResult, type PrdBackplane, type SketchRequirement } from './sketch-engine'
import { generateSketchLlm, SketchLlmError, type SketchAttemptDetail } from './sketch-engine-llm'
import { generatePrdLlm, readConversation } from './prd-engine-llm'
import { enrichRequirementsLlm, extractUserTexts, mergeEnrichment } from './requirement-enricher'
import { applyNormalization, normalizeRequirementUpdate, recordRequirementNormalization } from './requirement-normalizer'
import { readTestReport, runGwtScenarios, writeTestReport, type GwtTestResult } from './gwt-service'
import { renderSecurityScanMarkdown, runSecurityScan } from './security-scan'
import { runJudge, readArtifactText, type JudgeVerdict } from './judge-engine'
import { runSemanticJudgeReview } from './judge-semantic'
import { loadPromptOverride } from './prompt-config'
import { assertToolAllowed } from './permission-service'
import { recordDecision } from './decision-log'
import { CircuitBreakSettledError, circuitBreakRollback, isCircuitBreakSettled } from './recovery-service'
import { readPrimaryIntent, recordSessionActivity } from './session-service'
import { runAgentLoop, type AgentLoopResult } from './agent-loop'
import { buildAgentTools } from './agent-tools'
import { disposeParentDelegationState, registerParentLoopContext, setChildToolsBuilder } from './agent-collaboration'
import { categoryTemperature } from './model-resolution'
import type { SDKQuery, ToolDefinition } from './orchestrator'

/**
 * 无人值守豁免（A2-12）：自动化管线内部 service 直连时显式传入 allow-all——
 * warning 工具自动放行（不弹 UI）、dangerous 拒绝。禁止隐式绕过，豁免必须显式传入。
 */
const AUTOMATED_PERMISSION_MODE = 'allow-all' as const

/** 渠道未配置 max_tokens 时的默认上限（与旧 mvp-engine-llm 的 16384 同值，loop 路径沿用）。 */
const DEFAULT_MAX_TOKENS = 16384

/** 项目已生成完成（ready）的统一话术：完成通知与 ready 护栏共用，避免两套语义相近的固定文案。 */
export const READY_COMPLETION_COPY =
  '已经生成好了，可以点右侧预览区的按键试用。有想调整的地方随时告诉我。'

/** 迭代/生成失败时如实告知用户的话术：不假装成功，也不把失败藏成「已经生成好了」。 */
export const GENERATION_FAILED_COPY =
  '这次修改没有成功（模型生成失败了），你可以再试一次，或者换个说法描述你的需求。'

type ProgrammingEventPublisher = (event: AgentEvent) => void

/** 被阻塞的编程操作类型（A2 resume 闭环，落盘到 Project.blocked_action） */
export type BlockedAction = 'mvp_repair' | 'test_repair' | 'judge_return' | 'security_repair'
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
  /** 本次 MVP 由 Agent Loop 路径生成（3b：调用方据此把外部修复循环切为「只终验不重修」） */
  via_agent_loop?: boolean
  /** Agent Loop 结果元数据（M4-B：runAgentLoopPostTesting 透传给 judge loop-aware；仅 loop 路径存在） */
  loop_result?: AgentLoopResult
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
    // T7 文档版本化：草图快照也冻结当时的 prd.json/decisions.md（documents 目录
    // 尚不存在时 createSnapshot 内部如实置空归档路径，不谎报）
    include_documents: true,
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
        page_count: sketch.files.length,
        // FIRT（research-plan §4.1）：项目创建 → 首个可交互草图就绪的耗时，
        // = sketch_generated.created_at - project_created.created_at（本埋点落盘时点即草图就绪时刻）。
        duration_ms: Date.now() - new Date(findProject(input.project_id).created_at).getTime(),
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
      // 用户约束随草图注入（T4-L1）：「不含登录」→ 草图不画登录界面
      constraints: readProjectConstraints(input.project_id),
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
 * mvp_before_generation → Agent Loop 生成（唯一运行时）→ 沙箱启动 → mvp 快照（含文档）→
 * analytics mvp_delivered → stage testing → 发布 mvp_ready。
 */
export async function runMvpTask(input: MvpTaskInput): Promise<MvpTaskResult> {
  publish(input, 'stage_changed', { stage: 'generating_mvp' })
  updateProject(input.project_id, { current_stage: 'generating_mvp' })

  // T4-L3 蒸馏兜底·触发点①（草图确认后，fire-and-forget）：默认关闭
  // （BLOMA_MEMORY_DISTILL=1），失败在内部降级并落决策，绝不阻塞 MVP 生成
  distillProjectMemorySafely({
    project_id: input.project_id,
    session_id: input.session_id,
    channel_id: input.channel_id,
    query: input.query,
  })

  const requirements = readLastSketchRequirements(input.project_id)
  await syncPrdCheckpoints(input, requirements)
  // 需求确认后自动命名（首次生成执行一次）：命名是附属能力，任何失败都不阻断生成
  try {
    await autoNameProject(input)
  } catch {
    // 命名异常（如项目并发更新）静默放过，MVP 生成照常继续
  }
  await allowAutomatedTool('generate_mvp', { project_id: input.project_id }, input.session_id, input.project_id)

  // Agent Loop 是唯一运行时（废旧管道方案 D1）：MVP 一律走 agentic loop 生成。
  // 渠道不支持 tool use / 探测失败 / 探测无结论在此抛错向上（见 tryResolveAgentLoop），
  // 不再存在旧管道回退分支。
  return runMvpViaAgentLoop(input, await tryResolveAgentLoop(input))
}

/**
 * MVP 产物就绪后的交付尾巴（权限门 → mvp 快照 → mvp_delivered 埋点 → testing →
 * mvp_ready），管道路径与 Agent Loop 路径共用，保证两条路的检查点语义一致。
 */
async function finalizeMvpDelivery(
  input: MvpTaskInput,
  detail: { fileCount: number; snapshotSummary: string; readySummary: string; previewUrl: string; viaAgentLoop?: boolean; loopResult?: AgentLoopResult },
): Promise<MvpTaskResult> {
  const runCommand = 'npm start'
  await allowAutomatedTool('run_project', { project_id: input.project_id, command: runCommand }, input.session_id, input.project_id)
  await allowAutomatedTool('create_snapshot', { project_id: input.project_id, kind: 'mvp' }, input.session_id, input.project_id)
  const snapshot = await createSnapshot({
    request_id: input.request_id,
    project_id: input.project_id,
    kind: 'mvp',
    summary: detail.snapshotSummary,
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
        file_count: detail.fileCount,
        run_command: runCommand,
        ...(detail.viaAgentLoop ? { via_agent_loop: true } : {}),
      },
      privacy_level: 'research_safe',
    },
  })

  updateProject(input.project_id, {
    current_stage: 'testing',
    current_snapshot_id: snapshot.snapshot_id,
    // M4-A：持久化 loop 路径标记，resumeBlockedFlow 据此选「只终验不重修」门禁路径
    ...(detail.viaAgentLoop ? { via_agent_loop: true, agent_loop_status: detail.loopResult?.status } : {}),
  })
  publish(input, 'stage_changed', { stage: 'testing' })
  publish(input, 'mvp_ready', {
    preview_url: detail.previewUrl,
    snapshot_id: snapshot.snapshot_id,
    run_command: runCommand,
    summary: detail.readySummary,
  })

  return {
    preview_url: detail.previewUrl,
    snapshot,
    run_command: runCommand,
    ...(detail.viaAgentLoop ? { via_agent_loop: true, loop_result: detail.loopResult } : {}),
  }
}

// =========================================================================
// Agent Loop 接线（PR3，方案 §4.4）——与旧管道并存，flag + 渠道能力位双条件
// =========================================================================

/** Agent Loop 总开关（D5）：缺省开启；`=0` 紧急关闭；`=1` 兼容无害（显式开，与缺省同义）。 */
export function agentLoopEnabled(): boolean {
  return process.env.BLOMA_AGENT_LOOP !== '0'
}

/** maxTurns（方案 §8 待拍板默认：quick=24 / longterm=40，首跑后按埋点标定）。 */
const AGENT_LOOP_MAX_TURNS: Record<ProjectMode, number> = { quick: 24, longterm: 40 }

/** 子 agent 独立轮次上限（比主 loop 小，控制委派 token 成本；按埋点标定）。 */
const DELEGATION_MAX_TURNS = 12

/** 渠道 tool use 支持度的进程内探测缓存（key = `${channelId}:${modelName}`，重启后重新探测一次）。 */
const toolSupportCache = new Map<string, boolean>()

/** 探测用最小工具定义（不执行，只看模型会不会发起 tool_use）。 */
const TOOL_SUPPORT_PROBE: ToolDefinition = {
  name: 'loop_support_probe',
  description: '能力探测工具：请立即调用本工具，无需任何参数。',
  input_schema: { type: 'object', properties: {} },
}

export interface AgentLoopChannelContext {
  env: Record<string, string>
  channel: Channel
  model: ChannelModel | undefined
}

/**
 * 分流判定（runMvpTask 入口）：flag 开 + query 句柄在 + mvp 渠道可用 + 能力位放行。
 * 只有「通过」才返回 context；不支持 / 探测未通过 / 探测无结论一律发布用户可见错误并
 * **抛错**（废旧管道方案 D1/D2：agent loop 是唯一运行时，无管道可回退）。探测结论
 * 与失败原因均落决策日志，绝不静默降级（2026-08-15 赛车案例教训）。
 */
async function tryResolveAgentLoop(input: MvpTaskInput): Promise<AgentLoopChannelContext> {
  if (!agentLoopEnabled() || !input.query) throw agentLoopChannelError(input, 'AGENT_LOOP_UNAVAILABLE', 'Agent Loop 已关闭或缺少模型调用句柄，无法生成 MVP。')
  const resolution = resolveChannelEnv({
    channelId: input.channel_id,
    category: 'mvp',
    projectId: input.project_id,
    sessionId: input.session_id,
    requireTools: true,
  })
  if (!resolution.env || !resolution.channel) {
    const message =
      resolution.unusableReason === 'decrypt_failed'
        ? 'API_KEY_DECRYPT_FAILED: 渠道 api_key 无法解密，请在设置中重新保存该渠道'
        : resolution.unusableReason === 'model_not_found'
          ? 'CHANNEL_MODEL_NOT_FOUND: 渠道没有启用的模型，请在设置中启用至少一个模型后再生成'
          : resolution.unusableReason === 'tools_unsupported'
            ? 'AGENT_LOOP_CHANNEL_UNSUPPORTED: 当前渠道不支持工具循环（tool use），请切换到支持的工具渠道后重试。'
            : 'MVP_GENERATION_FAILED: 没有可用的模型渠道，请在设置中配置并验证渠道后再生成'
    throw agentLoopChannelError(input, errorCodeFrom(message), message)
  }
  const channel = resolution.channel
  const env = resolution.env
  const model = channel.models.find((candidate) => candidate.enabled && candidate.name === env.ANTHROPIC_MODEL)

  // 显式能力位：false = 已知不支持，直接抛错（路由层过滤已处理主/备用，此处兜底并发场景）
  if (model?.supports_tools === false) {
    throw agentLoopChannelError(input, 'AGENT_LOOP_CHANNEL_UNSUPPORTED', '当前渠道不支持工具循环（tool use），请切换到支持的工具渠道后重试。')
  }
  if (model?.supports_tools === true) return { env, channel, model }

  const cacheKey = `${channel.id}:${env.ANTHROPIC_MODEL}`
  const cached = toolSupportCache.get(cacheKey)
  if (cached !== undefined) {
    if (!cached) throw agentLoopChannelError(input, 'AGENT_LOOP_PROBE_FAILED', '当前渠道未通过工具能力探测，请更换渠道或稍后重试。')
    return { env, channel, model }
  }

  const probed = await probeToolSupport(input.query, env, input.session_id, input.signal)
  if (probed === undefined) {
    // 探测自身失败（网络/渠道抖动）：不写缓存——下次仍会重试探测；本次如实抛错（无管道可回退）
    throw agentLoopChannelError(input, 'AGENT_LOOP_PROBE_INCONCLUSIVE', '工具能力探测未得出结论（网络问题），请稍后重试。')
  }
  toolSupportCache.set(cacheKey, probed)
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'agent_loop',
      title: probed ? '渠道 tool use 探测通过' : '渠道 tool use 探测未通过',
      why: `对 ${channel.name}/${env.ANTHROPIC_MODEL} 发起带 tools 的最小探测请求：${probed ? '模型发起了 tool_use，走 Agent Loop 生成' : '模型未发起 tool_use（或渠道 400 拒绝 tools 参数），Agent Loop 不可用'}`,
      detail: { channel_id: channel.id, model: env.ANTHROPIC_MODEL, supports_tools: probed },
    },
  })
  if (!probed) throw agentLoopChannelError(input, 'AGENT_LOOP_PROBE_FAILED', '当前渠道未通过工具能力探测，请更换渠道或稍后重试。')
  return { env, channel, model }
}

/** Agent Loop 不可用的统一报错：发布用户可见 error 事件 + 落「Agent Loop 不可用」决策留痕，再抛错。 */
function agentLoopChannelError(input: MvpTaskInput, code: string, message: string): Error {
  recordAgentLoopUnavailable(input, message)
  publish(input, 'error', { code, message })
  return new Error(message)
}

/** 探测：发一个带 tools 的最小请求。返回 true/false；探测自身失败返回 undefined。 */
async function probeToolSupport(
  query: SDKQuery,
  env: Record<string, string>,
  sessionId: string,
  signal: AbortSignal | undefined,
): Promise<boolean | undefined> {
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', onOuterAbort, { once: true })
  try {
    let sawToolUse = false
    for await (const sdk of query('请调用 loop_support_probe 工具', {
      env,
      signal: controller.signal,
      sessionId,
      maxTokens: 128,
      history: [{ role: 'system', content: '这是一次工具能力探测。请立即调用 loop_support_probe 工具，不要输出任何文字。' }],
      tools: [TOOL_SUPPORT_PROBE],
    })) {
      if (sdk.type === 'assistant' && sdk.message?.content.some((block) => block.type === 'tool_use')) sawToolUse = true
    }
    return sawToolUse
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 400/404 且错误提到 tools = 渠道不支持工具参数；其余（网络/5xx/取消）视为探测未得出结论
    if (/\b(40[04])\b/.test(message) && /tool/i.test(message)) return false
    if (controller.signal.aborted || String(message).includes('AGENT_CANCELLED')) return undefined
    return undefined
  } finally {
    signal?.removeEventListener('abort', onOuterAbort)
  }
}

function recordAgentLoopUnavailable(input: MvpTaskInput, reason: string): void {
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'agent_loop',
      title: 'Agent Loop 不可用',
      why: reason,
    },
  })
}

/** 从 `CODE: message` 形态的错误串里抽出纯错误码（与 ipc.ts errorCodeFrom 同口径）。 */
function errorCodeFrom(message: string): string {
  const match = /^([A-Z_]+):/.exec(message)
  return match ? match[1] : 'AGENT_LOOP_UNAVAILABLE'
}

/**
 * Agent Loop 生成路径（3a）：loop 会话亲手构建 + 自测（背板锚定系统提示词），
 * 完成后补系统接管文件（package.json/static-server.js——loop 工具无权写）、
 * 单次启动沙箱（启动失败分类的修复已内化在 loop：run_preview 失败 → 看日志 → edit_file），
 * 再走共用交付尾巴。沙箱起不来直接抛错（loop 已给过自修机会，不再走外部修复循环）。
 */
async function runMvpViaAgentLoop(input: MvpTaskInput, loop: AgentLoopChannelContext): Promise<MvpTaskResult> {
  const project = findProject(input.project_id)
  const backplane = readPrdBackplane(input.project_id)
  const editFormat = loop.model?.edit_format ?? 'diff'
  const startedAt = Date.now()
  // 委派协作（嫁接方案 §4.1）：注册父 loop 上下文供 delegate_agent 构建子循环；子工具集按 role 裁剪
  setChildToolsBuilder((projectId, role, editFormat) => buildAgentTools({ projectId, role, editFormat }))
  registerParentLoopContext(input.session_id, {
    query: input.query!,
    env: loop.env,
    maxTokens: loop.channel.max_tokens ?? DEFAULT_MAX_TOKENS,
    maxTurns: AGENT_LOOP_MAX_TURNS[input.mode],
    delegationMaxTurns: DELEGATION_MAX_TURNS,
    permissionMode: AUTOMATED_PERMISSION_MODE,
    temperature: categoryTemperature('mvp'),
    system: buildLoopSystemWithOverride(backplane, editFormat),
    editFormat,
    publish: (type, payload) => publish(input, type, payload),
    onChildTurn: (info, child) => {
      trackAnalytics({
        request_id: child.requestId,
        event: {
          event_type: 'agent_loop_turn',
          project_id: input.project_id,
          session_id: child.sessionId,
          payload: {
            turn: info.turn,
            tool_calls: info.toolCalls.map((call) => call.name),
            via: 'delegation',
            role: child.role,
          },
          privacy_level: 'research_safe',
        },
      })
    },
  })

  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'agent_loop',
      title: 'Agent Loop 生成启用',
      why: `BLOMA_AGENT_LOOP=1 且渠道 ${loop.channel.name}/${loop.env.ANTHROPIC_MODEL} 支持 tool use，MVP 走 agentic loop 生成（maxTurns=${AGENT_LOOP_MAX_TURNS[input.mode]}，edit_format=${editFormat}）`,
      detail: {
        repair_budget_mapping: 'loop 内「GWT 失败后的 edit_file/write_file」预算 3 次，同构旧管道 test_repair_count ≤ 3',
        max_turns: AGENT_LOOP_MAX_TURNS[input.mode],
        edit_format: editFormat,
      },
    },
  })

  let result: AgentLoopResult
  try {
    result = await runAgentLoop({
    system: buildLoopSystemWithOverride(backplane, editFormat),
    task: buildAgentLoopTask(backplane, input.mode),
    tools: buildAgentTools({
      projectId: input.project_id,
      editFormat,
      // 修复预算映射（§4.4）：loop 内每个新失败回合 = 一次 self_repair，attempt 口径与旧管道对齐
      onRepairRound: (round) => {
        trackAnalytics({
          request_id: input.request_id,
          event: {
            event_type: 'self_repair_triggered',
            project_id: input.project_id,
            session_id: input.session_id,
            payload: { attempt: round, category: 'test_error', via: 'agent_loop' },
            privacy_level: 'research_safe',
          },
        })
      },
    }),
    query: input.query!,
    env: loop.env,
    sessionId: input.session_id,
    projectId: input.project_id,
    requestId: input.request_id,
    maxTokens: loop.channel.max_tokens ?? DEFAULT_MAX_TOKENS,
    maxTurns: AGENT_LOOP_MAX_TURNS[input.mode],
    permissionMode: AUTOMATED_PERMISSION_MODE,
    temperature: categoryTemperature('mvp'),
    signal: input.signal ?? new AbortController().signal,
    publish: (type, payload) => publish(input, type, payload),
    onTurn: (info) => {
      trackAnalytics({
        request_id: input.request_id,
        event: {
          event_type: 'agent_loop_turn',
          project_id: input.project_id,
          session_id: input.session_id,
          payload: {
            turn: info.turn,
            tool_calls: info.toolCalls.map((call) => call.name),
            ...(info.inputTokens !== undefined ? { input_tokens: info.inputTokens } : {}),
            ...(info.outputTokens !== undefined ? { output_tokens: info.outputTokens } : {}),
          },
          privacy_level: 'research_safe',
        },
      })
    },
  })
  } finally {
    // 父 loop 收尾（含用户停止/异常）：stop 全部 running 子委派 + 清幂等缓存 + 注销父上下文
    // （审计 P1-2/P2-4——只 unregister 不清理会让子 agent 后台偷跑且结果丢失）
    disposeParentDelegationState(input.session_id)
  }

  const durationMs = Date.now() - startedAt
  const toolDistribution: Record<string, number> = {}
  for (const call of result.toolCalls) toolDistribution[call.name] = (toolDistribution[call.name] ?? 0) + 1
  trackAnalytics({
    request_id: input.request_id,
    event: {
      event_type: 'agent_loop_completed',
      project_id: input.project_id,
      session_id: input.session_id,
      payload: {
        status: result.status,
        turns: result.turns,
        total_tool_calls: result.toolCalls.length,
        duration_ms: durationMs,
        tool_distribution: toolDistribution,
      },
      privacy_level: 'research_safe',
    },
  })
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'agent_loop',
      title: `Agent Loop 结束（${result.status}）`,
      why: `${result.turns} 轮、${result.toolCalls.length} 次工具调用、耗时 ${durationMs}ms；终验仍由外部代码执行（不信模型自述）`,
      detail: { status: result.status, turns: result.turns, tool_distribution: toolDistribution },
    },
  })

  // 执行经验沉淀（2026-08-26 改造 2，ralph progress.txt 等价物）：完成总结/异常结局
  // append-only 进 learnings.jsonl，下轮 fresh loop 经【历史经验】段注入；静默失败不阻断
  appendProjectLearning(input.project_id, {
    kind: result.status === 'completed' ? 'loop_summary' : 'loop_outcome',
    text:
      result.finalText.trim() ||
      `Loop 结束（${result.status}，${result.turns} 轮 / ${result.toolCalls.length} 次工具调用）`,
    meta: { status: result.status, turns: result.turns, tool_calls: result.toolCalls.length },
  })

  // 用户已停止（U5，2026-08-25 线上案例）：loop 返回 cancelled 即中止交付链——
  // 不补脚手架、不起沙箱、不终验不改阶段。此前无此特判，停止后照样交付+终验+
  // 熔断回滚，把用户停止谎报成「修复预算耗尽/无可用产物」并污染项目阶段。
  // 错误向上传播由调用方按「signal 已 abort → 静默」消化（runIterationTask 回 ready、
  // ipc 两处 catch 均不再发终态事件，渲染端已落「已停止生成」）。
  if (result.status === 'cancelled') {
    throw new Error(`AGENT_CANCELLED: Agent Loop 已取消（${result.turns} 轮），中止交付`)
  }

  // loop 工具无权写系统接管文件，由平台补齐（与管道路径 generateMvpLlm 行为一致）
  writeFileSync(join(project.root_path, 'package.json'), renderPackageJson(project.name), 'utf8')
  writeFileSync(join(project.root_path, 'static-server.js'), renderStaticServer(), 'utf8')

  if (!existsSync(join(project.root_path, 'index.html'))) {
    // loop 未产出入口文件（turn_limit/预算耗尽的典型残局）：如实报错，不假装交付
    throw new Error(`AGENT_LOOP_INCOMPLETE: Agent Loop 结束（${result.status}）但项目缺少 index.html，本次生成未完成`)
  }

  // 单次启动沙箱：启动失败的修复已内化在 loop（run_preview → logs → edit_file 自修），
  // 这里不再走 ensureSandboxRunning 的外部修复循环；仍失败则如实抛错交上层处理。
  const sandbox = await runSandbox({ request_id: input.request_id, project_id: input.project_id })
  if (sandbox.status !== 'running' || !sandbox.preview_url) {
    publish(input, 'error', {
      code: 'SANDBOX_RUN_FAILED',
      message: sandbox.error_summary?.user_visible_summary ?? '预览暂时没有启动成功。',
    })
    throw new Error(`SANDBOX_RUN_FAILED:${sandbox.error_summary?.category ?? 'unknown'}（agent loop 路径）`)
  }

  const fileCount = countProjectFiles(project.root_path)
  return finalizeMvpDelivery(input, {
    fileCount,
    snapshotSummary: `MVP 已生成（Agent Loop，${result.turns} 轮 / ${result.toolCalls.length} 次工具调用），进入测试阶段。`,
    readySummary: result.finalText.slice(0, 200) || `Agent Loop 生成完成（${result.status}）。`,
    previewUrl: sandbox.preview_url,
    viaAgentLoop: true,
    loopResult: result,
  })
}

/** 递归统计项目产物文件数（跳过 node_modules 等，快照 summary 与埋点用）。 */
function countProjectFiles(root: string): number {
  let count = 0
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'dist-main') continue
        walk(join(dir, entry.name))
      } else if (entry.isFile()) {
        count += 1
      }
    }
  }
  walk(root)
  return count
}

/**
 * 背板锚定系统提示词（方案 §4.4 骨架）：PRD 背板全文常驻每轮（AutoGPT 式漂移的
 * 解药，本项目区别于 SWE-agent/Codex 的差异化锚），工作方式与终止判据显式化。
 */
export function buildAgentLoopSystemPrompt(backplane: PrdBackplane, editFormat: 'diff' | 'whole'): string {
  const items = backplane.requirements
    .map((item) => {
      const assertions = requirementAssertions(item)
        .map((assertion) => `    - ${assertion}`)
        .join('\n')
      return (
        `- [${item.id}]（${requirementPriority(item)}）${requirementStory(item)}` +
        (assertions ? `\n  行为断言：\n${assertions}` : '') +
        (item.scope_notes ? `\n  范围排除：${item.scope_notes}` : '') +
        // 活背板：带执行状态时标注（首轮/全量重生成时无 status，零开销；
        // 部分重生成/恢复终验路径下让 loop 知道哪些项已是既成事实）
        (item.status ? `\n  执行状态：${requirementStatusLabel(item.status)}` : '')
      )
    })
    .join('\n')
  const outOfScope = backplane.out_of_scope.length
    ? backplane.out_of_scope.map((entry) => `- ${entry}`).join('\n')
    : '- （无）'
  const constraints = backplane.constraints?.length
    ? backplane.constraints.map((entry) => `- ${entry}`).join('\n')
    : '- （无）'
  return [
    '你是 Bloma 编程 Agent，用提供的工具亲手构建并验证一个可运行的应用。',
    '',
    '【项目锚（每轮有效，一切决策不得漂移出此范围）】',
    `产品定位：${backplane.positioning}`,
    '功能项（P0 必须全部实现且断言为真）：',
    items,
    '范围外（一律不做）：',
    outOfScope,
    '用户约束：',
    constraints,
    '',
    '【工作方式】',
    '逐功能项实现：write_file/edit_file 写代码 → run_preview 确认可运行 → ' +
    'run_gwt_tests 对照行为断言 → 失败先 read_file/grep 定位再修 → 全部 P0 断言通过后 ' +
    'run_security_scan 确认无高危。',
    editFormat === 'diff'
      ? '编辑用 edit_file 的 diff 模式（old_string 必须与当前文件逐字一致且唯一）。'
      : '编辑用 edit_file 的 whole 模式（提供修改后的完整文件内容）。',
    '',
    '【终止条件】全部 P0 断言通过 + 安全扫描无高危，才输出完成总结（含做了什么、' +
    '未解决的低优先级项）。测试未全绿不得声称完成。',
    '',
    '【表达】面向用户的旁白与完成总结一律用中文（代码与文件内容除外）。',
    '',
    '【护栏】路径限项目目录内；不 eval/Function；不外联 fetch/XHR；不写 CSP meta；' +
    'out_of_scope 内的功能一律不做；编辑校验失败的错误信息要读完再改。',
    '',
    '【产物形态】入口 index.html，纯前端静态产物（平台用静态服务器托管，无构建步骤）；' +
    '交互逻辑放 src/app.js，样式放 src/styles.css；不使用 import/ESM 模块语法。',
  ].join('\n')
}

/**
 * 背板锚定系统提示词 + 用户追加规则（D4 追加模式）：`loop-system` 覆盖文件内容追加在
 * 动态 system prompt 之后（背板锚定段不可覆盖）。无覆盖文件返回 base 本身。
 */
function buildLoopSystemWithOverride(backplane: PrdBackplane, editFormat: 'diff' | 'whole'): string {
  const base = buildAgentLoopSystemPrompt(backplane, editFormat)
  // 历史经验段（改造 2）：迭代/重生成场景下轮 fresh loop 开场即知上轮踩坑；
  // 首轮无经验返回空串零开销；renderLearningsSection 内部静默失败
  const learnings = renderLearningsSection(backplane.project_id)
  const override = loadPromptOverride('loop-system')
  return [base, learnings, override ? `【用户自定义规则】\n${override}` : ''].filter(Boolean).join('\n\n')
}

/** 初始 user 消息：任务指令（背板细节在 system，这里只给行动指令）。 */
function buildAgentLoopTask(backplane: PrdBackplane, mode: ProjectMode): string {
  return [
    `目标：实现「${backplane.name}」的可运行 MVP（${mode === 'quick' ? '快速模式' : '长期模式'}）。`,
    '按系统提示里的项目锚逐功能项实现，用工具自测（run_preview + run_gwt_tests + run_security_scan），' +
      '全部 P0 断言通过且无高危后输出完成总结。',
  ].join('\n')
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

/**
 * PRD 背板来源分流：渠道可用走 LLM 从对话提取，否则回退确定性模板。
 *
 * 2026-08-18 功能项加厚（设计 §3.3）：在 sketch_confirmed 与 `generatePrdLlm` **并行**
 * 跑一道「功能项加厚」LLM 提取（`enrichRequirementsLlm`），把薄功能项补成 story +
 * 行为断言 + 优先级。两路互不依赖、共用同一渠道/env/对话；任一失败一律降级，绝不
 * 阻断主链路——`enrichRequirementsLlm` 契约返回 null，但 abort/网络极端情形仍可能
 * throw，一并 `.catch(()=>null)` 兜底。
 *
 * 合并底 = 冻结清单（权威 id 集） + `readPrdBackplane` 上轮 prd.json 对应项既有字段
 * （重跑时上轮 auto priority/已厚断言成为「已有」被「只填缺省」保留）；`mergeEnrichment`
 * 返回 `{ requirements, stats }`，断言丢弃率/优先级抑制数由本调用侧落决策日志
 * （enrichment_stats）供线上标定接地守卫误杀——日志失败仅静默丢弃，不阻断主链路。
 */
export async function resolvePrdBackplane(input: MvpTaskInput, requirements: SketchRequirement[]): Promise<PrdBackplane> {
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

  const project = findProject(input.project_id)
  // 上轮已写盘的 prd.json（如有）：重跑时其对应项既有字段并入合并底（§3.2）；首轮无 prd.json 按最后草图需求忠实重建（不含默认项）
  const existing = readPrdBackplane(input.project_id)
  // 渠道能力上限：enricher 与 generatePrdLlm 共用同一上限，绝不请求超过渠道能力（§3.1 预算 = min(上限, 4096 + 项数×600)）
  const maxTokens = channel.max_tokens ?? 8192
  // 并行：PRD 元数据提取 + 功能项加厚互不依赖，共用同一渠道/env/对话
  const [llm, enriched] = await Promise.all([
    generatePrdLlm({
      project_id: input.project_id,
      session_id: input.session_id,
      requirements,
      query: input.query,
      env,
      maxTokens,
      signal: input.signal,
    }).catch(() => null), // 防御性兜底：契约返回 null，但 abort/网络极端情形仍可能 throw，一并降级避免 Promise.all 整体 reject
    enrichRequirementsLlm({
      session_id: input.session_id,
      requirements,
      query: input.query,
      env,
      maxTokens,
      signal: input.signal,
    }).catch(() => null), // 异常一律降级 null，绝不因 reject 阻断主链路
  ])

  const base = llm ?? template()
  // 权威 id 集：冻结清单（llm 失败回退 template() 时其 requirements 可能与冻结清单
  // 不一致——template() 会把默认存在性断言/story 物化，以原始冻结清单为准保证加厚不丢）
  const frozen = llm ? base.requirements : requirements
  // 接地守卫②的用户原话（user 轮次；assistant 轮次不参与子串匹配，防模型自述被引为支撑）
  const userTexts = extractUserTexts(readConversation(input.session_id))
  // 冻结项为 id 骨架，上轮 prd.json 对应项既有字段并入合并底；stats 为断言丢弃与优先级抑制分类（纯返回值，无日志副作用）
  let enrichedRequirements: SketchRequirement[]
  let stats = { formatDropped: 0, groundingDropped: 0, prioritySuppressed: 0 }
  try {
    const merged = mergeEnrichment(frozen, enriched, existing.requirements ?? [], userTexts)
    enrichedRequirements = merged.requirements
    stats = merged.stats
  } catch {
    // 防御性兜底：mergeEnrichment 自身契约不抛错（内部回退合并底），此处再包一层——
    // 任何异常回退冻结清单，绝不阻断 MVP 生成主链路（设计 §3.4）
    enrichedRequirements = frozen
  }
  // 丢弃率/抑制率决策日志（T2 recordDecision）：供线上标定接地守卫误杀。日志属附加
  // 观测，绝不得阻断主链路——recordDecision 为同步 void 且内部 appendJsonLine 无异常
  // 包裹，可能 throw，须 try/catch 隔离，失败仅静默丢弃观测
  try {
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'enrichment_stats',
        title: '功能项加厚断言丢弃与优先级抑制统计',
        why: '记录格式/接地守卫断言丢弃数与优先级抑制数，供线上标定',
        detail: stats,
      },
    })
  } catch {
    // 忽略：日志失败不影响主链路
  }
  // 项目级字段合并（T4-L1）：LLM 从对话提取的背板不带 project.constraints /
  // scope_exclusions（其提取源是会话文本，项目存储是另一路事实）——冻结前并入，
  // 防止确定性门捕获的约束/范围声明在 prd.json 里丢失
  return {
    ...base,
    name: project.name,
    requirements: enrichedRequirements,
    out_of_scope: [...new Set([...(llm?.out_of_scope ?? []), ...(project.scope_exclusions ?? [])])],
    ...(project.constraints?.length ? { constraints: [...new Set([...(llm?.constraints ?? []), ...project.constraints])] } : {}),
  }
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
  /** Agent Loop 结果元数据（M4-B）：loop 路径终验透传，judge 对异常终止态判「不达标/让渡」 */
  loop?: AgentLoopJudgeMetadata
  /** loop 路径「只终验不重修」（M4-B）：constraint_error 不再外部文档重修，首败熔断让渡 */
  repairInternalized?: boolean
  /** 语义审查腿（2026-08-26，裁判域 LLM）：规则全绿后审「产物是否忠实实现 PRD」；缺省跳过 */
  query?: SDKQuery
  channel_id?: string
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
 * 语义审查腿（2026-08-26）：规则先行——规则 return 直接进退回流（省一次 LLM）；
 * 规则全绿且 query 可用 → 语义审查（产物 vs PRD 忠实性），失败合成 return 进同一
 * 退回计数/让渡流；LLM 失败跳过留痕，绝不阻断交付。
 */
export async function runJudgeReview(input: JudgeReviewInput): Promise<JudgeReviewResult> {
  let verdict = await evaluateOnce(input)
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

    // M4-B loop-aware：loop 路径「只终验不重修」——constraint_error 不再外部文档重修
    // （loop 已内化修复，外部再修语义重复）；judge 自判 repairable=false（loop 异常终止态）
    // 同样不再重修。首败即熔断让渡（U7：把具体退回原因带给让渡卡片）。
    const repairable = verdict.repairable === true && input.repairInternalized !== true
    if (!repairable || returns > limit) {
      publishBlockedDecision(input, 'judge_return', verdict.user_visible_summary)
      return { outcome: 'blocked', verdict }
    }

    // constraint_error 修复：重新生成 PRD/GWT 骨架，然后重新判定
    applyConstraintErrorDocRepair({ request_id: input.request_id, session_id: input.session_id, project_id: input.project_id })
    updateProject(input.project_id, { current_stage: 'repairing' })
    publish(input, 'stage_changed', { stage: 'repairing' })
    publish(input, 'repairing', { attempt: returns, category: 'constraint_error', user_visible_summary: '功能要求未完全对齐，正在重新整理文档' })
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
    verdict = await evaluateOnce(input)
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

/**
 * constraint_error 文档级修复（原 repair-engine.applyRepairPatch 的 constraint 分支，随废旧管道
 * 删除内联于此）：重新生成 PRD 与 GWT 骨架（文档层面），不改动项目代码。judge 退回重试
 * 路径（repairInternalized 未设的存量语义）仍依赖它重建文档骨架。
 */
function applyConstraintErrorDocRepair(input: { request_id: string; session_id: string; project_id: string }): void {
  syncDocuments({
    request_id: input.request_id,
    session_id: input.session_id,
    project_id: input.project_id,
    checkpoint: 'mvp_before_generation',
  })
}

/** 单轮完整裁决：规则引擎先行，规则全绿且 query 可用时叠加 LLM 语义审查腿。 */
async function evaluateOnce(input: JudgeReviewInput): Promise<JudgeVerdict> {
  const verdict = judgeOnce(input)
  if (verdict.verdict === 'return' || !input.query) return verdict

  // 渠道：优先 M5 类别路由（prd 审查类，可指快模型），失败回退跳过
  let env: Record<string, string> | undefined
  try {
    const resolution = resolveChannelEnv({
      channelId: input.channel_id,
      category: 'prd',
      projectId: input.project_id,
      sessionId: input.session_id,
    })
    env = resolution.env ?? undefined
  } catch {
    env = undefined
  }
  const project = findProject(input.project_id)
  const backplane = readPrdBackplane(input.project_id)
  const testResult = readTestReport(input.project_id)
  const semantic = await runSemanticJudgeReview({
    backplane,
    artifact: readArtifactText(project.root_path),
    testSummary: testResult
      ? `共 ${testResult.total_count} 项，通过 ${testResult.passed_count}、失败 ${testResult.failed_count}`
      : undefined,
    query: input.query,
    env,
    sessionId: input.session_id,
    projectId: input.project_id,
    requestId: input.request_id,
    publish: (event) => publish(input, event.type, event.payload),
  })
  // 活背板（2026-08-26）：逐功能项判定回写 prd.json（pass/fail 都回写——partial/unverified
  // 同样是用户该看到的执行状态；内部全 catch，失败不影响裁决流）
  if (!semantic.skipped && semantic.findings.length > 0) {
    updateRequirementStatus(input.project_id, semantic.findings)
  }
  if (semantic.skipped) {
    try {
      recordDecision({
        project_id: input.project_id,
        session_id: input.session_id,
        entry: {
          type: 'judge_semantic',
          title: '语义审查跳过',
          why: semantic.skipReason === 'no_channel' ? '无可用渠道，语义审查未执行' : 'LLM 语义审查失败，跳过不阻断',
          detail: { skip_reason: semantic.skipReason },
        },
      })
    } catch {
      // 观测日志失败不影响主链路
    }
    return verdict
  }
  if (semantic.constraint && !semantic.constraint.passed) {
    try {
      recordDecision({
        project_id: input.project_id,
        session_id: input.session_id,
        entry: {
          type: 'judge_semantic',
          title: '语义审查未过（裁判 LLM）',
          why: semantic.constraint.detail,
          detail: { findings: semantic.findings },
        },
      })
    } catch {
      // 同上
    }
    return {
      verdict: 'return',
      hard_constraints: [...verdict.hard_constraints, semantic.constraint],
      soft_constraints: verdict.soft_constraints,
      user_visible_summary: semantic.constraint.detail,
      repairable: true,
    }
  }
  return verdict
}

function judgeOnce(input: JudgeReviewInput): JudgeVerdict {
  const project = findProject(input.project_id)
  const testResult = readTestReport(input.project_id)
  const verdict = runJudge({
    project_id: input.project_id,
    mode: project.mode,
    test_result: testResult ?? undefined,
    ...(input.loop ? { loop: input.loop } : {}),
  })
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

export interface AgentLoopPostTestingInput {
  request_id: string
  session_id: string
  project_id: string
  mode: ProjectMode
  preview_url: string
  /** Agent Loop 结果元数据（M4-B）：其存在即标记 loop 路径；judge 对异常终止态判「让渡」。
   *  存量旧版项目（via_agent_loop=false）resume 时无 loop 元数据，缺省走普通终验（无修复）。 */
  loop?: AgentLoopJudgeMetadata
  /** 语义审查腿透传（2026-08-26）：judge 规则全绿后审产物 vs PRD 忠实性 */
  query?: SDKQuery
  channel_id?: string
}

/**
 * 熔断原因里的 loop 结局描述（2026-08-25 线上案例）：此前写死「loop 内修复预算已
 * 用尽」，cancelled/turn_limit 等异常终止也被谎报成预算耗尽。按 loop 实际状态如实
 * 陈述——completed 才是「修复预算已用尽」语义，其余状态点名终止原因。
 */
function loopOutcomeNote(loop: AgentLoopJudgeMetadata | undefined): string {
  if (!loop) return '无 loop 元数据（存量项目 resume）'
  return loop.status === 'completed' ? 'loop 内修复预算已用尽' : `Agent Loop 异常终止（${loop.status}）`
}

/**
 * runAgentLoopPostTesting — Agent Loop 路径的独立门禁函数（M4-A，微调方案 §4）。
 *
 * 语义固定为「只终验不重修」：GWT 终验 →（通过）安全扫描 → judge 终审 → ready / 让渡，
 * **无外部修复循环**（loop 内的自测自修已用尽修复预算，不给外部预算）。与
 * runPostMvpTestingFlow（旧管道含 repairing 修复循环）解耦：loop 调用方一律走本函数，
 * 不再靠 `repair_internalized` 布尔位在旧函数里分叉两种语义（D1）。
 */
export async function runAgentLoopPostTesting(input: AgentLoopPostTestingInput): Promise<GwtTestingResult> {
  updateProject(input.project_id, { current_stage: 'testing' })
  publish(input, 'stage_changed', { stage: 'testing' })

  let testResult = await runGwtScenarios({ project_id: input.project_id, session_id: input.session_id, preview_url: input.preview_url })
  writeTestReport({ request_id: input.request_id, session_id: input.session_id, project_id: input.project_id, result: testResult })
  syncDocuments({ request_id: input.request_id, project_id: input.project_id, session_id: input.session_id, checkpoint: 'mvp_tested' })

  // 只终验不重修：GWT 首败即熔断回滚 / 让渡（loop 内修复预算已用尽）
  if (testResult.failed_count > 0) {
    const outcome = await circuitBreakRollback({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      reason: `终验未通过（Agent Loop 路径，${loopOutcomeNote(input.loop)}）`,
      publish: (type, payload) => publish(input, type, payload),
    })
    if (outcome.rolled_back) throw new CircuitBreakSettledError()
    const failureTitle =
      testResult.failure_summary.length > 0
        ? `测试未通过：${testResult.failure_summary.map((f) => f.scenario).join('、')}`
        : '自动修复多次后测试仍未通过'
    publishBlockedDecision(input, 'test_repair', failureTitle)
    return { verdict: 'blocked', test_result: testResult }
  }

  // 安全扫描终验（A3，OWASP 静态扫描）：高危/严重命中同样只熔断不重修
  let security = runSecurityScan({ project_id: input.project_id, root_path: findProject(input.project_id).root_path })
  writeSecurityScanDocument(input.project_id, renderSecurityScanMarkdown(security))
  if (!security.passed) {
    const outcome = await circuitBreakRollback({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      reason: `安全终验未通过（Agent Loop 路径，${loopOutcomeNote(input.loop)}）`,
      publish: (type, payload) => publish(input, type, payload),
    })
    if (outcome.rolled_back) throw new CircuitBreakSettledError()
    publishBlockedDecision(input, 'security_repair', '检测到的安全隐患反复修不好，需要你来定夺')
    return { verdict: 'blocked', test_result: testResult }
  }

  // 终审（M4-B loop-aware）：judge 感知 loop 结果——completed 照常读盘判定；异常终止态让渡。
  // judge 级修复同样「只终验不重修」（repairInternalized 熔断 constraint_error 外部文档重修）。
  updateProject(input.project_id, { current_stage: 'judge_review' })
  publish(input, 'stage_changed', { stage: 'judge_review' })
  const judge = await runJudgeReview({
    request_id: input.request_id,
    session_id: input.session_id,
    project_id: input.project_id,
    loop: input.loop,
    repairInternalized: true,
    query: input.query,
    channel_id: input.channel_id,
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
 * iterating 态后复用 runMvpTask + runAgentLoopPostTesting 完整闭环（重新生成 → 终验 → 裁判 → ready）。
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
    // Agent Loop 唯一运行时：迭代产物一律走独立门禁（只终验不重修）
    await runAgentLoopPostTesting({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      preview_url: mvp.preview_url,
      loop: mvp.loop_result,
      query: input.query,
      channel_id: input.channel_id,
    })
    // T4-L3 蒸馏兜底·触发点②（每次迭代完成后，fire-and-forget）：默认关闭，
    // 失败在内部降级并落决策，绝不阻塞迭代收尾
    distillProjectMemorySafely({
      project_id: input.project_id,
      session_id: input.session_id,
      channel_id: input.channel_id,
      query: input.query,
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
    // 约束走门（T4-L1 修改门）：修改诉求里的约束语句确定性入库，并随归一化判定注入——
    // 与既有约束冲突的新功能（如约束「不含登录」时要求加登录）判 out_of_scope
    captureConstraints({
      project_id: input.project_id,
      session_id: input.session_id,
      constraints: extractConstraints(input.prompt),
      source: 'iteration_modification',
    })
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
      constraints: readProjectConstraints(input.project_id),
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

/**
 * 后台链路会话活跃刷新（缺陷④）：编程编排器的后台任务（草图/MVP/迭代/终验/让渡恢复）
 * 不经 runAgent，会话索引 agent-sessions.json 的 updated_at 停在最后一次交互消息，
 * 历史列表「按最近活跃倒序」失真（实测后台 MVP 跑完数小时 updated_at 仍停在旧时间）。
 * publish 是全部后台链路事件的必经点，在此刷新索引；同一会话 30s 节流一次，
 * 避免 loop 多轮工具事件把小索引文件写成热点。旁路观测，失败不得阻断事件发布。
 */
const SESSION_ACTIVITY_REFRESH_MS = 30_000
const sessionActivityLastRefreshAt = new Map<string, number>()

function touchSessionActivity(input: Pick<SketchTaskInput, 'session_id' | 'project_id'>): void {
  const now = Date.now()
  const last = sessionActivityLastRefreshAt.get(input.session_id) ?? 0
  if (now - last < SESSION_ACTIVITY_REFRESH_MS) return
  sessionActivityLastRefreshAt.set(input.session_id, now)
  try {
    recordSessionActivity(input.session_id, input.project_id)
  } catch {
    // 索引刷新为旁路观测，绝不阻断事件发布
  }
}

/** 测试 seam：清除会话活跃节流状态，保证用例间互不串扰。 */
export function resetSessionActivityThrottleForTests(): void {
  sessionActivityLastRefreshAt.clear()
}

function publish(input: Pick<SketchTaskInput, 'session_id' | 'project_id'>, type: AgentEvent['type'], payload: Record<string, unknown>): void {
  touchSessionActivity(input)
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
  // 嵌套的 runMvpTask / runAgentLoopPostTesting / runJudgeReview 走同一发布通道
  setProgrammingEventPublisher(eventPublisher)

  const project = findProject(input.project_id)
  const action = project.blocked_action
  // M4-A：项目由 Agent Loop 生成 → resume 走独立门禁（只终验不重修）；judge 需 loop 元数据。
  // loop 已结束时原始 AgentLoopResult 不在内存，用持久化的 via_agent_loop + agent_loop_status 重建
  // 最小元数据（turns/finalText/toolCalls 不再可用，judge 只消费 status 判断异常终止态）。
  // fallback 用异常终止态（审计 P2-3 fail-closed）：状态缺失时宁可让渡（repairable:false），
  // 不能默认 completed 绕过门禁。
  const loopMeta: AgentLoopJudgeMetadata | undefined = project.via_agent_loop
    ? { status: project.agent_loop_status ?? 'turn_limit', turns: 0, finalText: '', toolCalls: [] }
    : undefined

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
    // Agent Loop 唯一运行时：新生成直接走门禁函数（只终验不重修）
    await runAgentLoopPostTesting({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      preview_url: mvp.preview_url,
      loop: mvp.loop_result,
      query: input.query,
      channel_id: input.channel_id,
    })
    return
  }

  if (action === 'test_repair') {
    updateProject(input.project_id, { test_repair_count: 0 })
    const previewUrl = await ensureResumePreview(input)
    // loop 元数据仅在 project.via_agent_loop 时存在；存量旧项目缺省走普通终验（无修复）
    await runAgentLoopPostTesting({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      preview_url: previewUrl,
      loop: loopMeta,
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
      ...(loopMeta ? { loop: loopMeta, repairInternalized: true } : {}),
      query: input.query,
      channel_id: input.channel_id,
    })
    return
  }

  if (action === 'security_repair') {
    updateProject(input.project_id, { security_repair_count: 0 })
    const previewUrl = await ensureResumePreview(input)
    // 重新走完整测试 + 安全扫描终验（安全扫描已嵌入 runAgentLoopPostTesting 后半段）
    await runAgentLoopPostTesting({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      preview_url: previewUrl,
      loop: loopMeta,
      query: input.query,
      channel_id: input.channel_id,
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
