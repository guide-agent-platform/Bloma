// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { act, cleanup, fireEvent, render, screen, waitFor, configure } from '@testing-library/react'

configure({ testIdAttribute: 'data-ai-id' })
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
    fireEvent.click(screen.getByTestId('mode-card-quick'))
    fireEvent.click(document.querySelector('[data-ai-id="create-project-button"]')!)

    await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy())
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ mode: 'quick' }))
    expect(screen.getByText('快速型')).toBeTruthy()
    expect(screen.getByTestId('chat-panel')).toBeTruthy()
    expect(screen.getByRole('button', { name: '版本' })).toBeTruthy()
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
    fireEvent.click(screen.getByTestId('mode-card-longterm'))
    fireEvent.click(document.querySelector('[data-ai-id="create-project-button"]')!)

    await waitFor(() => expect(screen.getByRole('button', { name: '文档' })).toBeTruthy())
    expect(screen.getByText('长期型')).toBeTruthy()
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
    fireEvent.click(screen.getByTestId('mode-card-quick'))
    fireEvent.click(document.querySelector('[data-ai-id="create-project-button"]')!)

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
    expect(screen.getByText('长期型')).toBeTruthy()
  })

  it('[S1-UI-007] 两道门应使用生活化文案且不要求技术栈配置', () => {
    render(<Provider><ModeSelectionPage onModeSelected={vi.fn()} /></Provider>)

    expect(screen.getByRole('button', { name: '快速型' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '长期型' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '你的软件想法' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '长期型' }))
    expect(screen.getByText(/关键节点一起确认/)).toBeTruthy()
    expect(screen.queryByText(/React|Vue|数据库|技术栈|API/)).toBeNull()
  })

  it('[S1-UI-023] 快消卡引导文案「转为长期维护」无「升级」付费歧义（QW#2 走查 P3-⑤）', () => {
    render(<Provider><ModeSelectionPage onModeSelected={vi.fn()} /></Provider>)

    expect(screen.getByText('以后也能转为长期维护')).toBeTruthy()
    // 「升级」在模式选择语境有付费暗示（评审 ux-qw2-welcome-review P3-⑤），此页不再出现
    expect(screen.queryByText(/升级为长期维护/)).toBeNull()
  })

  it('[S1-UI-012] 默认推荐快速型，选择长期型不会提前创建项目', () => {
    const create = vi.fn()
    const onModeSelected = vi.fn()
    window.electronAPI = { project: { create } } as unknown as ElectronAPI
    render(<Provider><ModeSelectionPage onModeSelected={onModeSelected} /></Provider>)
    expect(screen.getByRole('button', { name: '快速型' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '长期型' }))
    expect(screen.getByRole('button', { name: '长期型' }).getAttribute('aria-pressed')).toBe('true')
    expect(create).not.toHaveBeenCalled()
    expect(onModeSelected).not.toHaveBeenCalled()
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
    fireEvent.click(screen.getByTestId('mode-card-quick'))
    fireEvent.click(document.querySelector('[data-ai-id="create-project-button"]')!)

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

  it('[S1-UI-018b] channelsLoadingAtom=loading（拉取中）同样不渲染徽标——防「AI 就绪」闪变误导（吸收 ux-r102 H1，2026-10-03 删留执行）', () => {
    const store = createStore()
    store.set(currentProjectAtom, project('quick'))
    store.set(projectModeAtom, 'quick')
    store.set(channelsLoadingAtom, 'loading')

    render(<Provider store={store}><WorkspaceHeader /></Provider>)
    expect(screen.queryByText('AI 就绪')).toBeNull()
    expect(screen.queryByText('未配置 AI')).toBeNull()
    expect(screen.queryByText('已连接')).toBeNull()
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
    fireEvent.click(screen.getByTestId('mode-card-quick'))
    fireEvent.click(document.querySelector('[data-ai-id="create-project-button"]')!)
    await waitFor(() => expect(screen.getByRole('textbox', { name: '消息输入' })).toBeTruthy())

    const input = screen.getByRole('textbox', { name: '消息输入' })
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

  it('[S1-UI-020] 零渠道时输入提示和连接状态可见，设置入口直达渠道页', async () => {
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
    fireEvent.click(screen.getByTestId('mode-card-quick'))
    fireEvent.click(document.querySelector('[data-ai-id="create-project-button"]')!)

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/还没有连接 AI 模型/)).toBeTruthy()
    })
    // Current studio uses the input hint and persistent status instead of replaying internal welcome records.
    const goBtn = screen.getByRole('button', { name: '设置（模型渠道）' })
    expect(screen.getByText('未配置 AI')).toBeTruthy()
    expect(screen.queryByText(/2 分钟搞定/)).toBeNull()
    // 点击直达按钮 → 切到设置页（模型渠道 Tab）
    fireEvent.click(goBtn)
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '模型渠道' })).toBeTruthy()
    })
  })

  it('[S1-UI-022] 配置渠道后状态变为 AI 就绪，撤下未连接输入提示', async () => {
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
    fireEvent.click(screen.getByTestId('mode-card-quick'))
    fireEvent.click(document.querySelector('[data-ai-id="create-project-button"]')!)
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/还没有连接 AI 模型/)).toBeTruthy()
    })
    // 用户在设置页连好渠道 → 渠道列表原子更新（false → true 转换）
    act(() => {
      store.set(channelsListAtom, [
        { id: 'c1', name: 'x', provider_type: 'anthropic', base_url: 'u', api_key: 'k', enabled: true, models: [{ id: 'm1', name: 'm', enabled: true }] },
      ])
    })
    await waitFor(() => {
      expect(screen.getByText('AI 就绪')).toBeTruthy()
    })
    expect(screen.queryByPlaceholderText(/还没有连接 AI 模型/)).toBeNull()
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
    fireEvent.click(screen.getByTestId('mode-card-quick'))
    fireEvent.click(document.querySelector('[data-ai-id="create-project-button"]')!)

    await waitFor(() => expect(screen.getByRole('textbox', { name: '消息输入' })).toBeTruthy())
    expect(screen.queryByText(/还没连接 AI 模型/)).toBeNull()
  })

  it('[S1-UI-028] 零渠道时输入框 placeholder 显示连接引导而非默认文案（WC-P2）', async () => {
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
    fireEvent.click(screen.getByTestId('mode-card-quick'))
    fireEvent.click(document.querySelector('[data-ai-id="create-project-button"]')!)

    // 零渠道已决后：placeholder 从「描述你的想法…」切换为连接引导语
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/还没有连接 AI 模型/)).toBeTruthy()
    })
    // 引导语给动作指引（去哪连）而不只是陈述问题
    expect(screen.getByPlaceholderText(/设置页/)).toBeTruthy()
    expect(screen.queryByPlaceholderText('描述你的想法…')).toBeNull()
  })

  it('[S1-UI-029] 零渠道时提交首条消息 → 不发送（无 user 气泡），直达设置页，返回后草稿保留（WC-P2）', async () => {
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
    fireEvent.click(screen.getByTestId('mode-card-quick'))
    fireEvent.click(document.querySelector('[data-ai-id="create-project-button"]')!)

    const input = await waitFor(() => screen.getByPlaceholderText(/还没有连接 AI 模型/))
    fireEvent.change(input, { target: { value: '帮我做一个待办应用' } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))

    // ① 直达设置页（不裸报错、不发起无渠道 run）
    await waitFor(() => {
      expect(screen.getByText('模型渠道')).toBeTruthy()
    })
    // ② 消息未发送：消息流中没有 user 气泡（textarea value 不进 text content）
    expect(screen.queryByText('帮我做一个待办应用')).toBeNull()
    // ③ 返回工作区：草稿保留，连好渠道回来即可直接发送
    fireEvent.click(screen.getByRole('button', { name: '返回工作区' }))
    await waitFor(() => {
      const back = screen.getByPlaceholderText(/还没有连接 AI 模型/) as HTMLTextAreaElement
      expect(back.value).toBe('帮我做一个待办应用')
    })
  })

  it('[S1-UI-034] 新建第二个项目时上一项目草稿不串台（跨项目重置，WC-P2 审查加固）', async () => {
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
    fireEvent.click(screen.getByTestId('mode-card-quick'))
    fireEvent.click(document.querySelector('[data-ai-id="create-project-button"]')!)

    // 第一个项目里写下草稿（未发送）
    const input = await waitFor(() => screen.getByPlaceholderText(/还没有连接 AI 模型/)) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '第一个项目的想法' } })

    // workspace → 所有项目 → 新项目 → 模式选择 → 新 workspace
    fireEvent.click(screen.getByTestId('all-projects-button'))
    await waitFor(() => expect(screen.getByTestId('new-project-button')).toBeTruthy())
    fireEvent.click(screen.getByTestId('new-project-button'))
    fireEvent.click(await waitFor(() => screen.getByTestId('mode-card-quick')))
    fireEvent.click(document.querySelector('[data-ai-id="create-project-button"]')!)

    // 新项目 workspace：草稿应为空（上一项目未发送草稿不串台）
    const fresh = await waitFor(() => screen.getByPlaceholderText(/还没有连接 AI 模型/)) as HTMLTextAreaElement
    expect(fresh.value).toBe('')
  })
})

