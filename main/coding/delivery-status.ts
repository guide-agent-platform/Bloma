/**
 * Phase 7 U1 H1（2026-09-10，E1 咨询 H1 / P7 实施稿 §2）：delivery_status 交付状态。
 *
 * 产品总规则：「生成结束」描述工作进度，「可用」描述用户能完成什么；用户接受版本，
 * 也不能把未通过变成已通过。B0 实测错误放行 6/6（放行路径 5/5=circuit_rollback→ready、
 * 修复轮零改善 5/5）——首先是交付状态失真，不是文案问题。本模块把「这一版实际验证
 * 到什么程度」规则化成三态字段：
 *
 * - verified：必交任务全部通过、安全无高危、预检无未过项（v0 从严：有未验证必交项
 *   即不称 verified——实施稿 §8 待拍板项按建议从严执行，可调）；
 * - partial：有独立可用的必交任务，但其他任务失败/存在不可归属失败（API 契约失活等）；
 * - unavailable：核心目标失败（全部必交任务有关联失败）/ 不可启动（预览不可访问）/
 *   安全未过（不可隔离风险）。
 *
 * 纪律（对齐咨询「全局交付状态由规则计算，Agent 只翻译人话」）：
 * - 本字段只由终验链路（runAgentLoopPostTesting 收口点）调用 recordDeliveryStatus
 *   写入，Agent/loop 工具面无写入口（updateProject 不经工具面暴露）；
 * - 每次终验重算——迭代/重做产物重验，旧版本通过不给新版本背书；
 * - 熔断回滚路径用回滚目标版本的失败清单（initial 终验），修复轮改善不美化回滚版状态。
 *
 * 开关 BLOMA_DELIVERY_STATUS 缺省 off=字节级现状（project 无此键、零计算）。
 */
import type { DeliveryStatus } from '../../shared/types'
import type { GwtTestResult } from '../gwt-service'
import type { KeyTask } from '../model/prd-backplane'
import { updateProject } from '../project-service'

// ---------------------------------------------------------------------------
// Phase 7 U1 H3/H4（2026-09-10，P7 实施稿 §2）：交付呈现层——三层展示与四段式话术。\n// 纯呈现层（实施稿 §7 定直接上，不设开关）：H3 消费 delivery_status（BLOMA_
// DELIVERY_STATUS off 时无数据自然不展示）；断言通过率（N/M）不进主界面——任务级
// ✓×? 分组承载「现在能做什么、不能做什么」。
// ---------------------------------------------------------------------------

/** 交付展示三层（H3）：结论句 / 任务分组 / 详情提示。 */
export interface DeliveryPresentation {
  status: DeliveryStatus
  /** 第一层：目标结论一句（如「笔记功能可以使用，自动总结还没有做好」） */
  conclusion: string
  /** 第二层：按关键任务分组 ✓已验证 / ×检查中未通过 / ?未验证 */
  taskLines: string[]
  /** 第三层：验证详情提示（场景级明细在 test-report，主界面不堆原始断言） */
  detailHint?: string
}

/** 任务级三态（H3 第二层）。 */
export type DeliveryTaskState = 'verified' | 'failed' | 'unverified'

/** 任务分组行（buildDeliveryPresentation 内部产出，供卡 payload 结构化消费）。 */
export interface DeliveryTaskGroup {
  label: string
  state: DeliveryTaskState
  featureIds: string[]
}

const TASK_STATE_MARK: Record<DeliveryTaskState, string> = {
  verified: '✓',
  failed: '×',
  unverified: '?',
}

/**
 * H3 交付展示三层构建（纯函数）：任务组状态按场景归属判定（同 computeDeliveryStatus
 * 口径）；无 key_tasks 时 P0 各成一组（label=功能项 id，展示侧可再拼故事）。
 * verified 任务组在整体有不可归属失败（API 契约失活）时仍标 ✓——整体状态已由
 * status 承担，不重复惩罚单任务。
 */
