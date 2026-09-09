// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PrdConfirmDialog } from '../../renderer/components/PrdConfirmDialog'
import { PRD_TERMS, priorityLabel } from '../../renderer/lib/prd-terms'
import {
  activeAgentSessionIdAtom,
  prdConfirmFamily,
  setupGlobalAgentListeners,
} from '../../renderer/agent-atoms'
import type { AgentEvent, ElectronAPI } from '../../shared/types'

/**
 * PRD 确认弹窗（prd_confirm 流，2026-08-26 改造 3）：
 * 事件归约进 prdConfirmFamily → 四段式渲染（P0 断言展开/范围外高亮）
 * → 两出口（整体确认 / 逐项「这条不对」预填调整）均走 sendMessage card_option。
 * 锚点 data-ai-id（陷阱 30）；非 globals 模式 RTL 手动 cleanup。
 */

configure({ testIdAttribute: 'data-ai-id' })

const CONFIRM_EVENT: AgentEvent = {
  event_id: crypto.randomUUID(),
  session_id: 'session-pc',
  project_id: 'project-pc',
  type: 'user_decision_required',
  payload: {
    kind: 'prd_confirm',
    title: '请确认这份 PRD（已通过裁判审查）',
    positioning: '个人记账工具',
    requirements: [
      { id: 'F-001', priority: 'P0', story: '作为用户，我想记录日常收支，以便掌握花销', assertions: ['记录后列表实时刷新', '金额支持两位小数'] },
      { id: 'F-002', priority: 'P2', story: '导出 CSV', assertions: ['点击导出按钮生成 CSV 文件'] },
    ],
    out_of_scope: ['不做排行榜', '不做登录'],
    assumptions: ['数据只存本地浏览器（你未说明存储位置）'],
    constraints: ['必须离线可用'],
    expanded: false,
  },
  created_at: new Date().toISOString(),
}

