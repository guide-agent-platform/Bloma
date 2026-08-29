// @vitest-environment jsdom
// ux-header-badge-walkthrough r102（B 腿可执行走查，SOP 三用）：渠道感知三态徽标（QW#1）。
// 状态矩阵：hasChannels null（loading/error）→不渲染防闪变；false→「未配置 AI」；true+在线→「AI 就绪」；true+离线→「离线」。

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, render, screen } from '@testing-library/react'
import { configure } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceHeader } from '../../renderer/components/WorkspaceHeader'
import { channelsListAtom, channelsLoadingAtom } from '../../renderer/components/atoms-sprint2'
import { networkOnlineAtom } from '../../renderer/components/atoms'
import type { ElectronAPI } from '../../shared/types'

configure({ testIdAttribute: 'data-ai-id' })

const enabledChannel = {
  channel_id: 'c1', name: '测试渠道', enabled: true,
  models: [{ model_id: 'm1', name: 'M1', enabled: true }],
} as never

describe('ux-header-badge-walkthrough r102：渠道三态徽标（0 基础用户视角）', () => {
  let store: ReturnType<typeof createStore>
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    store = createStore()
    ;(window as never as { __jotai_store__: unknown }).__jotai_store__ = store
    ;(window as never as { electronAPI: unknown }).electronAPI = {
      agent: { onStreamEvent: vi.fn(() => () => undefined) },
    } as unknown as ElectronAPI
  })
  afterEach(() => {
    cleanup()
    delete (window as never as { electronAPI?: unknown }).electronAPI
    delete (window as never as { __jotai_store__?: unknown }).__jotai_store__
  })
  function mount() {
    render(
      <Provider store={store}>
        <WorkspaceHeader />
      </Provider>,
    )
  }
  const badgeText = () => (document.querySelector('[title]') ? (document.body.textContent ?? '') : '')

  it('[H1·加载态] loading → 徽标不渲染（防「AI 就绪」闪变误导，QW#1 审查 P1-①）', () => {
    store.set(channelsLoadingAtom, 'loading')
    mount()
    expect(document.body.textContent ?? '').not.toContain('未配置 AI')
    expect(document.body.textContent ?? '').not.toContain('AI 就绪')
  })

  it('[H2·零渠道] loaded+空列表 → 「未配置 AI」+引导 title', () => {
    store.set(channelsLoadingAtom, 'loaded')
    store.set(channelsListAtom, [])
    mount()
    expect(document.body.textContent ?? '').toContain('未配置 AI')
    const el = screen.getByTitle('还没有可用的 AI 模型，去设置里连接一个')
    expect(el).toBeTruthy()
  })

  it('[H3·就绪] loaded+可用渠道+在线 → 「AI 就绪」', () => {
    store.set(channelsLoadingAtom, 'loaded')
    store.set(channelsListAtom, [enabledChannel])
    store.set(networkOnlineAtom, true)
    mount()
    expect(screen.getByTitle('AI 就绪')).toBeTruthy()
  })

  it('[H4·离线] loaded+可用渠道+离线 → 「离线」（danger 提示）', () => {
    store.set(channelsLoadingAtom, 'loaded')
    store.set(channelsListAtom, [enabledChannel])
    store.set(networkOnlineAtom, false)
    mount()
    expect(screen.getByTitle('网络离线')).toBeTruthy()
  })
})
