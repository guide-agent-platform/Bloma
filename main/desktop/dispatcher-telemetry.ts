/**
 * 桌面线运行遥测（2026-10-04 从 dispatcher-loop 拆出——R7 800 行红线，拆分不豁免）。
 *
 * 起跑留痕（desktop_dispatch_run_started）+ 收口指标（desktop_dispatch_run：阶段/
 * 终态/轮数/工具计数/usage/轮级摘要/拒因修复分类/推进维度）。起跑事件是 10-04 晚
 * implement 卡 7 分半零观测痕迹的补丁——收口事件只在 loop 结束发，中途停止/挂起的
 * 运行此前无任何记录，卡点归因只能盘外推断。
 */
import type { DesktopDispatchRunInput, DesktopDispatchRunResult } from './dispatcher-loop'
import { trackAnalytics } from '../delivery/track-analytics'


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
    trackAnalytics({
      request_id: `desktop-dispatch-${input.sessionId}-${startedAt}`,
      event: {
        event_type: 'desktop_dispatch_run',
        project_id: input.projectId,
        session_id: input.sessionId,
        payload: {
          phase: result.phase?.id,
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
        },
        privacy_level: 'masked',
      },
    })
  } catch {
    // 遥测失败不反噬业务（analytics 写盘兜底已有；此处防未预期形状）
  }
}
