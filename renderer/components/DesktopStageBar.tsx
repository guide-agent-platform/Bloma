import { isModernWorkflowVersion } from '../../shared/workflow-version'
import React from 'react'
import { useAtomValue } from 'jotai'
import { currentProjectAtom, desktopPhaseAtom } from '../agent-atoms'
import { DESKTOP_PHASE_ORDER, desktopPhaseFullLabel, desktopPhaseLabel } from '../lib/desktop-stages'

/**
 * 桌面调度员线阶段条（渲染端适配批，2026-09-24；2026-10-04 审计修复 A-03/A-07）。
 *
 * 显示条件：当前项目为 desktop_tool 品类且 desktop_phase 已进入桌面表——
 * 满足时替换 WorkspaceHeader 的 web 阶段胶囊（桌面线期间 web 阶段停在
 * 「澄清需求」，继续显示会误导）；不满足时渲染 null（调用方回退 web 胶囊）。
 *
 * 数据面：desktopPhaseAtom（stage_changed 事件实时）优先，Project.desktop_phase
 *（回访恢复）兑底——由 visiblePhase 合并；两路一致时无闪烁。
 * 未知阶段 id（主进程侧插新阶段的演示场景）：追加尾部节点原样显示短名降级，
 * 不需要同步改本组件。
 *
 * A-03 修复：quick 直通道跳过的阶段（arch/scaffold/verify）不再显示为「已完成 ✓」，
 * 改为虚线灰样式 + 「跳过」角标——位置序推导的 isPast 会把从未执行的阶段误标成
 * 已完成，用户会误以为做过选型/骨架/验收。
 *
 * A-07 修复：project.desktop_blocked 置位（停止词/门禁耗尽）时，条前显示「已暂停」
 * 徽标、当前节点转灰色停动画——暂停态不再只藏在聊天记录的人话卡里（置位/放行
 * 时 main 会发 stage_changed 触发权威回填，本组件即可读到最新 desktop_blocked）。
 */

/** 快速直通道恒跳过的阶段（desktop-route quick 分支：implement 收口后过安全门+冒烟直达 delivered，不经 verify）。 */
const QUICK_SKIPPED_PHASES = new Set(['desktop-arch', 'desktop-scaffold', 'desktop-verify'])

export const DesktopStageBar: React.FC = () => {
  const project = useAtomValue(currentProjectAtom)
  const eventPhase = useAtomValue(desktopPhaseAtom)

  const lean = isModernWorkflowVersion(project?.workflow_version)
  const inDesktopLine = lean || project?.template_type === 'desktop_tool' && typeof project.desktop_phase === 'string'
  if (!inDesktopLine) return null
  const phase = eventPhase ?? project?.desktop_phase ?? 'prepare'
  const paused = project?.desktop_blocked != null
  const quickSkipped = !lean && project?.mode === 'quick' ? QUICK_SKIPPED_PHASES : new Set<string>()

  // 节点序：固定五节点 + 未知 id 追加尾部（降级显示）
  const leanLabels: Record<string, string> = { prepare: '准备', 'desktop-implement': '制作', 'desktop-verify': '验证', delivered: '已交付' }
  const nodes = lean ? Object.keys(leanLabels) : phase && !DESKTOP_PHASE_ORDER.includes(phase)
    ? [...DESKTOP_PHASE_ORDER, phase]
    : DESKTOP_PHASE_ORDER
  const currentIndex = phase ? Math.max(0, nodes.indexOf(phase)) : -1

  return (
    <nav
      data-ai-id="desktop-stage-bar"
      aria-label="桌面阶段进度"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        whiteSpace: 'nowrap',
      }}
    >
      {paused && (
        <span
          data-ai-id="desktop-stage-paused"
          title="流水线已暂停：回复「继续」按原方案再试一轮，或直接说明要改的地方"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '3px var(--space-2)',
            fontSize: 'var(--font-size-xs)',
            fontWeight: 600,
            borderRadius: 'var(--radius-full)',
            background: 'var(--color-danger-soft, #fee2e2)',
            color: 'var(--color-danger, #dc2626)',
            border: '1px solid var(--color-danger, #dc2626)',
            flexShrink: 0,
          }}
        >
          ⏸ 已暂停
        </span>
      )}
      {nodes.map((id, index) => {
        const isCurrent = index === currentIndex && !paused
        const isPast = currentIndex >= 0 && index < currentIndex
        const isSkipped = quickSkipped.has(id)
        // 跳过的节点：完成态让位给「跳过」视觉（A-03——从未执行不标 ✓）
        const showDone = isPast && !isSkipped
        return (
          <React.Fragment key={id}>
            {index > 0 && (
              <span
                data-ai-id="desktop-stage-separator"
                aria-hidden
                style={{ color: showDone ? 'var(--gray-500)' : 'var(--gray-300)', fontSize: 'var(--font-size-xs)' }}
              >
                ›
              </span>
            )}
            <span
              data-ai-id={`desktop-stage-node-${id}`}
              title={lean ? leanLabels[id] : isSkipped ? `快速模式跳过的阶段：${desktopPhaseFullLabel(id)}` : desktopPhaseFullLabel(id)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-1)',
                padding: '3px var(--space-2)',
                fontSize: 'var(--font-size-xs)',
                fontWeight: isCurrent ? 600 : 400,
                borderRadius: 'var(--radius-full)',
                // 暂停时当前节点转灰停动画（A-07：暂停≠进行中）
                background: isCurrent ? 'var(--color-warning)' : 'transparent',
                color: isCurrent
                  ? 'var(--white)'
                  : showDone
                    ? 'var(--gray-600)'
                    : isSkipped || paused
                      ? 'var(--gray-400)'
                      : 'var(--gray-400)',
                border: isCurrent
                  ? 'none'
                  : isSkipped
                    ? '1px dashed var(--gray-300)'
                    : '1px solid var(--color-border)',
                textDecoration: isSkipped ? 'none' : 'none',
                transition: 'background 0.2s ease, color 0.2s ease',
                flexShrink: 0,
              }}
            >
              {showDone && (
                <span aria-hidden style={{ fontSize: 10, lineHeight: 1 }}>
                  ✓
                </span>
              )}
              {lean ? leanLabels[id] : desktopPhaseLabel(id)}
              {isSkipped && (
                <span
                  aria-hidden
                  title="快速模式跳过"
                  style={{ fontSize: 10, lineHeight: 1, color: 'var(--gray-400)', marginLeft: 2 }}
                >
                  跳过
                </span>
              )}
            </span>
          </React.Fragment>
        )
      })}
    </nav>
  )
}

export default DesktopStageBar
