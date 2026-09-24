/**
 * 终验阶段（PR3b 拆出）：GWT+API 契约联合终验、失败源分类与对比、test_completed 埋点、交付状态记录、ready 交付文案、runAgentLoopPostTesting。
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
import { CircuitBreakSettledError, circuitBreakRollback, isCircuitBreakSettled } from '../../project/recovery-service'
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

import { publish, throwIfAborted } from './stage-runtime'
import { buildBlockedQuestions, publishBlockedDecision } from './blocked-flow'
import { buildRepairCheckpointContext, commitProjectLifecycle, runMvpViaAgentLoop } from './generate'
import { GwtTestingResult, runJudgeReview } from './judge-review'
import { repairAndRetest } from './repair'

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
export function loopOutcomeNote(loop: AgentLoopJudgeMetadata | undefined): string {
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
  // R0.1（2026-09-19 狗粮 7601e5ae）：real-fullstack 终验前陈旧检测重建 dist——修复/
  // 迭代轮只改 src 不重建的构建断链根治位；非 fullstack 变体 no-op（旧路径字节不变）。
  // 陈旧才建幂等：生成轮后首次终验 dist 刚由构建门禁产出，不重复构建。
  await rebuildRealFullstackDist({ projectId: input.project_id, sessionId: input.session_id })
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
  // Phase 10 W1-5：数据迁移门（BLOMA_DATA_MIGRATE on 时；纯磁盘检查不依赖预览，
  // 放 preview_url 卫语前——drill 失败以 GwtFailureSummary 并入，api-reconcile 同款）。
  try {
    const project = findProject(input.project_id)
    if (project && dataMigrateEnabled()) {
      const discipline = checkDataMigrationDiscipline(project.root_path)
      let drill: MigrationDrillResult | null = null
      if (discipline.status === 'drill') drill = await runMigrationDrill(project.root_path)
      recordDecision({
        project_id: input.project_id,
        session_id: input.session_id,
        entry: {
          type: 'agent_loop',
          title: `数据迁移门：${drill ? drill.summary : discipline.note}`,
          why: drill ? drill.summary : discipline.note,
          detail: { kind: 'data_migrate_check', status: drill ? drill.status : discipline.status, ...(drill ? drill.detail : {}) },
        },
      })
      if (discipline.status === 'unversioned') {
        testResult.unverified = [...(testResult.unverified ?? []), `数据迁移门：${discipline.note}`]
      }
      if (drill && drill.failures.length > 0) {
        testResult.total_count += drill.failures.length
        testResult.failed_count += drill.failures.length
        testResult.failure_summary = [...testResult.failure_summary, ...drill.failures]
        // Phase 10 W2：迁移演练失败进经验事件行（高优先级诊断队列，W3 消费）
        appendExperienceEvent({
          projectId: input.project_id,
          runId: input.session_id ?? input.project_id,
          eventType: 'data_migration_failed',
          stage: 'testing',
          observations: drill.failures.map((f) => `${f.scenario}：${f.reason}`),
          evidenceRefs: ['documents/test-report.json'],
        })
      }
    }
  } catch {
    // fail-open：迁移门异常不阻断终验（与 api-reconcile 同纪律）
  }
  if (!input.preview_url) return testResult
  const endpoints = backplaneInterfaceSpec(readPrdBackplane(input.project_id))
  // W1.3 静态三方对账（B 站案主死因拦截位）：前端引用⇄路由⇄契约。纯磁盘确定性，
  // 无需预览运行，放在 api-contract 探测之前（对账红时探测也会红，但对账给出可修复的具体措辞）。
  // 项目缺失/读不到 root 时静默跳过（对账是增强不是依赖，fail-open 与经验库同纪律）。
  try {
    const project = findProject(input.project_id)
    if (project && apiReconcileEnabled()) {
      const specPrefixes = endpoints.map((ep) => ep.endpoint.split('/').filter(Boolean)[1]).filter((p): p is string => Boolean(p))
      const reconcileFailures = [...reconcileApiUsage({ projectRoot: project.root_path, specPrefixes }), ...checkMediaSourceDiscipline(project.root_path)]
    if (reconcileFailures.length > 0) {
      // Phase 10 W4.3：对账失败=confirmed_failure 事件行（客观证据坐实，区别于用户反馈的
      // issue_hypothesis；高优先级诊断队列，供复盘成规则卡）
      appendExperienceEvent({
        projectId: input.project_id,
        runId: input.session_id ?? input.project_id,
        eventType: 'confirmed_failure',
        stage: 'testing',
        observations: reconcileFailures.map((f) => f.reason).slice(0, 5),
        evidenceRefs: ['documents/test-report.json'],
      })
      recordDecision({
        project_id: input.project_id,
        session_id: input.session_id,
        entry: {
          type: 'agent_loop',
          title: `API 三方对账：${reconcileFailures.length} 项不一致`,
          why: reconcileFailures.map((f) => f.reason).join('；').slice(0, 300),
          detail: { kind: 'api_reconcile', count: reconcileFailures.length },
        },
      })
      testResult.total_count += reconcileFailures.length
      testResult.failed_count += reconcileFailures.length
      testResult.failure_summary = [...testResult.failure_summary, ...reconcileFailures]
    }
    }
  } catch {
    /* 项目缺失 → 对账跳过（终验其余面照常） */
  }
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
export function classifyFailureSource(
  scenario: string,
  baseline: { kind: 'loop'; validation?: import('../../../shared/types').LoopValidationSnapshot } | { kind: 'prev_round'; prevFailures: string[] },
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
export function buildFailureComparison(
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

export function trackTestCompleted(
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
export function recordPostTestingDeliveryStatus(
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
export function mustDeliverFeatureIdsOf(projectId: string): string[] {
  const backplane = readPrdBackplane(projectId)
  const keyTasks = backplaneKeyTasks(backplane)
  if (keyTasks.length > 0) return [...new Set(keyTasks.filter((t) => t.must_deliver).flatMap((t) => t.feature_ids))]
  return backplane.requirements.filter((item) => requirementPriority(item) === 'P0').map((item) => item.id)
}

/**
 * Phase 7 U1 H3：ready 引导卡交付正文（三层：结论/任务分组✓×?/详情提示；无通过率数字）。
 * delivery_status 缺席（开关 off/未终验）→ undefined 不加载荷（渲染端自动隐藏）。
 */
export function buildReadyDeliveryBody(projectId: string): string | undefined {
  const project = findProject(projectId)
  if (!project?.delivery_status) return undefined
  const testReport = readTestReport(projectId)
  const backplane = readPrdBackplane(projectId)
  // Phase 10 落地旅程（2026-09-16）：成熟度三态行（09-06 挂账的徽标——文本态落地）：
  // 完整程序=路由模块在用 或 契约端点存在 且 data/ 有真实数据文件；MVP=已交付本轮产物；
  // 静态草图=更早形态。确定性判定（磁盘+背板），不猜。
  const maturity = (() => {
    try {
      const root = project.root_path
      const routesDir = join(root, 'server', 'routes')
      const routeFiles = existsSync(routesDir) ? readdirSync(routesDir).filter((f) => f.endsWith('.js') && !f.startsWith('_')) : []
      const dataDir = join(root, 'data')
      const dataFiles = existsSync(dataDir) ? readdirSync(dataDir).filter((f) => f.endsWith('.json')) : []
      const specCount = (backplane.interface_spec ?? []).filter((ep) => ep.endpoint.trim()).length
      if ((routeFiles.length > 0 || specCount > 0) && dataFiles.length > 0) {
        return `完整程序（${routeFiles.length} 个服务端路由 · ${dataFiles.length} 个数据文件 · ${specCount} 条接口契约）`
      }
      if (routeFiles.length > 0 || specCount > 0) return `MVP+（服务端已有：${routeFiles.length} 路由/${specCount} 契约；data/ 尚无真实数据）`
      return 'MVP（静态前端形态——数据留存走「把数据存到服务端」可升完整程序）'
    } catch {
      return 'MVP'
    }
  })()
  const storyOf = new Map(backplane.requirements.map((item) => [item.id, requirementStory(item)]))
  const presentation = buildDeliveryPresentation({
    status: project.delivery_status,
    keyTasks: backplaneKeyTasks(backplane),
    p0RequirementIds: backplane.requirements.filter((item) => requirementPriority(item) === 'P0').map((item) => item.id),
    testResult: testReport ?? { failed_count: 0, failure_summary: [] },
    featureLabelOf: (id) => storyOf.get(id),
  })
  const body = renderDeliveryBody(presentation)
  return body ? `成熟度：${maturity}

${body}` : `成熟度：${maturity}`
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
  // Phase 10 W1-1：生成轮结束态提交（终验开始前，首个生命周期提交点）
  commitProjectLifecycle(input.project_id, input.session_id, 'testing_begin', 'Agent Loop 生成轮结束，终验开始')

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
          : '自动修复后测试仍未通过（无具体失败清单）'
      publishBlockedDecision(input, 'test_repair', failureTitle, {
        reason: 'test',
        failures: testResult.failure_summary,
        mustDeliverFeatureIds: mustDeliverFeatureIdsOf(input.project_id),
        // H5 四问卡判据：W4-F5 升级信号（读 loop-checkpoint 账本，连续 ≥2 轮修复零推进）。
        // 开关 off 时 buildBlockedQuestions 字节级现状、escalated 不进卡（零行为变化）。
        escalated: buildRepairCheckpointContext(input.project_id).escalation === 'diagnosis',
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

