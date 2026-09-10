import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, AgentLoopJudgeMetadata, AgentSendMessageInput, Channel, ChannelModel, DocumentSyncResult, MessageContentBlock, Project, ProjectMode, Snapshot, SnapshotKind, TemplateType } from '../../shared/types'
import type { ThinkingLevel } from '../../shared/reasoning-profile'
import { getAgentSessionPath, getDocumentsDir } from '../../storage/config-paths'
import { appendSessionMessage } from '../session-tree'
import { emitAgentEvent } from '../agent-event-bus'
import { appendLoopLogDocument, loopLogEnabled, readLoopCheckpointDocument, readPrdBackplane, readUxContractSketch, renamePrdProject, syncDocuments, updateRequirementStatus, writeLoopCheckpointDocument, writeSecurityScanDocument, type LoopLogEntry, type LoopRepairAttemptRecord, writePlanDocument } from '../document-engine'
import { appendProjectLearning, renderLearningsSection } from '../learnings-log'
import { createSnapshot, runSandbox, trackAnalytics } from '../platform-services'
import { renderPackageJson, renderStaticServer, renderSkeletonToProject, scaffoldEnabled } from '../project-scaffold'
import { runBuildGate, type BuildGateResult } from './build-gate'
import { runArtifactUiGate, uiGateEnabled, uiProbeNotes, type ArtifactUiGateResult } from './artifact-ui-gate'
import { getCachedStaticEvidence, setCachedStaticEvidence } from './evidence-cache'
import { runVisionAuditGate } from './vision-audit-gate'
import { buildRepairTasks, resolveRepairBudget, runRepairLoop, repairScopeEnabled, type RepairCheckpointContext, type RepairTask } from './repair-loop'
import { recordFailureCards } from '../experience/error-card'
import { generateLoopPlan, planLegEnabled, renderPlanInjection, renderPlanMarkdown, type LoopPlan } from './loop-planner'
import { addScopeExclusion, findProject, readLastSketchRequirements, recordSketchGenerated, updateProject } from '../project-service'
import { appendProjectMapToSystem, loadProjectMapBlock } from '../project-map'
import { resolveChannelEnv } from '../runtime-fallback'
import { loadSkeletonTemplate, type ProjectSkeleton } from '../project-templates'
import { buildLoopInjection, buildSkeletonMapInjection } from '../template-injection'
import { buildModuleMapInjection, loadOfficialModules, modulesEnabled, renderOfficialModulesToProject } from '../module-library'
import { listRefPatternModules, refLibraryEnabled } from '../experience/ref-source'
import { backplaneInterfaceSpec, buildIterationRoundAnchor, buildRepairRoundAnchor, focusAnchorEnabled, renderBackplaneAnchor, renderRoundAnchorBlock, roundAnchorEnabled } from '../model/prd-backplane'
import { renderRulesSection, rulesRegistryEnabled } from '../rules-registry'
import { renderExpressionSection } from '../prompt-expression'
import { captureConstraints, extractConstraints, readProjectConstraints } from '../constraint-extractor'
import { distillProjectMemorySafely } from '../memory-distiller'
import { generateSketch, backplaneKeyTasks, requirementAssertions, requirementPriority, requirementStatusLabel, requirementStory, type GenerateSketchResult, type PrdBackplane, type SketchRequirement } from '../sketch-engine'
import { generateSketchLlm, SketchLlmError, type SketchAttemptDetail } from '../sketch-engine-llm'
import { applyNormalization, normalizeRequirementUpdate, recordRequirementNormalization } from '../requirement-normalizer'
import { readTestReport, runGwtScenarios, writeTestReport, type GwtFailureSummary, type GwtTestResult } from '../gwt-service'
import { renderSecurityScanMarkdown, runSecurityScan } from '../security-scan'
import { runJudge, readArtifactText, type JudgeVerdict } from '../judge-engine'
import { runSemanticJudgeReview } from '../judge-semantic'
import { loadPromptOverride } from '../prompt-config'
import { assertToolAllowed } from '../permission-service'
import { recordDecision } from '../decision-log'
import { CircuitBreakSettledError, circuitBreakRollback, isCircuitBreakSettled } from '../recovery-service'
import { readPrimaryIntent, recordSessionActivity } from '../session-service'
import { runAgentLoop, loopApiToolEnabled, loopCheckpointEnabled, preflightEnabled, narrationEventsEnabled, type AgentLoopResult, type LoopCheckpointSnapshot } from '../agent-loop'
import { deliveryStatusEnabled, recordDeliveryStatus, buildDeliveryPresentation, renderCircuitFailureNote, renderDeliveryBody, featureIdFromScenario } from './delivery-status'
import { isDegenerateText } from './output-integrity'
import { checkApiContract } from './api-contract'
import { buildAgentTools } from '../agent-tools'
import { disposeParentDelegationState, registerParentLoopContext, setChildToolsBuilder } from '../agent-collaboration'
import { categoryTemperature, resolveGenerationMaxTokens } from '../model-resolution'
import type { SDKQuery, ToolDefinition } from '../orchestrator'
import { resolvePrdBackplane } from '../guide/pipeline'

// R3 迁移过渡：resolvePrdBackplane 已迁 guide/pipeline（向导群·PRD 收敛管线），
// 此处 re-export 保持既有调用方/测试 import 路径零改动（R4 群目录归位后统一收口）。
export { resolvePrdBackplane }

/** web_research 每 loop 调用预算（闭环 PR5）：调研委派限 4 次，防无节制外呼。 */
const WEB_RESEARCH_BUDGET = 4

/**
 * 无人值守豁免（A2-12）：自动化管线内部 service 直连时显式传入 allow-all——
 * warning 工具自动放行（不弹 UI）、dangerous 拒绝。禁止隐式绕过，豁免必须显式传入。
 */
const AUTOMATED_PERMISSION_MODE = 'allow-all' as const

/** 渠道未配置 max_tokens 时的默认上限（对齐全渠道 640000，防思考型渠道零正文）。 */
const DEFAULT_MAX_TOKENS = 640000

/** 项目已生成完成（ready）的统一话术：完成通知与 ready 护栏共用，避免两套语义相近的固定文案。
 * 完成语义升级（2026-09-06 用户拍板「终点不是 MVP」）：就绪话术带走向完整产物的出口提示。 */
export const READY_COMPLETION_COPY =
  'MVP 已经生成好了，可以点右侧预览区的按键试用。想走向完整产物——数据存到服务端、加功能、接真实 AI、导出部署——直接说就行。'

/** 迭代/生成失败时如实告知用户的话术：不假装成功，也不把失败藏成「已经生成好了」。 */
export const GENERATION_FAILED_COPY =
  '这次修改没有成功（模型生成失败了），你可以再试一次，或者换个说法描述你的需求。'

type ProgrammingEventPublisher = (event: AgentEvent) => void

/** 统一的取消边界：所有顶层阶段在发生副作用前调用，保证 stop 后不再切状态/起新任务。 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('AGENT_CANCELLED')
}

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

/** Phase 7 U2 H5/H6（2026-09-10，E1 咨询）：决策卡条件化开关——BLOMA_DECISION_CONDITIONAL
 * 缺省 off=字节级现状（固定三选项）。on 时让渡卡按失败原因条件化动作与推荐主按钮，
 * accept 语义改「先使用已可用的部分」（不改 delivery_status、问题清单不清除持续可见）。
 * H5（卡文案与推荐）与 H6（先用语义）同卡一体改造其用一开关，拆开会出现
 * 「条件化卡+旧接受现状文案」的怪态（偏差已登记开关矩阵 §17）。 */
