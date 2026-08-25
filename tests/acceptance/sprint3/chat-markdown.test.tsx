// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../../renderer/components/ChatPanel'
import { activeAgentSessionIdAtom, agentMessagesFamily } from '../../../renderer/agent-atoms'
import type { AgentMessage } from '../../../shared/types'

/**
 * 聊天旁白 Markdown 渲染（2026-08-25 loop 完成总结裸 md 符号案例，会话 1c06f17a）：
 * - assistant 气泡渲染 Markdown：## → heading、**粗体** → strong、`代码` → code、表格可读；
 * - user 气泡保持纯文本：`1 * 2 * 3` 不被赋予 md 语义（无 em/strong）；
 * - 落盘与事件流不动，只改展示层。
 * 锚点用 data-ai-id（陷阱 30）；非 globals 模式 RTL 手动 cleanup。
 */

function message(role: AgentMessage['role'], text: string): AgentMessage {
  return { role, content: [{ type: 'text', text }], timestamp: Date.now() }
}

describe('聊天旁白 Markdown 渲染', () => {
  afterEach(() => {
    cleanup()
    delete window.__jotai_store__
  })

  function mountPanel(messages: AgentMessage[]) {
    Element.prototype.scrollIntoView = vi.fn()
    const store = createStore()
    store.set(activeAgentSessionIdAtom, 'session-md')
    store.set(agentMessagesFamily('session-md'), messages)
    window.__jotai_store__ = store
    render(
      <Provider store={store}>
        <ChatPanel />
      </Provider>,
    )
  }

  it('assistant 完成总结渲染为结构化 Markdown（heading/strong/行内 code/表格）', () => {
    mountPanel([
      message(
        'assistant',
        [
          '## 完成总结',
          '',
          '**F-001 基础计算器**：数字键与四则运算。',
          '',
          '- 行为断言通过：`点击数字按钮→显示屏追加数字`',
          '',
          '| 验证项 | 结果 |',
          '| --- | --- |',
          '| run_gwt_tests | 2/2 通过 |',
        ].join('\n'),
      ),
    ])

    expect(screen.getByRole('heading', { name: '完成总结' })).toBeTruthy()
    expect(screen.getByText('F-001 基础计算器').tagName).toBe('STRONG')
    expect(screen.getByText('点击数字按钮→显示屏追加数字').tagName).toBe('CODE')
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getByRole('cell', { name: '2/2 通过' })).toBeTruthy()
  })

  it('user 气泡保持纯文本：星号/井号不被解释为 md', () => {
    mountPanel([message('user', '算一下 1 * 2 * 3')])

    expect(screen.getByText('算一下 1 * 2 * 3')).toBeTruthy()
    expect(document.querySelector('.bloma-md')).toBeNull()
  })
})
