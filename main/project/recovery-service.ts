import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, Project, RollbackResult, Snapshot, WorkflowStage } from '../../shared/types'
import { getAgentSessionPath } from '../../storage/config-paths'
import { appendJsonLine } from '../../storage/json-store'
import { appendSessionMessage } from '../platform/sessions/session-tree'
import { recordDecision } from '../project/decision-log'
import { hasInteractiveEntry } from '../verification/test-legacy'
import { listSnapshots, restoreSnapshotFiles, rollbackSnapshot } from '../delivery/snapshots'
import { findProject, listProjects, updateProject } from '../project/project-service'
import { isHtmlDocument } from '../coding/sketch-engine-llm'
import { commitProjectState } from '../coding/project-git'
import { openRepairEpoch } from '../coding/repair-ledger'

/**
 * 恢复服务（长期型改造 T1 + T5）——崩溃对账与熔断回滚共用的状态收敛逻辑。
 *
 * 核心原则（阶段如实性）：只认磁盘证据，不推断进度。
 * - 「产物完整」= index.html 通过 isHtmlDocument 校验（复用草图产物同款闭合校验）
 *   且 gwt-service.hasInteractiveEntry 判定有交互入口（MVP 级产物，非纯外观草图）；
 * - 完整 → ready；仅草图级（合法 HTML 但无交互入口）→ sketch_ready；全无 → clarifying。
 */

export type DiskArtifactEvidence = 'complete' | 'sketch_only' | 'none'

/** 启动时视为「中断残留」的中间态：这些阶段在正常退出下不可能停留。 */
const INTERRUPTED_STAGES: ReadonlySet<WorkflowStage> = new Set([
  'generating_mvp',
  'testing',
  'judge_review',
  'repairing',
  'iterating',
  // M-16：历史版本把升级后项目停在 upgrading（无出口）——启动对账按磁盘证据收敛
  'upgrading',
])

/** 在这些阶段中断的，即使产物完整也须注明质量门未跑完（不冒充质量结论）。 */
const QUALITY_GATE_STAGES: ReadonlySet<WorkflowStage> = new Set(['testing', 'judge_review', 'repairing'])

const STAGE_LABEL: Partial<Record<WorkflowStage, string>> = {
  generating_mvp: '正在生成完整功能',
  testing: '正在检查能不能正常使用',
  judge_review: '正在确认功能是否到位',
  repairing: '正在尝试修复',
  iterating: '正在继续调整',
}

export interface ReconcileOutcome {
  project_id: string
  from_stage: WorkflowStage
  to_stage: WorkflowStage
  /** 恢复手段：磁盘产物直接认定 / 回滚健康快照后认定 */
  action: 'disk_verified' | 'snapshot_restored'
}

/** 按磁盘证据判定项目产物完整度（只读 root_path，不改任何状态）。 */
export function evaluateDiskArtifact(rootPath: string): DiskArtifactEvidence {
  const htmlPath = join(rootPath, 'index.html')
  if (!existsSync(htmlPath)) return 'none'
  let html: string
  try {
    html = readFileSync(htmlPath, 'utf8')
  } catch {
    return 'none'
  }
  if (!isHtmlDocument(html) && !isLoopStyleEntry(html)) return 'none'
  const appJsPath = join(rootPath, 'src', 'app.js')
  let appJs = ''
  if (existsSync(appJsPath)) {
    try {
      appJs = readFileSync(appJsPath, 'utf8')
    } catch {
      // 读不到按无脚本处理
    }
  }
  return hasInteractiveEntry(html, appJs) ? 'complete' : 'sketch_only'
}

/** 产物证据 → 收敛阶段：complete→ready / sketch_only→sketch_ready / none→clarifying。 */
export function convergeStageFromEvidence(evidence: DiskArtifactEvidence): 'ready' | 'sketch_ready' | 'clarifying' {
  if (evidence === 'complete') return 'ready'
  if (evidence === 'sketch_only') return 'sketch_ready'
  return 'clarifying'
}