export function buildDeliveryPresentation(input: {
  status: DeliveryStatus
  keyTasks: KeyTask[]
  p0RequirementIds: string[]
  testResult: Pick<GwtTestResult, 'failed_count' | 'failure_summary'> & { unverified?: string[] }
  /** 任务标签拼装（缺省 label 原样；调用方可传功能项故事映射） */
  featureLabelOf?: (featureId: string) => string | undefined
}): DeliveryPresentation {
  const failedIds = new Set(
    input.testResult.failure_summary
      .map((f) => featureIdFromScenario(f.scenario))
      .filter((id): id is string => Boolean(id)),
  )
  const unverifiedIds = new Set(
    (input.testResult.unverified ?? [])
      .map((scenario) => featureIdFromScenario(scenario))
      .filter((id): id is string => Boolean(id)),
  )
  const groups: DeliveryTaskGroup[] = (
    input.keyTasks.length > 0
      ? input.keyTasks.map((task) => ({ label: task.label, featureIds: task.feature_ids }))
      : input.p0RequirementIds.map((id) => ({ label: input.featureLabelOf?.(id) ?? id, featureIds: [id] }))
  ).map((group) => ({
    ...group,
    state: group.featureIds.some((id) => failedIds.has(id))
      ? ('failed' as const)
      : group.featureIds.some((id) => unverifiedIds.has(id))
        ? ('unverified' as const)
        : ('verified' as const),
  }))
  const taskLines = groups.map((g) => `${TASK_STATE_MARK[g.state]} ${g.label}`)
  const failedGroups = groups.filter((g) => g.state === 'failed')
  const verifiedGroups = groups.filter((g) => g.state === 'verified')
  const conclusion =
    input.status === 'verified'
      ? deliveryStatusConclusion('verified')
      : input.status === 'partial'
        ? deliveryStatusConclusion(
            'partial',
            verifiedGroups[0]?.label,
            failedGroups[0]?.label,
          )
        : deliveryStatusConclusion('unavailable')
  const detailHint =
    failedGroups.length > 0 || input.testResult.failed_count > 0
      ? `有 ${input.testResult.failed_count} 项检查未通过——详细验证记录在项目的验证报告中，可告诉我「先修好没做好的」`
      : undefined
  return { status: input.status, conclusion, taskLines, detailHint }
}

/** H3 渲染为决策卡正文多行文本（结论句 + 任务分组 + 详情提示；无通过率数字）。 */
export function renderDeliveryBody(presentation: DeliveryPresentation): string {
  const parts = [presentation.conclusion]
  if (presentation.taskLines.length > 0) {
    parts.push('', '这一版各任务的实际验证结果：', ...presentation.taskLines)
  }
  if (presentation.detailHint) parts.push('', presentation.detailHint)
  return parts.join('\n')
}

/** H4：单条失败的四段式人话（功能→现象→影响→可行替代）。 */
export interface FourPartFailure {
  feature: string
  phenomenon: string
  impact: string
  alternative: string
}

/** 敏感不折叠类（H4：数据丢失/隐私/金额/核心目标四类不折叠）。 */
const SENSITIVE_FAILURE_RE = /丢失|删除|清空|泄露|隐私|支付|金额|付费|密码|敏感/

/** 验证过程异常判定（预览不可达/探针未完成检查）。 */
const TOOL_ABNORMAL_RE = /预览不可访问|探针|浏览器不可用/

/**
 * H4 四段式构建（纯函数）：scenario 已是「F-xxx 动作→预期」用户语言形态，去 id
 * 前缀作功能句；现象句按验证结果特征分三类话术（E1 原文）：断言未过→检查中未得到
 * 预期结果；验证工具异常→验证未完成检查；替代承诺仅限已验证事实。
 */
export function buildFourPartFailure(failure: { scenario: string; reason?: string }): FourPartFailure {
  const featureId = featureIdFromScenario(failure.scenario)
  const action = featureId ? failure.scenario.slice(failure.scenario.indexOf(featureId) + featureId.length).trim() : failure.scenario
  const toolAbnormal = TOOL_ABNORMAL_RE.test(failure.reason ?? '')
  return {
    feature: featureId ? `${featureId} ${action}` : action,
    phenomenon: toolAbnormal
      ? '验证工具没有完成这一项的检查，状态待确认'
      : '自动检查时，这一步没有得到预期结果',
    impact: '这个功能现在不能当作可用来依赖；已通过的功能不受影响',
    alternative: '可以告诉我「先修好这项」，下一轮会优先处理',
  }
}

/**
 * H4 熔断 failureNote 四段式清单（纯函数）：默认展开影响最大 3 项；核心目标（必交任务
 * 关联）与敏感类（数据丢失/隐私/金额）不折叠；其余折叠为计数行。替代承诺只引用
 * 已验证事实（不编造未验证的可用性）。
 */
export function renderCircuitFailureNote(input: {
  failures: Array<{ scenario: string; reason?: string }>
  mustDeliverFeatureIds: string[]
}): string {
  if (input.failures.length === 0) return ''
  const mustSet = new Set(input.mustDeliverFeatureIds)
  const ranked = [...input.failures]
  const shown = ranked.filter(
    (f, i) =>
      i < 3 ||
      SENSITIVE_FAILURE_RE.test(f.scenario) ||
      SENSITIVE_FAILURE_RE.test(f.reason ?? '') ||
      mustSet.has(featureIdFromScenario(f.scenario) ?? ''),
  )
  const rest = ranked.length - shown.length
  const lines: string[] = [`注意：这一版有 ${ranked.length} 项检查未通过，已如实登记（不会当作「已完成」）：`]
  for (const failure of shown) {
    const four = buildFourPartFailure(failure)
    lines.push(`【功能】${four.feature}`, `【现象】${four.phenomenon}`, `【影响】${four.impact}`, `【替代】${four.alternative}`)
  }
  if (rest > 0) lines.push(`……还有 ${rest} 项未通过，已记录在验证报告中；可以告诉我「先修好没做好的」。`)
  return lines.join('\n')
}