export function decisionConditionalEnabled(): boolean {
  const raw = (process.env.BLOMA_DECISION_CONDITIONAL ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

/** 让渡卡条件化上下文（H5）：失败原因与可用部分判据（复用 delivery-status 归属口径）。 */
export interface BlockedDecisionContext {
  /** 失败场景清单（test_repair 路径；security/judge 可缺省） */
  failures?: Array<{ scenario: string; reason?: string }>
  /** 必交功能项集（主按钮推荐判据：有干净必交任务=存在可隔离可用部分） */
  mustDeliverFeatureIds?: string[]
  /** 失败类别（话术分档） */
  reason: 'test' | 'security' | 'judge'
}

/**
 * 条件化让渡卡选项（H5）：按失败原因生成动作体系——①修好「X」后再交付（有明确
 * 下一步）②先使用已可用的部分（存在可隔离可用部分；H6 改名，不改 delivery_status
 * 不清问题清单）③补充说明/调整需求（缺的是用户信息，不送回整个向导）。主按钮
 * 按失败原因推荐+一句理由（推荐≠自动执行）；回传 id 仍为 continue/accept/explain
 * 三值（resume 闭环零改动）。export：供单测直测（条件化承重）。 */
export function buildBlockedQuestions(context: BlockedDecisionContext | undefined): { id: BlockedDecision; label: string; description: string }[] {
  if (!context || !decisionConditionalEnabled()) return BLOCKED_DECISION_QUESTIONS
  const failedIds = new Set(
    (context.failures ?? []).map((f) => featureIdFromScenario(f.scenario)).filter((id): id is string => Boolean(id)),
  )
  const mustSet = new Set(context.mustDeliverFeatureIds ?? [])
  const hasUsablePart = [...mustSet].some((id) => !failedIds.has(id))
  const topFailedFeature = (context.failures ?? []).find((f) => {
    const id = featureIdFromScenario(f.scenario)
    return id && mustSet.has(id)
  })
  const topLabel = topFailedFeature
    ? (featureIdFromScenario(topFailedFeature.scenario) ?? '')
    : ''
  const questions: { id: BlockedDecision; label: string; description: string }[] = []
  if (context.reason === 'test') {
    questions.push(
      topLabel
        ? { id: 'continue', label: `先修好${topLabel}再交付`, description: '推荐：修复目标明确，优先再修一次' }
        : { id: 'continue', label: '继续修复', description: '推荐：再试一次修复' },
    )
    questions.push(
      hasUsablePart
        ? { id: 'accept', label: '先使用已可用的部分', description: '未通过的部分会如实登记（不算完成），随时可以再修' }
        : { id: 'accept', label: '先保留这一版', description: '核心任务未通过，保留仅供查看，不建议当作可用版本' },
    )
  } else if (context.reason === 'security') {
    questions.push(
      { id: 'continue', label: '继续修复安全问题', description: '推荐：安全风险修好再用更稳妥' },
      { id: 'accept', label: '先保留这一版（含安全风险）', description: '风险仍登记在案；不建议对外使用' },
    )
  } else {
    // judge_return：方向性问题优先听用户说（不盲推重修）
    questions.push(
      { id: 'explain', label: '告诉我怎么调整', description: '推荐：审查意见需要你确认方向' },
      { id: 'continue', label: '再试一次', description: '按当前要求重试' },
      { id: 'accept', label: '先使用已可用的部分', description: '接受当前版本，问题保持登记' },
    )
  }
  // explain 兜底追加（test/security 分支缺时补齐第三出口）
  if (!questions.some((q) => q.id === 'explain')) {
    questions.push({ id: 'explain', label: '补充说明', description: '告诉向导哪里不对' })
  }
  return questions
}

export interface SketchTaskInput {
  request_id: string
  session_id: string
  project_id: string
  mode: ProjectMode
  prompt: string
  requirements?: SketchRequirement[]
  channel_id?: string
  query?: SDKQuery
  /** 停止信号：草图生成、沙箱与快照间均不得在取消后继续推进。 */
  signal?: AbortSignal
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
  /** P3 迭代分级锚定：本轮聚焦的功能项 id（normalizer reviseId / append 新项 id）；
 *  仅迭代路径传入，生成路径缺省=全量锚定现状。受 BLOMA_FOCUS_ANCHOR 开关门控。 */
  focusRequirementIds?: string[]
}

export interface MvpTaskResult {
  preview_url: string
  snapshot: Snapshot
  run_command: string
  /** 本次 MVP 由 Agent Loop 路径生成（3b：调用方据此把外部修复循环切为「只终验不重修」） */
  via_agent_loop?: boolean
  /** Agent Loop 结果元数据（M4-B：runAgentLoopPostTesting 透传给 judge loop-aware；仅 loop 路径存在） */
  loop_result?: AgentLoopResult
  /** 构建门禁结果（P2 失败回流 PR-C）：调用方透传终验组装器，failed 追加 build 修复任务 */
  build_gate?: BuildGateResult
}

let programmingEventPublisher: ProgrammingEventPublisher = () => undefined

/**
 * 前台运行探针（让渡终态补发用）：由 ipc.ts 接线注入 orchestrator.hasForegroundRun。
 * 缺省 () => false = 视为无前台运行（单测环境），让渡路径总是补发终态——宁可多发一个
 * 幂等 completed，不可再让 UI 永久卡「生成中」。
 */
let foregroundRunChecker: (sessionId: string) => boolean = () => false
export function setForegroundRunChecker(checker: (sessionId: string) => boolean): void {
  foregroundRunChecker = checker
}

export function setProgrammingEventPublisher(publisher: ProgrammingEventPublisher): void {
  // P2-A 事件总线（2026-09-08）：接线时套一层 emit——事件先广播到 onAgentEvent 订阅面
  // 再转发原发布目标；原发布链路零改动（行为不变，总线只读旁路）
  programmingEventPublisher = (event) => {
    emitAgentEvent(event)
    publisher(event)
  }
}

export async function runSketchTask(input: SketchTaskInput): Promise<SketchTaskResult> {
  throwIfAborted(input.signal)
  publish(input, 'stage_changed', { stage: 'generating_sketch' })
  updateProject(input.project_id, { current_stage: 'generating_sketch' })

  const requirements = input.requirements?.length
    ? input.requirements
    : [{ id: 'F-001', description: input.prompt }]
  const { result: sketch, source, fallbackReason, llmErrorCode, llmAttempts } = await resolveSketch(input, requirements)
  throwIfAborted(input.signal)
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
    appendSessionMessage(input.session_id, {
      role: 'assistant',
      content: [{ type: 'text', text: copy }],
      timestamp: Date.now(),
    })
    publish(input, 'message_delta', { text: copy })
  }
  recordSketchGenerated(input.project_id, requirements)
  await allowAutomatedTool('run_project', { project_id: input.project_id }, input.session_id, input.project_id)
  const sandbox = await runSandbox({ request_id: input.request_id, project_id: input.project_id })
  throwIfAborted(input.signal)
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
      // 注入点⑤：模式与类型透传（pages/布局惯例切片）
      mode: input.mode,
      template_type: findProject(input.project_id).template_type,
      // 用户约束随草图注入（T4-L1）：「不含登录」→ 草图不画登录界面
      constraints: readProjectConstraints(input.project_id),
      query: input.query,
      env,
      sessionId: input.session_id,
      maxTokens: channel.max_tokens ?? DEFAULT_MAX_TOKENS,
      signal: input.signal,
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
  // QW#3（ux-first-run-0basics I2）：去「渠道」黑话 + 给动词出口（0 基础用户不知道「渠道」是什么）
  return '（草图说明：AI 还没连上，先用简化模板给你看个方向。去「设置」里连接 AI 模型后，回复「重新生成」即可。）'
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
    // A10（2026-09-03）：命名同步回填 prd.json，消除 PRD/loop 锚文本里的「未命名项目」；
    // prd.json 尚未落盘（命名先于首写）时静默跳过——后续 syncDocuments 会带上新名重建
    renamePrdProject(input.project_id, name)
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
  throwIfAborted(input.signal)
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
  throwIfAborted(input.signal)
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
  detail: { fileCount: number; snapshotSummary: string; readySummary: string; previewUrl: string; viaAgentLoop?: boolean; loopResult?: AgentLoopResult; buildGate?: BuildGateResult },
  snapshotKind: SnapshotKind = 'mvp',
): Promise<MvpTaskResult> {
  const runCommand = 'npm start'
  await allowAutomatedTool('run_project', { project_id: input.project_id, command: runCommand }, input.session_id, input.project_id)
  await allowAutomatedTool('create_snapshot', { project_id: input.project_id, kind: snapshotKind }, input.session_id, input.project_id)
  const snapshot = await createSnapshot({
    request_id: input.request_id,
    project_id: input.project_id,
    kind: snapshotKind,
    summary: detail.snapshotSummary,
    include_documents: true,
    health_status: 'healthy',
  })

  // 迭代快照不记 mvp_delivered（那是首次交付 MVP 的埋点；点选纠错的 point_correction 已在 ipc.ts 记录）
  if (snapshotKind === 'mvp') {
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
  }

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
    ...(detail.buildGate ? { build_gate: detail.buildGate } : {}),
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
/** maxTurns 缺省（缺省=现状，零行为变化）；可 env 覆盖（闭环 PR8）。 */
const AGENT_LOOP_MAX_TURNS_DEFAULTS: Record<ProjectMode, number> = { quick: 24, longterm: 40 }

/**
 * maxTurns 解析（闭环 PR8，随感 16/41）：BLOMA_LOOP_MAX_TURNS_QUICK / _LONGTERM
 * 可覆盖（标定脚本 npm run analyze:loop 出建议后人工回填）；非法值（非数字/≤0）
 * 回退缺省。每次调用读取（便于测试与运行时调整）。缺省 = 改造前常量，零行为变化。
 */
export function resolveAgentLoopMaxTurns(mode: ProjectMode): number {
  const fallback = AGENT_LOOP_MAX_TURNS_DEFAULTS[mode]
  const raw = mode === 'quick' ? process.env.BLOMA_LOOP_MAX_TURNS_QUICK : process.env.BLOMA_LOOP_MAX_TURNS_LONGTERM
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  // 先取整再校验（审查 P2-1）：'0.5' 不得 floor 成 0 让 loop 零轮直接 turn_limit
  const floored = Math.floor(parsed)
  return Number.isFinite(parsed) && floored > 0 ? floored : fallback
}

/** 子 agent 独立轮次上限（比主 loop 小，控制委派 token 成本；按埋点标定）。 */
const DELEGATION_MAX_TURNS = 12

/**
 * loop 思考档位解析（2026-09-03，上游 Proma 思考链分离方案落地）：BLOMA_LOOP_THINKING
 * 可覆盖（off/low/high/max）；缺省 low——推理写进思考通道不进旁白正文（线上案例：
 * flash 模型把推理全部写进正文，单轮 28k 字符英文独白）。DeepSeek v4/GLM 系经
 * output_config.effort 生效（不吞 max_tokens）；不支持思考的模型/omit 渠道由
 * buildThinkingFragment 自动落回现状，400 兼容降级兑底（orchestrator 既有链路）。
 * 每次调用读取（与 maxTurns 同风格，便于测试与运行时调整）。
 */
export function resolveLoopThinkingLevel(): ThinkingLevel {
  const raw = (process.env.BLOMA_LOOP_THINKING ?? '').trim().toLowerCase()
  if (raw === 'off' || raw === 'low' || raw === 'high' || raw === 'max') return raw
  return 'low'
}

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

  const probed = await probeToolSupport(input.query, env, input.session_id, input.signal, channel?.provider_type)
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
  providerType?: string,
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
      // omit 推广（审查 P2-①）：探测请求同样透传 providerType，避免 omit 渠道 400 导致
      // 探测无结论 → MVP 生成整体失败（而非仅多一次往返）
      providerType,
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
/**
 * PR-1 骨架先行（2026-09-03）：loop 启动前把骨架包确定性渲染到项目根（无 LLM）。
 * 成功 → 决策日志 skeleton_rendered + 返回骨架地图（进注入⑥）与骨架对象（供 PR-2
 * 构建门禁取 build 规约）；失败/无骨架/开关关 → 两者均 null，行为=现状从零写
 * （fail-open：骨架是增强不是依赖，绝不阻断 MVP 生成）。
 *
 * 官方模块库（2026-09-04）：函数内随后准备模块库（与骨架相互独立——无骨架类型也能
 * 用模块），返回 moduleMap 供调用方与骨架地图合并注入（事实与注入同源）。
 */
function prepareSkeletonBeforeLoop(
  input: MvpTaskInput,
  backplane: PrdBackplane,
  project: Project,
): {
  map: string | null
  skeleton: ProjectSkeleton | null
  rendered?: { written: string[]; skipped: string[] }
  moduleMap: string | null
} {
  const templateType = backplane.template_meta?.type ?? 'personal_tool'

  // === 骨架包（PR-1） ===
  let map: string | null = null
  let skeleton: ProjectSkeleton | null = null
  let rendered: { written: string[]; skipped: string[] } | undefined
  if (scaffoldEnabled()) {
    try {
      skeleton = loadSkeletonTemplate(templateType, { project_id: input.project_id, session_id: input.session_id })
    } catch {
      skeleton = null
    }
    if (skeleton) {
      try {
        rendered = renderSkeletonToProject(skeleton, project.root_path)
        try {
          recordDecision({
            project_id: input.project_id,
            session_id: input.session_id,
            entry: {
              type: 'skeleton_rendered',
              title: '工程骨架先行渲染',
              why: `loop 前按 ${templateType} 模板 v${skeleton.version} 渲染骨架（源=${skeleton.source}），编程 Agent 在骨架上填充实现；已存在文件跳过不覆盖`,
              detail: {
                template_type: templateType,
                version: skeleton.version,
                source: skeleton.source,
                written: rendered.written,
                skipped: rendered.skipped,
              },
            },
          })
        } catch {
          // 决策日志失败不影响骨架生效
        }
        map = buildSkeletonMapInjection(skeleton, rendered)
      } catch (err) {
        try {
          recordDecision({
            project_id: input.project_id,
            session_id: input.session_id,
            entry: {
              type: 'skeleton_render_failed',
              title: '骨架渲染失败，回退从零写',
              why: '骨架渲染抛出异常（fs 故障等）——回退无骨架现状，不阻断 MVP 生成',
              detail: { template_type: templateType, error: err instanceof Error ? err.message : String(err) },
            },
          })
        } catch {
          // 决策日志失败静默
        }
        skeleton = null
        rendered = undefined
        map = null
      }
    }
  }

  // === 官方模块库（P1 模块侧） ===
  const moduleMap = prepareModuleLibrary(input, templateType, project)

  return { map, skeleton, rendered, moduleMap }
}

/**
 * 官方模块库准备（2026-09-04）：loop 启动前把适用当前产物类型的官方模块确定性物化到
 * 项目 `src/official-modules/`（无 LLM，幂等）。成功 → 决策日志 module_rendered + 返回
 * 模块地图（进注入⑥）；开关关/无模块/渲染异常 → null（fail-open，绝不阻断 MVP 生成）。
 */
function prepareModuleLibrary(input: MvpTaskInput, templateType: TemplateType, project: Project): string | null {
  // G4 双内容源：官方预置（BLOMA_MODULES）+ 经验库 ref（BLOMA_REF_LIBRARY 缺省 off）；
  // 两开关正交，均 off = 现状字节级 null；ref 经同一渲染/地图管道消费（C-1）。
  if (!modulesEnabled() && !refLibraryEnabled()) return null
  try {
    const { modules: official, rejected } = modulesEnabled() ? loadOfficialModules(templateType) : { modules: [], rejected: [] }
    const refs = refLibraryEnabled() ? listRefPatternModules(templateType) : []
    const modules = [...official, ...refs]
    for (const item of rejected) {
      try {
        recordDecision({
          project_id: input.project_id,
          session_id: input.session_id,
          entry: {
            type: 'module_rejected',
            title: '官方模块校验失败，跳过',
            why: `模块 ${item.slug} 校验失败跳过（不阻断生成）：${item.reason}`,
            detail: { template_type: templateType, slug: item.slug, reason: item.reason },
          },
        })
      } catch {
        // 决策日志失败静默
      }
    }
    if (modules.length === 0) return null
    const rendered = renderOfficialModulesToProject(modules, project.root_path)
    try {
      recordDecision({
        project_id: input.project_id,
        session_id: input.session_id,
        entry: {
          type: 'module_rendered',
          title: '官方模块库渲染',
          why: `loop 前按 ${templateType} 类型渲染 ${modules.length} 个官方模块到 src/official-modules/（源=builtin）；已存在文件跳过不覆盖`,
          detail: {
            template_type: templateType,
            count: modules.length,
            slugs: modules.map((mod) => mod.slug),
            written: rendered.written,
            skipped: rendered.skipped,
          },
        },
      })
    } catch {
      // 决策日志失败不影响模块生效
    }
    return buildModuleMapInjection(modules, rendered)
  } catch (err) {
    try {
      recordDecision({
        project_id: input.project_id,
        session_id: input.session_id,
        entry: {
          type: 'module_render_failed',
          title: '官方模块库渲染失败，回退无模块',
          why: '模块库渲染抛出异常——回退无模块现状，不阻断 MVP 生成',
          detail: { template_type: templateType, error: err instanceof Error ? err.message : String(err) },
        },
      })
    } catch {
      // 决策日志失败静默
    }
    return null
  }
}

/** 资产地图合并：骨架地图 + 模块地图（两段事实描述，plan 腿与 loop system 共用）。 */
function mergeAssetMap(skeletonMap: string | null, moduleMap: string | null): string | null {
  return [skeletonMap, moduleMap].filter(Boolean).join('\n\n') || null
}

/** P3 分级锚定解析：focusRequirementIds 非空且开关开（BLOMA_FOCUS_ANCHOR 缺省
 * longterm=on / quick=off，D7 连锁）才生效；否则 undefined=全量锚定现状。 */
function resolveFocusAnchor(input: MvpTaskInput): string[] | undefined {
  const ids = input.focusRequirementIds
  if (!ids || ids.length === 0) return undefined
  if (!focusAnchorEnabled(input.mode)) return undefined
  return ids
}

/** loop-log 追加（BLOMA_LOOP_LOG 开关 + 失败静默：诊断增强不是依赖，绝不阻断主链路）。 */
function appendLoopLogSafely(projectId: string, entry: LoopLogEntry): void {
  if (!loopLogEnabled()) return
  try {
    appendLoopLogDocument(projectId, entry)
  } catch {
    // 写盘失败静默
  }
}

/** W2-E2/E3：检查点 runtime 投影持久化（BLOMA_LOOP_CHECKPOINT off=零写盘；失败静默不阻断）。 */
function persistCheckpointRuntime(projectId: string, snapshot: LoopCheckpointSnapshot): void {
  if (!loopCheckpointEnabled()) return
  try {
    const existing = readLoopCheckpointDocument(projectId)
    writeLoopCheckpointDocument(projectId, {
      version: 1,
      project_id: projectId,
      updated_at: new Date().toISOString(),
      runtime: snapshot,
      repair_attempts: existing?.repair_attempts ?? [],
    })
  } catch {
    // 写盘失败静默（检查点是增强不是依赖）
  }
}

/** W4-F1：修复证据包上下文（读检查点账本：候选指纹+此前修复尝试）；连续 ≥2 轮零修复 → 升级诊断态。 */
function buildRepairCheckpointContext(projectId: string): RepairCheckpointContext {
  const doc = readLoopCheckpointDocument(projectId)
  const attempts = doc?.repair_attempts ?? []
  const recent = attempts.slice(-2)
  const escalation =
    recent.length === 2 && recent.every((a) => a.outcome.resolved.length === 0 && !a.outcome.converged)
      ? ('diagnosis' as const)
      : undefined
  return {
    ...(doc?.runtime?.validation?.candidate_fingerprint
      ? { candidate_fingerprint: doc.runtime.validation.candidate_fingerprint }
      : {}),
    attempts,
    ...(escalation ? { escalation } : {}),
  }
}

/** W4-F2：从修复任务派生本轮修改授权——只认文件型 location（.js/.html/.css）；
 *  场景锚点不当白名单（D4 裁决），派生不出即不设边界（fail-open）。 */
function deriveAuthorizedWritePaths(tasks: RepairTask[]): string[] | undefined {
  const paths = [...new Set(tasks.map((task) => task.location ?? '').filter((loc) => /\.(js|html|css)$/i.test(loc)))]
  return paths.length > 0 ? paths : undefined
}

/** W2-F1：修复尝试记录追加进检查点账本（保留 runtime 投影不动）。 */
function appendRepairAttemptRecord(projectId: string, record: LoopRepairAttemptRecord): void {
  try {
    const existing = readLoopCheckpointDocument(projectId)
    writeLoopCheckpointDocument(projectId, {
      version: 1,
      project_id: projectId,
      updated_at: new Date().toISOString(),
      ...(existing?.runtime ? { runtime: existing.runtime } : {}),
      repair_attempts: [...(existing?.repair_attempts ?? []), record].slice(-20),
    })
  } catch {
    // 写盘失败静默
  }
}

/**
 * P3 任务级契约 · plan 腿（2026-09-04）：loop 前单轮技术合同。
 *
 * - 开关 BLOMA_PLAN_LEG（缺省 quick=off / longterm=on，D7）；关闭/quick 缺省直接短路（零延迟）；
 * - 任何失败 fail-open：generateLoopPlan 返回 null → plan_fallback 决策日志 + 现状注入
 *   （注入字节级=现状）；plan.md 落盘/决策日志失败均不阻断（增强不是依赖）；
 * - query/env 直取主 loop channel context（陷阱 23 口径：勿二次 resolve，随取随用）；
 * - 修复轮不接 plan 腿（非目标：修复卡即 mini-plan，叠加是双重合同）。
 */
async function tryGenerateLoopPlanLeg(
  input: MvpTaskInput,
  loop: AgentLoopChannelContext,
  backplane: PrdBackplane,
  skeletonMap: string | null,
  focus?: string[],
): Promise<LoopPlan | null> {
  if (!planLegEnabled(input.mode)) return null
  const plan = await generateLoopPlan({
    mode: input.mode,
    backplane,
    skeletonMap,
    query: input.query!,
    env: loop.env,
    sessionId: input.session_id,
    ...(focus && focus.length > 0 ? { focusRequirementIds: focus } : {}),
    ...(loop.channel.provider_type !== undefined ? { providerType: loop.channel.provider_type } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (!plan) {
    try {
      recordDecision({
        project_id: input.project_id,
        session_id: input.session_id,
        entry: {
          type: 'plan_fallback',
          title: '技术合同未生成，回退无合同现状',
          why: 'plan 腿单轮调用未产出可解析计划（渠道/LLM/解析/校验失败）——fail-open 回退现状注入，不阻断 MVP 生成',
        },
      })
    } catch {
      // 决策日志失败不阻断主链路
    }
    return null
  }
  // plan.md 落盘（人读/快照回看；D1：loop 消费内存对象，双消费同一对象）
  try {
    writePlanDocument(input.project_id, renderPlanMarkdown(plan))
  } catch {
    // 落盘失败不阻断注入（合同已在内存，注入照常）
  }
  try {
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'plan_generated',
        title: '技术合同已生成（plan 腿）',
        why: `loop 前单轮规划产出参考合同：${plan.filesToTouch.length} 个目标文件、${plan.reuse.length} 个复用点、${plan.verification.length} 条验证口径；注入 system 供参考（参考合同：偏离需在旁白说明）`,
        detail: {
          files: plan.filesToTouch.map((file) => file.path),
          reuse: plan.reuse.map((entry) => entry.from),
          risks: plan.risks,
        },
      },
    })
  } catch {
    // 静默
  }
  return plan
}

async function runMvpViaAgentLoop(input: MvpTaskInput, loop: AgentLoopChannelContext, snapshotKind: SnapshotKind = 'mvp'): Promise<MvpTaskResult> {
  const project = findProject(input.project_id)
  const backplane = readPrdBackplane(input.project_id)
  const editFormat = loop.model?.edit_format ?? 'diff'
  const startedAt = Date.now()
  // PR-1 骨架先行 + 官方模块库：渲染成功后骨架地图/模块地图随 system prompt 常驻（事实与注入同源）
  const { map: skeletonMap, skeleton, rendered, moduleMap } = prepareSkeletonBeforeLoop(input, backplane, project)
  // P3 分级锚定：focus 生效时（迭代路径透传 + BLOMA_FOCUS_ANCHOR 开）背板/骨架地图
  // 裁细节不减锚；生成路径/开关关 → undefined=全量锚定现状（字节级等价）
  const focus = resolveFocusAnchor(input)
  // P3 plan 腿：loop 前单轮技术合同（D2 参考合同：偏离旁白说明，不硬拦截）；
  // 失败/关闭 fail-open 回退现状（planInjection 为 null 时拼接函数字节级=现状）。
  // plan 腿输入用全量资产地图（骨架+模块，规划需要全貌），分级只作用于 loop system 注入
  const loopPlan = await tryGenerateLoopPlanLeg(input, loop, backplane, mergeAssetMap(skeletonMap, moduleMap), focus)
  const planInjection = loopPlan ? renderPlanInjection(loopPlan) : null
  // 骨架地图分级（注入侧，零改 prepare 语义）：plan 存在且 focus 生效时，非目标文件
  // 降为存在性行（路径锚不丢，D3）；无 plan / 无 focus → 全量地图现状。模块地图不分级。
  const effectiveSkeletonMap =
    skeletonMap && focus && loopPlan && skeleton && rendered
      ? buildSkeletonMapInjection(skeleton, rendered, loopPlan.filesToTouch.map((file) => file.path))
      : skeletonMap
  const buildSystemWithPlan = (fmt: 'diff' | 'whole'): string => {
    const base = buildLoopSystemWithOverride(backplane, fmt, input.project_id, effectiveSkeletonMap, focus, moduleMap)
    // Phase 3 B3：迭代轮本轮锚（聚焦路径才有；开关 off=零注入字节级现状）
    const roundAnchorBlock =
      focus && focus.length > 0 && roundAnchorEnabled()
        ? `\n\n${renderRoundAnchorBlock(buildIterationRoundAnchor(backplane, focus))}`
        : ''
    return planInjection ? `${base}${roundAnchorBlock}\n\n${planInjection}` : `${base}${roundAnchorBlock}`
  }
  // 委派协作（嫁接方案 §4.1）：注册父 loop 上下文供 delegate_agent 构建子循环；子工具集按 role 裁剪
  setChildToolsBuilder((projectId, role, editFormat) => buildAgentTools({ projectId, role, editFormat }))
  registerParentLoopContext(input.session_id, {
    query: input.query!,
    env: loop.env,
    maxTokens: resolveGenerationMaxTokens(loop.channel),
    maxTurns: resolveAgentLoopMaxTurns(input.mode),
    delegationMaxTurns: DELEGATION_MAX_TURNS,
    permissionMode: AUTOMATED_PERMISSION_MODE,
    temperature: categoryTemperature('mvp'),
    system: buildSystemWithPlan(editFormat),
    editFormat,
    providerType: loop.channel.provider_type,
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
    // W1-E1（咨询 D3）：子 loop 压缩观测同接入 analytics（与 onChildTurn 同模式）
    onChildCompaction: (info, child) => {
      trackAnalytics({
        request_id: child.requestId,
        event: {
          event_type: 'agent_loop_compact',
          project_id: input.project_id,
          session_id: child.sessionId,
          payload: { ...info, via: 'delegation', role: child.role },
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
      why: `BLOMA_AGENT_LOOP=1 且渠道 ${loop.channel.name}/${loop.env.ANTHROPIC_MODEL} 支持 tool use，MVP 走 agentic loop 生成（maxTurns=${resolveAgentLoopMaxTurns(input.mode)}，edit_format=${editFormat}）`,
      detail: {
        repair_budget_mapping: 'loop 内「GWT 失败后的 edit_file/write_file」预算 3 次，同构旧管道 test_repair_count ≤ 3',
        max_turns: resolveAgentLoopMaxTurns(input.mode),
        edit_format: editFormat,
      },
    },
  })

  let result: AgentLoopResult
  // P3 loop-log：会话头先行（mode/maxTurns/plan 摘要行——B 依赖 A 的合同存在性）；
  // 开关关/写盘失败均静默（诊断增强不是依赖）
  appendLoopLogSafely(input.project_id, {
    kind: 'session_start',
    mode: input.mode,
    maxTurns: resolveAgentLoopMaxTurns(input.mode),
    planSummary: loopPlan
      ? `${loopPlan.filesToTouch.length} 个目标文件：${loopPlan.filesToTouch.map((file) => file.path).join('、')}`
      : null,
    label: snapshotKind === 'iteration' ? '迭代重生成' : 'MVP 生成',
  })
  // 异常终态的计数量口径：onTurn 已写入盘的轮次/工具数（崩溃时 loop-log 本身即证据）
  let loggedTurns = 0
  let loggedToolCalls = 0
  try {
    result = await runAgentLoop({
    system: buildSystemWithPlan(editFormat),
    task: buildAgentLoopTask(backplane, input.mode),
    // toolBudget 首个生产接线（闭环 PR5）：web_research 每次都 fork 调研子代理，
    // 限 4 次防长 loop 无节制外呼；超限走既有 budgetExhausted 软着陆
    toolBudget: { web_research: WEB_RESEARCH_BUDGET },
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
    maxTokens: resolveGenerationMaxTokens(loop.channel),
    maxTurns: resolveAgentLoopMaxTurns(input.mode),
    permissionMode: AUTOMATED_PERMISSION_MODE,
    temperature: categoryTemperature('mvp'),
    providerType: loop.channel.provider_type,
    thinkingLevel: resolveLoopThinkingLevel(),
    signal: input.signal ?? new AbortController().signal,
    publish: (type, payload) => publish(input, type, payload),
    onTurn: (info) => {
      loggedTurns = Math.max(loggedTurns, info.turn)
      loggedToolCalls += info.toolCalls.length
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
      // P3 loop-log：同一回调实时 append（对齐磁盘证据哲学：取消/崩溃后过程证据已在盘上）；
      // agent_loop_turn 埋点 payload 结构不变（硬约束 8，path 只进 loop-log）
      appendLoopLogSafely(input.project_id, {
        kind: 'turn',
        turn: info.turn,
        toolCalls: info.toolCalls.map((call) => ({ name: call.name, ...(call.path ? { path: call.path } : {}) })),
        ...(info.inputTokens !== undefined ? { inputTokens: info.inputTokens } : {}),
        ...(info.outputTokens !== undefined ? { outputTokens: info.outputTokens } : {}),
      })
    },
    // W1-E1（咨询 D3，2026-09-09）：竹节压缩观测埋点（压缩发生或首次跳过；纯埋点零行为变更）
    onCompaction: (info) => {
      trackAnalytics({
        request_id: input.request_id,
        event: {
          event_type: 'agent_loop_compact',
          project_id: input.project_id,
          session_id: input.session_id,
          payload: { ...info, via: 'mvp' },
          privacy_level: 'research_safe',
        },
      })
    },
    // W2-E2/E3（咨询 D3/D4）：检查点 runtime 投影持久化（事件驱动：steer/验证工具/压缩/终态）
    onCheckpoint: (snapshot) => persistCheckpointRuntime(input.project_id, snapshot),
  })
  } catch (loopError) {
    // P3 loop-log：异常终态如实写终态节（硬约束 7：cancelled/error 也要终态节）后原样上抛
    appendLoopLogSafely(input.project_id, {
      kind: 'final',
      status: 'error',
      turns: loggedTurns,
      toolCalls: loggedToolCalls,
    })
    throw loopError
  } finally {
    // 父 loop 收尾（含用户停止/异常）：stop 全部 running 子委派 + 清幂等缓存 + 注销父上下文
    // （审计 P1-2/P2-4——只 unregister 不清理会让子 agent 后台偷跑且结果丢失）
    disposeParentDelegationState(input.session_id)
  }
  // P3 loop-log：正常返回终态节（completed/cancelled/turn_limit/budget_exhausted 如实记录）
  appendLoopLogSafely(input.project_id, {
    kind: 'final',
    status: result.status,
    turns: result.turns,
    toolCalls: result.toolCalls.length,
  })

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
        // W1-E1（咨询 D3）：cancelled 触发源细分（phase=loop 内观察点，source=abort reason 解析，
        // 如 user_cancelled）+ 会话级 usage 聚合（turns_with_usage=0 即渠道盲，压缩从未触发过）
        ...(result.cancel_detail
          ? {
              cancel_phase: result.cancel_detail.phase,
              ...(result.cancel_detail.source !== undefined ? { cancel_source: result.cancel_detail.source } : {}),
              ...(result.cancel_detail.reason !== undefined ? { cancel_reason: result.cancel_detail.reason } : {}),
            }
          : {}),
        ...(result.usage
          ? {
              usage: {
                input_tokens_total: result.usage.inputTokens,
                output_tokens_total: result.usage.outputTokens,
                est_context_tokens: result.usage.estContextTokens,
                turns_with_usage: result.usage.turnsWithUsage,
              },
            }
          : {}),
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
  // append-only 进 learnings.jsonl，下轮 fresh loop 经【历史经验】段注入；静默失败不阻断。
  // 退行文本（工具调用原文漏进正文/退行重复，output-integrity）不得进经验池污染下轮
  //（P2-13 读取侧过滤的源头堵法：脏文本在此就不落）
  const summaryText = result.finalText.trim()
  appendProjectLearning(input.project_id, {
    kind: result.status === 'completed' ? 'loop_summary' : 'loop_outcome',
    text:
      summaryText && !isDegenerateText(summaryText)
        ? summaryText
        : `Loop 结束（${result.status}，${result.turns} 轮 / ${result.toolCalls.length} 次工具调用）`,
    meta: { status: result.status, turns: result.turns, tool_calls: result.toolCalls.length },
  })

  // T-1 错误卡写点③：loop 异常结局（turn_limit/budget_exhausted）→ anti_pattern 候选卡
  // （账本 + learnings 镜像双落，fire-and-forget 绝不阻断交付链；开关 off 时门面内 no-op）
  if (result.status === 'turn_limit' || result.status === 'budget_exhausted') {
    recordFailureCards(
      { projectId: input.project_id, sessionId: input.session_id },
      { abnormal: { outcomeType: 'timeout', description: `Agent Loop 未正常收尾（${result.status}，${result.turns} 轮）` } },
    )
  }

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

  // PR-2 构建门禁（验证性，vendor 预打包路线）：loop 后系统接管，用 Bloma 自带
  // esbuild（零网络零安装）按 manifest.build 打包校验模块图；P2 失败回流（PR-C）
  // 起接住返回值：failed 时经 MvpTaskResult.build_gate 透传终验组装器追加 build 修复
  // 任务（清偿 PR-2b：构建失败从「如实记录」升级为「记录 + 修复轮尝试修一次」）
  const buildGate = await runBuildGate({
    projectId: input.project_id,
    sessionId: input.session_id,
    rootPath: project.root_path,
    skeleton,
  })

  // 单次启动沙箱：启动失败的修复已内化在 loop（run_preview → logs → edit_file 自修），
  // 这里不再走 ensureSandboxRunning 的外部修复循环；仍失败则如实抛错交上层处理。
  // llm_env（完整程序渠道）：交付预览即注入产物 AI 代理环境，用户看到的应用 AI 是真的
  const sandbox = await runSandbox({
    request_id: input.request_id,
    project_id: input.project_id,
    llm_env: buildAppLlmEnv(input),
  })
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
    snapshotSummary: snapshotKind === 'iteration'
      ? `已按修改意见重新生成（Agent Loop，${result.turns} 轮 / ${result.toolCalls.length} 次工具调用），进入测试阶段。`
      : `MVP 已生成（Agent Loop，${result.turns} 轮 / ${result.toolCalls.length} 次工具调用），进入测试阶段。`,
    readySummary: result.finalText.slice(0, 200) || `Agent Loop 生成完成（${result.status}）。`,
    previewUrl: sandbox.preview_url,
    viaAgentLoop: true,
    loopResult: result,
    ...(buildGate ? { buildGate } : {}),
  }, snapshotKind)
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
 * focus（P3 分级锚定）：未传=全量现状；传入时命中项全文、其余项一行摘要（只减细节不减锚）。
 */
export function buildAgentLoopSystemPrompt(backplane: PrdBackplane, editFormat: 'diff' | 'whole', templateType?: import('../../shared/types').TemplateType, skeletonMap?: string | null, focus?: string[], moduleMap?: string | null): string {
  // 注入点⑥（周计划 §6）：tech_skeleton/目录约定/依赖白名单进背板锚定段；
  // 开关关闭/模板缺失为 null（行为=现状）。类型缺省从背板 template_meta 兜底。
  const effectiveType = templateType ?? backplane.template_meta?.type ?? 'personal_tool'
  const loopInjection = (() => {
    try {
      return buildLoopInjection(effectiveType, skeletonMap)
    } catch {
      return null
    }
  })()
  // P3 分级锚定：功能项渲染归模型层（renderBackplaneAnchor，R1 口径）；
  // focus 缺省=全量全文（与旧内联渲染逐字同源）
  const items = renderBackplaneAnchor(backplane, focus)
  const outOfScope = backplane.out_of_scope.length
    ? backplane.out_of_scope.map((entry) => `- ${entry}`).join('\n')
    : '- （无）'
  const constraints = backplane.constraints?.length
    ? backplane.constraints.map((entry) => `- ${entry}`).join('\n')
    : '- （无）'
  const arr = [
    '你是 Bloma 编程 Agent，用提供的工具亲手构建并验证一个可运行的应用。',
    '',
    '【项目锚（每轮有效，一切决策不得漂移出此范围）】',
    `产品定位：${backplane.positioning}`,
    // 2026-09-03 长文本 PRD 常驻锚（需求工程链归向导）：全文注入，细节以其为准；
    // 与下方功能项/断言冲突时以下方硬契约为准（GWT/裁判以结构化字段为唯一判定口径）。
    // 旧背板无此字段时零注入（兼容）。
    ...(backplane.prd_document
      ? [
          'PRD 全文（用户确认版）：',
          '"""',
          backplane.prd_document,
          '"""',
        ]
      : []),
    // P1-7（2026-09-04）：game 类型 GDD（玩法真相源）常驻注入——机制拆解/核心循环/数值基准，
    // 编程 Agent 不凭对话臆造机制；非 game 缺省零注入。
    ...(backplane.gdd
      ? [
          '玩法设计文档（GDD，机制真相源）：',
          `- 核心幻想：${backplane.gdd.core_fantasy}`,
          `- 设计支柱：${backplane.gdd.pillars.join('；')}`,
          `- 核心循环：${backplane.gdd.core_loop.join(' → ')}`,
          `- 数值基准：${backplane.gdd.numbers.length ? backplane.gdd.numbers.join('；') : '（无）'}`,
        ]
      : []),
    '功能项（P0 必须全部实现且断言为真）：',
    // P3 分级锚定提示行（仅 focus 生效时存在）：其余项断言细节已折叠但探针仍全量验证，
    // 防止「折叠=可以不做」的误读（P0 执行面不裁，D3+硬约束 4）
    ...(focus && focus.length > 0
      ? [`（本轮迭代聚焦：${focus.join('、')}——其余功能项保持现状勿重做；其断言细节已折叠，但 run_gwt_tests 仍会全量验证全部 P0 断言）`]
      : []),
    items,
    '范围外（一律不做）：',
    outOfScope,
    '用户约束：',
    constraints,
    '',
    loopInjection ?? '',
    // 官方模块库地图（2026-09-04）：独立于骨架地图注入（模块地图不影响【产物形态】判断；
    // 事实与注入同源——只有模块实际物化成功才非 null）
    ...(moduleMap ? ['', moduleMap] : []),
    '',
    '【工作方式】',
    '逐功能项实现：write_file/edit_file 写代码 → run_preview 确认可运行 → ' +
    'run_gwt_tests 对照行为断言 → 失败先 read_file/grep 定位再修 → 全部 P0 断言通过后 ' +
    // D1（咨询 D，2026-09-09）：开关 on 时验证链补 API 契约（数据留存/接口类项目收口前必验）；
    // W3-D1/D2：BLOMA_PREFLIGHT on 时验证链收口为 run_preflight 一次跑全部验证面；off 保留原文（字节级现状）。
    (preflightEnabled()
      ? 'run_preflight 收口预检（一次跑全部验证面：GWT 全量/API 契约/产物审计/安全）。'
      : loopApiToolEnabled()
        ? 'run_api_contract_tests 验证接口契约（声明了 interface_spec 的项目）→ run_security_scan 确认无高危。'
        : 'run_security_scan 确认无高危。'),
    // P5 先读再改纪律（2026-09-04）：防凭记忆/凭 plan 推断文件现状（文件可能已被
    // 修复轮或上一迭代修改）；MVP 首跑无副作用（新文件不触发）；与 P3 plan 合同
    // 不冲突（plan 是参考，read 是事实）。
    // Phase 3 B2（2026-09-09）：开关 on 时本内联行让位给 rules-registry R-FILE-01
    // （四段式完整定义单点化，防双源）；off 保留原文（字节级现状）。
    ...(rulesRegistryEnabled()
      ? []
      : [
          '- 修改已存在于骨架或前轮产物中的文件前，先用 read_file 读该文件当前内容再编辑；' +
          '禁止凭记忆或凭 plan 推断文件现状（文件可能已被修复轮或上一迭代修改）。',
        ]),
    editFormat === 'diff'
      ? '编辑用 edit_file 的 diff 模式（old_string 必须与当前文件逐字一致且唯一）。'
      : '编辑用 edit_file 的 whole 模式（提供修改后的完整文件内容）。',
    // Phase 3 B2：操作契约注册表段（触发—必须—禁止替代—受阻四段式，R-* 单点定义）。
    ...(rulesRegistryEnabled() ? ['', renderRulesSection()] : []),
    '',
    // D1：开关 on 时终止条件升级为全验证面（GWT+API 契约+安全）；off 保留原文。
    // W3-D2：BLOMA_PREFLIGHT on 时收口条件=预检通过（GWT/API/产物审计/安全一次过）。
    (preflightEnabled()
      ? '【终止条件】run_preflight 收口预检全部通过（GWT 全量 + API 契约（声明了 interface_spec 的项目）+ 产物审计 + 安全扫描），才输出完成总结（含做了什么、'
      : loopApiToolEnabled()
        ? '【终止条件】全部 P0 断言通过 + API 契约验证通过（声明了 interface_spec 的项目必须 run_api_contract_tests 全过；未声明则豁免）+ 安全扫描无高危，才输出完成总结（含做了什么、'
        : '【终止条件】全部 P0 断言通过 + 安全扫描无高危，才输出完成总结（含做了什么、'),
    '未解决的低优先级项）。若技术合同规划了多文件，收口前确认目标文件已覆盖（未写的文件须在旁白说明偏离原因）。' +
    '测试未全绿不得声称完成。',
    '',
    // W5-G1（咨询 D5）：开关 on 时旁白改事件驱动五类事件版（普通工具链不逐轮播报；同构开头限制随文案
    // 移除——G2 的 A/B 对照即本开关）；off 保留原文四条（字节级现状）。
    ...(narrationEventsEnabled()
      ? [
          '【表达纪律】',
          '- 旁白按事件发生，不逐轮播报：仅在 ①开始明显新阶段 ②影响下一步的重要发现 ③阻塞/需授权/需用户决策 ④长操作进行中说明进展 ⑤交付或失败交接 时输出；表达「已知状态＋下一动作」（如「已定位到过滤谓词；接下来改边界条件」），不写「我将仔细分析并全面修复」式空话。',
          '- 普通 grep→read→edit 连续执行不逐步播报；关键决策点（架构选择、偏离技术合同、修复策略切换）可用 1–2 句说明为什么这么做。',
          '- 不把计划/工具成功/局部测试通过说成交付完成；不编造验证结果；受阻时明确原因与恢复路径。',
        ]
      : [
          '【表达纪律】',
          '- 每轮工具调用前用一句中文旁白说明意图；关键决策点（架构选择、偏离技术合同、测试失败后的修复策略）可用 1–2 句说明「为什么这么做」；不向用户展示冗长推理过程或自我怀疑（思考与推演放在思考通道，不进旁白）。',
          '- 旁白开头不要千篇一律：「现在/继续/接下来/先」这类同构开头连续不得超过两轮，换成自然的说法（读完了什么、发现了什么、为什么这么改）。',
        ]),
    '- 测试失败先读工具返回的失败详情再行动，不要在旁白里长篇分析或复述整段代码。',
    '- 完成总结用中文、400 字以内、自然分段（不要一行流水的清单腔）：做了什么、实际效果、哪些断言未通过、遗留哪些低优先级项。代码与文件内容不限语言。',
    '',
    // P5 术语纪律（2026-09-04）：agent 间统一术语表（与裁判/Defender 同源词表，
    // 措辞按角色微调）——防多 agent 协作中的同义漂移（VibeGame glossary 借鉴）
    '【术语纪律】与其他 agent 和用户交流时使用以下规范词，禁止同义漂移（不得混用右侧同义词）：' +
    '功能项（非"需求点/feature"）、断言（非"验收点"）、场景（非"用例/test case"）、' +
    '探针（非"测试脚本/自动化测试"）、骨架（非"模板项目/脚手架"）、背板（非"PRD 文档/需求文档"）、' +
    '修复轮（非"重试/返工"）。首次向用户提及时可带一句白话解释，之后一致使用规范词。',
    '',
    '【护栏】路径限项目目录内；不 eval/Function；不写 CSP meta；前端不直接外联（CSP 仅放行同源 fetch，真实出网只能走同源 /api/llm 代理）；' +
    // 完整程序阶段 2.5（2026-09-06 计算器案）：数据留存被 localStorage 绕过——「刷新后仍在」
    // 被模型当作 localStorage 的正当理由。硬条款锁死后端持久化，堵住合理化路径。
    // Phase 3 B2：开关 on 时本内联条款让位给 rules-registry R-DATA-01（防双源）；off 保留原文。
    (rulesRegistryEnabled()
      ? ''
      : '数据留存类需求（保存/历史/记录/收藏/刷新或重开后仍在）一律用后端持久化：server/routes/ 路由 + ctx.readData/writeData 落 data/ 目录，' +
        '禁止 localStorage/sessionStorage 存业务数据——PRD 说「刷新后仍在」不构成 localStorage 例外的理由，后端持久化同样满足且必须用后者；') +
    'out_of_scope 内的功能一律不做；编辑校验失败的错误信息要读完再改。',
    '',
    // 产物形态（PR-2 条件化）：工程骨架（带构建门禁）→ 模块化解禁（import 可选，
    // 构建期打包校验）；无骨架 → 维持 PR-1 前现状（单文件静态产物，不用 ESM）
    skeletonMap
      ? '【产物形态】入口 index.html，交互逻辑入口 src/app.js，样式 src/styles.css；' +
        '模块化优先：按技术合同的目标文件拆分为 src/ 下多个 .js 文件用 import 组织（loop 结束后构建门禁' +
        '会打包校验模块图，import 路径错误会在构建期暴露）；仅当功能极简单、单文件已足够时才可合并，且须在旁白说明合并原因。' +
        '预览沙箱直接加载源码，前端禁止直连外网。'
      : '【产物形态】入口 index.html，纯前端静态产物（平台用静态服务器托管，无构建步骤）；' +
        '交互逻辑放 src/app.js，样式放 src/styles.css；不使用 import/ESM 模块语法。',
    // 完整程序渠道（2026-09-06 随记灵案：AI 功能被写成前端模拟，用户要的是真的）——
    // 平台在沙箱注入 BLOMA_APP_LLM_*，产物经同源 /api/llm 代理调用真实模型
    '【AI 能力接入】产品需要 AI/模型能力时必须走真实调用，禁止在前端写死模拟回复冒充 AI：' +
    "fetch('/api/llm', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ messages: [{role:'user', content: 用户输入}], temperature: 0.7, max_tokens: 1024 }) })" +
    '→ 成功 200 {content: \"模型回复文本\"}；失败 非200 {error: \"...\"}（llm_not_configured=预览环境未注入模型，须有失败态）。',
    'AI 功能硬性要求：①messages 只用 user/assistant 角色；②必须实现 加载中/失败/空结果 三种界面状态，失败提示要具体；' +
    '③严禁把密钥、API 端点、模型名写进任何项目文件（平台已注入服务器进程，前端不可见）；' +
    '④页面 URL 带 mock=1 参数时，所有 /api/llm 调用自动附加 mock:true（URL 带 mock=fail 时附加 mock:\"fail\"）——平台探针与失败态自测走此通道，返回确定性应答；' +
    '⑤AI 功能的行为断言只断言界面形态（点击后出现结果区/失败提示），不断言模型输出的具体内容。',
    // 完整程序阶段 1（2026-09-06 用户拍板：终点是前后端分离的完整程序，静态单页只是里程碑）
    '【前后端分离】凡涉及数据留存或服务端能力的功能，后端优先——禁止把 localStorage 当唯一数据源：',
    '①后端路由：server/routes/<资源>.js 导出 { "GET /路径": handler, "POST /路径": handler }——文件名即路由前缀（notes.js → /api/notes/*），平台启动时自动挂载，无需注册；',
    '②handler 写 async (req, res, ctx)；ctx 提供 readData(name, fallback) / writeData(name, value)（JSON 持久化到 data/ 目录，重启不丢，原子写）、sendJson(res, code, obj)、query、body、params；',
    "③前端：fetch('/api/...') 调后端，处理加载/失败态；数据持久化职责在后端 data/，前端不留权威副本；",
    '④路由内禁止出网（外部 fetch）与 require 项目目录外的模块；外部模型能力走 /api/llm；',
    '⑤后端数据的断言写「新增项出现/状态变化」，禁止写「总数等于 N」这类依赖历史状态的断言（探针重复执行会累积数据）。',
  ]
  const base = arr.join('\n')
  // Phase 3 B5（2026-09-09）：表达适配层 append-only 注入（off=字节级现状；只改表达
  // 不改验收口径，契约层构件字节永不受本层影响——回归锁锁定 append-only）。
  const expression = renderExpressionSection()
  return expression ? `${base}\n\n${expression}` : base
}

/**
 * 背板锚定系统提示词 + 用户追加规则（D4 追加模式）：`loop-system` 覆盖文件内容追加在
 * 动态 system prompt 之后（背板锚定段不可覆盖）。无覆盖文件返回 base 本身。
 * focus（P3 分级锚定）：未传=全量现状（字节级等价，回归锁锁定）；修复轮不传（修复卡即 mini-plan）。
 */
function buildLoopSystemWithOverride(backplane: PrdBackplane, editFormat: 'diff' | 'whole', projectId?: string, skeletonMap?: string | null, focus?: string[], moduleMap?: string | null): string {
  const base = buildAgentLoopSystemPrompt(backplane, editFormat, undefined, skeletonMap, focus, moduleMap)
  // 历史经验段（改造 2）：迭代/重生成场景下轮 fresh loop 开场即知上轮踩坑；
  // 首轮无经验返回空串零开销；renderLearningsSection 内部静默失败
  const learnings = renderLearningsSection(backplane.project_id)
  const override = loadPromptOverride('loop-system')
  // 并集：本地 learnings 经验段 + 队友 project-map 注入（2026-08-29 合入）
  // project-map（Graft 模式，r69）：代码结构语义地图注入 system 尾部——定位代码优先按锚点
  // read_file，避免每轮 grep 漫游（冷会话重探索问题）；地图缺失/项目读取失败静默不注入。
  const withOverride = [base, learnings, override ? `【用户自定义规则】\n${override}` : ''].filter(Boolean).join('\n\n')
  if (!projectId) return withOverride
  try {
    const project = findProject(projectId)
    return appendProjectMapToSystem(withOverride, loadProjectMapBlock(projectId, project.workspace_slug))
  } catch {
    return withOverride
  }
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
  /** 取消信号：语义审查及其委派等待期间立即停止。 */
  signal?: AbortSignal
  /** L1 视觉审计摘要（2026-09-07）：代码参数注入裁判证据链，非提示词配置；
   *  passed/flagged/unavailable/skipped 均传（不可用也要让裁判看见缺口）。 */
  visualEvidence?: string
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
  throwIfAborted(input.signal)
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

    // T-1 错误卡写点②：裁判退回（blocking 信号）→ anti_pattern 候选卡；同指纹窗口折叠
    // 保证多轮退回不刷屏（fingerprint 基于 user_visible_summary）。
    recordFailureCards({ projectId: input.project_id, sessionId: input.session_id }, { judgeVerdict: verdict })

    // M4-B loop-aware：loop 路径「只终验不重修」——constraint_error 不再外部文档重修
    // （loop 已内化修复，外部再修语义重复）；judge 自判 repairable=false（loop 异常终止态）
    // 同样不再重修。首败即熔断让渡（U7：把具体退回原因带给让渡卡片）。
    const repairable = verdict.repairable === true && input.repairInternalized !== true
    if (!repairable || returns > limit) {
      publishBlockedDecision(input, 'judge_return', verdict.user_visible_summary, { reason: 'judge' })
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

  throwIfAborted(input.signal)
  updateProject(input.project_id, { current_stage: 'ready' })
  publish(input, 'stage_changed', { stage: 'ready' })
  // 软建议（suggest）不再静默忽略：把可读提示附在完成通知后反馈给用户（P1）
  const completion =
    verdict.verdict === 'suggest'
      ? `${READY_COMPLETION_COPY}\n\n补充提示：${verdict.user_visible_summary}`
      : READY_COMPLETION_COPY
  publishCompletionMessage(input, completion)
  // 就绪引导卡（2026-09-06 用户拍板「终点不是 MVP」）：MVP 只是里程碑——发下一步卡
  // 引导用户走向完整产物（数据上服务端/导出部署）。复用 user_decision_required 通道
  //（渲染端 useUserDecisionCards 扫描事件渲染卡片，选项经 card_option metadata 回传；
  // export_handoff 由渲染端特调导出 IPC，不进聊天管道）。mvp_ready 在交付期已发，
  // 本卡在其后到达 → 渲染端扫描顺序保证显示。
  const deliveryBody = buildReadyDeliveryBody(input.project_id)
  publish(input, 'user_decision_required', {
    kind: 'ready_next_steps',
    title: '当前版本已就绪——下一步走向完整产物',
    // Phase 7 U1 H3：交付状态三层正文（结论/任务分组/详情提示；delivery_status
    // 缺席时 undefined 渲染端自动隐藏——开关 off 时与现状字节一致）
    delivery_body: deliveryBody,
    questions: [
      { id: 'next_backend', label: '把数据存到服务端', description: '历史/记录改用 server/routes + data/ 持久化' },
      { id: 'export_handoff', label: '导出部署', description: '生成可独立部署的前后端工程' },
    ],
  })
  // Phase 7 U5 J5（2026-09-10）：delivery_presented 北极星地基事件——交付声明文案
  // 快照随事件 append-only 留存（后续话术改动不回写，J6 承诺冲突率证据源）；
  // delivery_status 缺席时记 status_absent（开关 off 事实也入账，可归因）。try/catch
  // 隔离不阻断 ready 收口。
  try {
    const project = findProject(input.project_id)
    trackAnalytics({
      request_id: input.request_id,
      event: {
        event_type: 'delivery_presented',
        project_id: input.project_id,
        session_id: input.session_id,
        payload: {
          via: 'ready_next_steps',
          snapshot_id: project?.current_snapshot_id,
          delivery_status: project?.delivery_status ?? 'absent',
          delivery_body_snapshot: deliveryBody ?? '',
        },
        privacy_level: 'research_safe',
      },
    })
  } catch {
    // 埋点失败不影响 ready 收口
  }
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

  // 渠道：优先 M5 类别路由（2026-09-01 起切 audit 内审类别——本腿是审查腿，与 PRD
  // 内审同渠道族；可指快模型），失败回退跳过；备用链限路由配置域（闭环 PR4）：终审
  // 绝不静默落到任意弱模型，找不到就 skip 留痕
  let env: Record<string, string> | undefined
  try {
    const resolution = resolveChannelEnv({
      channelId: input.channel_id,
      category: 'audit',
      projectId: input.project_id,
      sessionId: input.session_id,
      fallbackScope: 'routed-only',
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
    testSummary: [
      testResult
        ? `共 ${testResult.total_count} 项，通过 ${testResult.passed_count}、失败 ${testResult.failed_count}`
        : '',
      input.visualEvidence ? `视觉审计：${input.visualEvidence}` : '',
      testResult?.unverified?.length ? `未验证项：${testResult.unverified.join('；')}` : '',
    ].filter(Boolean).join('；') || undefined,
    query: input.query,
    env,
    sessionId: input.session_id,
    projectId: input.project_id,
    requestId: input.request_id,
    publish: (event) => publish(input, event.type, event.payload),
    signal: input.signal,
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
    // M-6：skip 在用户可见层披露（不变式 2「ack 如实」）——此前仅进 decisions.md，
    // judge_result 与用户可见话术均不披露：语义腿没跑时规则引擎存在性基线对
    // 「页面列了需求文字 + 一个 button」的空壳可一票通过，用户拿到 pass 无从知晓
    const skipNote = `（语义审查未执行：${semantic.skipReason === 'no_channel' ? '无可用审查渠道' : '审查服务暂时失败'}，本次仅做了存在性与运行证据检查）`
    publish(input, 'message_delta', { text: skipNote })
    return { ...verdict, user_visible_summary: `${verdict.user_visible_summary}${skipNote}` }
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
  /** 停止信号：终验开始后取消不得继续切阶段、写报告或触发裁判。 */
  signal?: AbortSignal
  /** Agent Loop 结果元数据（M4-B）：其存在即标记 loop 路径；judge 对异常终止态判「让渡」。
   *  存量旧版项目（via_agent_loop=false）resume 时无 loop 元数据，缺省走普通终验（无修复）。 */
  loop?: AgentLoopJudgeMetadata
  /** 语义审查腿透传（2026-08-26）：judge 规则全绿后审产物 vs PRD 忠实性 */
  query?: SDKQuery
  channel_id?: string
  /** 构建门禁结果（P2 失败回流 PR-C 接入）：failed 时修复卡追加 build 任务；
   *  此批先只透传不消费，PR-C 在 runMvpViaAgentLoop 侧填充 */
  buildGate?: BuildGateResult
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
 * API 契约存活检查（完整程序阶段 2，2026-09-06）：探测逻辑在 coding/api-contract.ts
 * （纯函数可测）；此处取背板 interface_spec 并把失败以 GwtFailureSummary 并入测试
 * 结果——修复回流/熔断/让渡口径完全复用（修复轮按 location「API 契约端点：…」定修）。
 */
/** 导出供接线契约测试（gwt-ui-gate-merge）：L0 门禁必须每次执行不可旁路。 */
export async function runGwtWithApiContract(input: { project_id: string; session_id: string; preview_url?: string }): Promise<GwtTestResult> {
  const testResult = await runGwtScenarios(input)
  // L0 产物 UI 完整性硬门禁（2026-09-07）：与 api-contract 同款合并——初验与修复轮
  // 重验共用本函数，无旁路；失败合成 UI-GATE 前缀条目进既有 repair-loop gwt 腿。
  // 探针不可用不判败但落 unverified 可见（F9a 不静默）。
  let gateResult: ArtifactUiGateResult | undefined
  if (input.preview_url && uiGateEnabled()) {
    gateResult = await runArtifactUiGate({ previewUrl: input.preview_url })
  }
  if (gateResult) {
    if (gateResult.status !== 'skipped') {
      recordDecision({
        project_id: input.project_id,
        session_id: input.session_id,
        entry: {
          type: 'ui_gate',
          title: gateResult.status === 'failed' ? `L0 UI 完整性门禁：${gateResult.failures.length} 项判败` : `L0 UI 完整性门禁：${gateResult.status}`,
          why: gateResult.status === 'failed' ? gateResult.failures.map((f) => f.reason).join('；').slice(0, 300) : gateResult.note ?? '探针通过',
          detail: { status: gateResult.status, realControls: gateResult.probe?.realControls, leaked: gateResult.probe?.leakedPatterns ?? [] },
        },
      })
    }
    if (gateResult.failures.length > 0) {
      testResult.total_count += gateResult.failures.length
      testResult.failed_count += gateResult.failures.length
      testResult.failure_summary = [...testResult.failure_summary, ...gateResult.failures]
    } else if (gateResult.status === 'unavailable') {
      testResult.unverified = [...(testResult.unverified ?? []), `UI 完整性门禁未执行（${gateResult.note ?? '探针失败'}），界面真实性未经机器探测，裁判与用户可见`]
    }
    // 通过态的信息位（死点击嫌疑/占位人设/console 错误）进 unverified：不判败但裁判可见
    if (gateResult.probe) {
      const notes = uiProbeNotes(gateResult.probe)
      if (notes.length > 0) testResult.unverified = [...(testResult.unverified ?? []), ...notes]
    }
  }
  if (!input.preview_url) return testResult
  const endpoints = backplaneInterfaceSpec(readPrdBackplane(input.project_id))
  if (endpoints.length === 0) return testResult
  const apiFailures = await checkApiContract(input.preview_url, endpoints)
  if (apiFailures.length === 0) return testResult
  return {
    ...testResult,
    total_count: testResult.total_count + apiFailures.length,
    failed_count: testResult.failed_count + apiFailures.length,
    failure_summary: [...testResult.failure_summary, ...apiFailures],
  }
}

/**
 * test_completed：GWT/终验结果的结构化证据事件（2026-09-09）。
 *
 * 背景：runAgentLoopPostTesting 每次写 test-report.json 后同点发送；analytics
 * append-only 不受熔断回滚影响（回滚会把工作区 test-report 清回终验前快照，导致
 * 事后无判定证据——见 P0 基准扫描发现）。事件即最终判定证据，供审计与 bench 采集。
 */
/** W2-D3（咨询 D2 §五）：终验失败的来源分类。目标五分类=覆盖缺口/环境差异/挑战发现/证据失效/
 *  基础设施；v0 确定性可判三类 + Bloma 特有 known_failure（B0 错误放行口径：loop 自测已知
 *  未修仍退出），challenge_found/infrastructure 留给 W3（judge/预检基础设施面）落地。 */
export type TestFailureSource =
  | 'coverage_gap'
  | 'environment_diff'
  | 'known_failure'
  | 'evidence_stale'
  | 'challenge_found'
  | 'infrastructure'

/** W2-D3：单条失败的来源判定（纯函数；baseline 两态：loop 自测基线 / 上一轮终验基线）。 */
function classifyFailureSource(
  scenario: string,
  baseline: { kind: 'loop'; validation?: import('../../shared/types').LoopValidationSnapshot } | { kind: 'prev_round'; prevFailures: string[] },
): TestFailureSource | undefined {
  // API 契约失败：loop 从未验过 → 结构性覆盖缺口；验过仍挂 → 环境差异；上轮挂过 → 持续；否则候选已变旧证据失效
  if (scenario.startsWith('API 契约端点')) {
    if (baseline.kind === 'loop') {
      if (!baseline.validation) return undefined
      return baseline.validation.api_contract_runs > 0 ? 'environment_diff' : 'coverage_gap'
    }
    return baseline.prevFailures.includes(scenario) ? 'known_failure' : 'evidence_stale'
  }
  // 产物审计失败（UI-GATE）：loop 工具面无对应（W3 run_preflight 落地后细分）
  if (scenario.startsWith('UI-GATE')) {
    if (baseline.kind === 'loop') return 'coverage_gap'
    return baseline.prevFailures.includes(scenario) ? 'known_failure' : 'evidence_stale'
  }
  // GWT 场景：loop 从未自测 → 覆盖缺口；上次自测就挂 → 已知未修；上次过这次挂 → 环境差异。
  // 上轮终验基线：持续 → 已知未修；新挂 → 候选已变（修复回归）= 证据失效。
  if (baseline.kind === 'loop') {
    const validation = baseline.validation
    if (!validation) return undefined
    if (validation.gwt_runs === 0) return 'coverage_gap'
    return validation.last_gwt_failures.includes(scenario) ? 'known_failure' : 'environment_diff'
  }
  return baseline.prevFailures.includes(scenario) ? 'known_failure' : 'evidence_stale'
}

/** W2-D3+F4：修复比较（resolved/persistent/new_failures；D4 稿——升级计数由宿主维护不靠模型数）。 */
function buildFailureComparison(
  baselineFailures: string[],
  currentFailures: string[],
  baselineKind: 'loop_last_run' | 'prev_round',
): { baseline: 'loop_last_run' | 'prev_round'; resolved: string[]; persistent: string[]; new_failures: string[]; comparison_valid: true } {
  return {
    baseline: baselineKind,
    resolved: baselineFailures.filter((s) => !currentFailures.includes(s)),
    persistent: currentFailures.filter((s) => baselineFailures.includes(s)),
    new_failures: currentFailures.filter((s) => !baselineFailures.includes(s)),
    comparison_valid: true as const,
  }
}

function trackTestCompleted(
  input: AgentLoopPostTestingInput,
  result: GwtTestResult,
  round: 'initial' | 'after_repair',
  /** W2-D3：after_repair 轮的基线（上一轮终验失败集）；initial 轮用 input.loop.validation */
  prevFailures?: string[],
) {
  const loopValidation = round === 'initial' ? input.loop?.validation : undefined
  const baseline =
    round === 'initial'
      ? ({ kind: 'loop', validation: loopValidation } as const)
      : ({ kind: 'prev_round', prevFailures: prevFailures ?? [] } as const)
  const currentFailures = (result.failure_summary || []).map((f) => f.scenario)
  const comparison =
    round === 'initial'
      ? loopValidation
        ? buildFailureComparison(loopValidation.last_gwt_failures, currentFailures, 'loop_last_run')
        : undefined
      : buildFailureComparison(prevFailures ?? [], currentFailures, 'prev_round')
  trackAnalytics({
    request_id: input.request_id,
    event: {
      event_type: 'test_completed',
      project_id: input.project_id,
      session_id: input.session_id,
      payload: {
        round,
        via: 'agent_loop_post_testing',
        total_count: result.total_count,
        passed_count: result.passed_count,
        failed_count: result.failed_count,
        // B0 错误放行深挖（2026-09-09）发现：熔断回滚会清掉 test-report.json，失败 reason
        // 只剩场景名可回溯——failures 升级为 {scenario, reason}（reason 截断 200 字）；
        // W2-D3 再附 source（终验失败来源分类；无 loop 基线的存量路径缺省不标）。
        failures: (result.failure_summary || []).slice(0, 20).map((f) => {
          const source = classifyFailureSource(f.scenario, baseline)
          return {
            scenario: f.scenario,
            reason: String(f.reason ?? '').slice(0, 200),
            ...(source ? { source } : {}),
          }
        }),
        // W2-F4：修复比较（resolved/persistent/new_failures；baseline=loop 上次自测或上轮终验）
        ...(comparison ? { comparison } : {}),
      },
      privacy_level: 'research_safe',
    },
  })
}

/**
 * Phase 7 U1 H1/H4：终验收口点交付状态写入（BLOMA_DELIVERY_STATUS off=零行为）。
 * 规则计算见 coding/delivery-status.ts；key_tasks 缺席时回退 P0 功能项判定；
 * preflight 取 loop 自验快照（W3 跑过才带，undefined 不影响判定）。
 */
function recordPostTestingDeliveryStatus(
  projectId: string,
  testResult: Pick<GwtTestResult, 'failed_count' | 'failure_summary'>,
  securityPassed: boolean,
  loop?: AgentLoopJudgeMetadata,
): void {
  if (!deliveryStatusEnabled()) return
  const backplane = readPrdBackplane(projectId)
  recordDeliveryStatus(projectId, {
    keyTasks: backplaneKeyTasks(backplane),
    p0RequirementIds: backplane.requirements.filter((item) => requirementPriority(item) === 'P0').map((item) => item.id),
    testResult,
    securityPassed,
    ...(loop?.validation?.preflight_passed !== undefined ? { preflightPassed: loop.validation.preflight_passed } : {}),
  })
}

/**
 * Phase 7 U1 H4：必交功能项集（熔断 failureNote 四段式的核心目标判定；无开关直接上）。
 */
function mustDeliverFeatureIdsOf(projectId: string): string[] {
  const backplane = readPrdBackplane(projectId)
  const keyTasks = backplaneKeyTasks(backplane)
  if (keyTasks.length > 0) return [...new Set(keyTasks.filter((t) => t.must_deliver).flatMap((t) => t.feature_ids))]
  return backplane.requirements.filter((item) => requirementPriority(item) === 'P0').map((item) => item.id)
}

/**
 * Phase 7 U1 H3：ready 引导卡交付正文（三层：结论/任务分组✓×?/详情提示；无通过率数字）。
 * delivery_status 缺席（开关 off/未终验）→ undefined 不加载荷（渲染端自动隐藏）。
 */
function buildReadyDeliveryBody(projectId: string): string | undefined {
  const project = findProject(projectId)
  if (!project?.delivery_status) return undefined
  const testReport = readTestReport(projectId)
  const backplane = readPrdBackplane(projectId)
  const storyOf = new Map(backplane.requirements.map((item) => [item.id, requirementStory(item)]))
  const presentation = buildDeliveryPresentation({
    status: project.delivery_status,
    keyTasks: backplaneKeyTasks(backplane),
    p0RequirementIds: backplane.requirements.filter((item) => requirementPriority(item) === 'P0').map((item) => item.id),
    testResult: testReport ?? { failed_count: 0, failure_summary: [] },
    featureLabelOf: (id) => storyOf.get(id),
  })
  return renderDeliveryBody(presentation)
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
  throwIfAborted(input.signal)
  updateProject(input.project_id, { current_stage: 'testing' })
  publish(input, 'stage_changed', { stage: 'testing' })

  let testResult = await runGwtWithApiContract({ project_id: input.project_id, session_id: input.session_id, preview_url: input.preview_url })
  throwIfAborted(input.signal)
  writeTestReport({ request_id: input.request_id, session_id: input.session_id, project_id: input.project_id, result: testResult })
  syncDocuments({ request_id: input.request_id, project_id: input.project_id, session_id: input.session_id, checkpoint: 'mvp_tested' })
  trackTestCompleted(input, testResult, 'initial')
  throwIfAborted(input.signal)
  // Phase 7 U1 H1：熔断回滚的目标是终验失败前版本——交付状态按 initial 失败清单判定
  // （修复轮改善不美化回滚版状态；修复收敛路径用重验后的最终结果）。
  const initialTestResult = testResult

  // P2 失败回流（实施稿 §4.4）：GWT 首败先定向修复再决定熔断——预算内修复轮 + 全量
  // 重验（D2：不做失败子集，防改坏已过场景）；预算耗尽 / 修复后仍失败 → 现状熔断
  // 口径一字不改（陷阱 37）。修复收敛则继续走安全扫描 → judge 正常链。
  if (testResult.failed_count > 0) {
    testResult = await repairAndRetest(input, testResult)
    throwIfAborted(input.signal)
    if (testResult.failed_count > 0) {
      // T-1 错误卡写点④（灰度 S1 实弹补位，2026-09-07）：修复轮跑完仍败的**首轮熔断**
      // 不经 used>=budget 早退分支——此前该路径无写点，真实失败反而不成卡。
      // 统一在熔断回滚前成卡（与①重叠时由指纹窗口折叠去重）。
      recordFailureCards(
        { projectId: input.project_id, sessionId: input.session_id },
        {
          testResult,
          ...(input.buildGate ? { buildGate: input.buildGate } : {}),
          abnormal: { outcomeType: 'unexpected_exit' as const, description: '修复轮执行后终验仍未通过，熔断回滚' },
        },
      )
      const outcome = await circuitBreakRollback({
        request_id: input.request_id,
        session_id: input.session_id,
        project_id: input.project_id,
        reason: `终验未通过（Agent Loop 路径，${loopOutcomeNote(input.loop)}）`,
        // 回滚目标快照是终验失败前的版本：如实带上已知未通过断言（Phase 7 U1 H4
        // 升级为四段式：功能→现象→影响→替代；核心目标/敏感类不折叠，防「可以继续
        // 试用」把坏版本当健康品——随记灵 2026-09-06 案）
        failureNote:
          testResult.failure_summary.length > 0
            ? renderCircuitFailureNote({
                failures: testResult.failure_summary,
                mustDeliverFeatureIds: mustDeliverFeatureIdsOf(input.project_id),
              })
            : undefined,
        publish: (type, payload) => publish(input, type, payload),
      })
      // Phase 7 U1 H1：B0 错误放行主路径（circuit_rollback→ready）在此如实落
      // partial/unavailable——「部分可用不再伪装成就绪」（用回滚目标版本的 initial 清单）。
      recordPostTestingDeliveryStatus(input.project_id, initialTestResult, true, input.loop)
      if (outcome.rolled_back) throw new CircuitBreakSettledError()
      const failureTitle =
        testResult.failure_summary.length > 0
          ? `测试未通过：${testResult.failure_summary.map((f) => f.scenario).join('、')}`
          : '自动修复多次后测试仍未通过'
      publishBlockedDecision(input, 'test_repair', failureTitle, {
        reason: 'test',
        failures: testResult.failure_summary,
        mustDeliverFeatureIds: mustDeliverFeatureIdsOf(input.project_id),
      })
      return { verdict: 'blocked', test_result: testResult }
    }
    // 修复收敛：testResult 已更新为重验结果，继续正常链
  }

  // 安全扫描终验（A3，OWASP 静态扫描）：高危/严重命中同样只熔断不重修。
  // W6-D6：静态证据按产物指纹缓存——预检（run_preflight）算过且候选未变则复用，
  // 行为类（GWT/API）仍独立重跑；开关 off=直通现状。
  const securityCached = getCachedStaticEvidence<ReturnType<typeof runSecurityScan>>(input.project_id, findProject(input.project_id).root_path, 'security-scan')
  let security = securityCached ?? runSecurityScan({ project_id: input.project_id, root_path: findProject(input.project_id).root_path })
  if (!securityCached) setCachedStaticEvidence(input.project_id, findProject(input.project_id).root_path, 'security-scan', security)
  throwIfAborted(input.signal)
  writeSecurityScanDocument(input.project_id, renderSecurityScanMarkdown(security))
  if (!security.passed) {
    const outcome = await circuitBreakRollback({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      reason: `安全终验未通过（Agent Loop 路径，${loopOutcomeNote(input.loop)}）`,
      failureNote: `注意：这一版安全扫描仍有 ${security.issues.length} 处命中。你可以继续试用，也可以告诉我下一步。`,
      publish: (type, payload) => publish(input, type, payload),
    })
    // Phase 7 U1 H1：安全未过=不可隔离风险→unavailable（GWT 全过也不粉饰）。
    recordPostTestingDeliveryStatus(input.project_id, testResult, false, input.loop)
    if (outcome.rolled_back) throw new CircuitBreakSettledError()
    publishBlockedDecision(input, 'security_repair', '检测到的安全隐患反复修不好，需要你来定夺', { reason: 'security' })
    return { verdict: 'blocked', test_result: testResult }
  }

  // L1 双视觉审计（2026-09-07 产出物审计固化）：截图→V1 详述→V2 异构互证→报告落
  // 项目文档 + 摘要经代码参数注入裁判语义审查腿（非提示词软约束，每次必执行）。
  // LLM 证据不直接判败（防视觉噪声成第二套硬门禁）；unavailable/skipped 也必须
  // 决策日志留痕并进裁判 testSummary（F9a 不静默）。
  // Phase 7 U1 H1：GWT+安全全过在此落 verified（后续 judge 若 blocking 退回/让渡，
  // 项目不进 ready 交付态——blocked 不消费 delivery_status；下次终验重算不背书）。
  recordPostTestingDeliveryStatus(input.project_id, testResult, true, input.loop)
  throwIfAborted(input.signal)
  const vision = await runVisionAuditGate({ previewUrl: input.preview_url, projectId: input.project_id })
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'vision_audit',
      title: `L1 视觉审计：${vision.status}`,
      why: vision.digest.slice(0, 300),
      detail: { status: vision.status, note: vision.note },
    },
  })

  // 终审（M4-B loop-aware）：judge 感知 loop 结果——completed 照常读盘判定；异常终止态让渡。
  // judge 级修复同样「只终验不重修」（repairInternalized 熔断 constraint_error 外部文档重修）。
  throwIfAborted(input.signal)
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
    signal: input.signal,
    visualEvidence: vision.digest,
  })
  return { verdict: judge.outcome, test_result: testResult, judge: judge.verdict }
}

/**
 * GWT 首败后的定向修复轮 + 全量重验（P2 失败回流入口 A，实施稿 §4.4）。
 *
 * 预算：project.test_repair_count 计数（既有字段），上限 resolveRepairBudget(mode)
 * （缺省 quick=1 / longterm=2，BLOMA_REPAIR_BUDGET 覆盖）；每轮 +1，收敛清零。
 * 任一「不起修复轮」的情形（预算耗尽 / 无 query / 渠道不可用 / 修复轮异常）
 * 均返回原 testResult，由调用方按现状熔断口径收口（陷阱 37 一字不改）——修复轮
 * 是增强不是依赖，绝不阻断交付链。
 */
async function repairAndRetest(input: AgentLoopPostTestingInput, testResult: GwtTestResult): Promise<GwtTestResult> {
  const project = findProject(input.project_id)
  const used = project.test_repair_count ?? 0
  const budget = resolveRepairBudget(input.mode)
  if (used >= budget) {
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'repair_budget_exhausted',
        title: '修复预算已耗尽',
        why: `已连续修复 ${used} 轮（${input.mode} 模式上限 ${budget}）终验仍未通过，按现状熔断口径收口`,
        detail: { used, budget, mode: input.mode },
      },
    })
    // T-1 错误卡写点①：入口 A 修复预算耗尽熔断——终验证据（GWT 逐场景 + 异常结局）成卡
    recordFailureCards(
      { projectId: input.project_id, sessionId: input.session_id },
      {
        testResult,
        ...(input.buildGate ? { buildGate: input.buildGate } : {}),
        abnormal: { outcomeType: 'unexpected_exit' as const, description: `修复预算耗尽（${used}/${budget}）终验仍未通过` },
      },
    )
    return testResult
  }
  // 无 query（存量项目 resume 等场景）无法起修复轮：不起不报错，走现状熔断
  if (!input.query) return testResult

  const tasks = buildRepairTasks({ testResult, ...(input.buildGate ? { buildGate: input.buildGate } : {}) })
  if (tasks.length === 0) return testResult
  throwIfAborted(input.signal)

  const round = used + 1
  updateProject(input.project_id, { test_repair_count: round })
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'repair_round_started',
      title: `定向修复轮启动（第 ${round}/${budget} 轮）`,
      why: `终验 ${tasks.length} 项未通过，回喂结构化修复任务后定向修复并全量重验（来源：${[...new Set(tasks.map((task) => task.source))].join('、')}）`,
      detail: { round, budget, mode: input.mode, tasks: tasks.map((task) => ({ id: task.id, source: task.source, location: task.location })) },
    },
  })
  // 旁白告知（渲染端零新组件，走既有 assistant 文案流）
  const repairNote = `终验有 ${tasks.length} 项未通过，我先定向修复一轮（第 ${round}/${budget} 轮），完成后再全量重验。`
  appendSessionMessage(input.session_id, {
    role: 'assistant',
    content: [{ type: 'text', text: repairNote }],
    timestamp: Date.now(),
  })
  publish(input, 'message_delta', { text: repairNote })

  // system 同款背板锚定 + 骨架地图（buildLoopSystemWithOverride 同款，防漂移锚不丢）；
  // 骨架幂等重渲染（已存在文件全部跳过，决策行如实记录），修复轮拿到与主 loop 一致的锚
  const backplane = readPrdBackplane(input.project_id)
  const { map: skeletonMap, skeleton, moduleMap } = prepareSkeletonBeforeLoop(input, backplane, project)
  const result = await runRepairLoop({
    request_id: input.request_id,
    session_id: input.session_id,
    project_id: input.project_id,
    mode: input.mode,
    ...(input.signal ? { signal: input.signal } : {}),
    channel_id: input.channel_id,
    query: input.query,
    tasks,
    round,
    buildSystem: (editFormat) => buildLoopSystemWithOverride(backplane, editFormat, input.project_id, skeletonMap, undefined, moduleMap),
    // Phase 3 B3：修复轮本轮锚（开关 off=零注入字节级现状）；完成证据=失败断言原文
    ...(roundAnchorEnabled() ? { roundAnchor: buildRepairRoundAnchor(backplane, tasks.map((task) => task.location ?? task.claim)) } : {}),
    // W2-F1：修复证据包（候选指纹+此前修复尝试；开关 off=零注入字节级现状）
    ...(loopCheckpointEnabled() ? { checkpointContext: buildRepairCheckpointContext(input.project_id) } : {}),
    // W4-F2：修改授权边界（BLOMA_REPAIR_SCOPE off=无边界字节级现状；场景锚点派生不出路径则不设）
    ...(repairScopeEnabled() && deriveAuthorizedWritePaths(tasks) ? { authorizedWritePaths: deriveAuthorizedWritePaths(tasks) } : {}),
    thinkingLevel: resolveLoopThinkingLevel(),
    publish: (type, payload) => publish(input, type, payload),
  })

  // 修复轮异常（渠道不可用 / loop 抛错等）：不再重验，直接走现状熔断
  if (result.status !== 'completed') return testResult
  throwIfAborted(input.signal)

  // 全量重验（D2）+ 重写测试报告（m-8 口径：最后一轮为准）；预览先兑底拉起
  const previewUrl = await ensureResumePreview(input)
  const retested = await runGwtWithApiContract({ project_id: input.project_id, session_id: input.session_id, preview_url: previewUrl })
  throwIfAborted(input.signal)
  writeTestReport({ request_id: input.request_id, session_id: input.session_id, project_id: input.project_id, result: retested })
  syncDocuments({ request_id: input.request_id, project_id: input.project_id, session_id: input.session_id, checkpoint: 'mvp_tested' })
  trackTestCompleted(input, retested, 'after_repair', testResult.failure_summary.map((f) => f.scenario))

  // W2-F1（咨询 D4）：修复尝试入检查点账本——下轮修复卡开场即知「之前试过什么、为何败」
  // （候选指纹+改了什么+resolved/persistent/new 对比）。开关 off=零写盘。
  if (loopCheckpointEnabled()) {
    const prevFailures = testResult.failure_summary.map((f) => f.scenario)
    const currentFailures = retested.failure_summary.map((f) => f.scenario)
    appendRepairAttemptRecord(input.project_id, {
      round,
      at: new Date().toISOString(),
      task_locations: tasks.map((task) => task.location ?? task.claim ?? '').filter(Boolean).slice(0, 10),
      files_touched: [...new Set((result.loopResult?.toolCalls ?? []).filter((call) => call.path).map((call) => call.path!))].slice(0, 20),
      outcome: {
        resolved: prevFailures.filter((s) => !currentFailures.includes(s)),
        persistent: currentFailures.filter((s) => prevFailures.includes(s)),
        new_failures: currentFailures.filter((s) => !prevFailures.includes(s)),
        converged: retested.failed_count === 0,
      },
    })
  }

  const converged = retested.failed_count === 0
  if (converged) updateProject(input.project_id, { test_repair_count: 0 })
  // 构建任务在修复卡里（PR-C）：修复轮结束后重跑构建门禁验证（决策日志自动落
  // build_gate_* 新行）；结果只留痕不影响 GWT 收敛判定（passed/skipped 同理）
  let buildGateAfter: BuildGateResult | undefined
  if (input.buildGate?.status === 'failed' && tasks.some((task) => task.source === 'build')) {
    buildGateAfter = await runBuildGate({
      projectId: input.project_id,
      sessionId: input.session_id,
      rootPath: project.root_path,
      skeleton,
    })
  }
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'repair_round_completed',
      title: converged ? '定向修复轮收敛' : '定向修复轮完成（未收敛）',
      why: converged
        ? `第 ${round} 轮修复后全量重验 ${retested.total_count} 场景全部通过，继续安全扫描与裁判终审`
        : `第 ${round} 轮修复后全量重验仍有 ${retested.failed_count} 项未通过，按现状熔断口径收口`,
      detail: {
        round,
        converged,
        failed_before: testResult.failed_count,
        failed_after: retested.failed_count,
        total_count: retested.total_count,
        ...(buildGateAfter ? { build_gate_after: buildGateAfter.status, build_detail: buildGateAfter.detail?.slice(0, 300) } : {}),
      },
    },
  })
  // 埋点（P2 PR-D）：修复前后 failed_count 对比进 payload，供收敛率统计（与决策日志
  // 同名不同体系，对齐 agent_loop_completed 风格；P1 蒸馏触发条件同源受益）
  trackAnalytics({
    request_id: input.request_id,
    event: {
      event_type: 'repair_round_completed',
      project_id: input.project_id,
      session_id: input.session_id,
      payload: {
        round,
        converged,
        failed_before: testResult.failed_count,
        failed_after: retested.failed_count,
        total_count: retested.total_count,
        mode: input.mode,
        via: 'post_testing',
        ...(buildGateAfter ? { build_gate_after: buildGateAfter.status } : {}),
      },
      privacy_level: 'research_safe',
    },
  })
  return retested
}

