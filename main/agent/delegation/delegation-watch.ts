/**
 * C4 委派观察哨（两级超时治理，协作机制改造清单 2026-09-24）。
 *
 * 背景：子会话渠道流挂死时系统层无兜底——wait 默认 600s 到点返回后由模型自行决定，
 * 编排器驱动的审查委派也只有 wait cap。本模块以「全局哨兵 + 周期扫描」实现两级超时
 * （参照 Proma-Easy 观察哨口径，阈值按我方 wait 600s 语义校准）：
 * - 软超时（默认 8min）：经 steer 队列向父 loop 批间注入催办（父无活跃 loop 时降级
 *   console.warn——委派等待期注入照常在下一批间生效，不打断等待）；
 * - 硬超时（默认 12min）：stopDelegation 强停（cancelled + 既有事件链）+ 观察者回调。
 * - ask 挂起（pendingQuestion）期间时钟重置：用户/代答驱动循环不计费。
 * - 依赖纪律：扫描数据源由 agent-collaboration 模块尾部注入（setDelegationScanSource，
 *   单向静态依赖零环）；硬超时落点是注入式观察者（编排器将来接 decision-log；agent
 *   层不向上引 domain——R1 只向下）。
 * - 开关 BLOMA_DELEGATION_WATCH 缺省 off（零定时器零扫描，字节级现状）。
 */

import { enqueueSteer } from '../loop/steer-queue'

/** 扫描数据源（agent-collaboration 模块尾部注入，规避静态环）。 */
export interface DelegationScanSource {
  forEachRunningDelegation: (fn: (record: DelegationWatchRecord) => void) => void
  stopDelegation: (parentSessionId: string, delegationId: string) => unknown
}

/** 观察哨所需的最小 record 面（结构子集，避免引 DelegationRecord 产生环）。 */
export interface DelegationWatchRecord {
  delegationId: string
  parentSessionId: string
  role: string
  goal: string
  startedAt: number
  pendingQuestion?: string
  channelOverride?: { channelName: string; modelName: string }
}

let scanSource: DelegationScanSource | undefined

/** 注册/注销扫描数据源（agent-collaboration 模块加载时注册一次）。 */
export function setDelegationScanSource(source: DelegationScanSource | null): void {
  scanSource = source ?? undefined
}

