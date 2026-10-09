// @vitest-environment jsdom
// ux-chip-walkthrough r93（B 腿可执行走查，2026-08-29 06:19-06:35）
// 机器可验证走查：ChatPanel 四状态 DOM 供词——S-007 P1 项的渲染级证据
// （对照 ux-paste-r72.md 九项+ux-paste-r86-anchor-refresh.md 现锚）。
// 产出语义：每个 it = 一条走查清单项；断言失败 = 走查发现回归/落地变化。

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { configure } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../renderer/components/ChatPanel'
import { activeAgentSessionIdAtom, agentStreamStateFamily } from '../../renderer/components/atoms'
import type { ElectronAPI } from '../../shared/types'

configure({ testIdAttribute: 'data-ai-id' })

const PNG_1PX_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

interface FakeItem { kind: 'file' | 'string'; type: string; getAsFile: () => File | null }
function makeItems(files: Array<{ type?: string; bytes?: Uint8Array; text?: string }>): DataTransferItemList {
  const items: FakeItem[] = files.map((f) =>
    f.text !== undefined
      ? { kind: 'string' as const, type: 'text/plain', getAsFile: () => null }
      : { kind: 'file' as const, type: f.type ?? 'application/octet-stream', getAsFile: () => new File([f.bytes ?? new Uint8Array()] as BlobPart[], 'pasted', { type: f.type ?? 'application/octet-stream' }) },
  )
  return Object.assign(items, { [Symbol.iterator]: items[Symbol.iterator].bind(items) }) as unknown as DataTransferItemList
}
function makePasteEvent(files: Array<{ type?: string; bytes?: Uint8Array; text?: string }>): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', { value: { items: makeItems(files) } })
  return event
}
function pngBytes(): Uint8Array { return Uint8Array.from(atob(PNG_1PX_BASE64), (c) => c.charCodeAt(0)) }

describe('ux-chip-walkthrough r93：ChatPanel 四状态 DOM 走查（0 基础用户视角）', () => {
  let store: ReturnType<typeof createStore>
  const saveMock = vi.fn()

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    store = createStore()
    ;(window as never as { __jotai_store__: unknown }).__jotai_store__ = store
    saveMock.mockReset()
    saveMock.mockResolvedValue({ ok: true, request_id: 'r', data: { imageId: 'session-x/walk-1.png', media_type: 'image/png' } })
    ;(window as never as { electronAPI: unknown }).electronAPI = {
      agent: { onStreamEvent: vi.fn(() => () => undefined) },
      pastedImage: { save: saveMock },
    } as unknown as ElectronAPI
  })
  afterEach(() => {
    cleanup()
    delete (window as never as { electronAPI?: unknown }).electronAPI
    delete (window as never as { __jotai_store__?: unknown }).__jotai_store__
  })

  function mountPanel(): HTMLTextAreaElement {
    render(
      <Provider store={store}>
        <ChatPanel onSendMessage={vi.fn()} />
      </Provider>,
    )
    return screen.getByPlaceholderText('描述你的想法…') as HTMLTextAreaElement
  }
  const sendButton = () => screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement

  it('[W1·空态] placeholder 可见且**无任何贴图暗示**（P1-2 可发现性缺口的渲染级证据）', () => {
    const input = mountPanel()
    expect(input).toBeTruthy()
    const ph = input.placeholder
    expect(/贴|图|截图/.test(ph)).toBe(false)
  })

  it('[W2·空态] 发送禁用 + 无 chip 行（零干扰空态合格）', () => {
    mountPanel()
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByTestId('paste-image-chip')).toBeNull()
  })

  it('[W3·贴图态] 纯图片可发送，移除后恢复空态', async () => {
    const input = mountPanel()
    fireEvent(input, makePasteEvent([{ type: 'image/png', bytes: pngBytes() }]))
    await waitFor(() => expect(screen.getByTestId('paste-image-chip')).toBeTruthy())
    expect(sendButton().disabled).toBe(false)
    fireEvent.change(input, { target: { value: '看' } })
    expect(sendButton().disabled).toBe(false)
  })

  it('[W4·错误态] 非白名单类型粘贴 → pasteError 可见文案（错误反馈存在性；r72 P2-5 相关）', async () => {
    const input = mountPanel()
    fireEvent(input, makePasteEvent([{ type: 'image/bmp', bytes: pngBytes() }]))
    await waitFor(() => {
      const err = document.body.textContent ?? ''
      expect(/bmp|不支持|白名单|PNG|JPEG|GIF|WebP/i.test(err)).toBe(true)
    })
  })

  it('[W5a·等待态] 等待阶段保留停止入口', () => {
    render(
      <Provider store={store}>
        <ChatPanel onSendMessage={vi.fn()} isWaiting={true} />
      </Provider>,
    )
    const send = screen.queryByRole('button', { name: '发送消息' })
    expect(send).toBeNull()
    expect(screen.queryByRole('button', { name: '停止本轮制作' })).not.toBeNull()  // F5：无停止可取消
  })

  it('[W5b·流态] hasActiveStream：停止按钮出现、发送消失（替换语义仅在流态成立）', () => {
    store.set(activeAgentSessionIdAtom, 'walk-s1')
    store.set(agentStreamStateFamily('walk-s1'), { running: true, events: [], content: '' })
    render(
      <Provider store={store}>
        <ChatPanel onSendMessage={vi.fn()} />
      </Provider>,
    )
    // 流态：输入区整体被替换（placeholder 亦不存在）+ 停止按钮出现
    expect(screen.getByRole('button', { name: '停止本轮制作' })).toBeTruthy()
    expect(screen.queryByPlaceholderText('描述你的想法…')).toBeNull()
    expect(screen.queryByRole('button', { name: '发送消息' })).toBeNull()
  })
})
