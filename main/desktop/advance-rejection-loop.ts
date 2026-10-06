/**
 * 拒收教育闭环（批次 E，2026-09-24）——把「拒收」从静默等待补齐为四要素闭环。
 *
 * 四要素（借结构思想自写；竞品 F5 闭环证伪注记的教训已吸收：两条拒收路径此前
 * 均已有教育注入，缺的是「驱动」——注入≠续接，拒收后模型看不到拒收就结束了）：
 *   ① 可见：教育消息注入会话（模型与用户都看得到拒收原因与正确做法）；
 *   ② 驱动：systemInitiated 续接指令（系统发起的下一轮驱动——拒收后立即续跑，
 *      不等用户新输入）；
 *   ③ 防环：同项目同阶段拒收闭环 ≤2 次，第 3 次起降级；
 *   ④ 降级：转人工提示（不再注入续接——防「拒收→注入→续接→再拒收」死循环烧 token）。
 *
 * 三态拒因登记（供诊断与遥测）：target-deny（目标校验拒）/ gate-deny（门禁拒：
 * 产物/驱动/契约）。（confirmation-required 随刀1 撤 manual 门删除，2026-10-03 删留执行）
 *
 * 推进成功：计数清零 + 待纠正拒因清除（新阶段重新计数）。
 *
 * 纯函数 + 状态注入（RejectionLedger 由调用方持有——编排层挂内存或持久化皆可）；
 * web 线可复用同一闭环模式（本模块零桌面语义耦合）。
 */

import type { AdvanceDecision } from './dispatcher-gate'
import { buildGateRejectionEdu } from './dispatcher-gate'

// =========================================================================
// 状态账本
// =========================================================================

/** 拒收账本（项目级；调用方持有，本模块只读写注入的这个对象）。 */
export interface RejectionLedger {
  /** 阶段 id → 拒收教育闭环已发生次数（防环计数）。 */
  counts: Record<string, number>
  /** 待纠正拒因（最后一次拒收的三态归因；推进成功清除）。 */
  pendingReasons: Record<string, RejectionFamily>
}

/** 三态拒因家族。 */
export type RejectionFamily = 'target-deny' | 'gate-deny'

/** 新账本。 */
export function createRejectionLedger(): RejectionLedger {
  return { counts: {}, pendingReasons: {} }
}

/** 防环上限：同阶段拒收教育闭环最多 2 次，第 3 次起降级人工。 */
export const REJECTION_LOOP_LIMIT = 2

// =========================================================================
// 拒因归类
// =========================================================================

/** AdvanceDecision 拒因 → 三态家族（education 语义归并，供登记与诊断）。 */
export function classifyRejection(decision: AdvanceDecision & { decision: 'reject' }): RejectionFamily {
  switch (decision.reason) {
    case 'unknown-target':
    case 'not-next':
    case 'terminal':
    case 'multiple-divergent':
    case 'unknown-current':
    case 'no-marks':
      return 'target-deny'
    case 'artifacts-missing':
    case 'contract-invalid':
    case 'security-fail':
    case 'test-invalid':
    case 'fault-survived':
      return 'gate-deny'
  }
}

// =========================================================================
// 闭环决策
// =========================================================================

/** 闭环动作。 */
export interface RejectionLoopAction {
  /** degrade=true 时不再注入续接（转人工；教育仍注入——用户需要看到状态）。 */
  degrade: boolean
  /** 教育消息（可见要素①；两态都返回）。 */
  education: string
  /** systemInitiated 续接指令（驱动要素②；degrade 时为 undefined）。 */
  continuation?: string
  /** 本次闭环后的计数（1/2/3...；deigrate=计数仍+1但不再续接）。 */
  count: number
  /** 拒因家族（三态登记）。 */
  family: RejectionFamily
}

/**
 * 拒收闭环决策（纯函数）：
 * - 教育消息：AdvanceDecision 已带 education 时直接用（保持三段式单一真源），
 *   缺失时按 family 兜底重建；
 * - 计数 <上限 → 注入续接（含唯一合法目标与正确动作指令）；
 * - 计数 ≥上限（本次是第 3+ 次）→ 降级：教育 + 转人工提示，无续接。
 *
 * 副作用约定：本函数只决策不改账本——registerRejection 落账（调用方一先一后，
 * 防止决策失败也计数的假账）。
 */
