// @vitest-environment jsdom
// ux-message-actions-walkthrough r117（B 腿可执行走查，SOP 九用）：消息操作台面能力（0 基础对照 Claude/GPT）。
// 现状：F4 实锤——AI 回复零复制入口（MessageBubble assistant 走 Markdown，无 copy 按钮；
// user 气泡纯文本也无 copy；错误回复无 retry）。本 spec 锁现状+预埋翻转位（修复后断言翻转即验收）。

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createStore, Provider } from 'jotai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../renderer/components/ChatPanel'
import { activeAgentSessionIdAtom, agentMessagesFamily } from '../../renderer/agent-atoms'
import type { AgentMessage } from '../../shared/types'

function msg(role: AgentMessage['role'], text: string, isError = false): AgentMessage {
  return { role, content: [{ type: 'text', text: isError ? `出错了：${text}` : text }], timestamp: Date.now() }
}

describe('ux-message-actions-walkthrough r117：消息操作（copy/retry——F4 现状锁定）', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    store = createStore()
    ;(window as never as { __jotai_store__: unknown }).__jotai_store__ = store
  })
  afterEach(() => {
    delete (window as never as { __jotai_store__?: unknown }).__jotai_store__
    cleanup()
  })

  function mountWith(list: AgentMessage[]): void {
    store.set(activeAgentSessionIdAtom, 's1')
    store.set(agentMessagesFamily('s1'), list)
    render(
      <Provider store={store}>
        <ChatPanel />
      </Provider>,
    )
  }

  it('[M1·assistant 复制按钮·F4 已修] AI 回复渲染 Markdown + 「复制」按钮写入剪贴板', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mountWith([msg('assistant', '# 方案标题\n\n正文内容')])
    expect(screen.getByText('方案标题')).toBeTruthy()
    const btn = screen.getByRole('button', { name: /复制|copy/i }) // F4 翻转：按钮存在
    fireEvent.click(btn)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('正文内容')))
  })

  it('[M2·user 复制按钮·F4 已修] 用户消息也有复制入口（翻转位同 M1）', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mountWith([msg('user', '这是我的原始提问')])
    expect(screen.getByText('这是我的原始提问')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /复制|copy/i }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('这是我的原始提问'))
  })

  it('[M3·错误回复无重试] 错误文本可见但无「重试」按钮（retry 语义需产品决策——P2 挂账，非本轮 F4 范围）', () => {
    mountWith([msg('user', '再来一次'), msg('assistant', '模型渠道超时', true)])
    expect(screen.getByText(/出错了：模型渠道超时/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /重试|retry/i })).toBeNull()
  })

  it('[M4·降级基线] 文本节点存在于 DOM（用户至少可手动框选 Ctrl+C——非图片化锁死）', () => {
    mountWith([msg('assistant', '可手动选中的回复文本')])
    expect(document.body.textContent ?? '').toContain('可手动选中的回复文本')
  })
})
