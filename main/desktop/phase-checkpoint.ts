/**
 * 桌面线阶段推进 checkpoint（刀2，2026-10-02 确认协议与呈现层战役）。
 *
 * 事故背书（d34d189f 狗粮案）：门禁全绿后推进未遂（旧协议 confirmation-required），
 * 用户新消息触发的重跑不继承旧验证结论——50 分钟的全绿验证被完整重做一遍。
 * 撤 manual 门消灭了主死循环，但 no-marks 拒收/turn 耗尽/预算断链的同阶段重跑
 * 仍会重验昂贵门禁（driver spawn + 安全扫描 + 裁判门）。
 *
 * 机制：
 * - 写入（dispatcher-loop advance 分支）：门禁全绿待推进时 createSnapshot 落阶段
 *   快照（verify 阶段=verified，对齐 P0-1b 语义；其余=recoverable）+
 *   updateProject(desktop_checkpoint)。快照失败不阻断推进（仅留痕，下次收口可补）。
 * - 消费（desktop-route 续跑注入）：当前阶段与 checkpoint 一致时，任务书头部注入
 *   「上一轮已验证结论」+ 明确指示勿重验、直接收口推进——重验率归零的数据面。
 *
 * dispatcher-loop 已 749 行（R7≤800），checkpoint 逻辑内聚本文件单点维护。
 */

import type { DesktopCheckpoint } from '../../shared/types'
import { updateProject } from '../project/project-service'

/** checkpoint 写入输入（gates 摘要由调用方按阶段门禁形态拼装）。 */
export interface PhaseCheckpointInput {
  projectId: string
  requestId: string
  stage: string
  /** 已验门禁结论摘要（人读行：'driver-report: 7/7 场景 PASS' 等）。 */
  gates: string[]
  /** 快照 summary（含验证形态描述）。 */
  summary: string
  /** verify 全绿=verified（对齐 P0-1b）；其余阶段=recoverable。 */
  verification: 'verified' | 'recoverable'
}

/**
 * 记录阶段 checkpoint（advance 分支调用；fail-open 双容错）：
 * - 快照失败 → snapshot_id 缺省，checkpoint 结论仍有效（验证事实不依赖快照）；
 * - 落库失败 → 返回 null（不阻断推进，仅留痕）。
 */
export async function recordPhaseCheckpoint(input: PhaseCheckpointInput): Promise<DesktopCheckpoint | null> {
  let snapshotId: string | undefined
  try {
    const { createSnapshot } = await import('../delivery/snapshots')
    const snapshot = await createSnapshot({
      request_id: input.requestId,
      project_id: input.projectId,
      kind: 'mvp',
      summary: input.summary,
      include_documents: true,
      health_status: 'healthy',
      verification: input.verification,
    })
    snapshotId = snapshot.snapshot_id
  } catch (error) {
    console.error(`[desktop-checkpoint] 阶段快照创建失败（不阻断推进，下次收口可补）：`, error)
  }
  const checkpoint: DesktopCheckpoint = {
    stage: input.stage,
    at: new Date().toISOString(),
    verified_gates: input.gates,
    ...(snapshotId ? { snapshot_id: snapshotId } : {}),
  }
  try {
    updateProject(input.projectId, { desktop_checkpoint: checkpoint })
  } catch (error) {
    console.error('[desktop-checkpoint] checkpoint 落库失败（不阻断推进）：', error)
    return null
  }
  return checkpoint
}

/**
 * 续跑注入文本（desktop-route 组装 verifiedConclusion 用；纯函数）：
 * 已验结论逐行 + 勿重验指示 + 直接推进目标。nextTarget=null（终态推进）时
 * 只给结论清单（终态无推进标记可输出）。
 */
export function buildCheckpointConclusion(checkpoint: DesktopCheckpoint, nextTarget: string | null): string {
  const lines: string[] = [
    `上一轮（${checkpoint.at}）本阶段门禁已全部验证通过，结论如下（勿重验）：`,
    ...checkpoint.verified_gates.map((gate) => `- ${gate}`),
  ]
  if (checkpoint.snapshot_id) lines.push(`- 阶段快照已存证：${checkpoint.snapshot_id}`)
  if (nextTarget) {
    lines.push(
      `直接续接收口：核对无需补充的工作后，在回复末尾单独一行输出推进标记 PHASE_ADVANCE: ${nextTarget}——` +
        '不要重新执行驱动、安全扫描或任何已通过的验证，不要重新委派已完成的任务。',
    )
  }
  return lines.join('\n')
}