/** 观察哨开关（缺省 off：不启动定时器，startDelegation 侧零行为变化）。 */
export function delegationWatchEnabled(): boolean {
  const raw = (process.env.BLOMA_DELEGATION_WATCH ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on'
}

/** 阈值（集中可调；测试用 setDelegationWatchThresholdsForTests 缩短）。 */
export interface DelegationWatchThresholds {
  /** 软超时（毫秒）：注入催办。 */
  softMs: number
  /** 硬超时（毫秒）：强停。 */
  hardMs: number
  /** 扫描间隔（毫秒）。 */
  scanIntervalMs: number
}

const DEFAULT_THRESHOLDS: DelegationWatchThresholds = {
  softMs: 8 * 60_000,
  hardMs: 12 * 60_000,
  scanIntervalMs: 30_000,
}

let thresholds: DelegationWatchThresholds = { ...DEFAULT_THRESHOLDS }

/** 测试 seam：缩短阈值（不传参恢复缺省）。 */
export function setDelegationWatchThresholdsForTests(next?: Partial<DelegationWatchThresholds>): void {
  thresholds = next ? { ...DEFAULT_THRESHOLDS, ...next } : { ...DEFAULT_THRESHOLDS }
}

/** 硬超时观察者载荷（编排器侧接 decision-log/埋点用；默认 console.warn）。 */
export interface DelegationHardTimeoutInfo {
  delegationId: string
  parentSessionId: string
  role: string
  goal: string
  effectiveMs: number
  channel?: string
}

type HardTimeoutObserver = (info: DelegationHardTimeoutInfo) => void

let hardTimeoutObserver: HardTimeoutObserver | undefined

/** 注册硬超时观察者（null 注销；异常由观察者自吞，哨兵不受影响）。 */
export function setDelegationHardTimeoutObserver(observer: HardTimeoutObserver | null): void {
  hardTimeoutObserver = observer ?? undefined
}

/** 每委派观察状态：有效计时基准 + 软催办是否已发（软超时只催一次）。 */
interface WatchState {
  baseAt: number
  softFired: boolean
}

const watchStates = new Map<string, WatchState>()

let watchTimer: ReturnType<typeof setInterval> | undefined

/** 启动哨兵（幂等；开关 off 零行为）。startDelegation 每次调用本函数确保在跑。 */
export function ensureDelegationWatchStarted(): void {
  if (!delegationWatchEnabled() || watchTimer) return
  watchTimer = setInterval(() => {
    scanDelegationsForWatch(Date.now())
  }, thresholds.scanIntervalMs)
  watchTimer.unref?.()
}

/** 停表并清状态（测试收尾用；生产进程退出随 unref 自然回收）。 */
export function stopDelegationWatchForTests(): void {
  if (watchTimer) clearInterval(watchTimer)
  watchTimer = undefined
  watchStates.clear()
}

function formatMinutes(ms: number): string {
  return `${Math.round(ms / 60000)}`
}

/**
 * 单轮扫描（导出供单测直接调；now 注入便于时间可控）。
 *
 * 扫描语义：
 * - ask 挂起中（pendingQuestion 非空）→ baseAt 重置为 now 并跳过（挂起不计费）；
 * - 有效时长 ≥ hardMs → 强停 + 观察者 + 状态清理；
 * - 有效时长 ≥ softMs 且未催过 → 催办（steer 注入或降级 warn）；
 * - 委派已终态但状态残留 → 惰性清理。
 */
export function scanDelegationsForWatch(now: number): void {
  if (!scanSource) return
  const { forEachRunningDelegation, stopDelegation } = scanSource
  const runningIds = new Set<string>()
  forEachRunningDelegation((record) => {
    runningIds.add(record.delegationId)
    let state = watchStates.get(record.delegationId)
    if (record.pendingQuestion) {
      // 挂起不计费：无论是否已有状态，基准重置为当前时刻（恢复后从挂起点重新计费），
      // 软催办标记同步重置（新一轮有效运行可再催）。
      watchStates.set(record.delegationId, { baseAt: now, softFired: false })
      return
    }
    if (!state) {
      state = { baseAt: record.startedAt, softFired: false }
      watchStates.set(record.delegationId, state)
    }
    const elapsed = now - state.baseAt
    if (elapsed >= thresholds.hardMs) {
      stopDelegation(record.parentSessionId, record.delegationId)
      watchStates.delete(record.delegationId)
      const info: DelegationHardTimeoutInfo = {
        delegationId: record.delegationId,
        parentSessionId: record.parentSessionId,
        role: record.role,
        goal: record.goal,
        effectiveMs: elapsed,
        channel: record.channelOverride
          ? `${record.channelOverride.channelName}/${record.channelOverride.modelName}`
          : undefined,
      }
      console.warn(
        `[delegation-watch] 硬超时强停：${info.delegationId}（${info.role}，有效运行 ${formatMinutes(elapsed)} 分钟${info.channel ? `，渠道 ${info.channel}` : ''}）`,
      )
      if (hardTimeoutObserver) {
        try {
          hardTimeoutObserver(info)
        } catch { /* 观察者异常不影响哨兵 */ }
      }
      return
    }
    if (elapsed >= thresholds.softMs && !state.softFired) {
      state.softFired = true
      const goalPreview = record.goal.slice(0, 40)
      const content =
        `⏱ 委派「${goalPreview}」（${record.role}）已运行 ${formatMinutes(elapsed)} 分钟无回传。` +
        `若子会话卡死：stop_delegation 停止后 continue_delegation 重派（保留上下文）；` +
        `若仍在正常工作可继续等待——硬超时 ${formatMinutes(thresholds.hardMs)} 分钟时系统将自动停止该委派。`
      const queued = enqueueSteer(record.parentSessionId, {
        queueMessageId: `delegation-watch-${record.delegationId}`,
        content,
        enqueuedAt: now,
      })
      if (!queued) {
        console.warn(
          `[delegation-watch] 软超时（父无活跃 loop，催办降级日志）：${record.delegationId}（${record.role}）有效运行 ${formatMinutes(elapsed)} 分钟`,
        )
      }
    }
  })
  // 惰性清理：终态委派的残留状态（下一轮扫描不再触达，防 Map 无界增长）
  for (const id of Array.from(watchStates.keys())) {
    if (!runningIds.has(id)) watchStates.delete(id)
  }
}
