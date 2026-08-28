// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../../renderer/components/App'
import { ModeSelectionPage } from '../../../renderer/components/ModeSelectionPage'
import { WorkspaceHeader } from '../../../renderer/components/WorkspaceHeader'
import {
  currentProjectAtom,
  projectModeAtom,
  stageIndicatorLabelAtom,
  workflowStageAtom,
  networkOnlineAtom,
} from '../../../renderer/components/atoms'
import {
  channelsListAtom,
  channelsLoadingAtom,
  refreshChannelsList,
  resetChannelsFetchFlagForTests,
} from '../../../renderer/components/atoms-sprint2'
import type { Channel, ElectronAPI, Project } from '../../../shared/types'

describe('Sprint 1 project mode and workspace acceptance', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    cleanup()
    delete window.electronAPI
    delete window.__jotai_store__
    vi.restoreAllMocks()
    resetChannelsFetchFlagForTests()
  })

  it('[S1-PROJECT-006] 选择快速尝鲜应创建 quick 项目并进入统一工作区', async () => {
    const store = createStore()
    const create = vi.fn().mockResolvedValue({
      ok: true,
      request_id: 'role-c-quick',
      data: project('quick'),
    })
    window.__jotai_store__ = store
    window.electronAPI = { project: { create } } as unknown as ElectronAPI

    render(<Provider store={store}><App /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: /快速尝鲜/ }))

    await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy())
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ mode: 'quick' }))
    expect(screen.getByText('快速尝鲜')).toBeTruthy()
    expect(screen.getByText('对话')).toBeTruthy()
    expect(screen.getByText('时间轴')).toBeTruthy()
    expect(screen.getByText('这里将展示你的软件预览')).toBeTruthy()
  })

  it('[S1-PROJECT-007] 选择精细打磨应创建 longterm 项目并显示文档入口', async () => {
    const store = createStore()
    window.__jotai_store__ = store
    window.electronAPI = {
      project: {
        create: vi.fn().mockResolvedValue({
          ok: true,
          request_id: 'role-c-longterm',
          data: project('longterm'),
        }),
      },
    } as unknown as ElectronAPI

    render(<Provider store={store}><App /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: /精细打磨/ }))

    await waitFor(() => expect(screen.getByRole('button', { name: '文档' })).toBeTruthy())
    expect(screen.getByText('精细打磨')).toBeTruthy()
  })

  it('[S1-PROJECT-008] 进入工作区后不得返回两道门且应提供所有项目入口', async () => {
    const store = createStore()
    window.__jotai_store__ = store
    window.electronAPI = {
      project: {
        create: vi.fn().mockResolvedValue({
          ok: true,
          request_id: 'role-c-locked',
          data: project('quick'),
        }),
      },
    } as unknown as ElectronAPI

    render(<Provider store={store}><App /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: /快速尝鲜/ }))

    await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy())
    expect(screen.queryByText('你想做什么样的软件？')).toBeNull()
    expect(screen.queryByRole('button', { name: /返回.*模式|重新选择/ })).toBeNull()
    expect(screen.getByRole('button', { name: '所有项目' })).toBeTruthy()
  })

  it('[S1-PROJECT-010] 长期迭代型工作区不得显示降级为快消型入口', () => {
    const store = createStore()
    store.set(currentProjectAtom, project('longterm'))
    store.set(projectModeAtom, 'longterm')
    store.set(workflowStageAtom, 'clarifying')
    store.set(stageIndicatorLabelAtom, '正在了解你的需求')

    render(<Provider store={store}><WorkspaceHeader /></Provider>)

    expect(screen.queryByRole('button', { name: /降级|快消/ })).toBeNull()
    expect(screen.getByText('精细打磨')).toBeTruthy()
  })

  it('[S1-UI-007] 两道门应使用生活化文案且不要求技术栈配置', () => {
    render(<Provider><ModeSelectionPage onModeSelected={vi.fn()} /></Provider>)

    expect(screen.getByText('快速做一个试试')).toBeTruthy()
    expect(screen.getByText('认真打磨一个产品')).toBeTruthy()
    expect(screen.getByText(/一次性小工具/)).toBeTruthy()
    expect(screen.getByText(/持续改进/)).toBeTruthy()
    expect(screen.queryByText(/React|Vue|数据库|技术栈|API/)).toBeNull()
  })

  it('[S1-UI-023] 快消卡引导文案「转为长期维护」无「升级」付费歧义（QW#2 走查 P3-⑤）', () => {
    render(<Provider><ModeSelectionPage onModeSelected={vi.fn()} /></Provider>)

    expect(screen.getByText('以后也能转为长期维护')).toBeTruthy()
    // 「升级」在模式选择语境有付费暗示（评审 ux-qw2-welcome-review P3-⑤），此页不再出现
    expect(screen.queryByText(/升级为长期维护/)).toBeNull()
  })

  it('[S1-UI-012] 快速尝鲜卡显示「新手推荐」角标（QW#4，ux-r2 I3 默认推荐）', () => {
    render(<Provider><ModeSelectionPage onModeSelected={vi.fn()} /></Provider>)
    expect(screen.getByText('新手推荐')).toBeTruthy()
  })

  it('[S1-UI-009] 零渠道时头部徽标显示「未配置 AI」而非「已连接」（QW#1，ux-r2 I1）', () => {
    const store = createStore()
    store.set(currentProjectAtom, project('quick'))
    store.set(projectModeAtom, 'quick')
    store.set(channelsLoadingAtom, 'loaded')
    store.set(channelsListAtom, [])

    render(<Provider store={store}><WorkspaceHeader /></Provider>)

    expect(screen.getByText('未配置 AI')).toBeTruthy()
    expect(screen.queryByText('已连接')).toBeNull()
    expect(screen.queryByText('AI 就绪')).toBeNull()
  })

  it('[S1-UI-010] 有可用渠道时显示「AI 就绪」而非「已连接」黑话（QW#1）', () => {
    const usableChannel: Channel = {
      id: 'c1',
      name: '测试渠道',
      provider_type: 'anthropic',
      base_url: 'https://example.com',
      api_key: 'enc',
      enabled: true,
      models: [{ id: 'm1', name: 'deepseek-v4-flash', enabled: true }],
    }
    const store = createStore()
    store.set(currentProjectAtom, project('quick'))
    store.set(projectModeAtom, 'quick')
    store.set(channelsLoadingAtom, 'loaded')
    store.set(channelsListAtom, [usableChannel])

    render(<Provider store={store}><WorkspaceHeader /></Provider>)
    expect(screen.getByText('AI 就绪')).toBeTruthy()
    expect(screen.queryByText('已连接')).toBeNull()
    expect(screen.queryByText('未配置 AI')).toBeNull()
  })

  it('[S1-UI-011] 禁用渠道 / 无启用模型 → 视为未配置 AI（QW#1）', () => {
    const store = createStore()
    store.set(currentProjectAtom, project('quick'))
    store.set(projectModeAtom, 'quick')
    store.set(channelsLoadingAtom, 'loaded')
    store.set(channelsListAtom, [
      {
        id: 'c1',
        name: '禁用渠道',
        provider_type: 'anthropic',
        base_url: 'https://example.com',
        api_key: 'enc',
        enabled: false,
        models: [{ id: 'm1', name: 'm', enabled: true }],
      },
      {
        id: 'c2',
        name: '无启用模型',
        provider_type: 'anthropic',
        base_url: 'https://example.com',
        api_key: 'enc',
        enabled: true,
        models: [{ id: 'm2', name: 'm2', enabled: false }],
      },
    ])

    render(<Provider store={store}><WorkspaceHeader /></Provider>)
    expect(screen.getByText('未配置 AI')).toBeTruthy()
    expect(screen.queryByText('AI 就绪')).toBeNull()
  })

  it('[S1-UI-014] 有渠道但网络离线 → 显示「离线」（QW#1 三态补齐）', () => {
    const store = createStore()
    store.set(currentProjectAtom, project('quick'))
    store.set(projectModeAtom, 'quick')
    store.set(channelsLoadingAtom, 'loaded')
    store.set(channelsListAtom, [
      {
        id: 'c1',
        name: '测试渠道',
        provider_type: 'anthropic',
        base_url: 'https://example.com',
        api_key: 'enc',
        enabled: true,
        models: [{ id: 'm1', name: 'm1', enabled: true }],
      },
    ])
    store.set(networkOnlineAtom, false)

    render(<Provider store={store}><WorkspaceHeader /></Provider>)
    expect(screen.getByText('离线')).toBeTruthy()
    expect(screen.queryByText('AI 就绪')).toBeNull()
    expect(screen.queryByText('已连接')).toBeNull()
  })

  it('[S1-UI-008] 项目创建失败时只展示 P0 可读文案且不进入工作区', async () => {
    const onModeSelected = vi.fn()
    window.electronAPI = {
      project: {
        create: vi.fn().mockResolvedValue({
          ok: false,
          request_id: 'role-c-create-error',
          error: {
            code: 'LOCAL_STORE_WRITE_FAILED',
            message: 'Error: ENOSPC at writeJsonFile (C:\\secret\\projects.json)',
            user_visible_message: '本地保存失败，请检查磁盘空间后再试。',
            retryable: true,
          },
        }),
      },
    } as unknown as ElectronAPI

    render(<Provider><ModeSelectionPage onModeSelected={onModeSelected} /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: /快速尝鲜/ }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('本地保存失败，请检查磁盘空间后再试。')
    expect(alert.textContent).not.toMatch(/ENOSPC|writeJsonFile|C:\\/)
    expect(onModeSelected).not.toHaveBeenCalled()
  })
})

