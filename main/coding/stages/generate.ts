/**
 * 生成阶段（PR3b 拆出）：runMvpTask、agent loop 渠道解析/工具探测、骨架/模块库/锚准备、检查点持久化、loop 计划腿、runMvpViaAgentLoop 主循环。
 * 纯机械搬移（零行为变化）；对外契约经 programming-orchestrator re-export 保持不变。
 */
/** 市调/网页检索类工具的单轮预算上限（原文件 72 行，PR3b 拆分时补回定义）。 */
const WEB_RESEARCH_BUDGET = 4

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
import { buildDomainTools, domainToolOptionsDefaults } from '../tool-handlers'
import { disposeParentDelegationState, registerParentLoopContext, setChildToolsBuilder } from '../../agent/delegation/agent-collaboration'
import { categoryTemperature, resolveGenerationMaxTokens } from '../../platform/llm/model-resolution'
import type { SDKQuery, ToolDefinition } from '../../orchestration/orchestrator'
import { resolvePrdBackplane } from '../../guide/pipeline'

// R3 迁移过渡：resolvePrdBackplane 已迁 guide/pipeline（向导群·PRD 收敛管线），
// 此处 re-export 保持既有调用方/测试 import 路径零改动（R4 群目录归位后统一收口）。
export { resolvePrdBackplane }

import { AUTOMATED_PERMISSION_MODE, publish, throwIfAborted } from './stage-runtime'
import { allowAutomatedTool, buildAppLlmEnv, resumeBlockedFlow } from './blocked-flow'
import { MvpTaskInput, MvpTaskResult, autoNameProject } from './sketch-task'
import { buildAgentLoopTask, buildLoopSystemWithOverride, syncPrdCheckpoints } from './loop-prompt'
import { runIterationTask } from './iterate'

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

  // T4-L3 蒸馏层已于 2026-09-12 冻结（记忆栈审计裁定 ①）：本层默认关闭且**未接注入面**
  // （memory.json 无任何读取方），生产触发点一律移除——不再「写了没人读」。层代码与单测
  // 保留作实验资产；若将来要启用，须先实现注入面并经产品决策（见 .context 记忆栈审计）。

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

/** Phase 10 W1-1 接线：产物 git 生命周期提交（fail-open；跳过仅记 decision，不阻塞主链路）。 */
export function commitProjectLifecycle(projectId: string, sessionId: string, kind: string, summary: string): void {
  try {
    const r = commitProjectState(findProject(projectId).root_path, { kind, summary })
    if (!r.ok && r.reason && r.reason !== 'disabled' && r.reason !== 'nothing_to_commit') {
      recordDecision({ project_id: projectId, session_id: sessionId, entry: { type: 'project_git', title: '产物 git 提交跳过', why: `fail-open：${r.reason}`, detail: { kind, reason: r.reason } } })
    }
  } catch { /* fail-open：绝不阻塞主链路 */ }
}

/**
 * MVP 产物就绪后的交付尾巴（权限门 → mvp 快照 → mvp_delivered 埋点 → testing →
 * mvp_ready），管道路径与 Agent Loop 路径共用，保证两条路的检查点语义一致。
 */
