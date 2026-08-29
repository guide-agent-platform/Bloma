// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RequirementConfirmDialog } from '../../renderer/components/RequirementConfirmDialog'
import {
  activeAgentSessionIdAtom,
  requirementConfirmFamily,
  setupGlobalAgentListeners,
} from '../../renderer/agent-atoms'
import type { AgentEvent, ElectronAPI } from '../../shared/types'

/**
 * 需求确认弹窗（confirm_requirements 流，2026-08-26）：
 * 事件归约进 requirementConfirmFamily → 弹窗渲染（默认全选/勾选切换/市调折叠）
 * → 三出口（confirm 子集 / delegate / supplement 走 sendMessage）→ 提交后关闭。
 * 锚点 data-ai-id（陷阱 30）；非 globals 模式 RTL 手动 cleanup。
 */

configure({ testIdAttribute: 'data-ai-id' })

const CONFIRM_EVENT: AgentEvent = {
  event_id: crypto.randomUUID(),
  session_id: 'session-rc',
  project_id: 'project-rc',
  type: 'user_decision_required',
  payload: {
    kind: 'requirement_confirm',
    title: '确认你的需求',
    requirements: [
      { id: 'F-001', description: '记账本，记录日常收支', origin: 'user' },
      { id: 'F-002', description: '按月汇总统计', origin: 'guide' },
    ],
    research: {
      available: true,
      summary: '1. 十款记账应用盘点 — a.example.com\n   流行的记账工具对比',
    },
  },
  created_at: new Date().toISOString(),
}

