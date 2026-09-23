/**
 * 草图阶段（PR3b 拆出）：runSketchTask 与 LLM 解析/兜底链、项目自动命名、任务/结果契约类型。
 * 纯机械搬移（零行为变化）；对外契约经 programming-orchestrator re-export 保持不变。
 */
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, AgentLoopJudgeMetadata, AgentSendMessageInput, Channel, ChannelModel, DocumentSyncResult, MessageContentBlock, Project, ProjectMode, Snapshot, SnapshotKind, TemplateType } from '../../../shared/types'
import type { ThinkingLevel } from '../../../shared/reasoning-profile'
import { getAgentSessionPath, getDocumentsDir } from '../../../storage/config-paths'
import { appendSessionMessage } from '../../platform/sessions/session-tree'
import { emitAgentEvent } from '../../platform/events/agent-event-bus'
import { appendLoopLogDocument, loopLogEnabled, readLoopCheckpointDocument, readPrdBackplane, readUxContractSketch, renamePrdProject, syncDocuments, updateRequirementStatus, writeLoopCheckpointDocument, writeSecurityScanDocument, type LoopLogEntry, type LoopRepairAttemptRecord, writePlanDocument } from '../../project/document-engine'
import { appendProjectLearning } from '../../project/learnings-log'
import { runSandbox } from '../../delivery/sandbox'
import { createSnapshot } from '../../delivery/snapshots'
import { trackAnalytics } from '../../delivery/track-analytics'
import { renderPackageJson, renderStaticServer, renderSkeletonToProject, scaffoldEnabled } from '../project-scaffold'
import { runBuildGate, type BuildGateResult } from '../build-gate'
import { rebuildRealFullstackDist } from '../dist-rebuild'
import { runArtifactUiGate, uiGateEnabled, uiProbeNotes, type ArtifactUiGateResult } from '../artifact-ui-gate'
import { getCachedStaticEvidence, setCachedStaticEvidence } from '../../verification/evidence-cache'
import { runVisionAuditGate } from '../vision-audit-gate'
import { buildRepairTasks, resolveRepairBudget, runRepairLoop, repairScopeEnabled, repairNoopGuardEnabled, hasWriteEditToolCall, type RepairCheckpointContext, type RepairTask } from '../repair-loop'
import { buildIterationTask, ITERATION_MODE_SECTION, iterationBriefEnabled, resolveAgentLoopMaxTurnsLocal } from '../iteration-brief'
import { appendContextPack, buildContextPack } from '../context-pack'
import { buildChangeContractBlock, changeContractEnabled, deriveChangeContract, roundAnchorFromChangeContract } from '../change-contract'
import { buildRuleInjectionMap, deriveCapabilitiesFromBackplane, recordRuleActionObserved } from '../../experience/rule-injection'
import { appendExperienceEvent } from '../../experience/event-log'
import { recordFailureCards } from '../../experience/error-card'
import { generateLoopPlan, planLegEnabled, renderPlanInjection, renderPlanMarkdown, renderTaskChecklist, type LoopPlan } from '../../agent/loop/loop-planner'
import { addScopeExclusion, findProject, readLastSketchRequirements, recordSketchGenerated, updateProject } from '../../project/project-service'
import { appendProjectMapToSystem, loadProjectMapBlock } from '../../project/project-map'
import { resolveChannelEnv } from '../../platform/llm/runtime-fallback'
import { loadRealScaffoldTemplate, loadSkeletonTemplate, realScaffoldEnabled, REAL_SCAFFOLD_TYPES, type ProjectSkeleton } from '../../project/project-templates'
import { readRealScaffoldVariant, writeRealScaffoldMarker } from '../preview-runtime'
import { buildLoopInjection, buildSkeletonMapInjection } from '../../agent/prompting/template-injection'
import { buildModuleMapInjection, loadOfficialModules, modulesEnabled, renderOfficialModulesToProject } from '../module-library'
import { listRefPatternModules, refLibraryEnabled } from '../../experience/ref-source'
import { backplaneInterfaceSpec, buildIterationRoundAnchor, buildRepairRoundAnchor, focusAnchorEnabled, gameDeriveExemptEnabled, renderBackplaneAnchor, renderRoundAnchorBlock, roundAnchorEnabled } from '../../model/prd-backplane'
import { gwtGameProbeEnabled } from '../../verification/gwt-runner'
import { renderRulesSection, rulesForTemplateType, rulesRegistryEnabled } from '../../agent/prompting/rules-registry'
import { renderExpressionSection } from '../../agent/prompting/prompt-expression'
import { captureConstraints, extractConstraints, readProjectConstraints, sanitizeConstraints } from '../../guide/constraint-extractor'
import { generateSketch, backplaneKeyTasks, requirementAssertions, requirementPriority, requirementStatusLabel, requirementStory, type GenerateSketchResult, type PrdBackplane, type SketchRequirement } from '../sketch-engine'
import { generateSketchLlm, SketchLlmError, type SketchAttemptDetail } from '../sketch-engine-llm'
import { applyNormalization, normalizeRequirementUpdate, recordRequirementNormalization } from '../../guide/requirement-normalizer'
import { readTestReport, runGwtScenarios, writeTestReport, type GwtFailureSummary, type GwtTestResult } from '../../verification/gwt-service'
import { renderSecurityScanMarkdown, runSecurityScan } from '../../verification/security-scan'
import { runJudge, readArtifactText, type JudgeVerdict } from '../../review/judge-engine'
import { runSemanticJudgeReview } from '../../review/judge-semantic'
import { loadPromptOverride } from '../../agent/prompting/prompt-config'
import { assertToolAllowed } from '../../agent/permissions/permission-service'
import { recordDecision } from '../../project/decision-log'
import { commitProjectState } from '../project-git'
import { CircuitBreakSettledError, circuitBreakRollback, isCircuitBreakSettled } from '../../orchestration/recovery-service'
import { readPrimaryIntent, recordSessionActivity } from '../../platform/sessions/session-service'
import { runAgentLoop, loopApiToolEnabled, loopCheckpointEnabled, preflightEnabled, narrationEventsEnabled, loopProgressNudgeEnabled, taskWorkflowEnabled, compactToolEnabled, type AgentLoopResult, type LoopCheckpointSnapshot } from '../../agent/loop/agent-loop'
import { browserToolsEnabled } from '../preview-browser'
import { deliveryStatusEnabled, recordDeliveryStatus, buildDeliveryPresentation, renderCircuitFailureNote, renderDeliveryBody, featureIdFromScenario } from '../delivery-status'
import { isDegenerateText } from '../output-integrity'
import { checkApiContract } from '../api-contract'
import { apiReconcileEnabled, checkMediaSourceDiscipline, reconcileApiUsage } from '../api-reconcile'
import { checkDataMigrationDiscipline, dataMigrateContractSection, dataMigrateEnabled, runMigrationDrill, type MigrationDrillResult } from '../data-migration'
import { buildAgentTools } from '../../agent/tools/agent-tools'
import { disposeParentDelegationState, registerParentLoopContext, setChildToolsBuilder } from '../../agent/delegation/agent-collaboration'
import { categoryTemperature, resolveGenerationMaxTokens } from '../../platform/llm/model-resolution'
import type { SDKQuery, ToolDefinition } from '../../orchestration/orchestrator'
import { resolvePrdBackplane } from '../../guide/pipeline'

