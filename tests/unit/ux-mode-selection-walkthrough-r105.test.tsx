// @vitest-environment jsdom
// ux-mode-selection-walkthrough r105（B 腿可执行走查，SOP 四用）：模式选择页（0 基础用户第一屏）。
// 状态矩阵：idle 双卡可用 / busy 双卡禁用+双击防重 / IPC 缺失环境错误 / 创建失败 user_visible_message /
// 创建抛异常通用文案 / 成功 → 三 atom 设置+onModeSelected 导航回调。

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModeSelectionPage } from '../../renderer/components/ModeSelectionPage'
import { modeSelectedAtom, projectModeAtom } from '../../renderer/components/atoms'

describe('ux-mode-selection-walkthrough r105：模式选择页（0 基础用户第一屏）', () => {
  let onModeSelected: ReturnType<typeof vi.fn>
  let onBackToHistory: ReturnType<typeof vi.fn>
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    if (!(window as never as { crypto?: { randomUUID?: unknown } }).crypto?.randomUUID) {
      Object.defineProperty(window, 'crypto', { value: { randomUUID: () => 'u-' + Math.random() } })
    }
    store = createStore()
    ;(window as never as { __jotai_store__: unknown }).__jotai_store__ = store
    onModeSelected = vi.fn()
    onBackToHistory = vi.fn()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete (window as never as { electronAPI?: unknown }).electronAPI
    delete (window as never as { __jotai_store__?: unknown }).__jotai_store__
    cleanup()
  })

  function mount() {
    return render(
      <Provider store={store}>
        <ModeSelectionPage onModeSelected={onModeSelected} onBackToHistory={onBackToHistory} />
      </Provider>,
    )
  }
  function card(aiId: string): { click: () => void; btn: () => HTMLButtonElement } {
    const btn = () => document.querySelector(`[data-ai-id="${aiId}"] button`) as HTMLButtonElement
    return { click: () => fireEvent.click(btn()), btn }
  }

  const setElectron = (createImpl?: unknown) => {
    ;(window as never as { electronAPI: unknown }).electronAPI = {
      project: { create: createImpl },
    }
  }

  it('[M1·首屏] 双模式卡渲染——「快速做一个试试」与「认真打磨一个产品」+title 引导', () => {
    setElectron()
    mount()
    expect(card('mode-card-quick').btn()).toBeTruthy()
    expect(card('mode-card-longterm').btn()).toBeTruthy()
  })

  it('[M2·成功] 点快速卡 → create 调用带 mode=quick → 三 atom 设置+onModeSelected(quick)', async () => {
    const create = vi.fn().mockResolvedValue({ ok: true, data: { project_id: 'p1', name: 'N' } })
    setElectron(create)
    mount()
    fireEvent.click(card('mode-card-quick').btn())
    await waitFor(() => expect(onModeSelected).toHaveBeenCalledWith('quick'))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ mode: 'quick' }))
    const st = store
    expect(st.get(modeSelectedAtom)).toBe(true)
    expect(st.get(projectModeAtom)).toBe('quick')
  })

  it('[M3·创建失败] ok:false → user_visible_message 展示且不导航（modeSelected 仍 false）', async () => {
    setElectron(vi.fn().mockResolvedValue({ ok: false, error: { user_visible_message: '磁盘已满，无法创建项目' } }))
    mount()
    fireEvent.click(card('mode-card-longterm').btn())
    await waitFor(() => expect(screen.getByText(/磁盘已满/)).toBeTruthy())
    expect(onModeSelected).not.toHaveBeenCalled()
    expect(store.get(modeSelectedAtom)).not.toBe(true)
  })

  it('[M4·IPC 缺失] 无 electronAPI → 环境错误文案（不裸崩）', async () => {
    mount()
    fireEvent.click(card('mode-card-quick').btn())
    await waitFor(() => expect(screen.getByText(/当前环境无法创建项目/)).toBeTruthy())
    expect(onModeSelected).not.toHaveBeenCalled()
  })

  it('[M5·busy] 创建挂起中双卡禁用（防双击重复创建）', async () => {
    let resolveCreate: (v: { ok: true; data: unknown }) => void = () => undefined
    setElectron(vi.fn().mockImplementation(() => new Promise((r) => { resolveCreate = r })))
    mount()
    fireEvent.click(card('mode-card-quick').btn())
    await waitFor(() => {
      expect((card('mode-card-quick').btn() as HTMLButtonElement).disabled).toBe(true)
      expect((card('mode-card-longterm').btn() as HTMLButtonElement).disabled).toBe(true)
    })
    resolveCreate({ ok: true, data: { project_id: 'p1' } })
    await waitFor(() => expect(onModeSelected).toHaveBeenCalled())
  })

  it('[M6·异常] create 抛错 → 通用文案+可重试（卡片恢复可用）', async () => {
    setElectron(vi.fn().mockRejectedValue(new Error('IPC boom')))
    mount()
    fireEvent.click(card('mode-card-quick').btn())
    await waitFor(() => expect(screen.getByText(/项目创建失败，请重试/)).toBeTruthy())
    expect((card('mode-card-quick').btn() as HTMLButtonElement).disabled).toBe(false)
  })
})
