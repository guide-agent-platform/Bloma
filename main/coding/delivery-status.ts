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