describe('PRD 确认弹窗 PrdConfirmDialog', () => {
  let store: ReturnType<typeof createStore>
  const sendMessage = vi.fn(async () => ({ ok: true, data: { accepted: true, session_id: 'session-pc', stream_started: true } }))

  beforeEach(() => {
    sendMessage.mockClear()
    store = createStore()
    window.__jotai_store__ = store as never
    store.set(activeAgentSessionIdAtom, 'session-pc')
    window.electronAPI = {
      agent: {
        onStreamEvent: () => () => undefined,
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

  function setState(): void {
    store.set(prdConfirmFamily('session-pc'), {
      sessionId: 'session-pc',
      projectId: 'project-pc',
      title: '请确认这份 PRD（已通过裁判审查）',
      positioning: '个人记账工具',
      requirements: [
        { id: 'F-001', priority: 'P0', story: '作为用户，我想记录日常收支，以便掌握花销', assertions: ['记录后列表实时刷新', '金额支持两位小数'] },
        { id: 'F-002', priority: 'P2', story: '导出 CSV', assertions: ['点击导出按钮生成 CSV 文件'] },
      ],
      outOfScope: ['不做排行榜', '不做登录'],
      assumptions: ['数据只存本地浏览器（你未说明存储位置）'],
      constraints: ['必须离线可用'],
      expanded: false,
      ideas: [],
    })
  }

  function renderDialog(): ReturnType<typeof render> {
    return render(
      <Provider store={store}>
        <PrdConfirmDialog />
      </Provider>,
    )
  }

  it('事件归约：kind=prd_confirm 写入专用 atom（优先级收窄/断言物化）', () => {
    let emit: ((event: AgentEvent) => void) | undefined
    window.electronAPI = {
      agent: {
        onStreamEvent: (listener: (event: AgentEvent) => void) => {
          emit = listener
          return () => undefined
        },
        sendMessage,
      },
    } as unknown as ElectronAPI
    setupGlobalAgentListeners()

    emit?.(CONFIRM_EVENT)
    expect(store.get(prdConfirmFamily('session-pc'))).toMatchObject({
      sessionId: 'session-pc',
      projectId: 'project-pc',
      requirements: [
        { id: 'F-001', priority: 'P0', assertions: expect.arrayContaining(['记录后列表实时刷新']) },
        { id: 'F-002', priority: 'P2' },
      ],
      outOfScope: ['不做排行榜', '不做登录'],
      expanded: false,
      ideas: [],
    })

    // 其它 kind 不触碰弹窗 atom
    emit?.({ ...CONFIRM_EVENT, payload: { kind: 'clarification', title: '先确认方向', questions: [] } })
    expect(store.get(prdConfirmFamily('session-pc'))).not.toBeNull()
  })

  it('四段式渲染：P0 断言展开可见；范围外/假设/约束各就各位', () => {
    setState()
    renderDialog()

    expect(screen.getByTestId('prd-confirm-positioning').textContent).toContain('个人记账工具')
    // P0 断言直接展开（决策密度最高的确认对象，不折叠）
    expect(screen.getByTestId('prd-confirm-item-F-001').textContent).toContain('记录后列表实时刷新')
    expect(screen.getByTestId('prd-confirm-item-F-001').textContent).toContain('金额支持两位小数')
    // P2 断言折叠（details 未展开时文本在文档中但不可见——断言元素存在即可）
    expect(screen.getByTestId('prd-confirm-item-F-002').textContent).toContain('导出 CSV')
    // 范围外高亮段
    expect(screen.getByTestId('prd-confirm-out-of-scope').textContent).toContain('不做排行榜')
    // 系统假设 + 用户约束
    expect(screen.getByTestId('prd-confirm-assumptions').textContent).toContain('数据只存本地浏览器')
    expect(screen.getByTestId('prd-confirm-constraints').textContent).toContain('必须离线可用')
  })

  it('灵感参考（2026-08-29）：想法区渲染可勾选，确认时 metadata 带 adopted_ideas；空想法不渲染', async () => {
    store.set(prdConfirmFamily('session-pc'), {
      sessionId: 'session-pc',
      projectId: 'project-pc',
      title: '请确认这份 PRD（已通过裁判审查）',
      positioning: '个人记账工具',
      requirements: [
        { id: 'F-001', priority: 'P0', story: '作为用户，我想记录日常收支', assertions: ['记录后列表实时刷新'] },
      ],
      outOfScope: [],
      assumptions: [],
      constraints: [],
      expanded: false,
      ideas: [
        { label: '语音快速记账', note: '说一句话自动记一笔', source: 'example.com' },
        { label: '拍照识别小票', note: '小票自动入账', source: 'example.org' },
      ],
    })
    renderDialog()

    expect(screen.getByTestId('prd-confirm-ideas').textContent).toContain('灵感参考')
    fireEvent.click(screen.getByTestId('prd-confirm-idea-语音快速记账'))
    fireEvent.click(screen.getByTestId('prd-confirm-submit'))

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({
          source: 'card_option',
          selected_option_id: 'prd_confirm_confirm',
          adopted_ideas: ['语音快速记账'],
        }),
      }))
    })
    await waitFor(() => {
      expect(screen.queryByTestId('prd-confirm-dialog')).toBeNull()
    })

    // 空想法（审查 P2-4 补断言）：ideas=[] 时想法区不渲染，确认不带 adopted_ideas
    cleanup()
    store.set(prdConfirmFamily('session-pc'), {
      sessionId: 'session-pc',
      projectId: 'project-pc',
      title: '请确认这份 PRD（已通过裁判审查）',
      positioning: '个人记账工具',
      requirements: [
        { id: 'F-001', priority: 'P0', story: '作为用户，我想记录日常收支', assertions: ['记录后列表实时刷新'] },
      ],
      outOfScope: [],
      assumptions: [],
      constraints: [],
      expanded: false,
      ideas: [],
    })
    renderDialog()
    expect(screen.queryByTestId('prd-confirm-ideas')).toBeNull()
    fireEvent.click(screen.getByTestId('prd-confirm-submit'))
    await waitFor(() => {
      expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
        metadata: { source: 'card_option', selected_option_id: 'prd_confirm_confirm' },
      }))
    })
  })

  it('整体确认 → sendMessage 携带 card_option/prd_confirm_confirm，弹窗关闭', async () => {
    setState()
    renderDialog()

    fireEvent.click(screen.getByTestId('prd-confirm-submit'))
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        session_id: 'session-pc',
        project_id: 'project-pc',
        metadata: { source: 'card_option', selected_option_id: 'prd_confirm_confirm' },
      }))
    })
    await waitFor(() => {
      expect(screen.queryByTestId('prd-confirm-dialog')).toBeNull()
    })
  })

  it('稍后再说（第三出口）→ 发送 prd_confirm_dismiss 并关闭弹窗，不开工（2026-08-27）', async () => {
    setState()
    renderDialog()

    fireEvent.click(screen.getByTestId('prd-confirm-dismiss'))
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        metadata: { source: 'card_option', selected_option_id: 'prd_confirm_dismiss' },
      }))
    })
    await waitFor(() => {
      expect(screen.queryByTestId('prd-confirm-dialog')).toBeNull()
    })
  })

  it('逐项「这条不对」→ 调整输入框预填条目 id，发送走 prd_confirm_adjust', async () => {
    setState()
    renderDialog()

    fireEvent.click(screen.getByTestId('prd-confirm-disagree-F-002'))
    const input = await screen.findByTestId('prd-confirm-adjust-input') as HTMLTextAreaElement
    expect(input.value).toContain('F-002')

    fireEvent.change(input, { target: { value: 'F-002 这条不对：我想要的是导出 Excel' } })
    fireEvent.click(screen.getByTestId('prd-confirm-adjust-send'))
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        content: 'F-002 这条不对：我想要的是导出 Excel',
        metadata: { source: 'card_option', selected_option_id: 'prd_confirm_adjust' },
      }))
    })
    await waitFor(() => {
      expect(screen.queryByTestId('prd-confirm-dialog')).toBeNull()
    })
  })

  it('白话术语层（闭环 PR7）：徽标带白话、段标题套术语表、顶部固定说明行', () => {
    setState()
    renderDialog()

    // 徽标：P 码保留对账 + 白话后缀
    expect(screen.getByTestId('prd-confirm-item-F-001').textContent).toContain('P0 · 核心必须')
    expect(screen.getByTestId('prd-confirm-item-F-002').textContent).toContain('P2 · 可延后')
    // P1/P2 折叠摘要套术语表
    expect(screen.getByTestId('prd-confirm-item-F-002').textContent).toContain('做到这样才算完成（1 条）')
    // 顶部固定说明行（婴儿模式入口语）
    expect(screen.getByTestId('prd-confirm-plain-intro').textContent).toContain('看不懂的词')
    expect(screen.getByTestId('prd-confirm-plain-intro').textContent).toContain('这条不对')
    // 功能清单段标题套术语表
    expect(screen.getByTestId('prd-confirm-requirements-title').textContent)
      .toContain('核心必须')
    expect(screen.getByTestId('prd-confirm-requirements-title').textContent)
      .toContain('做到这样才算完成')
    // 范围外 / 假设段标题套术语表
    expect(screen.getByTestId('prd-confirm-out-of-scope').textContent).toContain('这次明确不做的')
    expect(screen.getByTestId('prd-confirm-assumptions').textContent).toContain('我们替你默认的')
  })

  it('能力契约段（Phase 2 M1）：有 CAP 渲染不算完成/验收证据；无 CAP 不渲染（回归锁）', () => {
    // 无 CAP（旧夹具/开关 off）：段落不存在
    setState()
    const { unmount } = renderDialog()
    expect(screen.queryByTestId('prd-confirm-capabilities')).toBeNull()
    unmount()

    // 有 CAP：任务/不算完成/验收证据可见；缺 task 的脏条目被过滤
    store.set(prdConfirmFamily('session-pc'), {
      sessionId: 'session-pc',
      projectId: 'project-pc',
      title: '请确认这份 PRD（已通过裁判审查）',
      positioning: 'AI 随心记',
      requirements: [{ id: 'F-001', priority: 'P0', story: 'AI 智能总结', assertions: ['总结随笔记变化'] }],
      outOfScope: [],
      assumptions: [],
      constraints: [],
      aiCapabilities: [
        {
          capabilityId: 'CAP-01',
          task: '根据笔记内容生成智能总结',
          keyProcessing: '真实模型调用',
          ioDependency: '笔记变化→总结变化',
          forbiddenSubstitutions: ['固定模板冒充', '降级为普通增删改查'],
          evidence: ['修改笔记后总结随之变化'],
          source: 'user_explicit',
        },
      ],
      expanded: false,
      ideas: [],
    })
    renderDialog()
    const section = screen.getByTestId('prd-confirm-capabilities')
    expect(section.textContent).toContain('根据笔记内容生成智能总结')
    expect(section.textContent).toContain('不算完成：固定模板冒充；降级为普通增删改查')
    expect(section.textContent).toContain('验收证据：修改笔记后总结随之变化')
  })
})

describe('prd-terms 术语表（闭环 PR7，单点维护）', () => {
  it('P 码白话映射与 priorityLabel 拼装', () => {
    expect(PRD_TERMS.P0).toBe('核心必须')
    expect(PRD_TERMS.P1).toBe('重要')
    expect(PRD_TERMS.P2).toBe('可延后')
    expect(PRD_TERMS.assertion).toBe('做到这样才算完成')
    expect(PRD_TERMS.outOfScope).toBe('这次明确不做的')
    expect(PRD_TERMS.assumption).toBe('我们替你默认的（说一声就能改）')
    expect(priorityLabel('P0')).toBe('P0 · 核心必须')
    expect(priorityLabel('P1')).toBe('P1 · 重要')
    expect(priorityLabel('P2')).toBe('P2 · 可延后')
  })
})
