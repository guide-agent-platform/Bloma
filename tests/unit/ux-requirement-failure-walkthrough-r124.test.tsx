// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RequirementConfirmDialog } from '../../renderer/components/RequirementConfirmDialog'
import {
  activeAgentSessionIdAtom,
  requirementConfirmFamily,
  setupGlobalAgentListeners,
} from '../../renderer/agent-atoms'
import type { AgentEvent, ElectronAPI } from '../../shared/types'

/**
 * r124 B 腿十一用：需求确认弹窗「失败静默」走查（0 基础视角）。
 * F9a 实锤（2026-08-29 12:55 核验）：RequirementConfirmDialog.tsx:123-127/:145-148
 *   四路失败（confirm ok:false / confirm throw / supplement ok:false / supplement throw）
 *   全部仅 console.error 后照常 close() —— 用户零反馈、勾选/文本清空、决定丢失且无重试入口。
 *   （静默丢弃=最坏丢失形态——r110 queue 同族）
 * 修复指令（翻转位）：失败时不 close()——弹窗留、勾选/文本保留、submitting 复位、
 *   内联错误条 data-ai-id="requirement-confirm-submit-error" 可见（样式对齐 reference-error）。
 * M 组=aria/文案基线锁定（防回归）；D 组=降级基线（最差可用性也锁定）。
 */

configure({ testIdAttribute: 'data-ai-id' })

const CONFIRM_EVENT: AgentEvent = {
  event_id: crypto.randomUUID(),
  session_id: 'session-rc',
  project_id: 'project-rc',
  type: 'user_decision_required',
  payload: {
    kind: 'requirement_confirm',
    title: '确认你的需求',
    requirements: [
      { id: 'F-001', description: '记账本，记录日常收支' },
      { id: 'F-002', description: '按月汇总统计' },
    ],
    research: { available: false, summary: '' },
  },
  created_at: new Date().toISOString(),
}

describe('B 腿 r124：需求确认弹窗失败静默走查（F9a）', () => {
  let store: ReturnType<typeof createStore>
  const confirmRequirements = vi.fn(async (): Promise<Record<string, unknown>> => ({ ok: true, data: { started: true } }))
  const sendMessage = vi.fn(async (): Promise<Record<string, unknown>> => ({ ok: true, data: { accepted: true } }))

  beforeEach(() => {
    confirmRequirements.mockReset()
    confirmRequirements.mockResolvedValue({ ok: true, data: { started: true } })
    sendMessage.mockReset()
    sendMessage.mockResolvedValue({ ok: true, data: { accepted: true } })
    store = createStore()
    window.__jotai_store__ = store as never
    store.set(activeAgentSessionIdAtom, 'session-rc')
    let emit: ((event: AgentEvent) => void) | undefined
    window.electronAPI = {
      agent: {
        onStreamEvent: (listener: (event: AgentEvent) => void) => {
          emit = listener
          return () => undefined
        },
        confirmRequirements,
        sendMessage,
      },
    } as unknown as ElectronAPI
    setupGlobalAgentListeners()
    emit?.(CONFIRM_EVENT) // 事件归约注入（组件读取完整形状——勿直接 set atom）
  })

  afterEach(() => {
    delete window.electronAPI
    delete window.__jotai_store__
    cleanup()
  })

  function renderDialog(): ReturnType<typeof render> {
    return render(
      <Provider store={store}>
        <RequirementConfirmDialog />
      </Provider>,
    )
  }

  function dialogGone(): boolean {
    return screen.queryByRole('dialog') === null
  }

  it('[N1·confirm 失败静默] ok:false → 现状仅 console.error+close（F9a 翻转位：修复后弹窗留+错误条可见+勾选保留）', async () => {
    confirmRequirements.mockResolvedValue({ ok: false, error: 'db locked' })
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /确认，开始做/ }))
    await waitFor(() => expect(confirmRequirements).toHaveBeenCalledTimes(1))
    // 现状断言（修复后翻转）：弹窗关闭=决定静默丢失
    await waitFor(() => expect(dialogGone()).toBe(true))
    expect(screen.queryByText(/失败|出错|重试/)).toBeNull() // 零用户反馈
  })

  it('[N2·confirm 异常静默] throw → 同款静默关窗（翻转位同 N1）', async () => {
    confirmRequirements.mockRejectedValue(new Error('ipc gone'))
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /确认，开始做/ }))
    await waitFor(() => expect(confirmRequirements).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(dialogGone()).toBe(true))
    expect(screen.queryByText(/失败|出错|重试/)).toBeNull()
  })

  it('[N3·补充发送失败静默] supplement ok:false → 关窗+文本丢弃（翻转位：弹窗留+错误条+文本保留）', async () => {
    sendMessage.mockResolvedValue({ ok: false, error: 'queue full' })
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /继续补充说明/ }))
    const input = await screen.findByPlaceholderText('想补充或修改什么，直接写在这里…') // 全名定位：参考链接输入框并存（textbox 多匹配陷阱）
    fireEvent.change(input, { target: { value: '还要支持导出 Excel' } })
    fireEvent.click(screen.getByRole('button', { name: '发送补充说明' }))
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(dialogGone()).toBe(true))
  })

  it('[N4·补充发送异常静默] supplement throw → 同款（翻转位同 N3）', async () => {
    sendMessage.mockRejectedValue(new Error('net down'))
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /继续补充说明/ }))
    const input = await screen.findByPlaceholderText('想补充或修改什么，直接写在这里…') // 全名定位：参考链接输入框并存（textbox 多匹配陷阱）
    fireEvent.change(input, { target: { value: '补充：界面要简洁' } })
    fireEvent.click(screen.getByRole('button', { name: '发送补充说明' }))
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(dialogGone()).toBe(true))
  })

  it('[M1·aria/文案基线锁定] role=dialog+aria-modal+后果动词按钮（防回归，非发现）', () => {
    renderDialog()
    const dlg = screen.getByRole('dialog')
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(dlg.getAttribute('aria-label')).toBe('确认你的需求')
    // 0 基础文案已佳（吸取 P5b）：主按钮说明后果「确认…开始做」
    expect(screen.getByRole('button', { name: /确认，开始做/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /由向导决定/ })).toBeTruthy()
  })

  it('[D1·降级基线] electronAPI 缺失 → 点击无操作不崩、弹窗留（最差可用性也锁定）', () => {
    delete window.electronAPI
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /确认，开始做/ }))
    expect(screen.getByRole('dialog')).toBeTruthy() // 早退不动状态
  })
})