/**
 * 入口 B（blocked 卡「继续修」，P2 失败回流 PR-C）：上次让渡时的失败快照（test-report.json）
 * 直接组装修复任务，先跑一轮定向修复再交回终验门禁——从「产物未变的空转重验」升级为
 * 「先修再验」。与入口 A 的差异：入口 A 在终验现场拿新鲜失败证据；入口 B 消费上次落盘
 * 报告（省一次注定失败的全量重验）。预算计数与入口 A 共享 test_repair_count。
 *
 * 任一不起修复轮的情形（无快照 / 无失败 / 预算已耗尽 / 无 query / 修复轮异常）→
 * 行为=现状（直接终验，终验内部仍有入口 A 兜底）。cancelled → throw AGENT_CANCELLED
 * 向上传播（U5：不终验、不改阶段；陷阱 42：不发卡、不落收尾决策）。
 */
async function runBlockedTestRepair(input: {
  request_id: string
  session_id: string
  project_id: string
  mode: ProjectMode
  channel_id?: string
  query?: SDKQuery
  signal?: AbortSignal
  preview_url: string
}): Promise<void> {
  const lastReport = readTestReport(input.project_id)
  if (!lastReport || lastReport.failed_count === 0) return
  const project = findProject(input.project_id)
  const used = project.test_repair_count ?? 0
  const budget = resolveRepairBudget(input.mode)
  if (used >= budget) {
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'repair_budget_exhausted',
        title: '修复预算已耗尽（继续修）',
        why: `用户选择继续修，但已连续修复 ${used} 轮（${input.mode} 模式上限 ${budget}）仍未通过，本轮直接重验`,
        detail: { used, budget, mode: input.mode, via: 'blocked_resume' },
      },
    })
    // T-1 错误卡写点①b：入口 B（继续修）同口径成卡（同指纹被窗口折叠，不重复刷屏）
    recordFailureCards(
      { projectId: input.project_id, sessionId: input.session_id },
      { testResult: lastReport, abnormal: { outcomeType: 'unexpected_exit' as const, description: `继续修预算耗尽（${used}/${budget}）仍未通过` } },
    )
    return
  }
  // 无 query（存量 resume 场景）无法起修复轮：不起不报错，行为=现状重验
  if (!input.query) return

  const tasks = buildRepairTasks({ testResult: lastReport })
  if (tasks.length === 0) return
  throwIfAborted(input.signal)

  const round = used + 1
  updateProject(input.project_id, { test_repair_count: round })
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'repair_round_started',
      title: `定向修复轮启动（继续修，第 ${round}/${budget} 轮）`,
      why: `用户选择继续修：按上次终验失败快照回喂 ${tasks.length} 项修复任务，修复后重走终验门禁`,
      detail: { round, budget, mode: input.mode, via: 'blocked_resume', tasks: tasks.map((task) => ({ id: task.id, source: task.source, location: task.location })) },
    },
  })
  const repairNote = `继续修：按上次失败清单定向修复 ${tasks.length} 项（第 ${round}/${budget} 轮），完成后重新终验。`
  appendSessionMessage(input.session_id, {
    role: 'assistant',
    content: [{ type: 'text', text: repairNote }],
    timestamp: Date.now(),
  })
  publish(input, 'message_delta', { text: repairNote })

  const backplane = readPrdBackplane(input.project_id)
  const { map: skeletonMap, moduleMap } = prepareSkeletonBeforeLoop(input, backplane, project)
  const result = await runRepairLoop({
    request_id: input.request_id,
    session_id: input.session_id,
    project_id: input.project_id,
    mode: input.mode,
    ...(input.signal ? { signal: input.signal } : {}),
    channel_id: input.channel_id,
    query: input.query,
    tasks,
    round,
    buildSystem: (editFormat) => buildLoopSystemWithOverride(backplane, editFormat, input.project_id, skeletonMap, undefined, moduleMap),
    // Phase 3 B3：修复轮本轮锚（开关 off=零注入字节级现状）；完成证据=失败断言原文
    ...(roundAnchorEnabled() ? { roundAnchor: buildRepairRoundAnchor(backplane, tasks.map((task) => task.location ?? task.claim)) } : {}),
    // W2-F1：修复证据包（候选指纹+此前修复尝试；开关 off=零注入字节级现状）
    ...(loopCheckpointEnabled() ? { checkpointContext: buildRepairCheckpointContext(input.project_id) } : {}),
    // W4-F2：修改授权边界（BLOMA_REPAIR_SCOPE off=无边界字节级现状）
    ...(repairScopeEnabled() && deriveAuthorizedWritePaths(tasks) ? { authorizedWritePaths: deriveAuthorizedWritePaths(tasks) } : {}),
    thinkingLevel: resolveLoopThinkingLevel(),
    publish: (type, payload) => publish(input, type, payload),
  })

  // 修复轮未完成（渠道不可用 / 异常）：不阻断，交回终验门禁按现状收口
  if (result.status !== 'completed') return
  throwIfAborted(input.signal)

  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'repair_round_completed',
      title: '定向修复轮完成（继续修），重新终验',
      why: `第 ${round} 轮修复完成（${result.loopResult?.turns ?? 0} 轮 / ${result.loopResult?.toolCalls.length ?? 0} 次工具调用），产物已更新，重走终验门禁判定收敛`,
      detail: { round, via: 'blocked_resume', loop_status: result.loopResult?.status, failed_snapshot: lastReport.failed_count },
    },
  })
  trackAnalytics({
    request_id: input.request_id,
    event: {
      event_type: 'repair_round_completed',
      project_id: input.project_id,
      session_id: input.session_id,
      payload: {
        round,
        converged: false, // 入口 B 修复完成但收敛判定交给后续终验，此处只标记阶段
        failed_snapshot: lastReport.failed_count,
        mode: input.mode,
        via: 'blocked_resume',
      },
      privacy_level: 'research_safe',
    },
  })
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