/**
 * Agent Loop 产物入口判定（2026-08-25 线上案例）：结构与闭合同 isHtmlDocument，但样式
 * 走外链 `<link rel="stylesheet">`（src/styles.css）而非内联 `<style>`——loop 转正后
 * 的合法产物形态。isHtmlDocument 本体保持草图管线的「内联样式」校验语义不动，此处
 * 只放宽磁盘证据收敛（T1 启动对账 / T5 熔断回滚）对 loop 产物的误判
 * （此前外链样式产物被判 'none' → 收敛 clarifying + 「没有留下可用产物」假话）。
 */
function isLoopStyleEntry(html: string): boolean {
  return (
    /<link\b[^>]*\brel\s*=\s*["']?stylesheet/i.test(html) &&
    /<html[\s>]|<body[\s>]/i.test(html) &&
    /<\/html>\s*$/i.test(html)
  )
}

/** P1-07（2026-09-26 运行审计）：最近一个已验证快照（全部验证门通过后落的 verified
 *  分级）——回滚优先恢复它；缺省未标分级的存量快照不算 verified（不代签）。 */
export function latestVerifiedSnapshot(projectId: string): Snapshot | undefined {
  const snapshots = listSnapshots(projectId)
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    if (snapshots[index].verification === 'verified') return snapshots[index]
  }
  return undefined
}

/** 最近一个健康快照（health_status === 'healthy'，复用 Snapshot 既有字段）；无则 undefined。 */
export function latestHealthySnapshot(projectId: string): Snapshot | undefined {
  const snapshots = listSnapshots(projectId)
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    if (snapshots[index].health_status === 'healthy') return snapshots[index]
  }
  return undefined
}

/**
 * T1 启动对账：app.whenReady 后扫描一次全部项目索引，把停留在中间态的
 * 「孤儿项目」按磁盘证据收敛，并在会话 JSONL 落一条如实 system 消息。
 * 归档项目不处理（不改变用户已归档的可见状态）。
 */
export async function reconcileInterruptedProjects(): Promise<ReconcileOutcome[]> {
  const interrupted = listProjects('all').filter(
    (project) => project.status === 'active' && INTERRUPTED_STAGES.has(project.current_stage),
  )
  const outcomes: ReconcileOutcome[] = []
  for (const project of interrupted) {
    try {
      outcomes.push(await reconcileInterruptedProject(project))
    } catch (error) {
      // 单项目对账失败不阻断其他项目，也不阻断启动
      console.error(`[reconcile] 项目 ${project.project_id} 对账失败:`, error)
    }
  }
  return outcomes
}

async function reconcileInterruptedProject(project: Project): Promise<ReconcileOutcome> {
  let evidence = evaluateDiskArtifact(project.root_path)
  let action: ReconcileOutcome['action'] = 'disk_verified'
  let restoredFrom: Snapshot | undefined

  if (evidence !== 'complete') {
    const healthy = latestHealthySnapshot(project.project_id)
    if (healthy) {
      // 无完整产物但磁盘有健康快照：恢复快照文件（不重启沙箱、不拍 guard——
      // 崩溃残留本就是待丢弃状态，启动期也只应拉起用户当前打开的沙箱）
      await restoreSnapshotFiles({ request_id: 'startup-reconcile', project_id: project.project_id, snapshot_id: healthy.snapshot_id })
      evidence = evaluateDiskArtifact(project.root_path)
      action = 'snapshot_restored'
      restoredFrom = healthy
    }
  }

  const toStage = convergeStageFromEvidence(evidence)
  // P0-3（2026-09-04 拍板「交用户决策」）：从质量门阶段（testing/judge_review/repairing）
  // 中断（用户取消）的项目，磁盘产物虽完整但 GWT 未全过、终审未跑——不能冒充 ready。
  // 收敛到 blocked_for_user_decision（blocked_action=test_repair 复用 resume 闭环：
  // continue=重跑测试+终审 / accept=接受当前版本 / explain=回澄清）。
  const qualityGateInterrupted = evidence === 'complete' && QUALITY_GATE_STAGES.has(project.current_stage)
  const finalStage: WorkflowStage = qualityGateInterrupted ? 'blocked_for_user_decision' : toStage
  updateProject(project.project_id, {
    current_stage: finalStage,
    blocked_action: qualityGateInterrupted ? 'test_repair' : undefined,
  })
  persistReconcileMessage(project, finalStage, action, restoredFrom)

  return {
    project_id: project.project_id,
    from_stage: project.current_stage,
    to_stage: finalStage,
    action,
  }
}