function project(mode: Project['mode']): Project {
  return {
    project_id: `role-c-${mode}`,
    workspace_slug: 'default-software-builder',
    name: mode === 'quick' ? '快速验收项目' : '长期验收项目',
    mode,
    template_type: 'web_fullstack',
    status: 'active',
    current_stage: 'clarifying',
    root_path: `C:/role-c/${mode}`,
    created_at: '2026-07-25T00:00:00.000Z',
    updated_at: '2026-07-25T00:00:00.000Z',
  }
}

describe('refreshChannelsList（QW#1 启动加载）', () => {
  afterEach(() => {
    delete window.electronAPI
    vi.restoreAllMocks()
    resetChannelsFetchFlagForTests()
  })

  it('[S1-UI-015] 调用 channels.list 并写入 channelsListAtom / channelsLoadingAtom', async () => {
    const list = vi.fn().mockResolvedValue({
      ok: true,
      request_id: 't',
      data: [{ id: 'c1', name: 'x', provider_type: 'anthropic', base_url: 'u', api_key: 'k', enabled: true, models: [] }],
    })
    window.electronAPI = { channels: { list } } as unknown as ElectronAPI

    const setChannels = vi.fn()
    const setLoading = vi.fn()
    await refreshChannelsList(setChannels, setLoading)

    expect(list).toHaveBeenCalledTimes(1)
    expect(setLoading).toHaveBeenCalledWith('loading')
    expect(setChannels).toHaveBeenCalledWith([expect.objectContaining({ id: 'c1' })])
    expect(setLoading).toHaveBeenCalledWith('loaded')
  })

  it('[S1-UI-016] list 失败 → setLoading error（徽标回退加载中态不闪变）', async () => {
    window.electronAPI = {
      channels: { list: vi.fn().mockResolvedValue({ ok: false, request_id: 't', error: { code: 'X', message: 'x' } }) },
    } as unknown as ElectronAPI

    const setChannels = vi.fn()
    const setLoading = vi.fn()
    await refreshChannelsList(setChannels, setLoading)

    expect(setLoading).toHaveBeenCalledWith('error')
    expect(setChannels).not.toHaveBeenCalled()
  })
})

