// @vitest-environment jsdom
// ux-settings-walkthrough r95（B 腿可执行走查，walkthrough SOP v1 首次应用）
// S-006 P1a 前置 UX 证据：SettingsPage Tab 结构/无「关于」区/导航安全性。
// 勘误 r91：实为两 Tab（模型渠道+提示词配置），非「仅 channels」。

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { configure } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from '../../renderer/components/SettingsPage'
import type { ElectronAPI } from '../../shared/types'

configure({ testIdAttribute: 'data-ai-id' })

describe('ux-settings-walkthrough r95：SettingsPage（0 基础用户视角，S-006 P1a 前置）', () => {
  beforeEach(() => {
    ;(window as never as { electronAPI: unknown }).electronAPI = {
      channels: {
        list: vi.fn().mockResolvedValue({ ok: true, request_id: 'r', data: [] }),
        categoryRoutingList: vi.fn().mockResolvedValue({ ok: true, request_id: 'r', data: { views: [] } }),
        test: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), testDirect: vi.fn(), fetchModels: vi.fn(),
      },
      prompts: {
        list: vi.fn().mockResolvedValue({ ok: true, request_id: 'r', data: [] }),
        read: vi.fn().mockResolvedValue({ ok: true, request_id: 'r', data: '' }),
        save: vi.fn(), reset: vi.fn(),
      },
    } as unknown as ElectronAPI
  })
  afterEach(() => {
    cleanup()
    delete (window as never as { electronAPI?: unknown }).electronAPI
  })

  it('[S1·结构] Tab 集含模型渠道/提示词配置/通知与声音（2026-10-06 体验批 A 新增）且**无「关于」Tab/版本行**（S-006 P1a 缺口渲染级证据）', async () => {
    render(<SettingsPage onBack={vi.fn()} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['模型渠道', '验收模型', '提示词配置', '通知与声音'])
    fireEvent.click(screen.getByRole('tab', { name: '验收模型' }))
    expect(screen.getByRole('heading', { name: '验收模型' })).toBeTruthy()
    // 走查断言：无关于/版本任何入口（S-006 P1a 修后此断言应翻转为含「关于」）
    expect(document.body.textContent ?? '').not.toMatch(/关于|版本\s*0\.\d/)
    expect(screen.queryByTestId('about-section')).toBeNull()
  })

  it('[S2·导航安全] 返回工作区按钮存在（aria-label 可达）', () => {
    render(<SettingsPage onBack={vi.fn()} />)
    expect(screen.getByRole('button', { name: '返回工作区' })).toBeTruthy()
  })

  it('[S3·Tab 切换] 点「提示词配置」→ 选中态转移且内容区切换（交互可用性）', async () => {
    render(<SettingsPage onBack={vi.fn()} />)
    const promptsTab = screen.getAllByRole('tab').find((t) => t.textContent === '提示词配置') as HTMLElement
    expect((screen.getAllByRole('tab')[0] as HTMLElement).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(promptsTab)
    await waitFor(() => {
      expect(promptsTab.getAttribute('aria-selected')).toBe('true')
      expect(screen.getAllByRole('tab')[0].getAttribute('aria-selected')).toBe('false')
    })
  })
})
