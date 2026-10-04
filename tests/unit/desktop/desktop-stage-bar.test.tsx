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

describe('审计 A-03/A-07（2026-10-04）', () => {
  it('quick 模式：被跳过的 arch/scaffold 不带 ✓，显示「跳过」角标（不伪装已完成）', () => {
    renderBar({ project_id: 'p1', template_type: 'desktop_tool', mode: 'quick', desktop_phase: 'desktop-implement' }, null)
    const arch = screen.getByTestId('desktop-stage-node-desktop-arch')
    expect(arch.textContent).not.toContain('✓') // 从未执行 → 不打勾
    expect(arch.textContent).toContain('跳过')
    expect(arch.style.border).toContain('dashed') // 虚线区别于正常未到节点
    const scaffold = screen.getByTestId('desktop-stage-node-desktop-scaffold')
    expect(scaffold.textContent).toContain('跳过')
    // 当前节点（implement）正常高亮，不带跳过标记
    const current = screen.getByTestId('desktop-stage-node-desktop-implement')
    expect(current.style.background).toContain('warning')
    expect(current.textContent).not.toContain('跳过')
  })

  it('quick 直落 delivered：verify 也标跳过（未走过工程验收）', () => {
    renderBar({ project_id: 'p1', template_type: 'desktop_tool', mode: 'quick', desktop_phase: 'delivered' }, null)
    const verify = screen.getByTestId('desktop-stage-node-desktop-verify')
    expect(verify.textContent).toContain('跳过')
    expect(verify.textContent).not.toContain('✓')
    // implement 是真实完成的 → 正常勾选
    expect(screen.getByTestId('desktop-stage-node-desktop-implement').textContent).toContain('✓')
  })

  it('longterm 模式：无跳过标记，正常勾选推进', () => {
    renderBar({ project_id: 'p1', template_type: 'desktop_tool', mode: 'longterm', desktop_phase: 'desktop-verify' }, null)
    expect(screen.getByTestId('desktop-stage-node-desktop-arch').textContent).toContain('✓')
    expect(screen.getByTestId('desktop-stage-node-desktop-implement').textContent).not.toContain('跳过')
  })

  it('desktop_blocked 置位 → 「已暂停」徽标 + 当前节点停止高亮（A-07）', () => {
    renderBar({
      project_id: 'p1',
      template_type: 'desktop_tool',
      desktop_phase: 'desktop-implement',
      desktop_blocked: { reason: 'gate-exhausted', at: new Date().toISOString() },
    }, null)
    expect(screen.getByTestId('desktop-stage-paused').textContent).toContain('已暂停')
    // 暂停≠进行中：当前节点不再 warning 高亮
    expect(screen.getByTestId('desktop-stage-node-desktop-implement').style.background).toBe('transparent')
  })

  it('无 blocked → 无暂停徽标', () => {
    renderBar({ project_id: 'p1', template_type: 'desktop_tool', desktop_phase: 'desktop-implement' }, null)
    expect(screen.queryByTestId('desktop-stage-paused')).toBeNull()
  })
})