describe('WorkspaceHeader 徽标 null 态（QW#1 审查 P1-①）', () => {
  afterEach(() => {
    cleanup()
  })

  it('[S1-UI-017] channelsLoadingAtom=idle（未加载）时渲染 Header 不显示「AI 就绪」/「未配置 AI」', () => {
    const store = createStore()
    store.set(currentProjectAtom, project('quick'))
    store.set(projectModeAtom, 'quick')
    // 不 set loading：默认 'idle'

    render(<Provider store={store}><WorkspaceHeader /></Provider>)
    expect(screen.queryByText('AI 就绪')).toBeNull()
    expect(screen.queryByText('未配置 AI')).toBeNull()
    expect(screen.queryByText('已连接')).toBeNull()
  })

  it('[S1-UI-018] channelsLoadingAtom=error 时同样不显示徽标（避免永久「AI 就绪」误导）', () => {
    const store = createStore()
    store.set(currentProjectAtom, project('quick'))
    store.set(projectModeAtom, 'quick')
    store.set(channelsLoadingAtom, 'error')

    render(<Provider store={store}><WorkspaceHeader /></Provider>)
    expect(screen.queryByText('AI 就绪')).toBeNull()
    expect(screen.queryByText('未配置 AI')).toBeNull()
  })
})

describe('消息排队提示（message-queue S4-QUEUE-009）', () => {
  afterEach(() => {
    cleanup()
    delete window.electronAPI
    delete window.__jotai_store__
    vi.restoreAllMocks()
    resetChannelsFetchFlagForTests()
  })

  it('[S1-UI-019] 生成期间发送 → 后端返回 queued → 追加「已排队」系统提示', async () => {
    const store = createStore()
    window.__jotai_store__ = store
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      request_id: 't',
      data: { accepted: true, session_id: 's', stream_started: false, queued: true },
    })
    window.electronAPI = {
      project: {
        create: vi.fn().mockResolvedValue({ ok: true, request_id: 't', data: project('quick') }),
        list: vi.fn().mockResolvedValue({ ok: true, request_id: 't', data: [] }),
      },
      agent: { sendMessage },
    } as unknown as ElectronAPI

    render(<Provider store={store}><App /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: /快速做一个试试/ }))
    await waitFor(() => expect(screen.getByPlaceholderText('描述你的想法…')).toBeTruthy())

    const input = screen.getByPlaceholderText('描述你的想法…')
    fireEvent.change(input, { target: { value: '把按钮改成蓝色' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect(screen.getByText(/已排队/)).toBeTruthy()
    })
  })
})

