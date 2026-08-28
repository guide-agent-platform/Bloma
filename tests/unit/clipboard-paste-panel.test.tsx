// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { configure } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../renderer/components/ChatPanel'
import type { PastedImageRef } from '../../shared/types'
import type { ElectronAPI } from '../../shared/types'

/**
 * 剪贴板图片粘贴 P1（clipboard-image-paste，2026-08-29 r67）：ChatPanel 组件级交互。
 *
 * 粘贴图片 → 提取（白名单/大小）→ IPC 存文件得 imageId → 附件 chip（dataURL 预览）→
 * 发送时 onSendMessage(text, imageRefs)（既有纯文本路径签名兼容：第二参可选）。
 * 「零干扰」语义：纯文本粘贴不改任何行为（不 preventDefault、无 chip）。
 */

configure({ testIdAttribute: 'data-ai-id' })

const PNG_1PX_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_1PX_BASE64}`

interface FakeItem {
  kind: 'file' | 'string'
  type: string
  getAsFile: () => File | null
}

function makeItems(files: Array<{ type?: string; bytes?: Uint8Array; text?: string }>): DataTransferItemList {
  const items: FakeItem[] = files.map((f) =>
    f.text !== undefined
      ? { kind: 'string' as const, type: 'text/plain', getAsFile: () => null }
      : {
          kind: 'file' as const,
          type: f.type ?? 'application/octet-stream',
          getAsFile: () => new File([f.bytes ?? new Uint8Array()] as BlobPart[], 'pasted', { type: f.type ?? 'application/octet-stream' }),
        },
  )
  return Object.assign(items, { [Symbol.iterator]: items[Symbol.iterator].bind(items) }) as unknown as DataTransferItemList
}

/** jsdom 的 ClipboardEvent 构造不支持 clipboardData init：手动 defineProperty 挂 fake items */
function makePasteEvent(files: Array<{ type?: string; bytes?: Uint8Array; text?: string }>): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', { value: { items: makeItems(files) } })
  return event
}

describe('ChatPanel 粘贴图片（clipboard-paste 组件级）', () => {
  let store: ReturnType<typeof createStore>
  const saveMock = vi.fn()

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    store = createStore()
    window.__jotai_store__ = store as never
    saveMock.mockReset()
    saveMock.mockResolvedValue({ ok: true, request_id: 'r', data: { imageId: 'session-x/abc-123.png', media_type: 'image/png' } })
    window.electronAPI = {
      agent: { onStreamEvent: vi.fn(() => () => undefined) },
      pastedImage: { save: saveMock },
    } as unknown as ElectronAPI
  })

  afterEach(() => {
    cleanup()
    delete window.electronAPI
    delete window.__jotai_store__
  })

  function mountPanel(onSendMessage: (content: string, images?: PastedImageRef[]) => void) {
    render(
      <Provider store={store}>
        <ChatPanel onSendMessage={onSendMessage} />
      </Provider>,
    )
    return screen.getByPlaceholderText('描述你的想法…') as HTMLTextAreaElement
  }

  it('[S1-UI-044] 粘贴 PNG → IPC 存图 + 附件 chip 出现（含 dataURL 预览与「图片」可达名）', async () => {
    const onSend = vi.fn()
    const input = mountPanel(onSend)

    fireEvent(input, makePasteEvent([{ type: 'image/png', bytes: Uint8Array.from(atob(PNG_1PX_BASE64), (c) => c.charCodeAt(0)) }]))

    await waitFor(() => {
      expect(screen.getByTestId('paste-image-chip')).toBeTruthy()
    })
    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(saveMock.mock.calls[0][0]).toMatchObject({ ext: 'png' })
    // chip 预览直接用内存 dataURL（不依赖 file:// 协议，CSP 友好）
    const thumb = screen.getByTestId('paste-image-thumb') as HTMLImageElement
    expect(thumb.src.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('[S1-UI-045] 发送：onSendMessage(text, [imageRef]) 块数组语义 + chip 清空 + 输入清空', async () => {
    const onSend = vi.fn()
    const input = mountPanel(onSend)
    fireEvent.change(input, { target: { value: '看这张图' } })
    fireEvent(input, makePasteEvent([{ type: 'image/png', bytes: Uint8Array.from(atob(PNG_1PX_BASE64), (c) => c.charCodeAt(0)) }]))
    await waitFor(() => expect(screen.getByTestId('paste-image-chip')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1)
    })
    expect(onSend).toHaveBeenCalledWith('看这张图', [{ imageId: 'session-x/abc-123.png', media_type: 'image/png' }])
    // 发送后 chip 与输入清空
    expect(screen.queryByTestId('paste-image-chip')).toBeNull()
    expect(input.value).toBe('')
  })

  it('[S1-UI-046] 纯文本粘贴零干扰：不调 save、无 chip、不 preventDefault（textarea 仍收到文本）', () => {
    const onSend = vi.fn()
    const input = mountPanel(onSend)
    const event = makePasteEvent([{ text: '只是文字' }])
    const preventSpy = vi.spyOn(event, 'preventDefault')
    fireEvent(input, event)
    expect(saveMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('paste-image-chip')).toBeNull()
    expect(preventSpy).not.toHaveBeenCalled()
  })

  it('[S1-UI-047] 存图失败降级：IPC 返回错误 → chip 不出现、发送仍按纯文本路径（不阻塞用户）', async () => {
    saveMock.mockResolvedValue({ ok: false, request_id: 'r', error: { code: 'WRITE_FAILED', message: 'disk full' } })
    const onSend = vi.fn()
    const input = mountPanel(onSend)
    fireEvent.change(input, { target: { value: '图发不出也没关系' } })
    fireEvent(input, makePasteEvent([{ type: 'image/png', bytes: Uint8Array.from(atob(PNG_1PX_BASE64), (c) => c.charCodeAt(0)) }]))
    await waitFor(() => {
      // 降级提示出现（用户知情），但没有 chip
      expect(screen.getByTestId('paste-image-error')).toBeTruthy()
    })
    expect(screen.queryByTestId('paste-image-chip')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    // 降级=纯文本路径：单参调用形态（无 undefined 占位第二参）
    expect(onSend).toHaveBeenCalledWith('图发不出也没关系')
  })
})