/** 落一条如实 system 消息到项目最后活跃会话 + 记决策日志（启动收敛属系统级状态跃迁）。 */
function persistReconcileMessage(
  project: Project,
  toStage: WorkflowStage,
  action: ReconcileOutcome['action'],
  restoredFrom: Snapshot | undefined,
): void {
  const sessionId = project.last_session_id
  if (!sessionId) return

  const parts = [`检测到上次运行在「${STAGE_LABEL[project.current_stage] ?? project.current_stage}」阶段被中断。`]
  if (action === 'snapshot_restored' && restoredFrom) {
    parts.push(`磁盘上的产物不完整，已回滚到最近一个健康快照（${restoredFrom.snapshot_id.slice(0, 8)}，${restoredFrom.created_at.slice(0, 19).replace('T', ' ')} 创建）。`)
  }
  if (toStage === 'ready') {
    parts.push('现在磁盘上的产物是完整的，项目已恢复为可用状态。')
    if (QUALITY_GATE_STAGES.has(project.current_stage)) {
      parts.push('注意：当时的测试与裁判审查未执行完毕，此处的「可用」仅表示产物完整，不是质量结论。')
    }
  } else if (toStage === 'blocked_for_user_decision') {
    parts.push('磁盘上的产物是完整的，但上次运行在测试或审查未完成时被中断，还需要你决定是继续完成测试，还是保留当前版本。')
  } else if (toStage === 'sketch_ready') {
    parts.push('磁盘上目前只剩草图产物，项目已回到草图确认阶段。')
  } else {
    parts.push('磁盘上没有找到完整产物，也没有可用的健康快照，项目已回到需求澄清阶段，请重新描述你的想法。')
  }
  const text = `[reconcile] ${parts.join('')}`

  appendSessionMessage(sessionId, {
    role: 'system',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  })
  recordDecision({
    project_id: project.project_id,
    session_id: sessionId,
    entry: {
      type: 'startup_convergence',
      title: '启动对账：中断项目收敛',
      why: `${STAGE_LABEL[project.current_stage] ?? project.current_stage} 阶段中断后按磁盘证据收敛为 ${toStage}`,
      detail: {
        from_stage: project.current_stage,
        to_stage: toStage,
        action,
        restored_snapshot_id: restoredFrom?.snapshot_id,
      },
    },
  })
}

// =========================================================================
// T5 熔断回滚事务（修复循环耗尽 ≠ 只让渡）
// =========================================================================

/**
 * 熔断已完成收尾的哨兵错误：circuitBreakRollback 成功后由调用方抛出，
 * 上层（runAgent / ipc fire-and-forget）识别后不得再按普通失败处理
 * （不覆盖阶段、不发 error 事件）——回滚、阶段收敛、如实消息均已在回滚内完成。
 */
export class CircuitBreakSettledError extends Error {
  constructor() {
    super('REPAIR_CIRCUIT_SETTLED: 修复循环耗尽已熔断回滚并完成收尾')
    this.name = 'CircuitBreakSettledError'
  }
}

export function isCircuitBreakSettled(error: unknown): boolean {
  return error instanceof CircuitBreakSettledError
}

export interface CircuitBreakInput {
  request_id: string
  session_id: string
  project_id: string
  /** 熔断原因（如「runtime 修复循环耗尽（mvp_repair）」），进决策日志 */
  reason: string
  /** 已知未通过项摘要（2026-09-06 地牢清怪录/随记灵案）：回滚目标快照是终验失败前
   * 的版本，回滚后停在 ready 但断言仍不过——话术必须如实告知，不能说「可以继续试用」
   * 把坏版本当健康品。缺省不附加（其余熔断路径零回归）。 */
  failureNote?: string
  publish: (type: AgentEvent['type'], payload: Record<string, unknown>) => void
}

export interface CircuitBreakResult {
  rolled_back: boolean
  stage?: WorkflowStage
  snapshot_id?: string
  error?: string
}

