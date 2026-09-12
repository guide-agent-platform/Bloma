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

/**
 * 指标扩容（P0 Phase 0.5，2026-09-09）：8→14 项。新增六项全部确定性口径（零 LLM），
 * L0（历史扫描）与 L1（在线 run 档案）同源同口径：
 *
 *  9  firstConstraintViolation  首次约束违规（咨询B）：产物扫描——localStorage 作唯一数据源
 *     （无 serverRoutes/apiLlm 时 localStorage>0，即 435ca2c 渠道绕过特征）+ 密钥入码
 * 10 coreCapabilityRetention    核心能力保留率（咨询B）：AI 意图任务中，PRD 需求保留 AI 语义
 *     且产物有真实 AI 接入痕迹（apiLlm/aiMock 命中）的比例；非 AI 任务记 'n/a'
 * 11 protocolLeakRate           协议泄漏率（咨询B）：assistant 正文含工具协议原文的轮次占比
 *     （<tool_calls> 字面 / DSML 竖线标记 / 裸工具 JSON 块；与 learnings 过滤、output-integrity 同源）
 * 12 effectiveDeliveryTokens    有效交付 token（咨询B）：终态 converged 且 mvpDelivered 时
 *     agent_loop_completed 的 input_tokens 合计；未收敛记 null（无效交付不计入均值）
 * 13 emptyBodyRate              空正文率（咨询B）：无 text 且无 tool_use 的 assistant 轮占比
 *     （思考耗尽/空响应特征）
 * 14 wrongTriggerCount          错误触发计数（咨询C）：策略/经验注入到不适用场景——P0a 口径为
 *     会话 user 轮中【历史经验】/【常见错法】注入段计数（开关 off 时恒 0，记录基线占位）
 */
export function computeExtendedMetrics(evidence) {
  const an = evidence?.analytics || {}
  const artifacts = evidence?.artifacts || { hits: {} }
  const integrity = evidence?.assistantIntegrity || { assistantTurns: 0, protocolLeakTurns: 0, emptyTextTurns: 0 }
  const sessionText = (evidence?.session?.userMessages || []).map((u) => u.text).join('|')
  const prdText = (evidence?.docs?.prd?.requirements || []).map((r) => r.description).join('|')
  const hits = artifacts.hits || {}

  // 9 首次约束违规
  const violations = []
  if ((hits.localStorage || 0) > 0 && (hits.serverRoutes || 0) === 0 && (hits.apiLlm || 0) === 0) {
    violations.push({ code: 'localstorage-only', detail: `产物命中 localStorage×${hits.localStorage} 且无 serverRoutes/apiLlm——数据留存可能被前端存储绕过（435ca2c 渠道绕过特征）` })
  }
  if ((hits.secretPattern || 0) > 0) violations.push({ code: 'secret-in-code', detail: `产物源码疑似密钥模式×${hits.secretPattern}` })

  // 10 核心能力保留
  const wantsAI = AI_INTENT_RE.test((sessionText + '|' + (evidence?.docs?.prd?.positioning || '')).trim())
  const keptInPrd = AI_CAPABILITY_RE.test(prdText)
  const wiredInArtifacts = (hits.apiLlm || 0) > 0 || (hits.aiMock || 0) > 0
  const retention = wantsAI ? (keptInPrd && wiredInArtifacts ? 1 : keptInPrd ? 0.5 : 0) : 'n/a'

  // 11 协议泄漏率 / 13 空正文率
  const turnDen = Math.max(integrity.assistantTurns, 1)

  // 12 有效交付 token
  const tokens = (an.turnTokens || []).reduce((sum, t) => sum + (Number(t.in) || 0), 0)
  const converged = evidence?.terminal?.kind === 'converged' || ['ready', 'completed'].includes(evidence?.project?.stage || '')
  const effective = converged && an.mvpDelivered ? tokens : null

  // 14 错误触发（P0a 占位：注入段计数，人工判定相关性）
  const injections = (sessionText.match(/【(历史经验|常见错法)[^】]*】/g) || []).length

  return {
    firstConstraintViolation: { violated: violations.length > 0, details: violations },
    coreCapabilityRetention: retention,
    protocolLeakRate: integrity.protocolLeakTurns / turnDen,
    effectiveDeliveryTokens: effective,
    emptyBodyRate: integrity.emptyTextTurns / turnDen,
    wrongTriggerCount: injections,
    degenerateTurns: integrity.degenerateTurns || 0,
  }
}