describe('模式卡 a11y（mode-card-a11y，r63 方向 B）', () => {
  afterEach(() => {
    cleanup()
  })

  it('[S1-UI-024] B 档结构：卡为 group 可达名「title（模式名）」+「开始」为真按钮（h2 不嵌 button）', () => {
    render(<Provider store={createStore()}><ModeSelectionPage onModeSelected={vi.fn()} /></Provider>)

    // 卡=group（可达名收口，非整卡 74 字巨型按钮）
    const quick = screen.getByRole('group', { name: '快速做一个试试（快速尝鲜）' })
    expect(quick).toBeTruthy()
    // 「开始」是真按钮且可达名收口
    const start = screen.getByRole('button', { name: '开始：快速做一个试试' })
    expect(start).toBeTruthy()
    // h2 不再嵌 button（A 档已知边界，B 根治）
    expect(quick.querySelector('button')?.tagName).toBe('BUTTON')
    expect(quick.contains(start)).toBe(false)
  })

  it('[S1-UI-025] 只有明确点开始才创建；选择模式不提前创建', async () => {
    const onSelect = vi.fn()
    window.electronAPI = {
      project: { create: vi.fn().mockResolvedValue({ ok: true, request_id: 't', data: { project_id: 'p-b' } }) },
    } as unknown as ElectronAPI
    render(<Provider store={createStore()}><ModeSelectionPage onModeSelected={onSelect} /></Provider>)

    const start = screen.getByRole('button', { name: '开始：快速做一个试试' })
    fireEvent.click(start)
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: '长期型' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '开始：认真打磨一个产品' }))
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(2))
  })

  it('[S1-UI-026] 键盘激活：开始为原生 button（可 focus，Enter 激活由平台契约保证）', () => {
    const onSelect = vi.fn()
    render(<Provider store={createStore()}><ModeSelectionPage onModeSelected={onSelect} /></Provider>)

    const start = screen.getByRole('button', { name: '开始：快速做一个试试' })
    start.focus()
    expect(document.activeElement).toBe(start)
    // 原生 button 标签即键盘激活契约（jsdom 不合成 Enter→click，标签断言锁定）
    expect(start.tagName).toBe('BUTTON')
  })
})

