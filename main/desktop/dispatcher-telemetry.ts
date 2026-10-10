/**
 * 桌面线运行遥测（2026-10-04 从 dispatcher-loop 拆出——R7 800 行红线，拆分不豁免）。
 *
 * 起跑留痕（desktop_dispatch_run_started）+ 收口指标（desktop_dispatch_run：阶段/
 * 终态/轮数/工具计数/usage/轮级摘要/拒因修复分类/推进维度）。起跑事件是 10-04 晚
 * implement 卡 7 分半零观测痕迹的补丁——收口事件只在 loop 结束发，中途停止/挂起的
 * 运行此前无任何记录，卡点归因只能盘外推断。
 *
 * 批5（2026-10-06 质量指标地基）：①attempt_index/final_outcome 进收口事件
 * （过程层指标口径：同阶段段序号 + 结构化终态枚举）；②desktop_delivery_outcome
 * 交付汇总事件（delivered 时一条：模式/路径/驱动结果/验收覆盖/探索状态/冒烟证据，
 * 从磁盘真相源读——scripts/quality-report.mjs 直接消费）。
 */
import type { DesktopDispatchRunInput, DesktopDispatchRunResult } from './dispatcher-loop'
import { trackAnalytics } from '../delivery/track-analytics'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findProject } from '../project/project-service'
import { getAnalyticsPath } from '../../storage/config-paths'


/** 起跑留痕（每段 run 一条；失败静默不阻断主链路）。 */
export function recordDispatchStartTelemetry(input: DesktopDispatchRunInput, startedAt: number): void {
  try {
    trackAnalytics({
      request_id: `desktop-dispatch-${input.sessionId}-${startedAt}`,
      event: {
        event_type: 'desktop_dispatch_run_started',
        project_id: input.projectId,
        session_id: input.sessionId,
        payload: { phase: input.currentPhase },
        privacy_level: 'research_safe',
      },
    })
  } catch {
    // 遥测失败不阻断主链路
  }
}

/** 拒因修复分类（指标果集，2026-10-02）：对齐竞品 PE 回炉三分类口径——behavior（行为
 *  失败回炉 coding）/ mapping（协议·方言错配，不烧 coding 预算）/ coverage（场景覆盖
 *  补齐），另加 structure（产物结构缺失）/ environment（环境阻塞）/ confirm（确认非回炉）/
 *  discipline（推进纪律）。锚定文案来自本模块拒收教育的稳定前缀（改文案须同步此处）。 */
export function deriveRepairClass(result: DesktopDispatchRunResult): string | undefined {
  const advance = result.advance
  if (!advance || advance.decision !== 'reject') return undefined
  if (advance.reason === 'contract-invalid') return 'mapping'
  if (advance.reason === 'security-fail') return 'behavior' // 安全缺陷属行为面回炉（显式映射，不再靠教育文案关键词）
  if (advance.reason === 'test-invalid' || advance.reason === 'fault-survived') return 'coverage' // 批6：测试有效性回炉（断言/覆盖补齐）
  if (advance.reason === 'driver-blocked') return 'environment' // 批9.5：环境阻塞显式映射（不再依赖教育关键词顺序）
  if (advance.reason === 'driver-fail') return 'behavior' // 批9.5：断言红回行为面
  const education = advance.education ?? ''
  if (education.includes('裁判门未过')) {
    if (education.includes('场景覆盖不足')) return 'coverage'
    return 'structure' // PRD 空 / 入口缺失
  }
  if (education.includes('没有任何验证证据')) return 'coverage' // 空驱动：场景未发生
  if (education.includes('宿主安全扫描未通过')) return 'behavior' // 安全缺陷属行为面回炉
  const routing = result.driverReport?.routing
  if (routing === 'blocked') return 'environment'
  if (routing === 'fail') return 'behavior'
  if (advance.reason === 'no-marks' || advance.reason === 'unknown-target' || advance.reason === 'not-next' || advance.reason === 'multiple-divergent' || advance.reason === 'unknown-current' || advance.reason === 'terminal') return 'discipline'
  return 'structure' // 产物缺失等结构类
}

