/**
 * 阶段运行时共享件（PR3b 拆出）：公共文案、发布器/前台检查器状态与注入、publish/完成消息、会话活跃节流、生命周期提交、中止守卫。
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

import { SketchTaskInput } from './sketch-task'

/**
 * 无人值守豁免（A2-12）：自动化管线内部 service 直连时显式传入 allow-all——
 * warning 工具自动放行（不弹 UI）、dangerous 拒绝。禁止隐式绕过，豁免必须显式传入。
 */
export const AUTOMATED_PERMISSION_MODE = 'allow-all' as const

/** 渠道未配置 max_tokens 时的默认上限（对齐全渠道 640000，防思考型渠道零正文）。 */
export const DEFAULT_MAX_TOKENS = 640000

/** 项目已生成完成（ready）的统一话术：完成通知与 ready 护栏共用，避免两套语义相近的固定文案。
 * 完成语义升级（2026-09-06 用户拍板「终点不是 MVP」）：就绪话术带走向完整产物的出口提示。 */
export const READY_COMPLETION_COPY =
  'MVP 已经生成好了，可以点右侧预览区的按键试用。想走向完整产物——数据存到服务端、加功能、接真实 AI、导出部署——直接说就行。'

/** 迭代/生成失败时如实告知用户的话术：不假装成功，也不把失败藏成「已经生成好了」。 */
export const GENERATION_FAILED_COPY =
  '这次修改没有成功（模型生成失败了），你可以再试一次，或者换个说法描述你的需求。'

export type ProgrammingEventPublisher = (event: AgentEvent) => void

/** 统一的取消边界：所有顶层阶段在发生副作用前调用，保证 stop 后不再切状态/起新任务。 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('AGENT_CANCELLED')
}

export let programmingEventPublisher: ProgrammingEventPublisher = () => undefined
export let foregroundRunChecker: (sessionId: string) => boolean = () => false

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

/**
 * 后台链路会话活跃刷新（缺陷④）：编程编排器的后台任务（草图/MVP/迭代/终验/让渡恢复）
 * 不经 runAgent，会话索引 agent-sessions.json 的 updated_at 停在最后一次交互消息，
 * 历史列表「按最近活跃倒序」失真（实测后台 MVP 跑完数小时 updated_at 仍停在旧时间）。
 * publish 是全部后台链路事件的必经点，在此刷新索引；同一会话 30s 节流一次，
 * 避免 loop 多轮工具事件把小索引文件写成热点。旁路观测，失败不得阻断事件发布。
 */
export const SESSION_ACTIVITY_REFRESH_MS = 30_000
export const sessionActivityLastRefreshAt = new Map<string, number>()

export function touchSessionActivity(input: Pick<SketchTaskInput, 'session_id' | 'project_id'>): void {
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

export function publish(input: Pick<SketchTaskInput, 'session_id' | 'project_id'>, type: AgentEvent['type'], payload: Record<string, unknown>): void {
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
export function publishCompletionMessage(
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

