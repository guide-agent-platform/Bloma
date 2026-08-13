import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentSendMessageInput, Project, ProjectMode, Snapshot, TemplateType } from '../shared/types'
import { syncDocuments } from './document-engine'
import { createSnapshot, runSandbox, trackAnalytics } from './platform-services'
import { generateMvp } from './mvp-engine'
import { findProject, readLastSketchRequirements, recordSketchGenerated, updateProject } from './project-service'
import { generateSketch, type SketchRequirement } from './sketch-engine'
import { readTestReport, runGwtScenarios, writeTestReport, type GwtTestResult } from './gwt-service'
import { applyRepairPatch, REPAIR_CATEGORY_SUMMARY, runRepairCycle, type RepairCategory } from './repair-engine'
import { runJudge, type JudgeVerdict } from './judge-engine'
import { assertToolAllowed } from './permission-service'

/**
 * 无人值守豁免（A2-12）：自动化管线内部 service 直连时显式传入 allow-all——
 * warning 工具自动放行（不弹 UI）、dangerous 拒绝。禁止隐式绕过，豁免必须显式传入。
 */
const AUTOMATED_PERMISSION_MODE = 'allow-all' as const

type ProgrammingEventPublisher = (event: AgentEvent) => void

/** 被阻塞的编程操作类型（A2 resume 闭环，落盘到 Project.blocked_action） */
export type BlockedAction = 'mvp_repair' | 'test_repair' | 'judge_return'
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
}

export interface MvpTaskResult {
  preview_url: string
  snapshot: Snapshot
  run_command: string
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
  const sketch = generateSketch({ project_id: input.project_id, requirements, max_pages: 3 })
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
    include_documents: false,
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

/**
 * runMvpTask — 草图确认后无需再发消息，直接从模板生成 MVP 并进入测试阶段。
 *
 * 顺序（对齐任务规划）：stage generating_mvp → 文档打点 sketch_confirmed /
 * mvp_before_generation → generateMvp → 沙箱启动 → mvp 快照（含文档）→
 * analytics mvp_delivered → stage testing → 发布 mvp_ready。
 */
export async function runMvpTask(input: MvpTaskInput): Promise<MvpTaskResult> {
  publish(input, 'stage_changed', { stage: 'generating_mvp' })
  updateProject(input.project_id, { current_stage: 'generating_mvp' })

  syncDocuments({ request_id: input.request_id, project_id: input.project_id, session_id: input.session_id, checkpoint: 'sketch_confirmed' })
  syncDocuments({ request_id: input.request_id, project_id: input.project_id, session_id: input.session_id, checkpoint: 'mvp_before_generation' })

  const requirements = readLastSketchRequirements(input.project_id)
  await allowAutomatedTool('generate_mvp', { project_id: input.project_id }, input.session_id, input.project_id)
  const mvp = generateMvp({ project_id: input.project_id, requirements, template_type: input.template_type })
  await allowAutomatedTool('run_project', { project_id: input.project_id, command: mvp.run_command }, input.session_id, input.project_id)
  const sandbox = await ensureSandboxRunning(input)

  await allowAutomatedTool('create_snapshot', { project_id: input.project_id, kind: 'mvp' }, input.session_id, input.project_id)
  const snapshot = await createSnapshot({
    request_id: input.request_id,
    project_id: input.project_id,
    kind: 'mvp',
    summary: `MVP 已生成，共 ${mvp.files.length} 个文件，进入测试阶段。`,
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
        file_count: mvp.files.length,
        run_command: mvp.run_command,
      },
      privacy_level: 'research_safe',
    },
  })

  updateProject(input.project_id, {
    current_stage: 'testing',
    current_snapshot_id: snapshot.snapshot_id,
  })
  publish(input, 'stage_changed', { stage: 'testing' })
  publish(input, 'mvp_ready', {
    preview_url: sandbox.preview_url,
    snapshot_id: snapshot.snapshot_id,
    run_command: mvp.run_command,
    summary: mvp.assumptions.join('；'),
  })

  return { preview_url: sandbox.preview_url, snapshot, run_command: mvp.run_command }
}