export function recordDispatchRunTelemetry(
  input: DesktopDispatchRunInput,
  result: DesktopDispatchRunResult,
  startedAt: number,
): void {
  try {
    const loopResult = result.loopResult
    const toolCalls = loopResult?.toolCalls ?? []
    // 指标采集（2026-10-02，竞品对照指标体系）：①轮级 usage（段首上下文重建成本 =
    // 前 3 轮 input / 段总 input——段式编排 vs 连续会话的结构性差异度量；回炉 token 比
    // 的分子分母由此与段级 usage 组成）；②拒因修复分类（对齐 PE 三分类口径：behavior
    // 行为失败回炉 coding / mapping 协议·方言错配不烧 coding 预算 / coverage 场景覆盖
    // 补齐；另加 structure 产物结构 / environment 环境 / confirm 确认非回炉）。
    const turnsUsage = loopResult?.turnsUsage ?? []
    const turnsInputTotal = turnsUsage.reduce((sum, t) => sum + t.inputTokens, 0)
    const head3Input = turnsUsage.filter((t) => t.turn <= 3).reduce((sum, t) => sum + t.inputTokens, 0)
    const repairClass = deriveRepairClass(result)
    const payload: Record<string, unknown> = {
      verification_policy: result.testEffectiveness?.mode ?? input.verificationPolicy ?? (process.env.BLOMA_VERIFY_POLICY === 'strict' ? 'strict' : 'standard'),
      phase: result.phase?.id ?? input.currentPhase,
      status: result.status,
      loop_status: loopResult?.status,
      turns: loopResult?.turns,
      tool_calls: {
        total: toolCalls.length,
        ok: toolCalls.filter((c) => c.status === 'ok').length,
        error: toolCalls.filter((c) => c.status === 'error').length,
        delegate: toolCalls.filter((c) => typeof c.name === 'string' && c.name.startsWith('delegate')).length,
      },
      usage: loopResult?.usage
            ? {
                input: loopResult.usage.inputTokens,
                output: loopResult.usage.outputTokens,
                est_total: loopResult.usage.estTotalTokens,
              }
            : undefined,
          // 轮级 usage（指标果集）：前 3 轮 input 占比（段首重建成本，连续会话形态应→0）
          // + 按轮明细（狗粮复盘：哪几轮烧的 input 最大）
          ...(turnsUsage.length > 0
            ? {
                turns_usage: {
                  head3_input_ratio: turnsInputTotal > 0 ? Number((head3Input / turnsInputTotal).toFixed(3)) : null,
                  per_turn: turnsUsage,
                },
              }
            : {}),
          ...(repairClass ? { repair_class: repairClass } : {}),
          advance: result.advance
            ? result.advance.decision === 'advance'
              ? { decision: 'advance', target: result.advance.target }
              : {
                  decision: 'reject',
                  reason: result.advance.reason,
                  ...(result.advance.missingArtifacts ? { missing_artifacts: result.advance.missingArtifacts } : {}),
                  ...(result.advance.education ? { education: result.advance.education.slice(0, 400) } : {}),
                }
            : undefined,
          driver: result.driverReport,
          // 批6（2026-10-06）：测试有效性反证摘要（击杀率进遥测，大矩阵指标面）。
          ...(result.testEffectiveness
            ? {
                fault_kill: {
                  audit_reject: result.testEffectiveness.audit.findings.filter((f) => f.state === 'reject').length,
                  audit_inconclusive: result.testEffectiveness.audit.findings.filter((f) => f.state === 'inconclusive').length,
                  ...(result.testEffectiveness.audit.error ? { audit_error: result.testEffectiveness.audit.error } : {}),
                  killed: result.testEffectiveness.faultKill.killed,
                  executed: result.testEffectiveness.faultKill.executed,
                  survived: result.testEffectiveness.faultKill.survived,
                  not_applicable: result.testEffectiveness.faultKill.notApplicable,
                  not_run: result.testEffectiveness.faultKill.notRun,
                },
              }
            : {}),
          // P0-1c 软对账观测（2026-10-02）：P0 断言未命中场景名清单 + 计数——狗粮标定
          // 误杀率的数据面（命中≠验证充分，未命中也不阻断——只暴露对账缺口供复盘）。
          judge_coverage_gaps: result.judgeCoverageGaps ?? [],
          // 刀2 checkpoint（2026-10-02）：写入/消费各一维度——重验率 = 同阶段多段中
          // driver 重复执行占比（写入=本段落了存证；consumed=本段注入了勿重验结论）。
          checkpoint: {
            ...(result.checkpoint ? { recorded: result.checkpoint.stage } : { recorded: null }),
            consumed: Boolean(input.verifiedConclusion),
          },
          duration_ms: Date.now() - startedAt,
    }
    recordAttemptAndOutcome(input, result, payload)
    trackAnalytics({
      request_id: `desktop-dispatch-${input.sessionId}-${startedAt}`,
      event: {
        event_type: 'desktop_dispatch_run',
        project_id: input.projectId,
        session_id: input.sessionId,
        payload,
        privacy_level: 'masked',
      },
    })
  } catch {
    // 遥测失败不反噬业务（analytics 写盘兜底已有；此处防未预期形状）
  }
}

