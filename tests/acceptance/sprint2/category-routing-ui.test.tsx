// @vitest-environment jsdom

import React from 'react'
import { configure, cleanup, render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelSettingsPage } from '../../../renderer/components/ChannelSettingsPage'
import { resetChannelsFetchFlagForTests } from '../../../renderer/components/atoms-sprint2'
import type { CategoryRoutingListResult, CategoryRoutingUpdateEnvelope, Channel, ElectronAPI, RequestEnvelope } from '../../../shared/types'

// 项目约定：组件测试锚点用 data-ai-id（与 data-testid 同构查询）
configure({ testIdAttribute: 'data-ai-id' })

/**
 * M5 渲染端验收（§10/§11.4）：ChannelSettingsPage「职责分工」区——
 * - 悬空态（effective === 'dangling'）显示行内警示文案；
 * - 「恢复自动」清除该行 channel_id 后保存 payload 不再含该渠道（effective 变 auto 由
 *   main 返回的视图模型驱动，此处断言保存请求的 routing 内容）。
 */

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

function makeViews(overrides: Array<Partial<CategoryRoutingListResult['views'][number]>> = []): CategoryRoutingListResult['views'] {
  const base: CategoryRoutingListResult['views'] = [
    { category: 'sketch', label: '草图生成', channel_id: 'ch-kimi', channel_name: 'Kimi 渠道', model_name: 'kimi-k2.6', effective: 'routed' },
    { category: 'mvp', label: 'MVP 生成', channel_name: 'Kimi 渠道', model_name: 'kimi-k2.6', effective: 'auto' },
    { category: 'guide', label: '向导澄清 / 意图判定', channel_name: 'Kimi 渠道', model_name: 'kimi-k2.6', effective: 'auto' },
    { category: 'prd', label: 'PRD 提取 / 功能项加厚', channel_name: 'Kimi 渠道', model_name: 'kimi-k2.6', effective: 'auto' },
    { category: 'judge', label: '裁判审查', channel_name: 'Kimi 渠道', model_name: 'kimi-k2.6', effective: 'auto' },
    { category: 'summary', label: 'L3 蒸馏（默认关）', channel_name: 'Kimi 渠道', model_name: 'kimi-k2.6', effective: 'auto' },
  ]
  for (const override of overrides) {
    const index = base.findIndex((view) => view.category === override.category)
    if (index >= 0) base[index] = { ...base[index]!, ...override }
  }
  return base
}

function installApi(options: {
  views: CategoryRoutingListResult['views']
  onUpdate?: (input: CategoryRoutingUpdateEnvelope) => CategoryRoutingListResult
}): { updateSpy: ReturnType<typeof vi.fn> } {
  const updateSpy = vi.fn()
  window.electronAPI = {
    channels: {
      list: () => Promise.resolve({ ok: true, request_id: 't', data: CHANNELS }),
      categoryRoutingList: (_input: RequestEnvelope) =>
        Promise.resolve({ ok: true, request_id: 't', data: { version: 1, views: options.views } }),
      categoryRoutingUpdate: (input: CategoryRoutingUpdateEnvelope) => {
        updateSpy(input)
        const data = options.onUpdate ? options.onUpdate(input) : { version: 1, views: options.views }
        return Promise.resolve({ ok: true, request_id: 't', data })
      },
    },
  } as unknown as ElectronAPI
  return { updateSpy }
}

