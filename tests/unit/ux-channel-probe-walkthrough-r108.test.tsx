// @vitest-environment jsdom
// ux-channel-probe-walkthrough r108（B 腿可执行走查，SOP 五用）：渠道表单「测试连接/拉取模型」双探针。
// 状态矩阵：idle 双按钮 / canProbe=false 禁用（create 无 baseUrl）/ busy 标签换（测试中…）/
// 测试成功绿框 / 测试失败红框（testMsg.ok=false）/ 拉取失败 **现状锁定绿框（F1 翻转位——修后应变红）** / 拉取成功去重合并。
// 发现 F1：fetchMsg 无 ok 标志，色逻辑 (testMsg && !testMsg.ok)?red:green 在仅 fetchMsg 时恒绿——失败也绿。

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelSettingsPage } from '../../renderer/components/ChannelSettingsPage'

type Ctx = { electronAPI: unknown; channels: { testDirect: unknown; fetchModels: unknown } }

describe('ux-channel-probe-walkthrough r108：测试连接/拉取模型双探针（0 基础用户「我的 key 好了吗」）', () => {
  beforeEach(() => {
    if (!(window as never as { crypto?: { randomUUID?: unknown } }).crypto?.randomUUID) {
      Object.defineProperty(window, 'crypto', { value: { randomUUID: () => 'u-' + Math.random() } })
    }
  })
  afterEach(() => {
    delete (window as never as { electronAPI?: unknown }).electronAPI
    cleanup()
  })

  function mountChannel(initialOn?: () => void): void {
    initialOn?.()
    render(<ChannelSettingsPage />)
  }
  /** 直达「新建渠道」表单（页面级入口如无渠道空态/添加按钮） */
  async function openCreateForm(): Promise<void> {
    const add = await screen.findByRole('button', { name: /添加|新增|新建|配置/ })
    fireEvent.click(add)
  }
  function fillForm(baseUrl: string, key: string): void {
    fireEvent.change(screen.getByPlaceholderText(/留空使用|服务地址/), { target: { value: baseUrl } })
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: key } })
  }

  it('[C1·idle] 表单出现「测试连接」「拉取模型」双按钮', async () => {
    mountChannel()
    await openCreateForm()
    expect(await screen.findByRole('button', { name: /测试连接/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /拉取模型/ })).toBeTruthy()
  })

  it('[C2·禁用] create 模式无 baseUrl → 双按钮禁用（canProbe=false）', async () => {
    mountChannel()
    await openCreateForm()
    const test = await screen.findByRole('button', { name: /测试连接|测试中/ })
    expect((test as HTMLButtonElement).disabled).toBe(true)
  })

  it('[C3·busy] 测试挂起中 → 标签「测试中…」+ IPC 只发一次可见反馈', async () => {
    let resolveIt: (v: { ok: true; data: { ok: true; message: string } }) => void = () => undefined
    ;(window as never as Ctx).electronAPI = {
      channels: { testDirect: vi.fn().mockImplementation(() => new Promise((r) => { resolveIt = r })), fetchModels: vi.fn() },
    }
    mountChannel()
    await openCreateForm()
    fillForm('https://api.example.com', 'sk-x')
    fireEvent.click(screen.getByRole('button', { name: /测试连接/ }))
    expect(await screen.findByRole('button', { name: /测试中…/ })).toBeTruthy()
    resolveIt({ ok: true, data: { ok: true, message: '连接成功' } })
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
  })

  it('[C4·测试失败] data.ok=false → 红框（rgb 153,27,27 色）含通道级 message', async () => {
    ;(window as never as Ctx).electronAPI = {
      channels: { testDirect: vi.fn().mockResolvedValue({ ok: true, data: { ok: false, message: '密钥无效（401）' } }), fetchModels: vi.fn() },
    }
    mountChannel()
    await openCreateForm()
    fillForm('https://api.example.com', 'sk-bad')
    fireEvent.click(screen.getByRole('button', { name: /测试连接/ }))
    const st = await screen.findByRole('status')
    expect(st.textContent).toContain('密钥无效（401）')
    expect(st.style.color).toBe('rgb(153, 27, 27)')
  })

  it('[C5·拉取失败·F1 已修] fetch 失败 → 文案含「拉取失败」且框为红（F1 翻转完成，r73）', async () => {
    ;(window as never as Ctx).electronAPI = {
      channels: { testDirect: vi.fn(), fetchModels: vi.fn().mockResolvedValue({ ok: false, error: { user_visible_message: '拉取失败：网络不通' } }) },
    }
    mountChannel()
    await openCreateForm()
    fillForm('https://api.example.com', 'sk-x')
    fireEvent.click(screen.getByRole('button', { name: /拉取模型/ }))
    const st = await screen.findByRole('status')
    expect(st.textContent).toContain('拉取失败：网络不通')
    expect(st.style.color).toBe('rgb(153, 27, 27)') // F1 修复：失败红框（原缺陷：失败也绿）
  })

  it('[C6·拉取成功去重] 已有 a,b 拉回 a,c → 模型文本合并为 a,b,c', async () => {
    ;(window as never as Ctx).electronAPI = {
      channels: { testDirect: vi.fn(), fetchModels: vi.fn().mockResolvedValue({ ok: true, data: { models: [{ name: 'a' }, { name: 'c' }] } }) },
    }
    mountChannel()
    await openCreateForm()
    fillForm('https://api.example.com', 'sk-x')
    const modelsInput = screen.getByPlaceholderText(/deepseek-chat/)
    fireEvent.change(modelsInput, { target: { value: 'a, b' } })
    fireEvent.click(screen.getByRole('button', { name: /拉取模型/ }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('成功获取 2 个模型'))
    expect((screen.getByPlaceholderText(/deepseek-chat/) as HTMLInputElement).value).toBe('a, b, c')
  })
})