// =========================================================================
// 批5（2026-10-06 质量指标地基）：attempt_index / final_outcome / 交付汇总事件
// =========================================================================

/** 同项目同阶段的段计数；首次使用从 analytics.jsonl 恢复，按日志路径隔离不同 home/工作区。 */
const phaseRunCounts = new Map<string, number>()

/** 测试隔离用（beforeEach 重置；生产无需）。 */
export function resetDispatchTelemetryForTests(): void {
  phaseRunCounts.clear()
}

/**
 * 结构化终态（讨论 turn9 口径）：pass / product_fail / test_fail / security_fail /
 * infra_error / budget_exceeded / cancelled / inconclusive。从 advance + driver 路由 +
 * 修复分类收敛——「重试后绿」不抹掉本段终态（每段如实记录，首次通过率由报告侧聚合）。
 */
export function deriveFinalOutcome(result: DesktopDispatchRunResult): string {
  const advance = result.advance
  if (!advance) {
    const loopStatus = result.loopResult?.status
    if (loopStatus === 'cancelled') return 'cancelled'
    if (result.status === 'error') return 'infra_error'
    if (loopStatus && loopStatus !== 'completed') return 'budget_exceeded'
    return 'inconclusive'
  }
  if (advance.decision === 'advance') return 'pass'
  if (advance.reason === 'security-fail') return 'security_fail'
  const routing = result.driverReport?.routing
  if (routing === 'blocked') return 'infra_error'
  if (routing === 'fail') return 'product_fail'
  const repairClass = deriveRepairClass(result)
  if (repairClass === 'environment') return 'infra_error'
  if (repairClass === 'mapping' || repairClass === 'coverage') return 'test_fail'
  if (repairClass === 'behavior' || repairClass === 'structure') return 'product_fail'
  if (result.loopResult?.status !== 'completed') return 'budget_exceeded'
  return 'inconclusive'
}

/**
 * 参考本地 Proma bf3e98c 的 agent-session-usage.ts：逐行解析 JSONL，跳过坏行，
 * 读取失败不反噬业务。此处需扫描所有匹配段，用计数与最大序号兼容旧日志重启后重复的 1。
 * 只在当前进程首次遇到该项目/阶段时读取；不改写历史事件，也不引入另一份持久化计数器。
 */