describe('模式选择页异常路径（吸收 ux-r105 M4-M6，2026-10-03 删留执行：M1-M3 已由 S1-PROJECT-006/S1-UI-008/S1-UI-012/S1-UI-024 覆盖）', () => {
  // 自密闭：前序 describe（模式卡 a11y S1-UI-025）会泄漏 window.electronAPI，M4 的「无
  // electronAPI」前置必须自己归零，不依赖上游清理纪律。
  beforeEach(() => {
    delete window.electronAPI
    delete window.__jotai_store__
  })
  afterEach(() => {
    cleanup()
    delete window.electronAPI
    delete window.__jotai_store__
    vi.restoreAllMocks()
  })

  function mount(onModeSelected: ReturnType<typeof vi.fn>) {
    const store = createStore()
    window.__jotai_store__ = store
    return {
      store,
      ...render(
        <Provider store={store}>
          <ModeSelectionPage onModeSelected={onModeSelected} onBackToHistory={vi.fn()} />
        </Provider>,
      ),
    }
  }

  function cardButton(aiId: string): HTMLButtonElement {
    return document.querySelector(`[data-ai-id="${aiId}"] button`) as HTMLButtonElement
  }

  const setElectron = (createImpl?: unknown) => {
    window.electronAPI = { project: { create: createImpl } } as unknown as ElectronAPI
  }

  it('[S1-UI-035] 无 electronAPI → 环境错误文案不裸崩、不导航（原 ux-r105 M4）', async () => {
    const onModeSelected = vi.fn()
    mount(onModeSelected)
    fireEvent.click(cardButton('mode-card-quick'))
    fireEvent.click(document.querySelector('[data-ai-id="create-project-button"]')!)
    await waitFor(() => expect(screen.getByText(/当前环境无法创建项目/)).toBeTruthy())
    expect(onModeSelected).not.toHaveBeenCalled()
  })

  it('[S1-UI-036] 创建挂起中双卡禁用（防双击重复创建），成功后恢复并导航（原 ux-r105 M5）', async () => {
    const onModeSelected = vi.fn()
    let resolveCreate: (v: { ok: true; data: unknown }) => void = () => undefined
    setElectron(vi.fn().mockImplementation(() => new Promise((r) => { resolveCreate = r })))
    mount(onModeSelected)
    fireEvent.click(cardButton('mode-card-quick'))
    fireEvent.click(document.querySelector('[data-ai-id="create-project-button"]')!)
    await waitFor(() => {
      expect((cardButton('mode-card-quick') as HTMLButtonElement).disabled).toBe(true)
      expect((cardButton('mode-card-longterm') as HTMLButtonElement).disabled).toBe(true)
    })
    resolveCreate({ ok: true, data: { project_id: 'p1' } })
    await waitFor(() => expect(onModeSelected).toHaveBeenCalled())
  })

  it('[S1-UI-037] create 抛错 → 通用文案+卡片恢复可用可重试（原 ux-r105 M6）', async () => {
    const onModeSelected = vi.fn()
    setElectron(vi.fn().mockRejectedValue(new Error('IPC boom')))
    mount(onModeSelected)
    fireEvent.click(cardButton('mode-card-quick'))
    fireEvent.click(document.querySelector('[data-ai-id="create-project-button"]')!)
    await waitFor(() => expect(screen.getByText(/项目创建失败，请重试/)).toBeTruthy())
    expect((cardButton('mode-card-quick') as HTMLButtonElement).disabled).toBe(false)
  })
})