describe('零渠道欢迎引导（QW#2 ux-r2 I2）', () => {
  // 修 S1-UI-020 存量崩溃（2026-08-28）：该 describe 一直缺 scrollIntoView mock——
  // 引导消息追加触发 ChatPanel 滚动 effect，jsdom 无 scrollIntoView → 整树卸载 body 空 div。
  // 其他 describe 的 beforeEach 均有此 mock，仅本块漏配（FAIL_TEST，非产品缺陷）。
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => {
    cleanup()
    delete window.electronAPI
    delete window.__jotai_store__
    vi.restoreAllMocks()
    resetChannelsFetchFlagForTests()
  })

  it('[S1-UI-020] 进入工作区且零渠道 → 自动追加「还没连接 AI 模型」引导提示', async () => {
    const store = createStore()
    window.__jotai_store__ = store
    window.electronAPI = {
      project: {
        create: vi.fn().mockResolvedValue({ ok: true, request_id: 't', data: project('quick') }),
        list: vi.fn().mockResolvedValue({ ok: true, request_id: 't', data: [] }),
      },
      channels: {
        list: vi.fn().mockResolvedValue({ ok: true, request_id: 't', data: [] }),
      },
    } as unknown as ElectronAPI

    render(<Provider store={store}><App /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: /快速做一个试试/ }))

    await waitFor(() => {
      expect(screen.getByText(/还没连接 AI 模型/)).toBeTruthy()
    })
    // QW#2 二期 P1-②（2026-08-28）：引导卡片内嵌「去连接」直达按钮（宁可给按钮不给说明书）
    const goBtn = screen.getByRole('button', { name: /去连接 AI 模型/ })
    // P1-③：文案去黑话——API Key 解释为「门禁卡」+ 首次约 10 分钟（不再承诺 2 分钟）
    expect(screen.getByText(/门禁卡/)).toBeTruthy()
    expect(screen.getByText(/首次约 10 分钟/)).toBeTruthy()
    expect(screen.queryByText(/2 分钟搞定/)).toBeNull()
    // 点击直达按钮 → 切到设置页（模型渠道 Tab）
    fireEvent.click(goBtn)
    await waitFor(() => {
      expect(screen.getByText('模型渠道')).toBeTruthy()
    })
  })

  it('[S1-UI-022] 零渠道引导显示后连接成功 → 追加「✅ 连接成功」正反馈（QW#2 二期 P2-④）', async () => {
    const store = createStore()
    window.__jotai_store__ = store
    window.electronAPI = {
      project: {
        create: vi.fn().mockResolvedValue({ ok: true, request_id: 't', data: project('quick') }),
        list: vi.fn().mockResolvedValue({ ok: true, request_id: 't', data: [] }),
      },
      channels: {
        list: vi.fn().mockResolvedValue({ ok: true, request_id: 't', data: [] }),
      },
    } as unknown as ElectronAPI

    render(<Provider store={store}><App /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: /快速做一个试试/ }))
    await waitFor(() => {
      expect(screen.getByText(/还没连接 AI 模型/)).toBeTruthy()
    })
    // 用户在设置页连好渠道 → 渠道列表原子更新（false → true 转换）
    act(() => {
      store.set(channelsListAtom, [
        { id: 'c1', name: 'x', provider_type: 'anthropic', base_url: 'u', api_key: 'k', enabled: true, models: [{ id: 'm1', name: 'm', enabled: true }] },
      ])
    })
    await waitFor(() => {
      expect(screen.getByText(/连接成功/)).toBeTruthy()
    })
    // 成功卡不带直达按钮（反馈语义，不再指路）；引导卡按钮仍在属正常（两条消息并存）
    const successCard = screen.getByText(/连接成功/).closest('div')
    expect(successCard?.querySelector('button')).toBeNull()
  })

  it('[S1-UI-021] 有可用渠道时进入工作区不显示零渠道引导', async () => {
    const store = createStore()
    window.__jotai_store__ = store
    window.electronAPI = {
      project: {
        create: vi.fn().mockResolvedValue({ ok: true, request_id: 't', data: project('quick') }),
        list: vi.fn().mockResolvedValue({ ok: true, request_id: 't', data: [] }),
      },
      channels: {
        list: vi.fn().mockResolvedValue({
          ok: true,
          request_id: 't',
          data: [{ id: 'c1', name: 'x', provider_type: 'anthropic', base_url: 'u', api_key: 'k', enabled: true, models: [{ id: 'm1', name: 'm', enabled: true }] }],
        }),
      },
    } as unknown as ElectronAPI

    render(<Provider store={store}><App /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: /快速做一个试试/ }))

    await waitFor(() => expect(screen.getByPlaceholderText(/描述你的想法/)).toBeTruthy())
    expect(screen.queryByText(/还没连接 AI 模型/)).toBeNull()
  })
})