/**
 * ensureSandboxRunning — 启动 MVP 沙箱；启动失败时按错误类别进入自动修复循环
 * （dependency/syntax/runtime 可修复；timeout/端口等环境问题直接抛出，交由上层报错）。
 */
async function ensureSandboxRunning(input: MvpTaskInput): Promise<{ preview_url: string }> {
  let sandbox = await runSandbox({
    request_id: input.request_id,
    project_id: input.project_id,
    command: 'node static-server',
  })
  if (sandbox.status === 'running' && sandbox.preview_url) return { preview_url: sandbox.preview_url }

  let category = sandbox.error_summary?.category
  const repairable = (value: string | undefined): value is RepairCategory =>
    value === 'dependency_error' || value === 'syntax_error' || value === 'runtime_error'
  if (!repairable(category)) {
    throwSandboxFailure(input, sandbox.error_summary)
  }

  // 可修复 → 进入 runtime 修复循环（最多 3 次，内部熔断）
  while (true) {
    const cycle = await runRepairCycle({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      category: category as RepairCategory,
      publish: (type, payload) => publish(input, type, payload),
      verify: async () => {
        sandbox = await runSandbox({
          request_id: input.request_id,
          project_id: input.project_id,
          command: 'node static-server',
        })
        return { ok: sandbox.status === 'running', preview_url: sandbox.preview_url }
      },
    })
    if (cycle.blocked) {
      publishBlockedDecision(input, 'mvp_repair')
      throw new Error('SANDBOX_RUN_FAILED:blocked')
    }
    if (cycle.repaired && sandbox.status === 'running' && sandbox.preview_url) {
      return { preview_url: sandbox.preview_url }
    }
    const nextCategory = sandbox.error_summary?.category
    if (!repairable(nextCategory)) throwSandboxFailure(input, sandbox.error_summary)
    category = nextCategory
  }
}

function throwSandboxFailure(input: MvpTaskInput, errorSummary: { category: string; user_visible_summary: string } | undefined): never {
  publish(input, 'error', {
    code: 'SANDBOX_RUN_FAILED',
    message: errorSummary?.user_visible_summary ?? '预览暂时没有启动成功，我正在修复。',
  })
  throw new Error(`SANDBOX_RUN_FAILED:${errorSummary?.category ?? 'unknown'}`)
}