// R3 迁移过渡：resolvePrdBackplane 已迁 guide/pipeline（向导群·PRD 收敛管线），
// 此处 re-export 保持既有调用方/测试 import 路径零改动（R4 群目录归位后统一收口）。
export { resolvePrdBackplane }

import { DEFAULT_MAX_TOKENS, ProgrammingEventPublisher, publish, throwIfAborted } from './stage-runtime'
import { allowAutomatedTool } from './blocked-flow'
import { runMvpTask } from './generate'
import { runAgentLoopPostTesting } from './final-verify'

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
  /** Phase 8 W1：迭代路径透传的用户修改诉求原话（局部优化任务书主体；生成路径不传）。
 *  仅 localOnly 路径消费（buildIterationTask），rebuild/全量生成忽略。 */
  prompt?: string
  /** P3 迭代分级锚定：本轮聚焦的功能项 id（normalizer reviseId / append 新项 id）；
 *  仅迭代路径传入，生成路径缺省=全量锚定现状。受 BLOMA_FOCUS_ANCHOR 开关门控。 */
  focusRequirementIds?: string[]
  /** 局部修改（2026-09-11「提出意见」路径）：强制开启聚焦锚定，无视快速/长期模式默认——
   *  用户明确只要改这一处，必须把「其余功能项保持现状勿重做」送达模型。 */
  localOnly?: boolean
  /** 整版重做（2026-09-11「整版重做」路径）：不聚焦（全量锚定）、允许大改；
   *  与 localOnly 互斥语义（同时传以 rebuild 为准）。 */
  rebuild?: boolean
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


/**
 * 前台运行探针（让渡终态补发用）：由 ipc.ts 接线注入 orchestrator.hasForegroundRun。
 * 缺省 () => false = 视为无前台运行（单测环境），让渡路径总是补发终态——宁可多发一个
 * 幂等 completed，不可再让 UI 永久卡「生成中」。
 */
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
export type SketchFallbackReason = 'no_channel' | 'no_query' | 'decrypt_failed' | 'no_model' | 'llm_failed'

/** resolveSketch 的产物：结果 + 来源。模板路径必带 fallbackReason（LLM 路径不带）。 */
export interface ResolvedSketch {
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
export async function resolveSketch(input: SketchTaskInput, requirements: SketchRequirement[]): Promise<ResolvedSketch> {
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
export function sketchFallbackCopy(reason: SketchFallbackReason): string {
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
export const PROJECT_NAME_MAX_LENGTH = 12

export const NAMING_SYSTEM_PROMPT = `你是产品命名助手。根据用户的原始需求和 PRD 摘要，给这个软件项目起一个简短的中文名。
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
export async function nameByLlm(input: MvpTaskInput): Promise<string | null> {
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

export function extractQueryText(blocks: MessageContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

/**
 * 清洗模型输出：取首个非空行、剥包裹引号；长度异常或含句内标点
 * （说明性输出如「好的，我建议命名为：」）视为不合格交回兜底。
 */
export function sanitizeLlmName(raw: string): string | null {
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
export const VERB_PREFIX_PATTERN =
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

