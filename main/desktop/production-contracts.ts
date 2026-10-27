/** Shared production contracts and real host gates, independent of phase dispatch. */
import type {AgentEvent} from '../../shared/types'
import type {SDKQuery} from '../orchestration/stages/orchestration-contracts'
import type {CoreVerificationResult} from './core-verification'
import type {DriverSpawn} from './process-driver'
import {runLaunchSmoke,type LaunchSmokeResult} from './launch-smoke'
import {findProject} from '../project/project-service'
import {runSecurityScan} from '../verification/security-scan'
import {writeTextFileAtomic} from '../../storage/json-store'
import {join} from 'node:path'


/** 启动冒烟门缺省实现（2026-10-04；批1 2026-10-06 起服务 quick/longterm 双路）：读项目根
 *  真实 spawn 一次——宽限期内退出（含启动即崩）即不通过，stdout/stderr 尾部随卡回传修复轮；
 *  有 window_title 时走联合判定档（探针：窗口可见/消息循环响应/稳定期/优雅关闭/错误框），
 *  截图落 00_VERIFY/screenshots（delivered 卡自动嵌图）。项目根缺失/异常返回 null 跳过
 *  留痕（冒烟门不做可用性单点）。 */
export async function defaultLaunchSmokeGate(projectId: string, signal?: AbortSignal): Promise<LaunchSmokeResult | null> {
  try {
    const project = findProject(projectId)
    if (!project?.root_path) return null
    return await runLaunchSmoke(project.root_path, { signal,projectId })
  } catch (error) {
    if (signal?.aborted) throw error
    console.error('[desktop-quick] 启动冒烟执行失败（跳过本次门禁，留痕）：', error)
    return null
  }
}


// =========================================================================
// 路由依赖注入（orchestration 层适配）
// =========================================================================

/** 路由层外部效应面（测试全桩化；生产由 agent-dispatch 注入）。 */
export interface DesktopRouteDeps {
  coreVerification?: (projectId: string, signal?: AbortSignal) => Promise<CoreVerificationResult>
  /** 事件发布（生产=streamPublisher∘makeEvent；type+payload 直传）。 */
  publish: (input: { sessionId: string; projectId: string }, type: AgentEvent['type'], payload: Record<string, unknown>) => void
  /** 助手消息落盘（生产=appendAgentMessage）。 */
  persistAssistant: (sessionId: string, text: string) => void
  /** 内部标记落盘（生产=appendAgentMessage system role）。 */
  persistSystem: (sessionId: string, text: string) => void
  /** 终态事件（生产=persistTerminalMessage+completed 事件；路由收尾统一调）。
   *  P2-01：outcome 区分成功收口与未收口/取消——成功终态与未收口不再共用同一 success 事件
   *  （旧口径桌面未收口也发 subtype:success，下游/渲染端误当跑完）。 */
  complete: (sessionId: string, projectId: string, outcome?: 'success' | 'incomplete') => void
  /** 驱动 spawn 注入（可选；生产缺省 execFileDriverSpawn，测试桩 pass/fail）。 */
  driverSpawn?: DriverSpawn
  /** 需求摘要注入（首跑修复：PRD 背板 → 调度员系统提示词与子会话基底；编排层装配，缺省不注入）。 */
  requirementsDigest?: (projectId: string) => string | undefined
  /** 快速通道安全门注入（2026-10-03）：quick 直落 delivered 前的宿主安全扫描；
   *  缺省生产实现见 defaultQuickSecurityGate（无项目上下文返回 null 跳过留痕）。 */
  securityScan?: (projectId: string) => QuickSecurityGateResult | null
  /** 启动冒烟门注入（2026-10-04 呈现层收口）：quick 直落 delivered 前真实启动一次；
   *  缺省生产实现见 defaultLaunchSmokeGate（无项目上下文返回 null 跳过留痕）。 */
  launchSmoke?: (projectId: string, signal?: AbortSignal) => Promise<LaunchSmokeResult | null>
}


/** 快速通道安全门结果（与 dispatcher-loop 宿主安全门同构：pass/blocking/scanned/listing）。 */
export interface QuickSecurityGateResult {
  passed: boolean
  blocking: number
  scanned: number
  listing: string
}


/** 快速通道安全门生产实现：对产物根跑静态扫描（高危/严重 fail-closed）；
 *  扫描器异常或无项目上下文返回 null（跳过留痕——安全门不做可用性单点，与
 *  dispatcher-loop runHostSecurityGate 同哲学）。 */
export function defaultQuickSecurityGate(projectId: string, checkedRoot?: string): QuickSecurityGateResult | null {
  let rootPath: string | undefined
  try {
    rootPath = findProject(projectId).root_path
  } catch {
    return null
  }
  try {
    const result = runSecurityScan({ project_id: projectId, root_path: checkedRoot ?? rootPath,
      ...(findProject(projectId).workflow_version === 'software-v1' ? { profile: 'local-software' as const } : {}) })
    if (findProject(projectId).workflow_version === 'software-v1') writeTextFileAtomic(join(checkedRoot ?? rootPath, '00_VERIFY/security-scan.json'), JSON.stringify(result, null, 2))
    const blocking = result.issues.filter((issue) => issue.severity === 'high' || issue.severity === 'critical')
    return {
      passed: result.passed,
      blocking: blocking.length,
      scanned: result.scanned_files,
      listing: blocking.slice(0, 10).map((issue) => `- ${issue.file}:${issue.line} ${issue.user_visible_summary}`).join('\n'),
    }
  } catch (error) {
    console.error('[desktop-quick] 快速通道安全扫描执行失败（跳过本次门禁，留痕）：', error)
    return null
  }
}


// =========================================================================
// 消息路由主入口（agent-dispatch 分流调用）
// =========================================================================

/** 路由输入面（orchestration 层从 AgentSendMessageInput 抽取）。 */
export interface DesktopRouteInput {
  observedSoftwareVersion?: string
  images?: import('../../shared/types').PastedImageRef[]
  initialMessagePersisted?: boolean
  projectId: string
  sessionId: string
  requestId: string
  /** 用户消息文本（card_option 回传时为选项说明，仅留痕用） */
  content: string
  /** card_option 回传的选项 id（metadata.source==='card_option' 时有值） */
  cardOptionId?: string
  query: SDKQuery
  env: Record<string, string>
  maxTokens: number
  /** 取消信号（透传调度员 loop；缺省不可取消） */
  signal?: AbortSignal
}
