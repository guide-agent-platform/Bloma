/**
 * blocked 决策与恢复流（PR3b 拆出）：决策类型/问题卡构建、自动工具放行、blocked 卡发布、resolveBlockedDecision、resumeBlockedFlow、ensureResumePreview、App LLM env。
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
import { appendLoopLogDocument, readLoopCheckpointDocument, readPrdBackplane, readUxContractSketch, renamePrdProject, syncDocuments, updateRequirementStatus, writeLoopCheckpointDocument, writeSecurityScanDocument, type LoopLogEntry, type LoopRepairAttemptRecord, writePlanDocument } from '../../project/document-engine'
import { appendProjectLearning } from '../../project/learnings-log'
import { runSandbox } from '../../delivery/sandbox'
import { createSnapshot } from '../../delivery/snapshots'
import { trackAnalytics } from '../../delivery/track-analytics'
import { renderPackageJson, renderStaticServer, renderSkeletonToProject } from '../project-scaffold'
import { runBuildGate, type BuildGateResult } from '../build-gate'
import { rebuildRealFullstackDist } from '../dist-rebuild'
import { runArtifactUiGate, uiProbeNotes, type ArtifactUiGateResult } from '../artifact-ui-gate'
import { getCachedStaticEvidence, setCachedStaticEvidence } from '../../verification/evidence-cache'
import { runVisionAuditGate } from '../vision-audit-gate'
import { buildRepairTasks, resolveRepairBudget, runRepairLoop, repairScopeEnabled, hasWriteEditToolCall, type RepairCheckpointContext, type RepairTask } from '../repair-loop'
import { buildIterationTask, ITERATION_MODE_SECTION, resolveAgentLoopMaxTurnsLocal } from '../iteration-brief'
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
import { buildModuleMapInjection, loadOfficialModules, renderOfficialModulesToProject } from '../module-library'
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
import { CircuitBreakSettledError, circuitBreakRollback, isCircuitBreakSettled } from '../../project/recovery-service'
import { readPrimaryIntent, recordSessionActivity } from '../../platform/sessions/session-service'
import { runAgentLoop, loopApiToolEnabled, loopCheckpointEnabled, preflightEnabled, narrationEventsEnabled, loopProgressNudgeEnabled, compactToolEnabled, type AgentLoopResult, type LoopCheckpointSnapshot } from '../../agent/loop/agent-loop'
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

import { AUTOMATED_PERMISSION_MODE, ProgrammingEventPublisher, foregroundRunChecker, publish, publishCompletionMessage, setProgrammingEventPublisher } from './stage-runtime'

import { runMvpTask } from './generate'
import { runJudgeReview } from './judge-review'
import { runAgentLoopPostTesting } from './final-verify'
import { runBlockedTestRepair } from './repair'
import { openRepairEpoch } from '../repair-ledger'
import { runIterationTask } from './iterate'

/** 被阻塞的编程操作类型（A2 resume 闭环，落盘到 Project.blocked_action） */
export type BlockedAction = 'mvp_repair' | 'test_repair' | 'judge_return' | 'security_repair'
/** 阻塞态让渡后用户回传的决策（A3：消费 metadata.selected_option_id 映射而来）。
 *  regenerate=四问卡「按新方案生成一个版本」（H5 第四出口，仅 W4-F5 升级信号下出现）。 */
export type BlockedDecision = 'continue' | 'accept' | 'explain' | 'regenerate'

/** 阻塞态让渡卡片（A1：统一带 `id`，与引导澄清路径 questions 形态一致） */
export const BLOCKED_DECISION_QUESTIONS: { id: BlockedDecision; label: string; description: string }[] = [
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
  /** W4-F5 升级信号（连续 ≥2 轮修复零推进）：四问卡「按新方案生成一个版本」
 *  第四出口的判据（E1 §五：仅连续修复无进展时出现，预算用完但有推进不推） */
  escalated?: boolean
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
  // H5 第四出口（仅 test 路径 + W4-F5 升级信号）：「按新方案生成一个版本」四问卡。
  // E1 §五：是有理由的备选不是「修不好就抽卡重来」——只在连续修复无进展时出现；
  // 四问正文随卡 body 呈现（publishBlockedDecision 处拼装）。
  if (context.reason === 'test' && context.escalated) {
    questions.push({
      id: 'regenerate',
      label: '按新方案生成一个版本',
      description: '连续多轮修复都没有减少问题时的备选；保留已确认需求与草图',
    })
  }
  return questions
}

