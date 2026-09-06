// @vitest-environment jsdom
// 渠道列表对 models 缺字段的防御（迭代 #3）。
// 期望行为来源：channels.json 是用户可手改、且跨版本共存的运行时文件（~/.proma 下 JSON），
// 类型上 Channel.models 必填但运行时不可保证；main/channel-manager.ts:150 已按 (models ?? []) 口径防御，
// 渲染层此前直接 channel.models.length → 一条缺字段记录即整页白屏（本轮编写 M3 用例时实测崩过）。

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, configure, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelSettingsPage } from '../../renderer/components/ChannelSettingsPage'
import { channelsListAtom, channelsLoadingAtom } from '../../renderer/components/atoms-sprint2'

configure({ testIdAttribute: 'data-ai-id' })

/** 缺 models 字段的渠道记录（模拟手改/旧版本 channels.json） */
const CHANNEL_WITHOUT_MODELS = {
  id: 'ch-legacy',
  name: '老数据渠道',
  provider_type: 'deepseek',
  base_url: 'https://api.deepseek.com/anthropic',
  api_key: 'enc-hex',
  enabled: true,
}

const CHANNEL_WITH_MODELS = {
  id: 'ch-ok',
  name: '正常渠道',
  provider_type: 'deepseek',
  base_url: 'https://api.deepseek.com/anthropic',
  api_key: 'enc-hex',
  enabled: true,
  models: [
    { id: 'deepseek-a-0', name: 'model-alpha', enabled: true },
    { id: 'deepseek-b-1', name: 'model-beta', enabled: false },
  ],
}

function mount(channels: unknown[]): void {
  const store = createStore()
  // 页面不自行拉列表（由 atoms-sprint2 供给），按 r112 口径直接预置 store
  store.set(channelsLoadingAtom, 'loaded')
  store.set(channelsListAtom, channels as never)
  ;(window as unknown as { __jotai_store__?: unknown }).__jotai_store__ = store
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    channels: {
      list: vi.fn().mockResolvedValue({ ok: true, data: channels }),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue({ ok: true }),
      remove: vi.fn().mockResolvedValue({ ok: true, data: { ok: true } }),
      testDirect: vi.fn(),
      fetchModels: vi.fn(),
    },
  }
  render(
    <Provider store={store}>
      <ChannelSettingsPage />
    </Provider>,
  )
}

describe('渠道列表 models 缺字段防御（不白屏、不误计数）', () => {
  afterEach(() => {
    delete (window as never as { electronAPI?: unknown }).electronAPI
    cleanup()
  })

  it('[G1] 缺 models 的渠道渲染为「未配置模型」，页面其余部分仍可交互', async () => {
    mount([CHANNEL_WITHOUT_MODELS])
    expect(await screen.findByText('老数据渠道')).toBeTruthy()
    expect(screen.getByText(/未配置模型/)).toBeTruthy()
    // 页面骨架仍在（不是整页崩）
    expect(screen.getByTestId('channel-settings-page')).toBeTruthy()
    expect(screen.getByRole('button', { name: /添加|新增|新建|配置/ })).toBeTruthy()
  })

  it('[G2] 混合数据：有模型的仍按启用数展示，缺模型的不会把整页拖崩', async () => {
    mount([CHANNEL_WITH_MODELS, CHANNEL_WITHOUT_MODELS])
    expect(await screen.findByText(/2 个模型：model-alpha、model-beta/)).toBeTruthy()
    expect(screen.getByText(/未配置模型/)).toBeTruthy()
    // 只有 1 条缺字段记录 → 只出现一次「未配置模型」
    expect(screen.getAllByText(/未配置模型/)).toHaveLength(1)
  })

  it('[G3] models 显式为 null（更脏的数据）同样降级为未配置，且不把相邻渠道带崩', async () => {
    mount([CHANNEL_WITH_MODELS, { ...CHANNEL_WITHOUT_MODELS, id: 'ch-null', name: '空指针渠道', models: null }])
    expect(await screen.findByText('空指针渠道')).toBeTruthy()
    expect(screen.getAllByText(/未配置模型/)).toHaveLength(1)
    expect(screen.getByText(/2 个模型：model-alpha、model-beta/)).toBeTruthy()
  })
})