describe('M5 职责分工区（ChannelSettingsPage）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    cleanup()
    delete window.electronAPI
    resetChannelsFetchFlagForTests()
  })

  it('渲染 6 行职责 + 渠道下拉（仅 Anthropic 协议渠道可选）', async () => {
    installApi({ views: makeViews() })
    render(<ChannelSettingsPage />)

    await waitFor(() => {
      expect(screen.getByText('职责分工')).toBeDefined()
    })

    for (const label of ['草图生成', 'MVP 生成', '向导澄清 / 意图判定', 'PRD 提取 / 功能项加厚', '裁判审查', 'L3 蒸馏（默认关）']) {
      expect(screen.getByText(label)).toBeDefined()
    }

    // OpenAI 协议渠道（zhipu）不出现在路由下拉中（§9.1 协议过滤）
    const select = screen.getByLabelText('草图生成 渠道') as HTMLSelectElement
    const optionTexts = Array.from(select.options).map((option) => option.textContent ?? '')
    expect(optionTexts.some((text) => text.includes('智谱 OpenAI 协议'))).toBe(false)
    expect(optionTexts.some((text) => text.includes('Kimi 渠道'))).toBe(true)
    expect(select.value).toBe('ch-kimi')
  })

  it('悬空态显示警示文案，「恢复自动」清除 channel_id 后保存不再携带该渠道（effective 变 auto）', async () => {
    // sketch 指向已删除渠道 → dangling
    const viewsAfterRestore = makeViews([{ category: 'sketch', channel_id: undefined, channel_name: 'Kimi 渠道', model_name: 'kimi-k2.6', effective: 'auto' }])
    const { updateSpy } = installApi({
      views: makeViews([{ category: 'sketch', channel_id: 'ch-deleted', channel_name: 'Kimi 渠道', model_name: 'kimi-k2.6', effective: 'dangling' }]),
      onUpdate: () => ({ version: 1, views: viewsAfterRestore }),
    })
    render(<ChannelSettingsPage />)

    // 悬空警示文案（§7 口径）
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('指向的渠道已被删除，当前回退全局默认')

    // 「恢复自动」→ 清除该行 channel_id
    await act(async () => {
      fireEvent.click(screen.getByTestId('category-routing-restore-auto-sketch'))
    })
    // 保存按钮由脏变可用
    await act(async () => {
      fireEvent.click(screen.getByTestId('category-routing-save'))
    })

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledTimes(1)
    })
    const payload = updateSpy.mock.calls[0]![0] as CategoryRoutingUpdateEnvelope
    expect(payload.routing.sketch?.channel_id).toBeUndefined()
    // 其余类别未被阻塞（全量覆盖、缺省=未配置）
    expect(payload.routing.mvp).toBeUndefined()

    // 保存返回 auto 视图后：警示消失
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull()
    })
  })

  it('滚轮悬停渠道下拉循环切换该角色渠道（自动/各渠道），生效模型预览随草稿更新', async () => {
    installApi({ views: makeViews() })
    render(<ChannelSettingsPage />)

    await waitFor(() => {
      expect(screen.getByText('职责分工')).toBeDefined()
    })

    const select = screen.getByLabelText('草图生成 渠道') as HTMLSelectElement
    expect(select.value).toBe('ch-kimi')

    // 滚轮向下（deltaY>0）：ch-kimi → 自动/全局默认（''）
    await act(async () => {
      fireEvent.wheel(select, { deltaY: 120 })
    })
    expect(select.value).toBe('')
    // 草稿已变脏：保存按钮由禁用变可用（routing.sketch.channel_id 清除）
    expect((screen.getByTestId('category-routing-save') as HTMLButtonElement).disabled).toBe(false)

    // 滚轮向上（deltaY<0）：自动 → ch-kimi（累计器跨事件，-120 抵消先前余量后步进一步）
    await act(async () => {
      fireEvent.wheel(select, { deltaY: -120 })
    })
    expect(select.value).toBe('ch-kimi')
  })

  it('「恢复全部默认」提交空路由表', async () => {
    const { updateSpy } = installApi({
      views: makeViews(),
      onUpdate: () => ({ version: 1, views: makeViews() }),
    })
    render(<ChannelSettingsPage />)

    await waitFor(() => {
      expect(screen.getByTestId('category-routing-reset-all')).toBeDefined()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('category-routing-reset-all'))
    })

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledTimes(1)
    })
    expect((updateSpy.mock.calls[0]![0] as CategoryRoutingUpdateEnvelope).routing).toEqual({})
  })
})

describe('渠道表单文案（QW#5 ux-r2 I4）', () => {
  afterEach(() => {
    cleanup()
    delete window.electronAPI
    resetChannelsFetchFlagForTests()
  })

  it('[S1-UI-013] 表单标签去黑话：「渠道名称」→「给它起个名字」、「Base URL」→「服务地址」', async () => {
    window.electronAPI = {
      channels: {
        list: () => Promise.resolve({ ok: true, request_id: 't', data: [] }),
        categoryRoutingList: () => Promise.resolve({ ok: true, request_id: 't', data: { version: 1, views: [] } }),
      },
    } as unknown as ElectronAPI
    render(<ChannelSettingsPage />)

    await waitFor(() => expect(screen.getByText(/还没有配置/)).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: /添加第一个渠道/ }))

    await waitFor(() => expect(screen.getByText(/给它起个名字/)).toBeDefined())
    expect(screen.getByText(/服务地址/)).toBeDefined()
    expect(screen.queryByText('Base URL')).toBeNull()
    expect(screen.queryByText('渠道名称 *')).toBeNull()
  })
})