describe('需求确认弹窗 RequirementConfirmDialog', () => {
  let store: ReturnType<typeof createStore>
  const confirmRequirements = vi.fn(async () => ({ ok: true, data: { started: true, prd_written: true } }))
  const sendMessage = vi.fn(async () => ({ ok: true, data: { accepted: true, session_id: 'session-rc', stream_started: true } }))

  beforeEach(() => {
    confirmRequirements.mockClear()
    sendMessage.mockClear()
    store = createStore()
    window.__jotai_store__ = store as never
    store.set(activeAgentSessionIdAtom, 'session-rc')
    window.electronAPI = {
      agent: {
        onStreamEvent: () => () => undefined,
        confirmRequirements,
        sendMessage,
      },
    } as unknown as ElectronAPI
    setupGlobalAgentListeners()
  })

  afterEach(() => {
    delete window.electronAPI
    delete window.__jotai_store__
    cleanup()
  })

  function renderDialog(): ReturnType<typeof render> {
    return render(
      <Provider store={store}>
        <RequirementConfirmDialog />
      </Provider>,
    )
  }

  it('事件归约：kind=requirement_confirm 写入专用 atom；其它 kind 不触碰', () => {
    let emit: ((event: AgentEvent) => void) | undefined
    window.electronAPI = {
      agent: {
        onStreamEvent: (listener: (event: AgentEvent) => void) => {
          emit = listener
          return () => undefined
        },
        confirmResults: undefined,
        confirmRequirements,
        sendMessage,
      },
    } as unknown as ElectronAPI
    setupGlobalAgentListeners()

    emit?.(CONFIRM_EVENT)
    expect(store.get(requirementConfirmFamily('session-rc'))).toMatchObject({
      sessionId: 'session-rc',
      projectId: 'project-rc',
      requirements: [{ id: 'F-001' }, { id: 'F-002' }],
      research: { available: true, summary: expect.stringContaining('记账应用') },
    })

    // 其它 kind（如澄清卡）不写入弹窗 atom
    emit?.({ ...CONFIRM_EVENT, payload: { kind: 'clarification', title: '先确认方向', questions: [] } })
    expect(store.get(requirementConfirmFamily('session-rc'))).not.toBeNull()
  })

  it('灵感参考（2026-08-29）：想法区默认展开可勾选采纳，confirm 提交带 adopted_ideas；无想法时回退旧市调折叠区', async () => {
    store.set(requirementConfirmFamily('session-rc'), {
      sessionId: 'session-rc',
      projectId: 'project-rc',
      title: '确认你的需求',
      requirements: [{ id: 'F-001', description: '做一个音乐合成器' }],
      research: { available: true, summary: '原始摘要' },
      ideas: [
        { label: '虚拟键盘实时弹奏', note: '像钢琴 App 按键发声', source: 'example.com' },
        { label: '步进音序器编曲', note: '网格排布音符循环播放', source: 'example.org' },
      ],
    })
    renderDialog()

    // 想法区默认展开（非折叠）：向导整理过的做法可勾选
    expect(screen.getByTestId('requirement-confirm-ideas').textContent).toContain('灵感参考')
    expect(screen.getByTestId('requirement-confirm-idea-虚拟键盘实时弹奏').textContent).toContain('虚拟键盘实时弹奏')
    // 有想法区时不再显示旧折叠区
    expect(screen.queryByTestId('requirement-confirm-research')).toBeNull()

    // 勾选一条想法 → confirm 提交带 adopted_ideas
    fireEvent.click(screen.getByTestId('requirement-confirm-idea-虚拟键盘实时弹奏'))
    fireEvent.click(screen.getByTestId('requirement-confirm-submit'))
    await waitFor(() => {
      expect(confirmRequirements).toHaveBeenCalledWith(expect.objectContaining({
        decision: 'confirm',
        adopted_ideas: ['虚拟键盘实时弹奏'],
      }))
    })

    // 无想法时回退旧折叠区（零 LLM/市调空结果的兑底形态）
    cleanup()
    store.set(requirementConfirmFamily('session-rc'), {
      sessionId: 'session-rc',
      projectId: 'project-rc',
      title: '确认你的需求',
      requirements: [{ id: 'F-001', description: '做一个音乐合成器' }],
      research: { available: true, summary: '原始摘要' },
      ideas: [],
    })
    renderDialog()
    expect(screen.getByTestId('requirement-confirm-research').textContent).toContain('市面上类似的产品')
  })

  it('默认全选；取消一项后主按钮只提交勾选子集；提交成功弹窗关闭', async () => {
    store.set(requirementConfirmFamily('session-rc'), {
      sessionId: 'session-rc',
      projectId: 'project-rc',
      title: '确认你的需求',
      requirements: CONFIRM_EVENT.payload.requirements as Array<{ id: string; description: string }>,
      research: { available: true, summary: '市调摘要内容' },
      ideas: [],
    })
    renderDialog()

    expect(screen.getByTestId('requirement-confirm-dialog')).toBeTruthy()
    expect(screen.getByTestId('requirement-confirm-submit').textContent).toContain('确认，开始做')
    // 向导补充可见（2026-08-27）：origin=guide 的条目标「向导补充」徽标，user 条目不标
    expect(screen.getByTestId('requirement-confirm-origin-F-002').textContent).toContain('向导补充')
    expect(screen.queryByTestId('requirement-confirm-origin-F-001')).toBeNull()

    // 取消 F-001：主按钮变为「确认勾选的 1 项」
    fireEvent.click(screen.getByTestId('requirement-confirm-item-F-001'))
    expect(screen.getByTestId('requirement-confirm-submit').textContent).toContain('1 项')

    fireEvent.click(screen.getByTestId('requirement-confirm-submit'))
    await waitFor(() => {
      expect(confirmRequirements).toHaveBeenCalledWith(expect.objectContaining({
        session_id: 'session-rc',
        project_id: 'project-rc',
        decision: 'confirm',
        requirement_ids: ['F-002'],
      }))
    })
    // 提交后弹窗关闭
    await waitFor(() => {
      expect(screen.queryByTestId('requirement-confirm-dialog')).toBeNull()
    })
  })

  it('「由向导决定」出口 → decision=delegate（不带勾选集）', async () => {
    store.set(requirementConfirmFamily('session-rc'), {
      sessionId: 'session-rc',
      projectId: 'project-rc',
      title: '确认你的需求',
      requirements: [{ id: 'F-001', description: '记账本' }],
      research: { available: false, summary: '' },
      ideas: [],
    })
    renderDialog()

    // 市调不可用：如实标注且不阻断
    expect(screen.getByTestId('requirement-confirm-research').textContent).toContain('本次不可用')

    fireEvent.click(screen.getByRole('button', { name: '由向导决定' }))
    await waitFor(() => {
      expect(confirmRequirements).toHaveBeenCalledWith(expect.objectContaining({
        decision: 'delegate',
      }))
    })
    await waitFor(() => {
      expect(screen.queryByTestId('requirement-confirm-dialog')).toBeNull()
    })
  })

  it('「继续补充说明」→ 文本经既有 sendMessage 回到向导，弹窗关闭', async () => {
    store.set(requirementConfirmFamily('session-rc'), {
      sessionId: 'session-rc',
      projectId: 'project-rc',
      title: '确认你的需求',
      requirements: [{ id: 'F-001', description: '记账本' }],
      research: { available: false, summary: '' },
      ideas: [],
    })
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: '继续补充说明' }))
    const textarea = screen.getByTestId('requirement-confirm-supplement-input') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '还要能导出 CSV' } })
    fireEvent.click(screen.getByTestId('requirement-confirm-supplement-send'))

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        session_id: 'session-rc',
        content: '还要能导出 CSV',
        metadata: { source: 'chat' },
      }))
    })
    await waitFor(() => {
      expect(screen.queryByTestId('requirement-confirm-dialog')).toBeNull()
    })
  })

  it('无待决状态 → 不渲染弹窗', () => {
    const { container } = renderDialog()
    expect(container.firstChild).toBeNull()
  })
})