export async function finalizeMvpDelivery(
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
  // Phase 10 W1-1：产物 git 交付点提交（首次 mvp / 迭代交付两态）
  commitProjectLifecycle(input.project_id, input.session_id, snapshotKind === 'mvp' ? 'mvp_delivered' : 'iteration_delivered', `交付快照 ${snapshot.snapshot_id.slice(0, 8)}（${detail.snapshotSummary}）`)
  // Phase 10 W3：行动规则 action_observed（被注入项目回看工具调用序列；未注入零副作用）
  recordRuleActionObserved(input.project_id, (detail.loopResult?.toolCalls ?? []).map((t) => t.name))

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
export const AGENT_LOOP_MAX_TURNS_DEFAULTS: Record<ProjectMode, number> = { quick: 24, longterm: 40 }

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

/**
 * Phase 8 W1：轮次预算按任务比例收窄——局部修改轮（localOnly + 开关开）用独立档
 * （BLOMA_LOOP_MAX_TURNS_LOCAL 缺省 12），其余路径字节级=现状 resolveAgentLoopMaxTurns。
 * 对齐「过程按比例」原则：一行修复不应占用全量 40 轮预算，小预算快速熔断损失可控。
 */
export function resolveLoopMaxTurnsForInput(input: { mode: ProjectMode; localOnly?: boolean; rebuild?: boolean }): number {
  if (iterationBriefEnabled() && input.localOnly && !input.rebuild) return resolveAgentLoopMaxTurnsLocal()
  return resolveAgentLoopMaxTurns(input.mode)
}

/** Phase 8 W1：局部修改轮聚焦任务书是否生效（开关开 + localOnly + 非 rebuild）。 */
export function iterationBriefActive(input: { localOnly?: boolean; rebuild?: boolean }): boolean {
  return iterationBriefEnabled() && input.localOnly === true && input.rebuild !== true
}

/** 子 agent 独立轮次上限（比主 loop 小，控制委派 token 成本；按埋点标定）。 */
export const DELEGATION_MAX_TURNS = 12

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
export const toolSupportCache = new Map<string, boolean>()

/** 探测用最小工具定义（不执行，只看模型会不会发起 tool_use）。 */
export const TOOL_SUPPORT_PROBE: ToolDefinition = {
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
export async function tryResolveAgentLoop(input: MvpTaskInput): Promise<AgentLoopChannelContext> {
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
export function agentLoopChannelError(input: MvpTaskInput, code: string, message: string): Error {
  recordAgentLoopUnavailable(input, message)
  publish(input, 'error', { code, message })
  return new Error(message)
}

/** 探测：发一个带 tools 的最小请求。返回 true/false；探测自身失败返回 undefined。 */
export async function probeToolSupport(
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

export function recordAgentLoopUnavailable(input: MvpTaskInput, reason: string): void {
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
export function errorCodeFrom(message: string): string {
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
export function prepareSkeletonBeforeLoop(
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
      // W1 真实脚手架（BLOMA_REAL_SCAFFOLD）：web 形态类型的新项目按 interface_spec 两态判定
      // （非空→ real-fullstack Express 真实工程；空→ real-static 纯静态一等公民）；
      // 判定依据是 PRD 契约本身（背板），与旧路径「模板类型猜测」解耦。
      const useRealScaffold = realScaffoldEnabled() && REAL_SCAFFOLD_TYPES.has(templateType)
      skeleton = useRealScaffold
        ? loadRealScaffoldTemplate(backplaneInterfaceSpec(backplane).length > 0, {
            project_id: input.project_id,
            session_id: input.session_id,
          })
        : loadSkeletonTemplate(templateType, { project_id: input.project_id, session_id: input.session_id })
    } catch {
      skeleton = null
    }
    if (skeleton) {
      try {
        rendered = renderSkeletonToProject(skeleton, project.root_path)
        // W3：真实脚手架标记落盘（预览/交付链/工具面的权威判定源；随快照归档恢复）
        if (skeleton.variant) {
          try {
            writeRealScaffoldMarker(project.root_path, skeleton.variant)
          } catch {
            // 标记写失败不影响骨架生效（运行时回旧路径行为，fail-open）
          }
        }
        try {
          recordDecision({
            project_id: input.project_id,
            session_id: input.session_id,
            entry: {
              type: 'skeleton_rendered',
              title: '工程骨架先行渲染',
              why: `loop 前按 ${templateType} 模板 v${skeleton.version} 渲染骨架（源=${skeleton.source}${skeleton.variant ? `，真实脚手架变体=${skeleton.variant}` : ''}），编程 Agent 在骨架上填充实现；已存在文件跳过不覆盖`,
              detail: {
                template_type: templateType,
                variant: skeleton.variant,
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
export function prepareModuleLibrary(input: MvpTaskInput, templateType: TemplateType, project: Project): string | null {
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
export function mergeAssetMap(skeletonMap: string | null, moduleMap: string | null, ruleMap?: string | null): string | null {
  return [skeletonMap, moduleMap, ruleMap].filter(Boolean).join('\n\n') || null
}

/** P3 分级锚定解析：focusRequirementIds 非空且开关开（BLOMA_FOCUS_ANCHOR 缺省
 * longterm=on / quick=off，D7 连锁）才生效；否则 undefined=全量锚定现状。 */
export function resolveFocusAnchor(input: MvpTaskInput): string[] | undefined {
  // 整版重做：不聚焦（全量锚定、允许大改）——即使 normalizer 派生了焦点也忽略。
  if (input.rebuild) return undefined
  const ids = input.focusRequirementIds
  if (!ids || ids.length === 0) return undefined
  // localOnly（「局部优化」）：强制开启聚焦，无视 quick/longterm 默认——
  // 用户明确只要改这一处，必须把「其余保持现状勿重做」的锚定送达模型。
  if (!input.localOnly && !focusAnchorEnabled(input.mode)) return undefined
  return ids
}

/** loop-log 追加（BLOMA_LOOP_LOG 开关 + 失败静默：诊断增强不是依赖，绝不阻断主链路）。 */
export function appendLoopLogSafely(projectId: string, entry: LoopLogEntry): void {
  if (!loopLogEnabled()) return
  try {
    appendLoopLogDocument(projectId, entry)
  } catch {
    // 写盘失败静默
  }
}

/** W2-E2/E3：检查点 runtime 投影持久化（BLOMA_LOOP_CHECKPOINT off=零写盘；失败静默不阻断）。 */
export function persistCheckpointRuntime(projectId: string, snapshot: LoopCheckpointSnapshot): void {
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
export function buildRepairCheckpointContext(projectId: string): RepairCheckpointContext {
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
export function deriveAuthorizedWritePaths(tasks: RepairTask[]): string[] | undefined {
  const paths = [...new Set(tasks.map((task) => task.location ?? '').filter((loc) => /\.(js|html|css)$/i.test(loc)))]
  return paths.length > 0 ? paths : undefined
}

/** W2-F1：修复尝试记录追加进检查点账本（保留 runtime 投影不动）。 */
export function appendRepairAttemptRecord(projectId: string, record: LoopRepairAttemptRecord): void {
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
export async function tryGenerateLoopPlanLeg(
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
    // Phase 8 W2-3：局部修改轮定位合同（只改既有文件；模型给出不存在文件时硬剔除）
    ...(iterationBriefActive(input)
      ? { localOnly: true, localPrompt: input.prompt, projectRootPath: findProject(input.project_id).root_path }
      : {}),
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

export async function runMvpViaAgentLoop(input: MvpTaskInput, loop: AgentLoopChannelContext, snapshotKind: SnapshotKind = 'mvp'): Promise<MvpTaskResult> {
  const project = findProject(input.project_id)
  const backplane = readPrdBackplane(input.project_id)
  const editFormat = loop.model?.edit_format ?? 'diff'
  const startedAt = Date.now()
  // PR-1 骨架先行 + 官方模块库：渲染成功后骨架地图/模块地图随 system prompt 常驻（事实与注入同源）
  // Phase 8 W2-2：局部修改轮跳过骨架/模块库重渲染——项目已实现（骨架幂等跳过只剩决策
  // 噪音），文件全貌由项目地图（buildLoopSystemWithOverride 尾部注入）承担；跳过如实落决策。
  // 非 localOnly / 开关关 = 现状渲染（字节级）。
  if (iterationBriefActive(input)) {
    try {
      recordDecision({
        project_id: input.project_id,
        session_id: input.session_id,
        entry: {
          type: 'skeleton_render_skipped_local',
          title: '局部修改轮跳过骨架/模块库重渲染',
          why: 'localOnly 聚焦任务书生效：项目已实现，文件全貌由项目地图（system 尾部注入）承担，重渲染只产生决策噪音',
        },
      })
    } catch {
      // 决策日志失败不阻断主链路
    }
  }
  const { map: skeletonMap, skeleton, rendered, moduleMap } = iterationBriefActive(input)
    ? { map: null as string | null, skeleton: null as ProjectSkeleton | null, rendered: undefined, moduleMap: null as string | null }
    : prepareSkeletonBeforeLoop(input, backplane, project)
  // P3 分级锚定：focus 生效时（迭代路径透传 + BLOMA_FOCUS_ANCHOR 开）背板/骨架地图
  // 裁细节不减锚；生成路径/开关关 → undefined=全量锚定现状（字节级等价）
  const focus = resolveFocusAnchor(input)
  // P3 plan 腿：loop 前单轮技术合同（D2 参考合同：偏离旁白说明，不硬拦截）；
  // 失败/关闭 fail-open 回退现状（planInjection 为 null 时拼接函数字节级=现状）。
  // plan 腿输入用全量资产地图（骨架+模块，规划需要全貌），分级只作用于 loop system 注入。
  // Phase 10 W3：行动规则第三参（BLOMA_EXP_RULE_INJECT off=null 字节级；条件—动作—证据）
  const ruleMap = await buildRuleInjectionMap({
    projectId: input.project_id,
    stage: 'implement',
    templateType: findProject(input.project_id).template_type,
    capabilities: deriveCapabilitiesFromBackplane(backplane),
  })
  const loopPlan = await tryGenerateLoopPlanLeg(input, loop, backplane, mergeAssetMap(skeletonMap, moduleMap, ruleMap), focus)
  const planInjection = loopPlan ? renderPlanInjection(loopPlan) : null
  // 骨架地图分级（注入侧，零改 prepare 语义）：plan 存在且 focus 生效时，非目标文件
  // 降为存在性行（路径锚不丢，D3）；无 plan / 无 focus → 全量地图现状。模块地图不分级。
  const effectiveSkeletonMap =
    skeletonMap && focus && loopPlan && skeleton && rendered
      ? buildSkeletonMapInjection(skeleton, rendered, loopPlan.filesToTouch.map((file) => file.path))
      : skeletonMap
  const buildSystemWithPlan = (fmt: 'diff' | 'whole'): string => {
    const base = buildLoopSystemWithOverride(backplane, fmt, input.project_id, effectiveSkeletonMap, focus, moduleMap)
    // Phase 3 B3：迭代轮本轮锚（聚焦路径才有；开关 off=零注入字节级现状）。
    // Phase 8 W1：localOnly（局部优化）强制开启——照 resolveFocusAnchor 的 localOnly
    // 先例（用户明确只要改这一处，本轮锚必须送达；开关总开关 off 时字节级现状）。
    // Phase 10 W1-4：契约激活时本轮锚由变更契约派生（见下方 changeContract 块）。
    const briefActive = iterationBriefActive(input)
    // Phase 8 W1：【修改模式】段（语义对齐 repair-loop REPAIR_MODE_SECTION：任务书即
    // 全部工作，不要重新生成整个项目）；非 localOnly / 开关关 = 零注入字节级现状。
    const iterationModeBlock = briefActive ? `\n\n${ITERATION_MODE_SECTION}` : ''
    // Phase 10 W1-4：变更契约（BLOMA_CHANGE_CONTRACT on 时：契约派生本轮锚 + system
    // 增【变更契约】段；off 零派生零注入字节级。fail-open：派生失败回退既有锚路径）
    let changeContractBlock = ''
    let contractAnchorBlock: string | null = null
    if (changeContractEnabled()) {
      try {
        const lastReport = readTestReport(input.project_id)
        const pack = buildContextPack(input.project_id, input.prompt)
        const contract = deriveChangeContract({
          goal: input.prompt ?? '',
          backplane,
          ...(focus && focus.length > 0 ? { focus } : {}),
          dataFiles: pack.dataFiles.map((d) => d.file),
          baseline: lastReport ? { passed: lastReport.passed_count, total: lastReport.total_count } : null,
        })
        contractAnchorBlock = `\n\n${renderRoundAnchorBlock(roundAnchorFromChangeContract(contract))}`
        changeContractBlock = buildChangeContractBlock(contract)
      } catch {
        // fail-open：契约派生失败回退既有锚路径
      }
    }
    const roundAnchorBlock =
      contractAnchorBlock ??
      (focus && focus.length > 0 && (roundAnchorEnabled() || briefActive)
        ? `\n\n${renderRoundAnchorBlock(buildIterationRoundAnchor(backplane, focus))}`
        : '')
    // W5-1（Phase 8.5）：实施清单（checklist 化 plan）——生成路径且开关开时注入，
    // 提供逐项推进工作结构；局部修改轮不叠加（聚焦任务书已含工作法）
    const checklistBlock = !briefActive && taskWorkflowEnabled() && loopPlan ? `\n\n${renderTaskChecklist(loopPlan)}` : ''
    return planInjection
      ? `${base}${roundAnchorBlock}${iterationModeBlock}${changeContractBlock}\n\n${planInjection}${checklistBlock}`
      : `${base}${roundAnchorBlock}${iterationModeBlock}${changeContractBlock}${checklistBlock}`
  }
  // 委派协作（嫁接方案 §4.1）：注册父 loop 上下文供 delegate_agent 构建子循环；子工具集按 role 裁剪
  setChildToolsBuilder((projectId, role, editFormat) => [...buildAgentTools({ projectId, role, editFormat, ...domainToolOptionsDefaults(projectId) }), ...buildDomainTools({ projectId, role, editFormat, ...domainToolOptionsDefaults(projectId) })])
  registerParentLoopContext(input.session_id, {
    query: input.query!,
    env: loop.env,
    maxTokens: resolveGenerationMaxTokens(loop.channel),
    maxTurns: resolveLoopMaxTurnsForInput(input),
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
      why: `BLOMA_AGENT_LOOP=1 且渠道 ${loop.channel.name}/${loop.env.ANTHROPIC_MODEL} 支持 tool use，MVP 走 agentic loop 生成（maxTurns=${resolveLoopMaxTurnsForInput(input)}，edit_format=${editFormat}${iterationBriefActive(input) ? '，局部修改轮聚焦任务书生效' : ''}）`,
      detail: {
        repair_budget_mapping: 'loop 内「GWT 失败后的 edit_file/write_file」预算 3 次，同构旧管道 test_repair_count ≤ 3',
        max_turns: resolveLoopMaxTurnsForInput(input),
        edit_format: editFormat,
      },
    },
  })

  // Phase 8 W1：局部修改轮聚焦任务书生效如实落决策（任务书快照入账，事后可审计）
  if (iterationBriefActive(input)) {
    try {
      recordDecision({
        project_id: input.project_id,
        session_id: input.session_id,
        entry: {
          type: 'iteration_brief',
          title: '局部修改轮聚焦任务书生效',
          why: `localOnly 路径不再使用全量 MVP 任务书：用户诉求原话即任务主体（maxTurns 收窄至 ${resolveLoopMaxTurnsForInput(input)}），system 附【修改模式】段与本轮锚`,
          detail: {
            task: buildIterationTask(input.prompt ?? ''),
            max_turns: resolveLoopMaxTurnsForInput(input),
          },
        },
      })
    } catch {
      // 决策日志失败不阻断主链路
    }
  }

  let result: AgentLoopResult
  // P3 loop-log：会话头先行（mode/maxTurns/plan 摘要行——B 依赖 A 的合同存在性）；
  // 开关关/写盘失败均静默（诊断增强不是依赖）
  appendLoopLogSafely(input.project_id, {
    kind: 'session_start',
    mode: input.mode,
    maxTurns: resolveLoopMaxTurnsForInput(input),
    planSummary: loopPlan
      ? `${loopPlan.filesToTouch.length} 个目标文件：${loopPlan.filesToTouch.map((file) => file.path).join('、')}`
      : null,
    label: snapshotKind === 'iteration' ? (iterationBriefActive(input) ? '迭代重生成（局部修改）' : '迭代重生成') : 'MVP 生成',
  })
  // 异常终态的计数量口径：onTurn 已写入盘的轮次/工具数（崩溃时 loop-log 本身即证据）
  let loggedTurns = 0
  let loggedToolCalls = 0
  try {
    result = await runAgentLoop({
    system: buildSystemWithPlan(editFormat),
    // Phase 8 W1：局部修改轮用聚焦任务书（用户诉求原话即任务主体）；其余路径字节级=现状
    // Phase 8 W1 / W5-4：局部修改轮用聚焦任务书；生成路径任务书在 W5 开时升级为
    // 「逐项推进工作法」（对齐正常 agent 工作流）；其余路径字节级=现状全量任务书
    // Phase 10 W1-3：聚焦任务书尾部追加项目侦察包（BLOMA_CONTEXT_PACK off=字节级）
    task: iterationBriefActive(input) && input.prompt
      ? appendContextPack({ projectId: input.project_id, sessionId: input.session_id, task: buildIterationTask(input.prompt), changeQuery: input.prompt })
      : buildAgentLoopTask(backplane, input.mode, input),
    // B3（P0-B，2026-09-11）：技术合同清单透传进度对账守卫（BLOMA_LOOP_PROGRESS_NUDGE
    // off 时不读不注入字节级现状；无 plan 自然无守卫2，守卫1/3 照常）
    ...(loopProgressNudgeEnabled() && loopPlan ? { planFiles: loopPlan.filesToTouch.map((file) => file.path) } : {}),
    // toolBudget 首个生产接线（闭环 PR5）：web_research 每次都 fork 调研子代理，
    // 限 4 次防长 loop 无节制外呼；超限走既有 budgetExhausted 软着陆
    toolBudget: { web_research: WEB_RESEARCH_BUDGET },
    tools: [
      ...buildAgentTools({
        projectId: input.project_id,
        editFormat,
        ...domainToolOptionsDefaults(input.project_id),
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
      // PR4c：领域验证面（run_preview/gwt/security/api/preflight/browser）在编排层拼接
      ...buildDomainTools({
        projectId: input.project_id,
        editFormat,
        ...domainToolOptionsDefaults(input.project_id),
      }),
    ],
    query: input.query!,
    env: loop.env,
    sessionId: input.session_id,
    projectId: input.project_id,
    requestId: input.request_id,
    maxTokens: resolveGenerationMaxTokens(loop.channel),
    maxTurns: resolveLoopMaxTurnsForInput(input),
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
    ...(result.termination_detail ? { terminationReason: 'degenerate_output（末轮输出退化，非轮数耗尽）' } : {}),
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
        // P2a（2026-09-11）：异常终止真实出口原因（degenerate_output ≠ 真实跑满轮数）
        ...(result.termination_detail
          ? { termination_reason: result.termination_detail.reason, termination_retries: result.termination_detail.retries }
          : {}),
        // D2（2026-09-11 狗粮 dd6ba98d）：DSML 传输事故恢复轮数（只读调用救回次数）
        ...(result.transport_recoveries !== undefined ? { transport_recoveries: result.transport_recoveries } : {}),
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
      title: `Agent Loop 结束（${result.status}${result.termination_detail ? '·输出退化' : ''}）`,
      why: `${result.turns} 轮、${result.toolCalls.length} 次工具调用、耗时 ${durationMs}ms${
        result.termination_detail
          ? `；末轮输出退化（协议原文漏进正文，重试 ${result.termination_detail.retries} 次仍脏——非真实跑满轮数）`
          : ''
      }${result.transport_recoveries ? `；DSML 传输事故恢复 ${result.transport_recoveries} 次（只读调用解析回工具调用执行）` : ''}；终验仍由外部代码执行（不信模型自述）`,
      detail: {
        status: result.status,
        turns: result.turns,
        tool_distribution: toolDistribution,
        ...(result.termination_detail ? { termination: result.termination_detail } : {}),
        ...(result.transport_recoveries !== undefined ? { transport_recoveries: result.transport_recoveries } : {}),
      },
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
      {
        abnormal: {
          outcomeType: 'timeout',
          description: `Agent Loop 未正常收尾（${result.status}，${result.turns} 轮${
            result.termination_detail ? '，末轮输出退化（传输事故）' : ''
          }）`,
        },
      },
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

  // loop 工具无权写系统接管文件，由平台补齐（与管道路径 generateMvpLlm 行为一致）。
  // W1/W3 真实脚手架：标记文件判定（real-static 与 real-fullstack 一并跳过——real-static
  // 无 server.js，旧 server.js 存在性启发会漏判给纯静态产物注入 static-server，破坏「零约定
  // file server」分流）；旧路径（无标记）行为字节级不变。
  if (!readRealScaffoldVariant(project.root_path)) {
    writeFileSync(join(project.root_path, 'package.json'), renderPackageJson(project.name), 'utf8')
    writeFileSync(join(project.root_path, 'static-server.js'), renderStaticServer(), 'utf8')
  }

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
export function countProjectFiles(root: string): number {
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

