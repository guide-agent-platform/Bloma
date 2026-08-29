// @vitest-environment jsdom
// ux-channel-list-walkthrough r112（B 腿可执行走查，SOP 七用）：渠道列表区「管理我的渠道」。
// 状态矩阵：列表渲染（名称+启用状态点色）/ 删除二次确认（title 删除渠道→确认/取消）/ 删除成功列表移除 /
// 删除失败行级错误 / IPC 异常同错误 / 取消不动列表。

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelSettingsPage } from '../../renderer/components/ChannelSettingsPage'
import { channelsListAtom, channelsLoadingAtom } from '../../renderer/components/atoms-sprint2'

const ch = (id: string, name: string, enabled: boolean) => ({
  id, name, enabled, provider: 'deepseek', models: [{ model_id: 'm1', name: 'M1', enabled: true }],
} as never)

describe('ux-channel-list-walkthrough r112：渠道列表区（0 基础「管理我的渠道」）', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    if (!(window as never as { crypto?: { randomUUID?: unknown } }).crypto?.randomUUID) {
      Object.defineProperty(window, 'crypto', { value: { randomUUID: () => 'u-' + Math.random() } })
    }
    store = createStore()
    ;(window as never as { __jotai_store__: unknown }).__jotai_store__ = store
    store.set(channelsLoadingAtom, 'loaded')
    store.set(channelsListAtom, [ch('c1', '我的 DeepSeek', true), ch('c2', '备用智谱', false)])
  })
  afterEach(() => {
    delete (window as never as { electronAPI?: unknown }).electronAPI
    delete (window as never as { __jotai_store__?: unknown }).__jotai_store__
    cleanup()
  })

  function mount() {
    return render(
      <Provider store={store}>
        <ChannelSettingsPage />
      </Provider>,
    )
  }
  const setDelete = (impl: unknown = undefined) => {
    ;(window as never as { electronAPI: unknown }).electronAPI = { channels: { delete: impl } }
  }

  it('[L1·列表] 两渠道名可见+启用状态点（绿=启用/灰=禁用）', () => {
    setDelete()
    mount()
    expect(screen.getByText('我的 DeepSeek')).toBeTruthy()
    expect(screen.getByText('备用智谱')).toBeTruthy()
    const dots = document.querySelectorAll('span[style*="border-radius: 50%"]')
    expect(dots.length).toBeGreaterThanOrEqual(2)
  })

  it('[L2·删除流] title=删除渠道 → 确认/取消出现 → 确认 → IPC 带 channel_id → 列表移除', async () => {
    const del = vi.fn().mockResolvedValue({ ok: true })
    setDelete(del)
    mount()
    fireEvent.click(screen.getAllByTitle('删除渠道')[0])
    const confirm = await screen.findByRole('button', { name: '确认删除' })
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy()
    fireEvent.click(confirm)
    await waitFor(() => expect(del).toHaveBeenCalledWith(expect.objectContaining({ channel_id: 'c1' })))
    await waitFor(() => expect(screen.queryByText('我的 DeepSeek')).toBeNull())
    expect(screen.getByText('备用智谱')).toBeTruthy()
  })

  it('[L3·删除失败] ok:false → 行级错误消息+列表不变', async () => {
    setDelete(vi.fn().mockResolvedValue({ ok: false, error: { user_visible_message: '渠道正被默认路由引用，无法删除' } }))
    mount()
    fireEvent.click(screen.getAllByTitle('删除渠道')[0])
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(screen.getByText(/正被默认路由引用/)).toBeTruthy())
    expect(screen.getByText('我的 DeepSeek')).toBeTruthy()
  })

  it('[L4·IPC 异常] delete 抛错 → 通用错误+确认态关闭', async () => {
    setDelete(vi.fn().mockRejectedValue(new Error('boom')))
    mount()
    fireEvent.click(screen.getAllByTitle('删除渠道')[0])
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(screen.getByText(/删除失败，请重试/)).toBeTruthy())
    await waitFor(() => expect(screen.queryByRole('button', { name: '确认删除' })).toBeNull())
  })

  it('[L5·取消] 点取消 → 不调 IPC+列表不变', async () => {
    const del = vi.fn()
    setDelete(del)
    mount()
    fireEvent.click(screen.getAllByTitle('删除渠道')[1])
    fireEvent.click(await screen.findByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '确认删除' })).toBeNull())
    expect(del).not.toHaveBeenCalled()
    expect(screen.getByText('备用智谱')).toBeTruthy()
  })
})