export interface GwtTestingInput {
  request_id: string
  session_id: string
  project_id: string
  mode: ProjectMode
  preview_url: string
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
 */
export async function runJudgeReview(input: JudgeReviewInput): Promise<JudgeReviewResult> {
  let verdict = judgeOnce(input)
  while (verdict.verdict === 'return') {
    const project = findProject(input.project_id)
    const limit = project.mode === 'quick' ? JUDGE_RETURN_QUICK_LIMIT : JUDGE_RETURN_LONGTERM_LIMIT
    const returns = (project.judge_return_count ?? 0) + 1
    updateProject(input.project_id, { judge_return_count: returns })

    if (returns > limit) {
      publishBlockedDecision(input, 'judge_return')
      return { outcome: 'blocked', verdict }
    }

    // constraint_error 修复：重新生成 PRD/GWT 骨架，然后重新判定
    applyRepairPatch({ request_id: input.request_id, session_id: input.session_id, project_id: input.project_id }, 'constraint_error')
    updateProject(input.project_id, { current_stage: 'repairing' })
    publish(input, 'stage_changed', { stage: 'repairing' })
    publish(input, 'repairing', { attempt: returns, category: 'constraint_error', user_visible_summary: REPAIR_CATEGORY_SUMMARY.constraint_error })
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
    verdict = judgeOnce(input)
  }

  updateProject(input.project_id, { current_stage: 'ready' })
  publish(input, 'stage_changed', { stage: 'ready' })
  return { outcome: 'ready', verdict }
}

function judgeOnce(input: JudgeReviewInput): JudgeVerdict {
  const project = findProject(input.project_id)
  const testResult = readTestReport(input.project_id)
  const verdict = runJudge({ project_id: input.project_id, mode: project.mode, test_result: testResult ?? undefined })
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

/**
 * runPostMvpTestingFlow — MVP 就绪后的测试与状态机后半段（A2-09）。
 *
 * testing →（GWT 执行 + 测试报告）→ 通过则进入 judge_review（A2-11 接入裁判判定）；
 * 失败则进入 repairing ↔ testing 自动修复循环（A2-08），达上限 blocked_for_user_decision 让渡。
 */
export async function runPostMvpTestingFlow(input: GwtTestingInput): Promise<GwtTestingResult> {
  updateProject(input.project_id, { current_stage: 'testing' })
  publish(input, 'stage_changed', { stage: 'testing' })

  let testResult = await runGwtScenarios({ project_id: input.project_id, session_id: input.session_id, preview_url: input.preview_url })
  writeTestReport({ request_id: input.request_id, session_id: input.session_id, project_id: input.project_id, result: testResult })
  syncDocuments({ request_id: input.request_id, project_id: input.project_id, session_id: input.session_id, checkpoint: 'mvp_tested' })

  while (testResult.failed_count > 0) {
    const cycle = await runRepairCycle({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      category: 'test_error',
      publish: (type, payload) => publish(input, type, payload),
      verify: async () => {
        testResult = await runGwtScenarios({ project_id: input.project_id, session_id: input.session_id, preview_url: input.preview_url })
        writeTestReport({ request_id: input.request_id, session_id: input.session_id, project_id: input.project_id, result: testResult })
        return { ok: testResult.failed_count === 0 }
      },
    })
    if (cycle.blocked) {
      publishBlockedDecision(input, 'test_repair')
      return { verdict: 'blocked', test_result: testResult }
    }
    if (cycle.repaired) break
  }

  // 测试通过 → 进入裁判审查（A2-11）
  updateProject(input.project_id, { current_stage: 'judge_review' })
  publish(input, 'stage_changed', { stage: 'judge_review' })
  const judge = await runJudgeReview({
    request_id: input.request_id,
    session_id: input.session_id,
    project_id: input.project_id,
  })
  return { verdict: judge.outcome, test_result: testResult, judge: judge.verdict }
}

function publish(input: Pick<SketchTaskInput, 'session_id' | 'project_id'>, type: AgentEvent['type'], payload: Record<string, unknown>): void {
  programmingEventPublisher({
    event_id: randomUUID(),
    session_id: input.session_id,
    project_id: input.project_id,
    type,
    payload,
    created_at: new Date().toISOString(),
  })
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
): void {
  updateProject(input.project_id, { current_stage: 'blocked_for_user_decision', blocked_action: action })
  publish(input, 'stage_changed', { stage: 'blocked_for_user_decision' })
  publish(input, 'user_decision_required', {
    kind: 'blocked',
    stage: 'blocked_for_user_decision',
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
  // 嵌套的 runMvpTask / runPostMvpTestingFlow / runJudgeReview 走同一发布通道
  setProgrammingEventPublisher(eventPublisher)

  const project = findProject(input.project_id)
  const action = project.blocked_action

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
    })
    await runPostMvpTestingFlow({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      preview_url: mvp.preview_url,
    })
    return
  }

  if (action === 'test_repair') {
    updateProject(input.project_id, { test_repair_count: 0 })
    const previewUrl = await ensureResumePreview(input)
    await runPostMvpTestingFlow({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      preview_url: previewUrl,
    })
    return
  }

  if (action === 'judge_return') {
    updateProject(input.project_id, { judge_return_count: 0 })
    await runJudgeReview({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
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