// 注：P3 分级锚定的 focusRequirementIds 由 runIterationTask 从归一化判定派生后
// 直接并入 runMvpViaAgentLoop 调用入参（MvpTaskInput 可选字段），不经本接口。

/**
 * 迭代收尾 changelog 触发（GA-03 后半 2026-08-27，PRD §7.1「每轮迭代结束后追加 Changelog」）。
 *
 * 同步执行、失败静默降级（同 distillProjectMemorySafely 的降级原则）：文档同步是附属产物，
 * 失败绝不阻断迭代成功收尾；熔断/取消路径不调用本函数（调用位置在 runIterationTask 成功尾）。
 * 返回降级结果（当前无调用方消费返回值，保留以便未来接决策日志）。
 */
export function syncIterationCompleted(input: {
  request_id: string
  session_id: string
  project_id: string
}): DocumentSyncResult {
  try {
    return syncDocuments({ ...input, checkpoint: 'iteration_completed' })
  } catch {
    return { documents: [], stale_documents: [] }
  }
}

/**
 * runIterationTask — 已生成完成后用户提出修改诉求（打字或点选纠错）时，重新生成一版 MVP。
 *
 * 打通 Sprint 3「纠错 → 重新生成 → 迭代」主线：此前 ready 护栏把修改请求一律挡回固定文案，
 * 且 submitCorrection 只落盘不触发再生成。这里把修改诉求作为新功能项并入需求清单，进入
 * iterating 态后复用 runMvpTask + runAgentLoopPostTesting 完整闭环（重新生成 → 终验 → 裁判 → ready）。
 * 返回值两调用方均不消费；「做完整的程序」定向修复分支无新 snapshot，返回 void。
 */
