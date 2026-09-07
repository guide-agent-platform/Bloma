// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { configure } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../renderer/components/ChatPanel'
import type { ElectronAPI } from '../../shared/types'
import { channelsListAtom, channelsLoadingAtom, chatInputDraftAtom } from '../../renderer/components/atoms-sprint2'

/**
 * WC-P2 零渠道输入框引导联动（2026-08-29）单元层：
 * ChatPanel 直挂（不经 App 路由）验证 placeholder 引导语与提交拦截分支——
 * 零渠道提交 → onOpenSettings 调用 + onSendMessage 不调用 + 草稿保留（atom 化）；
 * 有渠道提交 → onSendMessage 正常 + 草稿清空（守卫不影响既有路径）；
 * 渠道未决（null）→ 不引导不拦截（不在加载窗口打扰）。
 *
 * GWT/路由级断言见 tests/acceptance/sprint1/project-mode-workspace.test.tsx S1-UI-028/029。
 */

configure({ testIdAttribute: 'data-ai-id' })

const enabledChannel = {
  id: 'c1',
  name: 'x',
  provider_type: 'anthropic' as const,
  base_url: 'u',
  api_key: 'k',
  enabled: true,
  models: [{ id: 'm1', name: 'm', enabled: true }],
}

describe('零渠道输入框引导（WC-P2 单元层）', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    store = createStore()
    window.__jotai_store__ = store as never
    window.electronAPI = {
      agent: {
        onStreamEvent: vi.fn(() => () => undefined),
      },
    } as unknown as ElectronAPI
  })

  afterEach(() => {
    cleanup()
    delete window.electronAPI
    delete window.__jotai_store__
  })

  function mountPanel(onSendMessage: (c: string) => void, onOpenSettings: () => void) {
    render(
      <Provider store={store}>
        <ChatPanel onSendMessage={onSendMessage} onOpenSettings={onOpenSettings} />
      </Provider>,
    )
  }

  it('[S1-UI-030] 零渠道：placeholder 引导语 + 提交拦截（onOpenSettings 调用、onSendMessage 不调用、草稿保留）', () => {
    store.set(channelsListAtom, [])
    store.set(channelsLoadingAtom, 'loaded')
    const onSendMessage = vi.fn()
    const onOpenSettings = vi.fn()
    mountPanel(onSendMessage, onOpenSettings)

    const input = screen.getByPlaceholderText(/还没有连接 AI 模型/) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '帮我做一个待办应用' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))

    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(onSendMessage).not.toHaveBeenCalled()
    expect(store.get(chatInputDraftAtom)).toBe('帮我做一个待办应用')
  })

  it('[S1-UI-031] 有渠道：placeholder 默认 + 提交正常发送并清空草稿（守卫不影响既有路径）', () => {
    store.set(channelsListAtom, [enabledChannel])
    store.set(channelsLoadingAtom, 'loaded')
    const onSendMessage = vi.fn()
    const onOpenSettings = vi.fn()
    mountPanel(onSendMessage, onOpenSettings)

    const input = screen.getByPlaceholderText('描述你的想法…') as HTMLTextAreaElement
    expect(input.placeholder).toBe('描述你的想法…')
    fireEvent.change(input, { target: { value: '做个计算器' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))

    expect(onSendMessage).toHaveBeenCalledTimes(1)
    expect(onSendMessage).toHaveBeenCalledWith('做个计算器')
    expect(onOpenSettings).not.toHaveBeenCalled()
    expect(store.get(chatInputDraftAtom)).toBe('')
  })

  it('[S1-UI-032] 渠道未决（loading→null）：不引导不拦截，placeholder 默认（不在加载窗口打扰）', () => {
    store.set(channelsListAtom, [])
    store.set(channelsLoadingAtom, 'loading')
    const onSendMessage = vi.fn()
    const onOpenSettings = vi.fn()
    mountPanel(onSendMessage, onOpenSettings)

    const input = screen.getByPlaceholderText('描述你的想法…') as HTMLTextAreaElement
    expect(input.placeholder).toBe('描述你的想法…')
    fireEvent.change(input, { target: { value: '先写着' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    expect(onSendMessage).toHaveBeenCalledWith('先写着')
    expect(onOpenSettings).not.toHaveBeenCalled()
  })

  it('[S1-UI-033] 零渠道 Enter 键提交同样被拦截（onKeyDown 显式 handler 路径，多厂商审查缺口修复）', () => {
    // jsdom 不合成平台 Enter→click（r65 S1-UI-026 决策），但 handleKeyDown 是显式 React
    // handler，fireEvent.keyDown 直接触发——按钮与 Enter 共用 handleSubmit 入口的证据锁定。
    store.set(channelsListAtom, [])
    store.set(channelsLoadingAtom, 'loaded')
    const onSendMessage = vi.fn()
    const onOpenSettings = vi.fn()
    mountPanel(onSendMessage, onOpenSettings)

    const input = screen.getByPlaceholderText(/还没有连接 AI 模型/) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '用键盘输入的内容' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(onSendMessage).not.toHaveBeenCalled()
    expect(store.get(chatInputDraftAtom)).toBe('用键盘输入的内容')
  })
})
