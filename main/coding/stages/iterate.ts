/**
 * 迭代阶段（PR3b 拆出）：runIterationTask、需求合并/编号派生、修改诉求精化、迭代完成同步。
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

import { GENERATION_FAILED_COPY, publish, publishCompletionMessage } from './stage-runtime'
import { ensureResumePreview, resumeBlockedFlow } from './blocked-flow'
import { MvpTaskInput, MvpTaskResult } from './sketch-task'
import { runMvpTask, runMvpViaAgentLoop, tryResolveAgentLoop } from './generate'
import { syncPrdCheckpoints } from './loop-prompt'
import { runAgentLoopPostTesting } from './final-verify'
import { openRepairEpoch } from '../repair-ledger'
import { runBlockedTestRepair } from './repair'

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
  /** H5 四问卡专用（resumeBlockedFlow regenerate 分支）：不归一化并入本次诉求，
 *  按原需求清单整版重摇（保留已确认需求与草图；不重置修复预算）。 */
  regenerate?: boolean
  /** 局部修改（2026-09-11「局部优化」路径）：强制开启聚焦锚定（quick 也生效），
   *  其余功能项保持现状勿重做。 */
  localOnly?: boolean
  /** 整版重做（2026-09-11「整版重做」路径）：并入用户重做方向到需求清单，
   *  不聚焦（全量锚定、允许大改），保留已确认需求与草图。 */
  rebuild?: boolean
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
  // H5 四问卡（regenerate）：不走归一化（本次 prompt 是重摇指令非需求变更，并入会
  // 污染清单），原需求清单直接重摇；focus 无（全量锚定与普通重摇一致）。
  const merged = input.regenerate
    ? ({ action: 'skip' as const, requirements: existing, focusRequirementIds: undefined } as Awaited<ReturnType<typeof mergeIterationRequirements>>)
    : await mergeIterationRequirements(input, existing)
  const requirements = merged.requirements
  recordSketchGenerated(input.project_id, requirements)

  // ack 如实（2026-08-27 线上案例 dbe1e6fd：「换个名字」被判 skip 后仍说「按你的新想法
  // 重新生成」，用户体感记忆断层——skip 意味着诉求未入需求，必须告知而非假装采纳）
  if (merged.action === 'skip') {
    // H5 四问卡 regenerate：ack 用四问承诺版（不再说"没当作需求改动"——用户是
    // 明确选的重做，需要被告知换了什么保留了什么）
    if (input.regenerate) {
      publishCompletionMessage(
        input,
        '好的，按新方案重新生成一版：保留已确认的需求与草图，当前版本已保留为快照可随时回看；等待时间与之前一轮相当。',
      )
    } else {
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
      // 2026-09-26 审计 P1-02：用户授权修完=新预算纪元留痕；P1-04：signal 贯穿终验
      openRepairEpoch(input.project_id, 'iteration_finish_unfinished')
      await runBlockedTestRepair({ ...input, preview_url: previewUrl })
      const project = findProject(input.project_id)
      // 终验门禁收口：loop 元数据按 resume 口径重建（judge 只消费 status 判异常终止态）
      await runAgentLoopPostTesting({
        request_id: input.request_id,
        session_id: input.session_id,
        project_id: input.project_id,
        mode: input.mode,
        preview_url: previewUrl,
        ...(input.signal ? { signal: input.signal } : {}),
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
      input.localOnly
        ? `收到「${truncateCopy(input.prompt, 20)}」——这句我没当成具体改动（判为操作指令），这一轮没改到功能。想改哪里请再具体说一点，比如「把页面标题的文字改一下」。`
        : `收到「${truncateCopy(input.prompt, 20)}」——这句我没当作需求改动（判为操作指令），按原样重新生成了一版。想改哪里请直接说，比如「把页面标题的文字改一下」。`,
    )
    }
  } else {
    publishCompletionMessage(
      input,
      input.rebuild
        ? `好的，我按你说的方向「${truncateCopy(input.prompt, 20)}」整版重做一版（保留已确认需求与草图）。`
        : input.localOnly
          ? `好的，我按你说的「${truncateCopy(input.prompt, 20)}」调整这一处，其余保持现状。`
          : `好的，我按你的新想法「${truncateCopy(input.prompt, 20)}」重新生成一版。`,
    )
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
    // 2026-09-26 审计 P1-02：新迭代候选=新预算纪元；P1-04：signal 贯穿终验
    openRepairEpoch(input.project_id, 'iteration_new_candidate')
    await runAgentLoopPostTesting({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      preview_url: mvp.preview_url,
      ...(input.signal ? { signal: input.signal } : {}),
      loop: mvp.loop_result,
      query: input.query,
      channel_id: input.channel_id,
      // P2 失败回流（PR-C）：构建门禁结果透传终验组装器（failed → build 修复任务）
      ...(mvp.build_gate ? { buildGate: mvp.build_gate } : {}),
    })
    // T4-L3 蒸馏触发点②已于 2026-09-12 冻结并移除（同上：本层无注入面，不再生产写入）
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
  clearPendingReviewAction,
  isIterationDecisionId,
  setFailedIteration,
  setPendingReviewAction,
  takeFailedIteration,
  takePendingReviewAction,
} from '../../iteration/pending'
export {
  clearPendingReviewAction,
  isIterationDecisionId,
  setFailedIteration,
  setPendingReviewAction,
  takeFailedIteration,
  takePendingReviewAction,
} from '../../iteration/pending'
export type { IterationDecisionId, PendingReviewAction } from '../../iteration/pending'

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

export function truncateCopy(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