function readPersistedRunCount(path: string, projectId: string, phaseId: string): number | undefined {
  let lines: string[]
  try {
    lines = readFileSync(path, 'utf8').split('\n')
  } catch (error) {
    // 日志不存在是首次运行；不可读则未知，不能冒充首次尝试。
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : undefined
  }
  let count = 0
  let maxIndex = 0
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed)) continue
      const event = isRecord(parsed.event) ? parsed.event : parsed
      if (event.event_type !== 'desktop_dispatch_run' || event.project_id !== projectId) continue
      const payload = event.payload
      if (!isRecord(payload) || payload.phase !== phaseId) continue
      count += 1
      const index = payload.attempt_index
      if (typeof index === 'number' && Number.isSafeInteger(index) && index > 0) {
        maxIndex = Math.max(maxIndex, index)
      }
    } catch {
      // 截断/损坏的行不能遮蔽其余完整运行记录。
    }
  }
  return Math.max(count, maxIndex)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 收口事件附加 attempt_index/final_outcome；历史不可读时省略序号，保留其他遥测。 */
function recordAttemptAndOutcome(input: DesktopDispatchRunInput, result: DesktopDispatchRunResult, payload: Record<string, unknown>): void {
  payload.final_outcome = deriveFinalOutcome(result)
  const phaseId = result.phase?.id ?? input.currentPhase
  let workspaceSlug = 'default-software-builder'
  try {
    workspaceSlug = findProject(input.projectId).workspace_slug
  } catch {
    // 与 trackAnalytics 的缺失项目回退路径一致。
  }
  const path = getAnalyticsPath(workspaceSlug)
  const key = JSON.stringify([path, input.projectId, phaseId])
  const previous = phaseRunCounts.get(key) ?? readPersistedRunCount(path, input.projectId, phaseId)
  if (previous === undefined || previous >= Number.MAX_SAFE_INTEGER) return
  const attemptIndex = previous + 1
  phaseRunCounts.set(key, attemptIndex)
  payload.attempt_index = attemptIndex
}

/**
 * 交付汇总事件（批5）：delivered 时一条——三处收口点（terminal/quick-direct/mvp-confirm）
 * 调用；从磁盘真相源读驱动结果/验收覆盖/探索状态/冒烟证据（与 MVP 过目页同一数据面），
 * scripts/quality-report.mjs 直接消费出三层指标。失败静默不阻断交付链。
 */
export function recordDeliveryOutcomeTelemetry(projectId: string, sessionId: string, via: 'terminal' | 'quick-direct' | 'mvp-confirm'): void {
  try {
    const project = findProject(projectId)
    const root = project?.root_path
    const payload: Record<string, unknown> = {
      via,
      mode: project?.mode ?? null,
      template_type: project?.template_type ?? null,
    }
    if (root) {
      try {
        const reportPath = join(root, '00_VERIFY', 'driver-report.json')
        if (existsSync(reportPath)) {
          const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
            routing?: string
            scenarios?: Array<{ outcome?: string }>
            acceptance_coverage?: Array<{ fid: string; passed: boolean }>
          }
          payload.driver = {
            routing: report.routing ?? null,
            scenarios_total: report.scenarios?.length ?? 0,
            scenarios_pass: report.scenarios?.filter((s) => s.outcome === 'pass').length ?? 0,
            acceptance_mapped: report.acceptance_coverage?.length ?? 0,
            acceptance_passed: report.acceptance_coverage?.filter((e) => e.passed).length ?? 0,
          }
        }
        const sessionsPath = join(root, '00_VERIFY', 'drive-sessions.json')
        if (existsSync(sessionsPath)) {
          const sessions = JSON.parse(readFileSync(sessionsPath, 'utf8')) as Array<{ outcome?: string }>
          payload.exploration = {
            sessions: sessions.length,
            degraded: sessions.filter((s) => s?.outcome !== 'closed').length,
          }
        }
        payload.smoke_screenshot = existsSync(join(root, '00_VERIFY', 'screenshots', 'LAUNCH.png'))
      } catch {
        // 磁盘佐证缺失如实省略（事件仍记录基础面）
      }
    }
    trackAnalytics({
      request_id: `desktop-delivery-${sessionId}-${Date.now()}`,
      event: {
        event_type: 'desktop_delivery_outcome',
        project_id: projectId,
        session_id: sessionId,
        payload,
        privacy_level: 'research_safe',
      },
    })
  } catch {
    // 遥测失败不阻断交付
  }
}
