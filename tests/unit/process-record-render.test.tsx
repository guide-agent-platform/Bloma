// @vitest-environment jsdom
/**
 * 过程记录卡片渲染回归（2026-09-11）：
 * ① 生成中就有过程记录卡片（不再等收尾，也不依赖 running 门控）；
 * ② 生成完成后过程文本保留为**折叠**卡片（不是消失），与交付消息并列；
 * ③ 卡片可展开/收起往复（点开能再点回去）。
 */
import React from 'react'
import { createStore, Provider } from 'jotai'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../renderer/components/ChatPanel'
import { activeAgentSessionIdAtom, agentMessagesFamily, setupGlobalAgentListeners } from '../../renderer/agent-atoms'
import type { AgentEvent, ElectronAPI } from '../../shared/types'

let seq = 0
const ev = (session: string, type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent => ({
  event_id: `e${++seq}`,
  session_id: session,
  project_id: 'p1',
  type,
  payload,
  created_at: new Date().toISOString(),
})

function mountPanel(): { listener: (event: AgentEvent) => void } {
  Element.prototype.scrollIntoView = vi.fn()
  const store = createStore()
  let listener: ((event: AgentEvent) => void) | undefined
  window.__jotai_store__ = store
  window.electronAPI = {
    agent: {
      onStreamEvent(next: (event: AgentEvent) => void) {
        listener = next
        return vi.fn()
      },
    },
  } as unknown as ElectronAPI
  setupGlobalAgentListeners()
  store.set(activeAgentSessionIdAtom, 's1')
  render(
    <Provider store={store}>
      <ChatPanel />
    </Provider>,
  )
  return { listener: (event) => act(() => listener?.(event)) }
}

const card = (): HTMLElement | null => document.querySelector('[data-ai-id="process-record"]')

describe('过程记录卡片渲染', () => {
  afterEach(() => {
    cleanup()
    delete window.electronAPI
    delete window.__jotai_store__
    vi.restoreAllMocks()
  })

  it('生成中即出现卡片，完成后保留为折叠卡片且可往复展开收起', () => {
    const { listener } = mountPanel()
    listener(ev('s1', 'stage_changed', { stage: 'generating_mvp' }))
    listener(ev('s1', 'message_delta', { text: '正在实现第一个功能项…' }))

    // ① 生成中就有卡片，且默认收起（正文不外露）
    expect(card()).not.toBeNull()
    expect(card()?.textContent).toContain('过程记录')
    expect(card()?.textContent).not.toContain('正在实现第一个功能项')

    // 完成交付
    listener(ev('s1', 'delivery_message', { text: '你的应用已经做好了。', fallback: false }))
    listener(ev('s1', 'completed', { subtype: 'success' }))

    // ② 过程文本没有消失：仍是折叠卡片，且交付文本可见
    expect(card()).not.toBeNull()
    expect(card()?.textContent).not.toContain('正在实现第一个功能项')
    expect(document.body.textContent).toContain('你的应用已经做好了')

    // ③ 展开/收起往复
    const header = card()?.querySelector('button')
    expect(header).toBeTruthy()
    fireEvent.click(header as HTMLButtonElement)
    expect(card()?.textContent).toContain('正在实现第一个功能项')
    fireEvent.click(header as HTMLButtonElement)
    expect(card()?.textContent).not.toContain('正在实现第一个功能项')
  })

  it('纯对话回复不折叠（普通气泡直接可见）', () => {
    const { listener } = mountPanel()
    listener(ev('s1', 'message_delta', { text: '你说的是想做记账对吧？' }))
    listener(ev('s1', 'completed', { subtype: 'success' }))
    expect(card()).toBeNull()
    expect(document.body.textContent).toContain('你说的是想做记账对吧？')
  })
})
it('存量碎块 thinking（每块 0~11 字符）回放时重组为可读文本（2026-09-11 真机案例回归）', () => {
  const { listener } = mountPanel()
  // 模拟存量 JSONL 回放：一轮收尾 = 上百个思考碎块 + 收尾正文（无工具块、无 process_record 标记）
  const fragments = ['我先', '分析', '需求', '，', '然后', '实现', '记账', '功能']
  act(() => {
    listener(
      ev('s1', 'message_delta', { text: '' }),
    )
  })
  const store = window.__jotai_store__ as { set: (a: unknown, v: unknown) => void }
  act(() => {
    store.set(agentMessagesFamily('s1'), [
      {
        role: 'assistant' as const,
        content: [
          ...fragments.map((thinking) => ({ type: 'thinking' as const, thinking })),
          { type: 'text' as const, text: '这个单位换算器现在可以随手完成日常换算。' },
        ],
        timestamp: Date.now(),
      },
    ])
  })
  // 回放消息无标记 → 普通气泡 + ThinkingBlock（不折叠为过程卡片）
  const record = document.querySelector('[data-ai-id="process-record"]')
  expect(record).toBeNull()
  const thinkingBlock = document.querySelector('[data-ai-id="thinking-block"]')
  expect(thinkingBlock).not.toBeNull()
  fireEvent.click(thinkingBlock?.querySelector('button') as HTMLButtonElement)
  // '' 连接重组为连续可读句，而非被退行折叠吃成空白
  expect(thinkingBlock?.textContent).toContain('我先分析需求，然后实现记账功能')
})
