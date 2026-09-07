// @vitest-environment jsdom
// 编辑态残留回归（2026-09-06 第 3 层真 UI 目检缺陷 #1）。
// 场景：表单打开着编辑渠道甲，不关闭直接点渠道乙的「编辑」——
// ChannelForm 的 useState 只在挂载时取 initial，无 key 时 React 复用实例，
// 名称/URL/模型列表会残留甲；更危险的是拉取结果 mergeFetchedModels(prev=甲列表)
// 会把甲的勾选状态合进乙并随保存写坏乙的数据。
// 修复：调用点给 ChannelForm 加 key={editingChannel?.id ?? 'new'} 强制重挂载。

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelSettingsPage } from '../../renderer/components/ChannelSettingsPage'
import { channelsListAtom, channelsLoadingAtom } from '../../renderer/components/atoms-sprint2'

configure({ testIdAttribute: 'data-ai-id' })

const CH_A = {
  id: 'ch-a', name: '渠道甲', provider_type: 'custom',
  base_url: 'https://a.example/v1', api_key: 'enc-hex', enabled: true,
  models: [{ id: 'a-1', name: 'a-model-1', enabled: true }],
}
const CH_B = {
  id: 'ch-b', name: '渠道乙', provider_type: 'custom',
  base_url: 'https://b.example/v1', api_key: 'enc-hex', enabled: true,
  models: [
    { id: 'b-1', name: 'b-model-1', enabled: false },
    { id: 'b-2', name: 'b-model-2', enabled: true },
  ],
}

let store: ReturnType<typeof createStore>

beforeEach(() => {
  store = createStore()
  store.set(channelsListAtom, [CH_A, CH_B] as never)
  store.set(channelsLoadingAtom, 'loaded' as never) // r112 口径：该原子是状态字符串非 boolean，置 false 会落在骨架分支
  ;(window as unknown as { __jotai_store__?: unknown }).__jotai_store__ = store
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    channels: {
      list: vi.fn().mockResolvedValue({ ok: true, data: [CH_A, CH_B] }),
      create: vi.fn().mockResolvedValue({ ok: true, data: CH_A }),
      update: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      delete: vi.fn().mockResolvedValue({ ok: true }),
      remove: vi.fn().mockResolvedValue({ ok: true }),
      testDirect: vi.fn().mockResolvedValue({ ok: true, data: { ok: true } }),
      fetchModels: vi.fn().mockResolvedValue({ ok: true, data: { models: [] } }),
    },
  }
})

afterEach(() => {
  delete (window as never as { electronAPI?: unknown }).electronAPI
  delete (window as never as { __jotai_store__?: unknown }).__jotai_store__
  cleanup()
})

describe('编辑渠道切换目标不残留（目检缺陷 #1 翻转位）', () => {
  it('表单打开态直接换编辑目标 → 名称/模型列表应换成新渠道，不带旧数据', async () => {
    render(<Provider store={store}><ChannelSettingsPage /></Provider>)

    await screen.findByText('渠道甲') // 卡片在 refresh effect 微任务后才落地（r112 同款时序）
    const editButtons = screen.getAllByTitle('编辑渠道')
    fireEvent.click(editButtons[0]!)
    const nameInput = screen.getByPlaceholderText(/例如：我的 DeepSeek/) as HTMLInputElement
    // 基线：先确认甲的表单正常
    expect(nameInput.value).toBe('渠道甲')
    expect(screen.getByTestId('channel-model-row-a-model-1')).toBeTruthy()

    // 不关表单，直接点乙的「编辑」（修复后 ChannelForm 重挂载，旧 DOM 已脱离文档 → 必须重新查询）
    fireEvent.click(screen.getAllByTitle('编辑渠道')[1]!)

    const nameInputAfter = screen.getByPlaceholderText(/例如：我的 DeepSeek/) as HTMLInputElement
    expect(nameInputAfter.value).toBe('渠道乙') // 残留缺陷时现红
    expect(nameInputAfter).not.toBe(nameInput) // 重挂载硬断言：必须是新元素（旧元素已 detach）
    expect(screen.getByTestId('channel-model-count').textContent).toContain('已启用 1 / 共 2') // 乙=2模型1启用
    expect(screen.queryByTestId('channel-model-row-a-model-1')).toBeNull() // 甲模型不得混进乙列表
    expect(screen.queryByTestId('channel-model-row-b-model-2')).toBeTruthy()
  })
})
