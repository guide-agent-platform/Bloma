// @vitest-environment jsdom

/**
 * CorrectionPanel 修改预览会话视图（批11 MVP-E，2026-10-08）：
 * - 入口态：completed 项目呈现「修改这个应用」；启动失败（unsupported 旧骨架）如实提示；
 * - 会话态：品牌头条 + 选区卡片流（displayName/kind 标签/note/预览说明）+ 空态引导；
 * - 收口：picks 非空可「开始修改」——finish 返回反馈文本经 agent.sendMessage 代发（回炉链），
 *   发送后回 idle 并呈现已提交提示。
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { configure } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Provider, createStore } from 'jotai'
import { CorrectionPanel } from '../../renderer/components/CorrectionPanel'
import {
  activeAgentSessionIdAtom,
  correctionSessionAtom,
  currentProjectAtom,
} from '../../renderer/agent-atoms'

configure({ testIdAttribute: 'data-ai-id' })

function renderPanel(): { store: ReturnType<typeof createStore> } {
  const store = createStore()
  store.set(currentProjectAtom, { project_id: 'p1', project_id_full: 'p1', name: '记账本', current_stage: 'completed', mode: 'longterm' } as never)
  store.set(activeAgentSessionIdAtom, 'sess-1')
  store.set(correctionSessionAtom, { status: 'idle' })
  render(
    <Provider store={store}>
      <CorrectionPanel />
    </Provider>,
  )
  return { store }
}

describe('CorrectionPanel', () => {
  beforeEach(() => {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = undefined
  })
  afterEach(() => cleanup())

  it('入口态：呈现「修改这个应用」按钮；启动成功进入会话态（品牌头条+空态引导）', async () => {
    const start = vi.fn(async () => ({
      ok: true,
      data: { ok: true, session: { sessionKey: 's1', sessionDir: 'C:/x', drivePort: 28000, dataSnapshotted: true, startedAt: 't' } },
    }))
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { correction: { start, picks: vi.fn(async () => ({ ok: true, data: { ok: true, picks: [], done: false } })), finish: vi.fn() } }
    const { store } = renderPanel()
    expect(screen.getByTestId('correction-start-button').textContent).toContain('修改这个应用')
    fireEvent.click(screen.getByTestId('correction-start-button'))
    await waitFor(() => {
      expect(store.get(correctionSessionAtom).status).toBe('active')
    })
    expect(screen.getByTestId('correction-panel').textContent).toContain('修改预览进行中')
    expect(screen.getByTestId('correction-panel').textContent).toContain('还没有点选')
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1' }))
  })

  it('启动失败（旧骨架 unsupported）：如实提示不进入会话态', async () => {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      correction: { start: vi.fn(async () => ({ ok: true, data: { ok: false, reason: 'unsupported', error: 'CORRECTION_UNSUPPORTED: 该应用由旧版骨架生成，暂不支持点选修改（可用文字反馈）' } })), picks: vi.fn(), finish: vi.fn() },
    }
    const { store } = renderPanel()
    fireEvent.click(screen.getByTestId('correction-start-button'))
    await waitFor(() => {
      expect(screen.getByTestId('correction-start-error').textContent).toContain('旧版骨架')
    })
    expect(store.get(correctionSessionAtom).status).toBe('error')
  })

  it('会话态：选区卡片流渲染（组件名/kind 标签/note/预览说明）+ 开始修改代发反馈', async () => {
    const finish = vi.fn(async () => ({
      ok: true,
      data: { ok: true, pickCount: 2, feedback: '我在「记账本」的修改预览里点选了 2 处要改的地方：\n1. 按钮「发送」……' },
    }))
    const sendMessage = vi.fn(async () => ({ ok: true }))
    const picksMock = vi.fn(async () => ({
      ok: true,
      data: {
        ok: true,
        done: false,
        picks: [
          { seq: 1, displayName: '按钮「发送」', kind: 'visual', note: '太不显眼', componentId: 'action.send', preview: { detail: '外观强调' } },
          { seq: 2, displayName: '输入框「备注」', kind: 'guess', componentId: 'input.main' },
        ],
      },
    }))
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      correction: { start: vi.fn(), picks: picksMock, finish },
      agent: { sendMessage },
    }
    const { store } = renderPanel()
    store.set(correctionSessionAtom, { status: 'active', sessionKey: 's1', startedAt: 't' })
    /* 选区经轮询到达（文件交接时延模拟——生产行为：picks 只来自轮询） */
    await waitFor(() => {
      expect(screen.getByTestId('correction-pick-1').textContent).toContain('按钮「发送」')
      expect(screen.getByTestId('correction-pick-1').textContent).toContain('外观 / 布局')
      expect(screen.getByTestId('correction-pick-1').textContent).toContain('试过 · 外观强调')
      expect(screen.getByTestId('correction-pick-2').textContent).toContain('让系统猜')
    })
    expect(screen.getByTestId('correction-apply-button').textContent).toContain('开始修改（2 处）')
    fireEvent.click(screen.getByTestId('correction-apply-button'))
    await waitFor(() => {
      expect(finish).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1' }))
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1', session_id: 'sess-1', content: expect.stringContaining('点选了 2 处') }))
    })
    await waitFor(() => {
      expect(store.get(correctionSessionAtom).status).toBe('idle')
    })
    expect(screen.getByTestId('correction-sent-hint').textContent).toContain('修改意见已提交')
  })
})
