/**
 * bench 指标纯函数（P0a，2026-09-09）。零依赖、可单测。
 *
 * computeFlags(evidence)：从采集证据给出 v0 失败特征标记（启发式，供人工校准）。
 * computeProjectMetrics(evidence)：结构化指标快照。
 */

/** AI 意图关键词：命中即认为任务/产品含 AI 能力诉求。 */
export const AI_INTENT_RE = /ai|智能|语音|总结|整理|自动生成|自动整理|ai/i
/** AI 能力保留关键词：PRD 需求/验收里出现才算「AI 能力没有被蒸馏掉」。 */
export const AI_CAPABILITY_RE = /ai|智能|语音|转文字|自动.*(总结|汇总|整理)|生成.*(总结|回答)|来源|引用|模型/i
/** 异常/外部依赖暗示（external-fault 类种子用）。 */
export const EXTERNAL_RE = /外部|服务不可用|超时|失败注入|断网|500|降级/i

function allText(evidence) {
  const parts = []
  if (evidence?.session?.userMessages) parts.push(...evidence.session.userMessages.map((u) => u.text))
  if (evidence?.docs?.prd?.positioning) parts.push(evidence.docs.prd.positioning)
  if (evidence?.docs?.prd?.requirements) parts.push(...evidence.docs.prd.requirements.map((r) => r.description))
  return parts.join('\n')
}

/**
 * v0 失败特征标记。只做「提示」，不做判定——共因/随机分类须人工校准。
 * 返回 [{code, severity:'info'|'warn'|'risk', detail}]
 */
export function computeFlags(evidence) {
  const flags = []
  const prd = evidence?.docs?.prd
  const tr = evidence?.docs?.testReport
  const an = evidence?.analytics || {}
  const docsMap = evidence?.docs?.docs || {}
  const text = allText(evidence)

  if (evidence?.project?.stage === 'blocked_for_user_decision') {
    flags.push({ code: 'blocked-decision', severity: 'warn', detail: '项目停在 blocked_for_user_decision，未走完或被中断，需人工确认' })
  }

  if (!evidence?.docs?.hasDocsDir) {
    flags.push({ code: 'no-docs', severity: 'risk', detail: 'documents 目录缺失，无 PRD/测试证据' })
    return flags
  }
  if (!prd) flags.push({ code: 'no-prd', severity: 'risk', detail: '缺 prd.json' })

  const wantsAI = AI_INTENT_RE.test(text)
  const keptAI = AI_CAPABILITY_RE.test((prd?.requirements || []).map((r) => r.description).join('\n'))
  const reqCount = prd?.requirementCount ?? 0

  // 蒸馏过素：想要 AI 能力，但需求项极少或需求文本里已无 AI 能力痕迹
  if (wantsAI && !keptAI) {
    flags.push({ code: 'distilled-ai', severity: 'risk', detail: `AI 意图明显但需求项未保留 AI 能力语义（req=${reqCount}）` })
  } else if (wantsAI && reqCount <= 3) {
    flags.push({ code: 'thin-ai', severity: 'warn', detail: `AI 意图且需求项偏少（req=${reqCount}），有蒸馏风险` })
  }

  // 测试证据缺失：无 test-report 且无 loop 完成事件
  if (!tr && !an.mvpDelivered && !docsMap.mvp_tested_md && !docsMap['test-report.json']) {
    flags.push({ code: 'no-test-evidence', severity: 'warn', detail: '既无 test-report 也无 mvp_delivered 事件，质量证据缺失' })
  } else if (!tr && an.mvpDelivered) {
    if (an.testCompleted) {
      // 判定证据在 analytics 事件（熔断回滚会清除工作区 test-report，事件 append-only 保留）
      const t = an.testCompleted
      if (t.failed > 0) flags.push({ code: 'test-failed-by-event', severity: 'risk', detail: `test_completed(${t.round}) 显示失败 ${t.failed}/${t.total}` })
      else flags.push({ code: 'test-event-ok', severity: 'info', detail: `test-report 文件缺失（疑回滚清除）但 test_completed(${t.round}) 已录：通过 ${t.total - t.failed}/${t.total}` })
    } else {
      flags.push({ code: 'test-report-missing', severity: 'info', detail: '有 mvp_delivered 但 documents 下无 test-report.json，且无 test_completed 事件' })
    }
  }
  if (tr?.failed > 0) {
    flags.push({ code: 'test-failed', severity: 'risk', detail: `test-report 显示失败 ${tr.failed}/${tr.total}` })
  }

  // 长循环未收敛 / 修复不收敛
  if (an.lastLoopStatus === 'cancelled') {
    flags.push({ code: 'loop-unfinished', severity: 'risk', detail: `最后一次 loop 状态 cancelled（turns=${an.lastLoopTurns ?? '?'}, repair=${an.repairAttempts}）` })
  } else if (!an.mvpDelivered && an.loopCompletedCount > 0) {
    flags.push({ code: 'no-delivery', severity: 'risk', detail: 'loop 已结束但无 mvp_delivered 事件' })
  }
  if ((an.repairAttempts ?? 0) >= 4) {
    flags.push({ code: 'high-repair', severity: 'warn', detail: `修复尝试 ${an.repairAttempts} 次仍未收敛，疑似共因或预算/停止条件不当` })
  }

  // PRD 未用户确认（老管道或绕过确认门的信号）
  if (prd && !prd.userConfirmed) {
    flags.push({ code: 'prd-unconfirmed', severity: 'info', detail: 'PRD 无 user_confirmed_at（老管道常见，需人工判断是否渠道绕过）' })
  }
  return flags
}

/** 结构化指标快照（供报告 json/md 使用）。 */
export function computeProjectMetrics(evidence) {
  const prd = evidence?.docs?.prd
  const tr = evidence?.docs?.testReport
  const an = evidence?.analytics || {}
  const flags = computeFlags(evidence)
  return {
    id: evidence?.project?.id,
    name: evidence?.project?.name || prd?.name || '',
    stage: evidence?.project?.stage || '',
    created: evidence?.project?.created || '',
    prd: {
      requirementCount: prd?.requirementCount ?? null,
      hasInterfaceSpec: prd?.hasInterfaceSpec ?? false,
      userConfirmed: prd?.userConfirmed ?? false,
    },
    test: {
      hasReport: !!tr,
      total: tr?.total ?? null,
      failed: tr?.failed ?? null,
      passed: tr?.passed ?? null,
    },
    loop: {
      completedCount: an.loopCompletedCount ?? 0,
      lastStatus: an.lastLoopStatus ?? null,
      lastTurns: an.lastLoopTurns ?? null,
      durationMs: an.durationMs ?? null,
      repairAttempts: an.repairAttempts ?? 0,
      repairRounds: an.repairRounds ?? 0,
      gwtRuns: an.gwtRuns ?? 0,
      judgePass: an.judgePass ?? 0,
      judgeFail: an.judgeFail ?? 0,
      testCompleted: an.testCompleted ?? null,
      mvpDelivered: an.mvpDelivered ?? false,
    },
    flags,
    riskFlags: flags.filter((f) => f.severity !== 'info').length,
  }
}