/** BLOMA_DELIVERY_STATUS 开关：缺省 off（终验链路零计算零写入）。 */
export function deliveryStatusEnabled(): boolean {
  const raw = (process.env.BLOMA_DELIVERY_STATUS ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

/** 交付状态计算输入（纯函数，供 B0 重放等离线验收直测）。 */
export interface DeliveryStatusComputationInput {
  /** 关键任务（BLOMA_KEY_TASKS on 时背板携带）；空时回退 P0 功能项各成一必交任务 */
  keyTasks: KeyTask[]
  /** 兜底任务源：P0 功能项 id（无 key_tasks 时 must_deliver 任务的等价口径） */
  p0RequirementIds: string[]
  /** 终验结果（失败场景按 `F-xxx 断言` 前缀归属功能项） */
  testResult: Pick<GwtTestResult, 'failed_count' | 'failure_summary'>
  /** 安全扫描是否通过（未过=不可隔离风险→unavailable） */
  securityPassed: boolean
  /** 收口预检结果（W3；开关 off/未跑=undefined 不影响判定；false=有未过验证面→从严 partial） */
  preflightPassed?: boolean
}

/**
 * 场景名 → 功能项 id（GWT 场景名为 `${itemId} ${assertion}`（gwt-runner scenarioName）；
 * API 契约失败场景名为 `API 契约端点：…`，无 F 前缀 → undefined（不可归属，只压
 * verified 不参与任务成败归属）。
 */
export function featureIdFromScenario(scenario: string): string | undefined {
  const match = /^((?:F|CAP)-\d+)/.exec(scenario.trim())
  return match ? match[1] : undefined
}

/** 必交任务集：key_tasks 优先；无 key_tasks（开关 off/旧背板）回退 P0 各成一任务。 */
function mustDeliverFeatureSets(input: DeliveryStatusComputationInput): string[][] {
  const fromKeyTasks = input.keyTasks.filter((task) => task.must_deliver && task.feature_ids.length > 0)
  if (fromKeyTasks.length > 0) return fromKeyTasks.map((task) => task.feature_ids)
  return input.p0RequirementIds.map((id) => [id])
}

/**
 * 交付状态规则计算（纯函数；判定顺序即优先级）：
 * ① 安全未过 → unavailable；② 预览不可访问 → unavailable（不可启动）；
 * ③ failed===0 → preflight!==false 才 verified，否则 partial（有未验证面从严）；
 * ④ 有失败时按场景前缀归属：全部必交任务都有关联失败 → unavailable（核心目标失败）；
 * ⑤ 其余（含不可归属失败如 API 契约失活）→ partial。
 */
export function computeDeliveryStatus(input: DeliveryStatusComputationInput): DeliveryStatus {
  if (!input.securityPassed) return 'unavailable'
  if (input.testResult.failure_summary.some((f) => f.reason.includes('预览不可访问'))) return 'unavailable'
  if (input.testResult.failed_count === 0) return input.preflightPassed === false ? 'partial' : 'verified'
  const failedFeatureIds = new Set(
    input.testResult.failure_summary.map((f) => featureIdFromScenario(f.scenario)).filter((id): id is string => Boolean(id)),
  )
  if (failedFeatureIds.size === 0) return 'partial'
  const mustDeliver = mustDeliverFeatureSets(input)
  if (mustDeliver.length === 0) return 'partial'
  const anyTaskClean = mustDeliver.some((featureIds) => !featureIds.some((id) => failedFeatureIds.has(id)))
  return anyTaskClean ? 'partial' : 'unavailable'
}

/**
 * 终验链路收口点写入：计算 + updateProject + 决策日志留痕（try/catch 隔离，陷阱 29：
 * 交付状态写入失败不阻断终验主链）。返回计算结论供调用方决策日志/话术消费。
 */
export function recordDeliveryStatus(projectId: string, computation: DeliveryStatusComputationInput): DeliveryStatus | undefined {
  if (!deliveryStatusEnabled()) return undefined
  const status = computeDeliveryStatus(computation)
  try {
    updateProject(projectId, { delivery_status: status })
  } catch (error) {
    console.error('[delivery-status] 写入 project 失败（不阻断终验）:', error)
  }
  return status
}

/** 交付状态中文标签（H3 三层展示/P7-3 消费同源）。 */
export function deliveryStatusLabel(status: DeliveryStatus): string {
  switch (status) {
    case 'verified':
      return '已验证'
    case 'partial':
      return '部分可用'
    default:
      return '不可用'
  }
}

/** 交付状态一句话结论模板（H3 第一层「目标结论」；调用方拼任务名）。 */
export function deliveryStatusConclusion(status: DeliveryStatus, passedTaskLabel?: string, failedTaskLabel?: string): string {
  switch (status) {
    case 'verified':
      return '这一版的关键任务都已完成并通过验证。'
    case 'partial':
      return passedTaskLabel && failedTaskLabel
        ? `${passedTaskLabel}可以使用，${failedTaskLabel}还没有做好。`
        : '有部分功能可以使用，其他还没有做好。'
    default:
      return '这一版的关键任务没有完成，现在还不能当作可用版本。'
  }
}