/**
 * T5 熔断回滚：修复循环耗尽后不再只让渡——
 * 1. 有健康快照 → 调 rollback_snapshot（guard 保护 + 停沙箱 + 恢复文件/文档 + 重启沙箱），
 *    失败重试一次；成功后按磁盘证据收敛阶段（与 T1 同一套逻辑）并清零全部修复计数；
 * 2. 回滚仍失败 / 无健康快照 → 如实告知，交回 blocked_for_user_decision 让渡，不留半事务态。
 */
export async function circuitBreakRollback(input: CircuitBreakInput): Promise<CircuitBreakResult> {
  const project = findProject(input.project_id)
  // P1-07：回滚目标优先「已验证快照」（全部验证门通过）；无 verified 才退最近健康
  // 快照（可预览但未经终验——存量快照亦按可预览理解，不冒充已验证）。
  const verifiedSnapshot = latestVerifiedSnapshot(input.project_id)
  const healthy = verifiedSnapshot ?? latestHealthySnapshot(input.project_id)
  if (!healthy) return { rolled_back: false }
  const restoreBasis = verifiedSnapshot ? 'verified' : 'recoverable'

  // Phase 10 W1-1：回滚前提交（失败态入库；fail-open 模块内部永不抛错）。恢复原语
  // 排除 .git（SNAPSHOT_PRESERVED_TOPLEVEL），版本史跨回滚连续累积。
  commitProjectState(project.root_path, { kind: 'rollback_pre', summary: `熔断回滚前（${input.reason.slice(0, 80)}）` })

  // 话术口径（狗粮 52f19ab4：0 次修复轮也报「多次都没有成功」）——修复次数在清零前
  // 如实读取；「回到之前的版本」在首次生成时语义错位，改用 Phase 7 已确立的
  // 「保存的版本」术语（恢复到最近保存的快照，首次/迭代两态均如实）。
  const repairsAttempted =
    (project.test_repair_count ?? 0) + (project.security_repair_count ?? 0) + (project.runtime_repair_count ?? 0)
  const repairPhrase =
    repairsAttempted <= 0
      ? '这次没能进行自动修复（触发熔断时没有可用的修复轮）'
      : repairsAttempted === 1
        ? '自动修复 1 轮没有成功'
        : `自动修复 ${repairsAttempted} 轮都没有成功`

  let lastError: unknown
  let rollback: RollbackResult | undefined
  for (let attempt = 0; attempt < 2 && !rollback; attempt += 1) {
    try {
      rollback = await rollbackSnapshot({
        request_id: input.request_id,
        project_id: input.project_id,
        snapshot_id: healthy.snapshot_id,
        // reason 受 api-spec 枚举约束，取熔断专用值；完整语境在决策日志里
        reason: 'repair_fuse',
      })
      // Phase 10 W1-1：回滚后提交（恢复态入库——重演在版本史里可见为一次反向提交）
      commitProjectState(project.root_path, { kind: 'rollback_post', summary: `熔断回滚完成（恢复到 ${healthy.snapshot_id.slice(0, 8)}·${restoreBasis}）` })
    } catch (error) {
      lastError = error
    }
  }

  if (!rollback) {
    const message =
      `${repairPhrase}，回滚到最近保存的健康版本也没有成功。当前版本可能不完整，` +
      '你可以从底部时间轴手动选择一个快照回滚，或者告诉我重新生成一版。'
    appendAssistantMessage(input.session_id, message)
    input.publish('message_delta', { text: message })
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'circuit_rollback',
        title: '熔断回滚失败（让渡）',
        why: `修复耗尽后回滚健康快照失败，项目保持 blocked_for_user_decision 交用户决策：${describeError(lastError)}`,
        detail: { reason: input.reason, snapshot_id: healthy.snapshot_id },
      },
    })
    return { rolled_back: false, error: describeError(lastError) }
  }

  const stage = convergeStageFromEvidence(evaluateDiskArtifact(project.root_path))
  // 2026-09-26 审计 P1-02：回滚=新预算纪元（epoch+1 留痕）；跨 epoch 累计尝试与账本
  // 不清零（回滚不擦除历史）。runtime/security/judge 计数保持原语义一并归零。
  openRepairEpoch(input.project_id, 'circuit_rollback')
  updateProject(input.project_id, {
    current_stage: stage,
    runtime_repair_count: 0,
    security_repair_count: 0,
    judge_return_count: 0,
    blocked_action: undefined,
  })

  // 「内容未丢失」话术对齐 self-healing-judge @S2-JUDGE-002（原 ROLLBACK_FUSE_COPY）；
  // failureNote：回滚目标带已知未通过断言时如实附加（随记灵 2026-09-06 案：
  // 「可以继续试用这一版」把 F-002 坏版本当健康品，用户下一轮「用不了」）。
  // R0.6（2026-09-19 狗粮 7601e5ae）：话术不再一律称「内容都还在」——恢复的是代码与
  // 文档；使用数据（data/）不随版本回滚，回滚前已整份备份（restoreSnapshotFiles 无条件
  // 备份），狗粮实锤旧话术与磁盘事实矛盾（data/ 被清空却说没丢失）。
  const dataNote = rollback.data_backup_dir
    ? `使用数据不随版本回滚，回滚前的数据已备份到 data-backups/${(rollback.data_backup_dir.split(/[\\/]/).pop() ?? '')}，需要时可以找回。`
    : ''
  const message =
    stage === 'ready'
      ? `${repairPhrase}，已自动恢复到最近保存的${restoreBasis === 'verified' ? '已验证版本（该版本已通过全部验证）' : '版本（该版本尚未通过终验，仅确认可预览）'}（代码与文档）。${dataNote}${input.failureNote ?? '你可以继续试用这一版，或者告诉我换个思路重新生成。'}`
      : stage === 'sketch_ready'
        ? `${repairPhrase}，已自动恢复到最近保存的版本（草图阶段）。${dataNote}可以重新确认草图后再生成完整功能。`
        : `${repairPhrase}，且最近保存的版本没有留下可用产物。请重新描述你的想法，我们再来一次。`
  appendAssistantMessage(input.session_id, message)
  // rollback_done 先行（渲染端契约：用它回填预览地址，与旧让渡路径一致），再收敛阶段、发消息收尾
  input.publish('rollback_done', {
    snapshot_id: rollback.current_snapshot_id,
    preview_url: rollback.preview_url,
  })
  input.publish('stage_changed', { stage })
  input.publish('message_delta', { text: message })
  input.publish('completed', { subtype: 'success' })
  // W5（2026-09-18 本月流水账案）：熔断→ready 也发 mvp_review 卡——田掉引导链断点。
  // B0 实锤错误放行 5/5 走本路径，而 mvp_review/ready_next_steps 只在健康路径发布，
  // 「最该被引导的会话反而零引导」。failureNote 非空（带已知未通过项）时主选项
  // fix_now（先修这一项，进定向修复轮）；决策路由在 orchestrator 同一消费口。
  if (stage === 'ready') {
    const hasKnownFailures = Boolean(input.failureNote && input.failureNote.trim())
    input.publish('user_decision_required', {
      kind: 'mvp_review',
      title: hasKnownFailures ? '这一版有未通过项——先修还是先用？' : '这一版你满意吗？',
      questions: hasKnownFailures
        ? [
            { id: 'fix_now', label: '先修这一项', description: '定向修复已知未通过项，修完重新终验（不改需求清单）' },
            { id: 'keep', label: '接受当前版本', description: '先保留这一版，之后可随时再修' },
            { id: 'optimize', label: '局部优化', description: '去输入框说说要改哪里（只改这一处）' },
          ]
        : [
            { id: 'keep', label: '保持现状', description: '就到这里，当前版本保留' },
            { id: 'optimize', label: '局部优化', description: '去输入框说说要改哪里（只改这一处）' },
            { id: 'rebuild', label: '整版重做', description: '换一种方式把功能重做一遍' },
          ],
    })
  }
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'circuit_rollback',
      title: '修复循环耗尽，熔断回滚',
      why: `${input.reason}，已回滚到${restoreBasis === 'verified' ? '已验证快照' : '可预览快照（未过终验）'}并按磁盘证据收敛为 ${stage}`,
      detail: { reason: input.reason, snapshot_id: healthy.snapshot_id, stage, restore_basis: restoreBasis },
    },
  })
  return { rolled_back: true, stage, snapshot_id: healthy.snapshot_id }
}

function appendAssistantMessage(sessionId: string, text: string): void {
  appendSessionMessage(sessionId, {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  })
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