export function decideRejectionLoop(
  ledger: RejectionLedger,
  phaseId: string,
  decision: AdvanceDecision & { decision: 'reject' },
): RejectionLoopAction {
  const family = classifyRejection(decision)
  const nextCount = (ledger.counts[phaseId] ?? 0) + 1
  const degrade = nextCount > REJECTION_LOOP_LIMIT
  const education = decision.education || buildGateRejectionEdu('no-marks', { current: phaseId })

  if (degrade) {
    return {
      degrade: true,
      education:
        education +
        `\n\n【已降级转人工】本阶段拒收教育闭环已达上限（${REJECTION_LOOP_LIMIT} 次），系统不再自动续接。` +
        '已转为人工介入态（blocked）：用户回复「继续」可再试一轮，或直接给出修改意见。',
      count: nextCount,
      family,
    }
  }

  const expected = 'expected' in decision && decision.expected ? String(decision.expected) : undefined
  return {
    degrade: false,
    education,
    continuation: buildContinuationDirective(phaseId, family, expected, decision),
    count: nextCount,
    family,
  }
}

/** 落账（决策成功后调用；幂等性由调用方保证——一次拒收一次落账）。 */
export function registerRejection(ledger: RejectionLedger, phaseId: string, family: RejectionFamily, count: number): void {
  ledger.counts[phaseId] = count
  ledger.pendingReasons[phaseId] = family
}

/** 推进成功：计数清零 + 待纠正拒因清除（新阶段重新计数）。 */
export function clearRejectionOnAdvance(ledger: RejectionLedger, phaseId: string): void {
  delete ledger.counts[phaseId]
  delete ledger.pendingReasons[phaseId]
}

// =========================================================================
// 续接指令构建
// =========================================================================

/**
 * systemInitiated 续接指令（驱动要素②）：系统发起的下一轮 user 指令——
 * 模型在拒收后立即看到「拒收已发生 + 现在做什么」，不等用户新输入。
 * 指令要素：当前阶段 / 拒因家族 / 唯一合法目标（有则给）/ 明确动作。
 */
export function buildContinuationDirective(
  phaseId: string,
  family: RejectionFamily,
  expected: string | undefined,
  detail?: AdvanceDecision & { decision: 'reject' },
): string {
  const head = `[system·拒收续接] 阶段「${phaseId}」的推进声明被裁决边界拒绝（${family}），请立即按以下指引继续工作：`
  const familyAction: Record<RejectionFamily, string> = {
    'target-deny': expected
      ? `本阶段唯一合法推进目标是「${expected}」。请先完成当前阶段门禁，再以注释或行首形态单独一行输出 PHASE_ADVANCE: ${expected}；句中复述协议字面串不构成推进。`
      : '请检查推进目标：只能推进到当前阶段的唯一合法下一阶段（见系统提示词推进协议段）；句中复述不构成推进。',
    'gate-deny': '门禁未过：请核对缺失产物清单，委派补齐（产物必须真实存在且内容有效），然后重新声明推进。',
  }
  const missing = detail && 'missingArtifacts' in detail && detail.missingArtifacts?.length
    ? `\n缺失产物：${detail.missingArtifacts.flatMap((m) => m.artifacts).join('、')}`
    : ''
  const actual = detail && 'actual' in detail && detail.actual ? `\n本次声明目标：「${detail.actual}」` : ''
  // 刀4 强化（狗粮 c21e10b1 实证，2026-10-03）：implement 段全英文叙述——续接指令是每轮
  // 最强提醒位，语言纪律随拒收教育重选（英文工具输出占比高时模型语言漂移）。
  const disciplineReminder = '\n输出纪律提醒：面向用户文本一律中文、≤2 句要点，结尾只给下一步一句话或推进标记。'
  return `${head}${actual}${missing}\n${familyAction[family]}${disciplineReminder}`
}
