import React from 'react'
import { useAtomValue } from 'jotai'
import { currentProjectAtom, desktopPhaseAtom } from '../agent-atoms'
import { DESKTOP_PHASE_ORDER, desktopPhaseFullLabel, desktopPhaseLabel } from '../lib/desktop-stages'

/**
 * 桌面调度员线阶段条（渲染端适配批，2026-09-24）。
 *
 * 显示条件：当前项目为 desktop_tool 品类且 desktop_phase 已进入桌面表——
 * 满足时替换 WorkspaceHeader 的 web 阶段胶囊（桌面线期间 web 阶段停在
 * 「澄清需求」，继续显示会误导）；不满足时渲染 null（调用方回退 web 胶囊）。
 *
 * 数据面：desktopPhaseAtom（stage_changed 事件实时）优先，Project.desktop_phase
 *（回访恢复）兑底——由 visiblePhase 合并；两路一致时无闪烁。
 * 未知阶段 id（主进程侧插新阶段的演示场景）：追加尾部节点原样显示短名降级，
 * 不需要同步改本组件。
 */
export const DesktopStageBar: React.FC = () => {
  const project = useAtomValue(currentProjectAtom)
  const eventPhase = useAtomValue(desktopPhaseAtom)

  const inDesktopLine = project?.template_type === 'desktop_tool' && typeof project.desktop_phase === 'string'
  if (!inDesktopLine) return null
  const phase = eventPhase ?? (project?.desktop_phase as string)

  // 节点序：固定五节点 + 未知 id 追加尾部（降级显示）
  const nodes = phase && !DESKTOP_PHASE_ORDER.includes(phase)
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
      {nodes.map((id, index) => {
        const isCurrent = index === currentIndex
        const isPast = currentIndex >= 0 && index < currentIndex
        return (
          <React.Fragment key={id}>
            {index > 0 && (
              <span
                data-ai-id="desktop-stage-separator"
                aria-hidden
                style={{ color: isPast ? 'var(--gray-500)' : 'var(--gray-300)', fontSize: 'var(--font-size-xs)' }}
              >
                ›
              </span>
            )}
            <span
              data-ai-id={`desktop-stage-node-${id}`}
              title={desktopPhaseFullLabel(id)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-1)',
                padding: '3px var(--space-2)',
                fontSize: 'var(--font-size-xs)',
                fontWeight: isCurrent ? 600 : 400,
                borderRadius: 'var(--radius-full)',
                background: isCurrent ? 'var(--color-warning)' : 'transparent',
                color: isCurrent ? 'var(--white)' : isPast ? 'var(--gray-600)' : 'var(--gray-400)',
                border: isCurrent ? 'none' : '1px solid var(--color-border)',
                transition: 'background 0.2s ease, color 0.2s ease',
              }}
            >
              {isPast && (
                <span aria-hidden style={{ fontSize: 10, lineHeight: 1 }}>
                  ✓
                </span>
              )}
              {desktopPhaseLabel(id)}
            </span>
          </React.Fragment>
        )
      })}
    </nav>
  )
}

export default DesktopStageBar
