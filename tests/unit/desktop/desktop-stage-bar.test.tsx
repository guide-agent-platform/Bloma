// @vitest-environment jsdom
/**
 * 桌面阶段条组件测试（渲染端适配批，2026-09-24）。
 *
 * 锚点 data-ai-id（陷阱 30）；非 globals 模式 RTL 手动 cleanup。
 * 覆盖：显示判定（品类×desktop_phase）、节点序与当前高亮、事件相位优先于
 * 项目记录、未知阶段 id 降级追加、已完成节点勾选。
 */
import { cleanup, configure, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createStore, Provider } from 'jotai'
import { currentProjectAtom, desktopPhaseAtom } from '../../../renderer/agent-atoms'
import { DesktopStageBar } from '../../../renderer/components/DesktopStageBar'

configure({ testIdAttribute: 'data-ai-id' })
afterEach(() => cleanup())

/** 注入型渲染：独立 store.set 两个 atom 目标值 + Provider store（项目组件测试惯例，
 * 同 clarification-card 模式；测试间无串扰）。 */
function renderBar(project: Record<string, unknown> | null, eventPhase: string | null) {
  const store = createStore()
  store.set(currentProjectAtom, project as never)
  store.set(desktopPhaseAtom, eventPhase)
  return render(
    <Provider store={store}>
      <DesktopStageBar />
    </Provider>,
  )
}

describe('显示判定', () => {
  it('desktop_tool + desktop_phase 已设 → 渲染五节点', () => {
    renderBar({ project_id: 'p1', template_type: 'desktop_tool', desktop_phase: 'desktop-arch' }, null)
    expect(screen.getByTestId('desktop-stage-bar')).toBeTruthy()
    expect(screen.getByTestId('desktop-stage-node-desktop-arch')).toBeTruthy()
    expect(screen.getByTestId('desktop-stage-node-delivered')).toBeTruthy()
  })

  it('非 desktop_tool → 不渲染（回退 web 胶囊由 WorkspaceHeader 负责）', () => {
    renderBar({ project_id: 'p1', template_type: 'web_fullstack', desktop_phase: 'desktop-arch' }, null)
    expect(screen.queryByTestId('desktop-stage-bar')).toBeNull()
  })

  it('desktop_phase 未设（未进入桌面线）→ 不渲染', () => {
    renderBar({ project_id: 'p1', template_type: 'desktop_tool' }, null)
    expect(screen.queryByTestId('desktop-stage-bar')).toBeNull()
  })
})

describe('节点状态', () => {
  it('当前阶段高亮（背景样式）；已过节点带 ✓；未到灰显', () => {
    renderBar({ project_id: 'p1', template_type: 'desktop_tool', desktop_phase: 'desktop-implement' }, null)
    const current = screen.getByTestId('desktop-stage-node-desktop-implement')
    expect(current.style.background).toContain('warning')
    const past = screen.getByTestId('desktop-stage-node-desktop-arch')
    expect(past.textContent).toContain('✓')
    const future = screen.getByTestId('desktop-stage-node-desktop-verify')
    expect(future.style.background).toBe('transparent') // 未到节点透明底
  })

  it('事件相位优先于项目记录（desktopPhaseAtom 实时跳格）', () => {
    renderBar({ project_id: 'p1', template_type: 'desktop_tool', desktop_phase: 'desktop-arch' }, 'desktop-verify')
    const current = screen.getByTestId('desktop-stage-node-desktop-verify')
    expect(current.style.background).toContain('warning')
  })

  it('未知阶段 id（插阶段演示场景）：追加尾部降级显示', () => {
    renderBar({ project_id: 'p1', template_type: 'desktop_tool', desktop_phase: 'desktop-package' }, null)
    const node = screen.getByTestId('desktop-stage-node-desktop-package')
    expect(node.textContent).toContain('package') // 短名降级（去前缀）
    expect(screen.getByTestId('desktop-stage-node-delivered')).toBeTruthy() // 五节点仍在
  })
})