/** 无人值守自动化路径的工具门禁：显式传入豁免模式，不弹 UI，危险工具仍拒绝。 */
export async function allowAutomatedTool(
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
export function publishBlockedDecision(
  input: { session_id: string; project_id: string },
  action: BlockedAction,
  title?: string,
  context?: BlockedDecisionContext,
): void {
  updateProject(input.project_id, { current_stage: 'blocked_for_user_decision', blocked_action: action })
  publish(input, 'stage_changed', { stage: 'blocked_for_user_decision' })
  // H5 四问卡正文（仅开关 on + W4-F5 升级信号 + test 路径）：必答四问随卡 body 呈现
  //（E1 §五：为什么重做/这次换什么/保留什么/代价——没把握就直说不确定，不编成功率）
  // 开关 off 时 payload 无 body 键（字节级现状，与选项条件化同门）。
  const fourQuestions =
    decisionConditionalEnabled() && context?.reason === 'test' && context?.escalated
      ? [
          '关于「按新方案生成一个版本」：',
          '· 为什么重做：连续多轮修复都没有减少关键问题（每轮修复记录在案，可回看）',
          '· 这次换什么：整体换一种实现方式，具体新方案由重新规划决定——没有把握一定比现在好',
          '· 保留什么：已确认的需求与草图不变；当前版本保留为快照，随时可回看',
          '· 代价：需要重新生成完整版本，等待时间与之前一轮相当；重做不重置修复预算',
        ].join('\n')
      : undefined
  publish(input, 'user_decision_required', {
    kind: 'blocked',
    stage: 'blocked_for_user_decision',
    // U7：让渡卡片带上具体偏差描述（如「缺了按月统计功能」），落到 title 字段由渲染端展示
    title,
    ...(fourQuestions ? { body: fourQuestions } : {}),
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
    if (id === 'accept' || id === 'explain' || id === 'continue' || id === 'regenerate') return id
    return 'continue'
  }

  // 自由文本兜底：阻塞态下用户可能直接打字（卡片是主路径，这里是容错）
  const text = input.content.trim()
  if (/接受|保留|现状|就这样|算了/.test(text)) return 'accept'
  if (/继续|重试|再试|再修/.test(text)) return 'continue'
  // H5 四问卡自由文本兑底：换方案/换思路/重新生成一版（明说才认，宁漏勿误）
  if (/换[个一]?(方案|思路)|按新方案|重新生成一版/.test(text)) return 'regenerate'
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
  /** P1-04（2026-09-26 运行审计）：取消信号贯穿 Resume 恢复链——嵌套重生成/
   *  修复轮/终验共用同一信号，用户停止能传导到恢复流程内部。 */
  signal?: AbortSignal
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

  // H5 四问卡回传（W4-F5 升级信号下出现的第四出口）：清阻塞 + 整版重摇。
  // E1 §五约束：保留已确认需求与草图（不并入本次诉求，原清单直接重生成）；
  // 重做受总预算约束不重置修复额度（test_repair_count 不清零）；当前版本已随
  // 熔断回滚保留为快照。
  if (input.decision === 'regenerate') {
    updateProject(input.project_id, { current_stage: 'iterating', blocked_action: undefined })
    publish(input, 'stage_changed', { stage: 'iterating' })
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'modification_decision',
        title: '用户选择按新方案生成一个版本',
        why: '四问卡回传：连续多轮修复无进展，用户选择换实现方式重做（保留需求清单与草图，当前版本保留为快照）',
        detail: { decision: 'regenerate', blocked_action: action },
      },
    })
    await runIterationTask({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      prompt: '按新方案重新实现全部已确认需求（换一种实现方式）',
      channel_id: input.channel_id,
      query: input.query,
      regenerate: true,
    })
    return
  }

  // decision === 'continue'：重置相关计数后恢复被阻塞的操作
  if (action === 'mvp_repair') {
    // 2026-09-26 审计 P1-02：重新生成=新预算授权，epoch+1 留痕（历史计数在 repair_ledger/repair_total_attempts 保留）
    openRepairEpoch(input.project_id, 'user_resume_mvp_repair')
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
      ...(input.signal ? { signal: input.signal } : {}),
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
    // 2026-09-26 审计 P1-02：用户继续修=合法新预算授权，epoch+1 留痕——清零动作可审计
    openRepairEpoch(input.project_id, 'user_resume_test_repair')
    const previewUrl = await ensureResumePreview(input)
    // P2 失败回流（入口 B，PR-C）：从「空转重验」升级为「先修再验」——上次让渡时的
    // 失败快照（test-report.json）直接组装修复任务，先跑一轮定向修复再走终验门禁，
    // 避免产物未变重验原地失败；无失败快照 / 无预算 / 修复轮未完成 → 行为=现状重验。
    // （终验内部仍带入口 A 的自动修复轮，两层互不冲突：预算计数共享 test_repair_count）
    await runBlockedTestRepair({ ...input, preview_url: previewUrl, ...(input.signal ? { signal: input.signal } : {}) })
    // loop 元数据仅在 project.via_agent_loop 时存在；存量旧项目缺省走普通终验（无修复）
    await runAgentLoopPostTesting({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      ...(input.signal ? { signal: input.signal } : {}),
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
      ...(input.signal ? { signal: input.signal } : {}),
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
export async function ensureResumePreview(input: { request_id: string; project_id: string; channel_id?: string; session_id?: string }): Promise<string> {
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
export function buildAppLlmEnv(input: { channel_id?: string; project_id: string }): Record<string, string> | undefined {
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

