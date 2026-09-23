/**
 * 裁判阶段（PR3b 拆出）：runJudgeReview 主链、内审评估、裁判退回限额、反馈卡与后续步骤卡。
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

import { READY_COMPLETION_COPY, publish, publishCompletionMessage, throwIfAborted } from './stage-runtime'
import { publishBlockedDecision } from './blocked-flow'
import { buildReadyDeliveryBody } from './final-verify'

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
  // MVP 就绪三按钮卡（2026-09-11 用户拍板改版）：生成完**立即**弹，让用户选
  // 保持现状（停）/ 局部优化（跳输入框说改哪里）/ 整版重做（先问方向再二次确认）。
  // 分流只依赖用户点选的选项，不依赖用户在输入框里说的话。原「下一步走向完整产物」
  // 引导卡（ready_next_steps）改由「保持现状」后触发（publishReadyNextStepsCard）。
  publish(input, 'user_decision_required', {
    kind: 'mvp_review',
    title: '这一版你满意吗？',
    questions: [
      { id: 'keep', label: '保持现状', description: '就到这里，当前版本保留' },
      { id: 'optimize', label: '局部优化', description: '去输入框说说要改哪里（只改这一处）' },
      { id: 'rebuild', label: '整版重做', description: '换一种方式把功能重做一遍' },
    ],
  })
  return { outcome: 'ready', verdict }
}

/** Phase 10 W4：BLOMA_FEEDBACK_CARD 缺省 off（keep 直接发引导卡=现状字节级）。 */
export function feedbackCardEnabled(): boolean {
  const raw = (process.env.BLOMA_FEEDBACK_CARD ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

/**
 * Phase 10 W4（F 系列 4.1）：一键反馈卡——「保持现状」后、引导卡前非强制出卡
 *（反馈优先于引导：用户可能根本用不了，引导无意义）。选负面项→issue_hypothesis
 * 事件+issue_reported 埋点（行为信号源=本卡，非意图识别）；选项 id 前缀 fb_。
 */
export function publishDeliveryFeedbackCard(input: {
  request_id: string
  session_id: string
  project_id: string
}): void {
  if (!feedbackCardEnabled()) return
  publish(input, 'user_decision_required', {
    kind: 'delivery_feedback',
    title: '这一版用下来怎么样？',
    questions: [
      { id: 'fb_broken', label: '无法运行', description: '打不开或直接报错' },
      { id: 'fb_feature_broken', label: '关键功能无效', description: '某个功能点了没反应/结果不对' },
      { id: 'fb_unsatisfied', label: '效果不满意', description: '能用，但不是我想要的效果' },
      { id: 'fb_change_needs', label: '改变需求', description: '想加/改功能，去输入框说' },
      { id: 'fb_later', label: '暂不反馈', description: '先跳过' },
    ],
  })
}

/**
 * 「保持现状」后触发的就绪引导卡（原 runJudgeReview 内联 ready_next_steps，
 * 2026-09-11 三按钮改版后移）：用户对 MVP 整体满意 → 顺势给「走向完整产物」引导
 *（数据上服务端/导出部署）。复用 user_decision_required 通道；export_handoff 由
 * 渲染端特调导出 IPC，不进聊天管道。
 */
export function publishReadyNextStepsCard(input: {
  request_id: string
  session_id: string
  project_id: string
}): void {
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
}

/**
 * constraint_error 文档级修复（原 repair-engine.applyRepairPatch 的 constraint 分支，随废旧管道
 * 删除内联于此）：重新生成 PRD 与 GWT 骨架（文档层面），不改动项目代码。judge 退回重试
 * 路径（repairInternalized 未设的存量语义）仍依赖它重建文档骨架。
 */
export function applyConstraintErrorDocRepair(input: { request_id: string; session_id: string; project_id: string }): void {
  syncDocuments({
    request_id: input.request_id,
    session_id: input.session_id,
    project_id: input.project_id,
    checkpoint: 'mvp_before_generation',
  })
}

/** 单轮完整裁决：规则引擎先行，规则全绿且 query 可用时叠加 LLM 语义审查腿。 */
export async function evaluateOnce(input: JudgeReviewInput): Promise<JudgeVerdict> {
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

export function judgeOnce(input: JudgeReviewInput): JudgeVerdict {
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

