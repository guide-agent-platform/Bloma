/**
 * 修复阶段（PR3b 拆出）：repairAndRetest 修复重验闭环（预算/零编辑守卫）、runBlockedTestRepair 定向修复入口。
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
import { ensureResumePreview } from './blocked-flow'
import { appendRepairAttemptRecord, buildRepairCheckpointContext, commitProjectLifecycle, deriveAuthorizedWritePaths, prepareSkeletonBeforeLoop, resolveLoopThinkingLevel } from './generate'
import { buildLoopSystemWithOverride } from './loop-prompt'
import { AgentLoopPostTestingInput, runGwtWithApiContract, trackTestCompleted } from './final-verify'

/**
 * GWT 首败后的定向修复轮 + 全量重验（P2 失败回流入口 A，实施稿 §4.4）。
 *
 * 预算：project.test_repair_count 计数（既有字段），上限 resolveRepairBudget(mode)
 * （缺省 quick=1 / longterm=2，BLOMA_REPAIR_BUDGET 覆盖）；每轮 +1，收敛清零。
 * 任一「不起修复轮」的情形（预算耗尽 / 无 query / 渠道不可用 / 修复轮异常）
 * 均返回原 testResult，由调用方按现状熔断口径收口（陷阱 37 一字不改）——修复轮
 * 是增强不是依赖，绝不阻断交付链。
 */
export async function repairAndRetest(input: AgentLoopPostTestingInput, testResult: GwtTestResult): Promise<GwtTestResult> {
  // 2026-09-25 对齐批·环境豁免（Proma-Easy「环境类不入修复循环」铁律直译）：
  // 浏览器探针不可用（probe_degraded）时的失败是静态兜底口径——不可归因产物缺陷，
  // 修复轮修不了「探针缺席」，不烧预算不计数；如实留痕转既有终验口径。
  if (testResult.probe_degraded === true && testResult.failed_count > 0) {
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'repair_round_skipped',
        title: '环境类失败不入修复预算（探针降级）',
        why: `浏览器探针不可用，GWT 走静态兜底判定（失败 ${testResult.failed_count} 项不可归因产物缺陷）——不起修复轮、不烧预算；恢复探针后重验即恢复全预算`,
        detail: { probe_degraded: true, failed_count: testResult.failed_count },
      },
    })
    appendSessionMessage(input.session_id, {
      role: 'assistant',
      content: [{ type: 'text', text: '本轮验证的浏览器探针不可用（走静态兜底判定），失败项无法归因到产物缺陷——不消耗修复预算。恢复预览/浏览器环境后重新验证即可。' }],
      timestamp: Date.now(),
    })
    return testResult
  }
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
  // Phase 10 W1-1：修复轮前提交（修复前状态入库）
  commitProjectLifecycle(input.project_id, input.session_id, 'repair_begin', `定向修复轮（第 ${round}/${budget} 轮，${tasks.length} 项）开始`)
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
    // R1-providers（狗粮 7601e5ae #496）：上轮预算耗尽时被信道丢弃的写类意图回喛——
    // 只在存在时注入（缺省零注入字节级不变）
    ...(input.loop?.termination_detail?.dropped_tool_intents?.length
      ? { droppedToolIntents: input.loop.termination_detail.dropped_tool_intents }
      : {}),
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
  // Phase 10 W1-1：修复轮结束提交（修复后状态入库，后续重验不丢中间态）
  commitProjectLifecycle(input.project_id, input.session_id, 'repair_loop_end', `定向修复轮（第 ${round}/${budget} 轮）结束`)

  // B2（P0-B，2026-09-11 审计案 35c1a633）：零编辑守卫——修复轮零 write/edit 即不计轮。
  // 旧路径：17 次全读 + 空口完成总结照样 status=completed → 全量重验逐条相同（initial=
  // after_repair）→ 白烧一轮预算。开关 on：产物未变不重验、计数回滚、旁白如实、零编辑轮
  // 入 loop-checkpoint 账本（files_touched=[]，W4-F5 升级信号与四问卡自然承接）；
  // off=字节级现状（照常重验照常计轮）。
  if (repairNoopGuardEnabled() && !hasWriteEditToolCall(result.loopResult?.toolCalls ?? [])) {
    updateProject(input.project_id, { test_repair_count: used })
    if (loopCheckpointEnabled()) {
      const prevFailures = testResult.failure_summary.map((f) => f.scenario)
      appendRepairAttemptRecord(input.project_id, {
        round,
        at: new Date().toISOString(),
        task_locations: tasks.map((task) => task.location ?? task.claim ?? '').filter(Boolean).slice(0, 10),
        files_touched: [],
        outcome: {
          // 产物未变：失败清单结构性不变（非猜测）；零 resolved 参与升级信号判定
          resolved: [],
          persistent: prevFailures,
          new_failures: [],
          converged: false,
        },
      })
    }
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'repair_noop_skipped',
        title: `修复轮未产生任何代码改动，不计入预算（第 ${round} 轮回退）`,
        why: `修复轮 ${result.loopResult?.turns ?? 0} 轮 / ${result.loopResult?.toolCalls.length ?? 0} 次工具调用全部为只读，零 write_file/edit_file——产物未变不重验，预算计数回退到 ${used}/${budget}`,
        detail: {
          round,
          budget,
          turns: result.loopResult?.turns ?? 0,
          tool_calls: result.loopResult?.toolCalls.length ?? 0,
          tool_names: [...new Set((result.loopResult?.toolCalls ?? []).map((call) => call.name))],
        },
      },
    })
    const noopNote =
      '刚才的修复轮没有产生任何代码改动（全部为读取操作），这一轮不计入修复预算，也不重复重验；接下来按测试未通过口径收口，你可以告诉我下一步怎么处理。'
    appendSessionMessage(input.session_id, {
      role: 'assistant',
      content: [{ type: 'text', text: noopNote }],
      timestamp: Date.now(),
    })
    publish(input, 'message_delta', { text: noopNote })
    return testResult
  }

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
export async function runBlockedTestRepair(input: {
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
  // Phase 10 W1-1：入口 B（继续修）修复轮前提交
  commitProjectLifecycle(input.project_id, input.session_id, 'repair_begin', `继续修定向修复轮（第 ${round}/${budget} 轮，${tasks.length} 项）开始`)
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

