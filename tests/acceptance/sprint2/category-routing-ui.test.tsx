// @vitest-environment jsdom

import React from 'react'
import { configure, cleanup, render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelSettingsPage } from '../../../renderer/components/ChannelSettingsPage'
import type {
  CategoryRoutingRoleListResult,
  CategoryRoutingRoleUpdateEnvelope,
  Channel,
  ElectronAPI,
  RequestEnvelope,
} from '../../../shared/types'

configure({ testIdAttribute: 'data-ai-id' })

const CHANNELS: Channel[] = [
  {
    id: 'ch-kimi',
    name: 'Kimi 渠道',
    provider_type: 'kimi-api',
    base_url: 'https://kimi.example',
    api_key: '***',
    enabled: true,
    models: [{ id: 'm1', name: 'kimi-k2.6', enabled: true }],
  },
  {
    id: 'ch-zhipu-openai',
    name: '智谱 OpenAI 协议',
    provider_type: 'zhipu',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    api_key: '***',
    enabled: true,
    models: [{ id: 'm2', name: 'glm-5', enabled: true }],
  },
]

function makeViews(overrides: Array<Partial<CategoryRoutingRoleListResult['views'][number]>> = []): CategoryRoutingRoleListResult['views'] {
  const base: CategoryRoutingRoleListResult['views'] = [
    { role: 'guide', label: '向导 Agent', description: '澄清需求、提取 PRD 与整理项目记忆', categories: ['guide', 'prd', 'summary'], channel_id: 'ch-kimi', channel_name: 'Kimi 渠道', model_name: 'kimi-k2.6', effective: 'routed' },
    { role: 'programming', label: '编程 Agent', description: '生成草图与完整可运行版本', categories: ['sketch', 'mvp'], channel_name: 'Kimi 渠道', model_name: 'kimi-k2.6', effective: 'auto' },
    { role: 'judge', label: '裁判 Agent', description: '审查需求与交付是否达到要求', categories: ['judge'], channel_name: 'Kimi 渠道', model_name: 'kimi-k2.6', effective: 'auto' },
  ]
  for (const override of overrides) {
    const index = base.findIndex((view) => view.role === override.role)
    if (index >= 0) base[index] = { ...base[index]!, ...override }
  }
  return base
}

function installApi(options: {
  views: CategoryRoutingRoleListResult['views']
  onUpdate?: (input: CategoryRoutingRoleUpdateEnvelope) => CategoryRoutingRoleListResult
}): { updateSpy: ReturnType<typeof vi.fn> } {
  const updateSpy = vi.fn()
  window.electronAPI = {
    channels: {
      list: () => Promise.resolve({ ok: true, request_id: 't', data: CHANNELS }),
      categoryRoutingRoleList: (_input: RequestEnvelope) =>
        Promise.resolve({ ok: true, request_id: 't', data: { version: 2, views: options.views } }),
      categoryRoutingRoleUpdate: (input: CategoryRoutingRoleUpdateEnvelope) => {
        updateSpy(input)
        const data = options.onUpdate ? options.onUpdate(input) : { version: 2, views: options.views }
        return Promise.resolve({ ok: true, request_id: 't', data })
      },
    },
  } as unknown as ElectronAPI
  return { updateSpy }
}

describe('M5 三角色渠道配置区（ChannelSettingsPage）', () => {
  beforeEach(() => vi.restoreAllMocks())

  afterEach(() => {
    cleanup()
    delete window.electronAPI
  })

  it('渲染向导、编程、裁判三行角色 + 渠道下拉（仅 Anthropic 协议渠道可选）', async () => {
    installApi({ views: makeViews() })
    render(<ChannelSettingsPage />)

    await waitFor(() => expect(screen.getByText('角色配置')).toBeDefined())
    for (const label of ['向导 Agent', '编程 Agent', '裁判 Agent']) {
      expect(screen.getByText(label)).toBeDefined()
    }
    expect(screen.queryByText('草图生成')).toBeNull()

    const select = screen.getByLabelText('向导 Agent 渠道') as HTMLSelectElement
    const optionTexts = Array.from(select.options).map((option) => option.textContent ?? '')
    expect(optionTexts.some((text) => text.includes('智谱 OpenAI 协议'))).toBe(false)
    expect(optionTexts.some((text) => text.includes('Kimi 渠道'))).toBe(true)
    expect(select.value).toBe('ch-kimi')
  })

  it('悬空角色显示警示，「恢复自动」后保存不再携带该角色配置', async () => {
    const restored = makeViews([{ role: 'guide', channel_id: undefined, channel_name: 'Kimi 渠道', model_name: 'kimi-k2.6', effective: 'auto' }])
    const { updateSpy } = installApi({
      views: makeViews([{ role: 'guide', channel_id: 'ch-deleted', channel_name: 'Kimi 渠道', model_name: 'kimi-k2.6', effective: 'dangling' }]),
      onUpdate: () => ({ version: 2, views: restored }),
    })
    render(<ChannelSettingsPage />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('指向的渠道已被删除，当前回退全局默认')
    await act(async () => fireEvent.click(screen.getByText('恢复自动')))
    await act(async () => fireEvent.click(screen.getByTestId('role-routing-save')))

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1))
    const payload = updateSpy.mock.calls[0]![0] as CategoryRoutingRoleUpdateEnvelope
    expect(payload.routing.guide).toBeUndefined()
    expect(payload.routing.programming).toBeUndefined()
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('滚轮悬停角色渠道下拉循环切换自动/各渠道', async () => {
    installApi({ views: makeViews() })
    render(<ChannelSettingsPage />)
    await waitFor(() => expect(screen.getByText('角色配置')).toBeDefined())

    const select = screen.getByLabelText('向导 Agent 渠道') as HTMLSelectElement
    expect(select.value).toBe('ch-kimi')
    await act(async () => fireEvent.wheel(select, { deltaY: 120 }))
    expect(select.value).toBe('')
    expect((screen.getByTestId('role-routing-save') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => fireEvent.wheel(select, { deltaY: -120 }))
    expect(select.value).toBe('ch-kimi')
  })

  it('历史类别配置不一致时显示 mixed，选择渠道可统一该角色', async () => {
    const { updateSpy } = installApi({
      views: makeViews([{ role: 'guide', channel_id: undefined, fallback_channel_ids: undefined, effective: 'mixed' }]),
      onUpdate: () => ({ version: 2, views: makeViews() }),
    })
    render(<ChannelSettingsPage />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('沿用了旧的分项配置')
    const select = screen.getByLabelText('向导 Agent 渠道') as HTMLSelectElement
    await act(async () => fireEvent.change(select, { target: { value: 'ch-kimi' } }))
    await act(async () => fireEvent.click(screen.getByTestId('role-routing-save')))

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1))
    expect((updateSpy.mock.calls[0]![0] as CategoryRoutingRoleUpdateEnvelope).routing.guide?.channel_id).toBe('ch-kimi')
  })

  it('「恢复全部默认」提交空角色路由表', async () => {
    const { updateSpy } = installApi({ views: makeViews(), onUpdate: () => ({ version: 2, views: makeViews() }) })
    render(<ChannelSettingsPage />)
    await waitFor(() => expect(screen.getByTestId('role-routing-reset-all')).toBeDefined())
    await act(async () => fireEvent.click(screen.getByTestId('role-routing-reset-all')))
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1))
    expect((updateSpy.mock.calls[0]![0] as CategoryRoutingRoleUpdateEnvelope).routing).toEqual({})
  })
})