export async function runIterationTask(input: IterationTaskInput): Promise<MvpTaskResult | void> {
  updateProject(input.project_id, { current_stage: 'iterating' })
  publish(input, 'stage_changed', { stage: 'iterating' })

  // 修改诉求归一化后并入需求清单，供 runMvpTask 重新生成读取（含 GWT 骨架同步）。
  // 口语碎片原样入库会污染 PRD 背板（线上案例：「重新生成」被 acceptance 解释成功能、
  // 产品里长出重置按钮），归一化失败/无渠道时回退原样追加（改动前现状），不阻断迭代。
  const existing = readLastSketchRequirements(input.project_id)
  const merged = await mergeIterationRequirements(input, existing)
  const requirements = merged.requirements
  recordSketchGenerated(input.project_id, requirements)

  // ack 如实（2026-08-27 线上案例 dbe1e6fd：「换个名字」被判 skip 后仍说「按你的新想法
  // 重新生成」，用户体感记忆断层——skip 意味着诉求未入需求，必须告知而非假装采纳）
  if (merged.action === 'skip') {
    // 「做完整的程序」类诉求路由（2026-09-06 随记灵案）：skip=无需求变更，按原清单
    // 整版重摇（longterm 40 轮）大概率复现同一批失败。上次终验若留有未通过断言且修复
    // 预算未耗尽，「把程序做完整」的正确动作是定向修复（复用入口 B 修复轮 + 终验门禁
    // 收口），不动需求清单不重摇——这就是聊天里缺的「生成完整程序」渠道。无失败快照 /
    // 预算耗尽 / 无 query → 行为=现状整版重摇。
    const lastReport = readTestReport(input.project_id)
    const repairUsed = findProject(input.project_id).test_repair_count ?? 0
    if (lastReport && lastReport.failed_count > 0 && repairUsed < resolveRepairBudget(input.mode) && input.query) {
      publishCompletionMessage(
        input,
        `收到「${truncateCopy(input.prompt, 20)}」——我把这理解成「把没做完的做完」：这一版还有 ${lastReport.failed_count} 项行为断言未通过，我先定向修复（不改需求清单），修完重新终验。`,
      )
      const previewUrl = await ensureResumePreview(input)
      await runBlockedTestRepair({ ...input, preview_url: previewUrl })
      const project = findProject(input.project_id)
      // 终验门禁收口：loop 元数据按 resume 口径重建（judge 只消费 status 判异常终止态）
      await runAgentLoopPostTesting({
        request_id: input.request_id,
        session_id: input.session_id,
        project_id: input.project_id,
        mode: input.mode,
        preview_url: previewUrl,
        ...(project.via_agent_loop
          ? { loop: { status: project.agent_loop_status ?? 'turn_limit', turns: 0, finalText: '', toolCalls: [] } }
          : {}),
        query: input.query,
        channel_id: input.channel_id,
      })
      return
    }
    publishCompletionMessage(
      input,
      `收到「${truncateCopy(input.prompt, 20)}」——这句我没当作需求改动（判为操作指令），按原样重新生成了一版。想改哪里请直接说，比如「标题改成计算助手」。`,
    )
  } else {
    publishCompletionMessage(input, `好的，我按你的新想法「${truncateCopy(input.prompt, 20)}」重新生成一版。`)
  }

  try {
    // 迭代不进入 generating_mvp 阶段（那是首次生成 MVP 的语义）：保持 iterating，
    // 只更新 PRD 背板（含合并后的需求）供 loop 增量修改，快照用 iteration 而非 mvp。
    await syncPrdCheckpoints(input, requirements)
    // P3 分级锚定：normalizer 判定焦点（reviseId/append 新项 id）透传 loop——
    // 命中项全文锚定，其余项一行摘要（只减细节不减锚）；skip/out_of_scope 无焦点=全量
    const mvp = await runMvpViaAgentLoop(
      {
        ...input,
        ...(merged.focusRequirementIds && merged.focusRequirementIds.length > 0
          ? { focusRequirementIds: merged.focusRequirementIds }
          : {}),
      },
      await tryResolveAgentLoop(input),
      'iteration',
    )
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
      // P2 失败回流（PR-C）：构建门禁结果透传终验组装器（failed → build 修复任务）
      ...(mvp.build_gate ? { buildGate: mvp.build_gate } : {}),
    })
    // T4-L3 蒸馏兜底·触发点②（每次迭代完成后，fire-and-forget）：默认关闭，
    // 失败在内部降级并落决策，绝不阻塞迭代收尾
    distillProjectMemorySafely({
      project_id: input.project_id,
      session_id: input.session_id,
      channel_id: input.channel_id,
      query: input.query,
    })
    // GA-03（PRD §7.1 触发节点「每轮迭代结束后」）：追加 Changelog，合并本轮功能项
    // 清单；fire-and-forget——写盘失败静默降级，不阻断迭代成功收尾
    syncIterationCompleted({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
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
      appendSessionMessage(input.session_id, {
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
): Promise<{
  requirements: SketchRequirement[]
  action: 'revise' | 'append' | 'skip' | 'out_of_scope' | 'raw'
  /** P3 分级锚定：本轮聚焦功能项 id（revise 的 reviseId / append·raw 的新项 id；
 *  skip/out_of_scope 无需求变更 → 空数组=全量锚定） */
  focusRequirementIds?: string[]
}> {
  const appendRaw = (): { requirements: SketchRequirement[]; action: 'raw'; focusRequirementIds: string[] } => {
    const newId = nextRequirementId(existing)
    return { requirements: [...existing, { id: newId, description: input.prompt }], action: 'raw', focusRequirementIds: [newId] }
  }
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
      // 推理档位试点（reasoning-profile 2026-08-27）：归一化语义判定启用 high；
      // 仅 deepseek-v4* / glm 系 profile 实际生效，其余模型/omit 渠道自动落回现状
      thinkingLevel: 'high',
      providerType: resolution.channel?.provider_type,
    })
    if (normalization.action === 'out_of_scope' && normalization.outOfScope) {
      addScopeExclusion(input.project_id, normalization.outOfScope)
    }
    if (normalization.via === 'llm') {
      recordRequirementNormalization(input, 'iteration', input.prompt, normalization)
    }
    const nextId = nextRequirementId(existing)
    const requirements = applyNormalization(existing, normalization, nextId, 'iteration')
    // P3 分级锚定焦点派生：revise → 目标项 id（目标缺失回退 append 形态则取新项 id）；
    // append → 新项 id；skip/out_of_scope → 无需求变更不聚焦（全量锚定）
    const focus: string[] = []
    if (normalization.action === 'revise' && normalization.reviseId) {
      focus.push(existing.some((item) => item.id === normalization.reviseId) ? normalization.reviseId : nextId)
    } else if (normalization.action === 'append') {
      focus.push(nextId)
    }
    return { requirements, action: normalization.action, ...(focus.length > 0 ? { focusRequirementIds: focus } : {}) }
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

// R4 群目录归位（2026-09-03）：迭代挂起状态管理已迁 main/iteration/pending.ts
// （iteration 群独立状态面）；此处 import + re-export 保持旧导出面不变
// （存量消费者与 vi.mock 工厂零改动）。runIterationTask 本体仍在本文件
// （与 runMvpTask 共享内部函数，拆分挂后续独立批次）。
import {
  isIterationDecisionId,
  setFailedIteration,
  setPendingIteration,
  takeFailedIteration,
  takePendingIteration,
} from '../iteration/pending'
export {
  isIterationDecisionId,
  setFailedIteration,
  setPendingIteration,
  takeFailedIteration,
  takePendingIteration,
} from '../iteration/pending'
export type { IterationDecisionId, PendingIteration } from '../iteration/pending'

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
  appendSessionMessage(input.session_id, {
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
  context?: BlockedDecisionContext,
): void {
  updateProject(input.project_id, { current_stage: 'blocked_for_user_decision', blocked_action: action })
  publish(input, 'stage_changed', { stage: 'blocked_for_user_decision' })
  publish(input, 'user_decision_required', {
    kind: 'blocked',
    stage: 'blocked_for_user_decision',
    // U7：让渡卡片带上具体偏差描述（如「缺了按月统计功能」），落到 title 字段由渲染端展示
    title,
    // Phase 7 U2 H5：条件化选项（BLOMA_DECISION_CONDITIONAL on 时按失败原因推荐主按钮；
    // off = BLOCKED_DECISION_QUESTIONS 字节级现状）
    questions: buildBlockedQuestions(context),
  })
  // 终态补发（2026-08-29 线上卡死案例 eb900c57）：让渡路径此前只发 stage_changed +
  // user_decision_required，渲染端 running 只有 completed/error 能复位 → UI 永久停在
  // 「生成中」、停止按钮点了没反应。把让渡问题沉淀为助手消息并补发 completed，让输入框
  // 回到可发送状态（决策卡片仍展示，等用户点选 resume）。前台 runAgent 流除外——它自带
  // 终态，中途补发会提前熄掉运行指示（resume 的继续尝试可能跑几分钟）。
  const text = `这里需要你来定夺：${title ?? '当前进度需要你确认下一步'}。`
  appendSessionMessage(input.session_id, {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  })
  publish(input, 'message_delta', { text })
  if (!foregroundRunChecker(input.session_id)) {
    publish(input, 'completed', { subtype: 'blocked' })
  }
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

  // Phase 7 U5 J5：decision_selected 埋点（阶段+动作——决策卡转化度量；v0 接
  // blocked 让渡卡一处，ready_next_steps 等其余卡待后续批次）
  try {
    trackAnalytics({
      request_id: input.request_id,
      event: {
        event_type: 'decision_selected',
        project_id: input.project_id,
        session_id: input.session_id,
        payload: { stage: 'blocked_for_user_decision', action: input.decision, blocked_action: findProject(input.project_id).blocked_action ?? null },
        privacy_level: 'research_safe',
      },
    })
  } catch {
    // 埋点失败不影响 resume 链
  }

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
    // Phase 7 U2 H6（BLOMA_DECISION_CONDITIONAL on）：「先使用已可用的部分」语义——
    // 不改 delivery_status（终验链路规则字段）、不清除问题清单；accept 话术如实带上
    // 已知未通过项（持续可见，用户接受版本也不能把未通过变成已通过）。
    // off = 原话术字节级。
    if (decisionConditionalEnabled()) {
      const testReport = readTestReport(input.project_id)
      const knownIssues = testReport && testReport.failed_count > 0
        ? `注意：这一版仍有 ${testReport.failed_count} 项检查未通过（${testReport.failure_summary.slice(0, 3).map((f) => f.scenario).join('；')}${testReport.failed_count > 3 ? ' 等' : ''}），这些不算完成；已通过的功能可以正常使用。随时可以说「先修好没做好的」。`
        : ''
      publishCompletionMessage(
        input,
        `好的，先使用已可用的部分。${knownIssues || '你可以点右侧预览区继续试用，有需要调整的随时告诉我。'}`,
      )
    } else {
      publishCompletionMessage(input, '好的，已保留当前版本。你可以点右侧预览区继续试用，有需要调整的随时告诉我。')
    }
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
      // P2 失败回流（PR-C）：构建门禁结果透传终验组装器（failed → build 修复任务）
      ...(mvp.build_gate ? { buildGate: mvp.build_gate } : {}),
    })
    return
  }

  if (action === 'test_repair') {
    updateProject(input.project_id, { test_repair_count: 0 })
    const previewUrl = await ensureResumePreview(input)
    // P2 失败回流（入口 B，PR-C）：从「空转重验」升级为「先修再验」——上次让渡时的
    // 失败快照（test-report.json）直接组装修复任务，先跑一轮定向修复再走终验门禁，
    // 避免产物未变重验原地失败；无失败快照 / 无预算 / 修复轮未完成 → 行为=现状重验。
    // （终验内部仍带入口 A 的自动修复轮，两层互不冲突：预算计数共享 test_repair_count）
    await runBlockedTestRepair({ ...input, preview_url: previewUrl })
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
async function ensureResumePreview(input: { request_id: string; project_id: string; channel_id?: string; session_id?: string }): Promise<string> {
  const sandbox = await runSandbox({
    request_id: input.request_id,
    project_id: input.project_id,
    command: 'node static-server',
    llm_env: buildAppLlmEnv(input),
  })
  if (sandbox.status !== 'running' || !sandbox.preview_url) {
    throw new Error(`SANDBOX_RUN_FAILED:${sandbox.error_summary?.category ?? 'unknown'}`)
  }
  return sandbox.preview_url
}

/**
 * 产物 AI 代理环境（完整程序渠道，2026-09-06）：把 mvp 类别渠道的 base/key/model
 * 以 BLOMA_APP_LLM_* 注入产物 static-server 进程——生成的应用经同源 /api/llm 代理
 * 调用真实模型，AI 功能不再是前端写死的模拟。密钥只落服务器进程 env（沙箱 spawn
 * 参数），绝不写进前端代码/项目文件；渠道不可用或字段缺失 → undefined（产物
 * /api/llm 如实 503 llm_not_configured，前端失败态兜住）。
 */
function buildAppLlmEnv(input: { channel_id?: string; project_id: string }): Record<string, string> | undefined {
  try {
    const resolution = resolveChannelEnv({ channelId: input.channel_id, category: 'mvp', projectId: input.project_id })
    const env = resolution.env
    const base = env?.ANTHROPIC_BASE_URL
    const key = env?.ANTHROPIC_AUTH_TOKEN
    const model = env?.ANTHROPIC_MODEL
    if (!base || !key || !model) return undefined
    return {
      BLOMA_APP_LLM_BASE_URL: base,
      BLOMA_APP_LLM_KEY: key,
      BLOMA_APP_LLM_MODEL: model,
      BLOMA_APP_LLM_PROTOCOL: resolution.channel?.provider_type === 'anthropic' ? 'anthropic' : 'openai',
    }
  } catch {
    // 渠道解析异常（测试字面 id 等）→ 无 AI 环境降级，不阻断预览
    return undefined
  }
}
