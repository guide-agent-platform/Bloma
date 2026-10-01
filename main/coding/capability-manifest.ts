/**
 * 能力开关 manifest（2026-09-26 运行审计 P2-03：已有保护大量缺省关闭）。
 *
 * 审计原文：「关键保证分散在可独立启停的灰度能力中，调用方和 prompt 却可能按全能力
 * 理解……应每 run 持久化真实开关/能力 manifest；必需验证未启用时阻断相应交付结论，
 * 而不是只修改文案。」
 *
 * 本模块采集**该 run 的真实开关值**并随终验收口落盘（项目字段 + 决策日志）——
 * 「函数存在」不再等于「现网生效」，下游（裁判/审计/下一次 run）可据实判断。
 * 交付结论的证据级阻断（probe_degraded/unverified → partial、裁判退回 → partial）
 * 已在 P0/P1 批落在**证据**层（比开关层更准确）；此处补齐事实可见性。
 */

import {
  compactToolEnabled,
  loopCheckpointEnabled,
  narrationEventsEnabled,
  preflightEnabled,
  toolEvidenceEnabled,
  writeGuardEnabled,
} from '../agent/loop/agent-loop'
import { browserToolsEnabled } from './preview-browser'
import { deliveryStatusEnabled } from './delivery-status'
import { repairScopeEnabled } from './repair-loop'
import { isDesktopDispatchEnabled } from '../desktop/dispatcher-switch'
import { delegationWatchEnabled } from '../agent/delegation/delegation-watch'
import { recordDecision } from '../project/decision-log'
import type { CapabilityManifest } from '../../shared/types'
import { findProject, updateProject } from '../project/project-service'

/** 单次 run 的能力开关事实（类型定义在 shared/types.ts；此处 re-export 便于消费）。 */
export type { CapabilityManifest } from '../../shared/types'

/** 关键开关清单（按功能域分组；新增保护能力时在此登记，防「能力事实不可见」）。 */
export function captureCapabilityManifest(sessionId: string, runtimeNotes: string[] = []): CapabilityManifest {
  return {
    at: new Date().toISOString(),
    session_id: sessionId,
    switches: {
      // loop 侧
      write_guard: writeGuardEnabled(),
      tool_evidence: toolEvidenceEnabled(),
      preflight: preflightEnabled(),
      loop_checkpoint: loopCheckpointEnabled(),
      compact_tool: compactToolEnabled(),
      narration_events: narrationEventsEnabled(),
      // 修复侧
      repair_scope: repairScopeEnabled(),
      // 交付/工具面
      delivery_status: deliveryStatusEnabled(),
      browser_tools: browserToolsEnabled(),
      desktop_dispatch: isDesktopDispatchEnabled(),
      delegation_watch: delegationWatchEnabled(),
    },
    notes: runtimeNotes,
  }
}

/**
 * 随终验收口记录 manifest（项目字段留最近一次；决策日志留可追溯行）。
 * fail-open：采集/写盘失败不阻断交付链（可观测性增强）。
 */
export function recordCapabilityManifest(projectId: string, sessionId: string, runtimeNotes: string[] = []): void {
  try {
    const project = findProject(projectId)
    if (!project) return
    const manifest = captureCapabilityManifest(sessionId, runtimeNotes)
    updateProject(projectId, { capability_manifest: manifest })
    const offSwitches = Object.entries(manifest.switches).filter(([, on]) => !on).map(([name]) => name)
    recordDecision({
      project_id: projectId,
      session_id: sessionId,
      entry: {
        type: 'agent_loop',
        title: '能力开关 manifest（本次 run 真实生效值）',
        why:
          offSwitches.length > 0
            ? `以下能力本次 run 未启用：${offSwitches.join('、')}——相关验证/守卫面按未启用的证据口径判定，不按全能力理解`
            : '本次 run 全部关键能力启用',
        detail: { switches: manifest.switches, notes: manifest.notes },
      },
    })
  } catch {
    // fail-open：manifest 是事实可见性增强，不阻断终验
  }
}
