// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PrdConfirmDialog } from '../../renderer/components/PrdConfirmDialog'
import {
  activeAgentSessionIdAtom,
  prdConfirmFamily,
  setupGlobalAgentListeners,
} from '../../renderer/agent-atoms'
import type { ElectronAPI } from '../../shared/types'

/**
 * PRD 确认弹窗「累计池批量修改」（2026-08-30 组会决议 7，2026-09-02 落地）：
 * 旧语义「一步一问一改」——openAdjustWith 替换文本，一条「这条不对」= 关卡一轮修订闭环，
 * N 条修改 N 轮（token 与轮时双浪费，导师点名）。
 * 新语义：调整先压栈（点 N 条累计 N 条，同条目不重复，可增删改/手动补条），
 * 「一次性提交全部修改」合并为一条消息回向导（selected_option_id=prd_confirm_adjust 不变，
 * 零新 IPC），一轮修订统一处理；typed 路径失败恢复弹窗+池内容全保留（F9a 同款）。
 * P 组=池行为；F 组=失败恢复；S 组=成功收尾。
 */

configure({ testIdAttribute: 'data-ai-id' })

describe('PRD 确认弹窗累计池批量修改（决议 7）', () => {
  let store: ReturnType<typeof createStore>
  const sendMessage = vi.fn(
    async (_input: { content: string; metadata?: Record<string, unknown> }): Promise<Record<string, unknown>> =>
      ({ ok: true, data: { accepted: true } }),
  )

  beforeEach(() => {
    sendMessage.mockReset()
    sendMessage.mockResolvedValue({ ok: true, data: { accepted: true } })
    store = createStore()
    window.__jotai_store__ = store as never
    store.set(activeAgentSessionIdAtom, 'session-pc')
    window.electronAPI = {
      agent: {
        onStreamEvent: () => () => undefined,
        sendMessage,
      },
    } as unknown as ElectronAPI
    setupGlobalAgentListeners()
    store.set(prdConfirmFamily('session-pc'), {
      sessionId: 'session-pc',
      projectId: 'project-pc',
      title: '请确认这份 PRD（已通过裁判审查）',
      positioning: '个人记账工具',
      requirements: [
        { id: 'F-001', priority: 'P0', story: '记录日常收支', assertions: ['列表实时刷新'] },
        { id: 'F-002', priority: 'P2', story: '导出 CSV', assertions: ['点击导出生成 CSV'] },
        { id: 'F-003', priority: 'P1', story: '按月汇总', assertions: ['月末自动汇总'] },
      ],
      outOfScope: ['不做排行榜'],
      assumptions: [],
      constraints: [],
      expanded: false,
      ideas: [],
    })
  })

  afterEach(() => {
    delete window.electronAPI
    delete window.__jotai_store__
    cleanup()
  })

  function renderDialog(): ReturnType<typeof render> {
    return render(
      <Provider store={store}>
        <PrdConfirmDialog />
      </Provider>,
    )
  }

  function inputs(): HTMLTextAreaElement[] {
    return screen.queryAllByTestId('prd-confirm-adjust-input') as HTMLTextAreaElement[]
  }

  it('[P1·压栈不替换] 点两条「这条不对」→ 池累计 2 条、各带条目 id 前缀', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('prd-confirm-disagree-F-001'))
    fireEvent.click(screen.getByTestId('prd-confirm-disagree-F-002'))
    // 旧语义反向锁定：openAdjustWith 曾是替换——第二条会吃掉第一条（此处必须 2 条共存）
    expect(inputs()).toHaveLength(2)
    expect(inputs()[0].value).toBe('F-001 这条不对：')
    expect(inputs()[1].value).toBe('F-002 这条不对：')
    expect(screen.getByTestId('prd-confirm-adjust-pool-count').textContent).toContain('已累计 2 条')
  })

  it('[P2·同条目不重复] 再点同一条「这条不对」→ 池仍 2 条', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('prd-confirm-disagree-F-001'))
    fireEvent.click(screen.getByTestId('prd-confirm-disagree-F-002'))
    fireEvent.click(screen.getByTestId('prd-confirm-disagree-F-001'))
    expect(inputs()).toHaveLength(2)
  })

  it('[P3·手动添加+逐条编辑] ＋再添加一条 → 3 条；各条编辑互不影响', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('prd-confirm-disagree-F-001'))
    fireEvent.click(screen.getByTestId('prd-confirm-adjust-add'))
    const fields = inputs()
    expect(fields).toHaveLength(2)
    fireEvent.change(fields[0], { target: { value: 'F-001 这条不对：改成多账户' } })
    fireEvent.change(fields[1], { target: { value: '整体：导出格式要 Excel 不要 CSV' } })
    expect(inputs()[0].value).toBe('F-001 这条不对：改成多账户')
    expect(inputs()[1].value).toBe('整体：导出格式要 Excel 不要 CSV')
  })

  it('[P4·移除] 移除池中一条 → 剩余条目保留', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('prd-confirm-disagree-F-001'))
    fireEvent.click(screen.getByTestId('prd-confirm-disagree-F-002'))
    fireEvent.click(screen.getByTestId('prd-confirm-adjust-remove-F-001'))
    expect(inputs()).toHaveLength(1)
    expect(inputs()[0].value).toBe('F-002 这条不对：')
  })

  it('[P5·批量提交一次回传] 3 条合并为 1 条消息（换行拼接），仅调 1 次 sendMessage', async () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('prd-confirm-disagree-F-001'))
    fireEvent.click(screen.getByTestId('prd-confirm-disagree-F-002'))
    fireEvent.click(screen.getByTestId('prd-confirm-adjust-add'))
    const fields = inputs()
    fireEvent.change(fields[0], { target: { value: 'F-001 这条不对：改成多账户' } })
    fireEvent.change(fields[1], { target: { value: 'F-002 这条不对：要导出 Excel' } })
    fireEvent.change(fields[2], { target: { value: '整体：配色要深色模式' } })
    fireEvent.click(screen.getByTestId('prd-confirm-adjust-send'))
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    const call = sendMessage.mock.calls[0][0] as { content: string; metadata: Record<string, string> }
    expect(call.content).toBe('F-001 这条不对：改成多账户\nF-002 这条不对：要导出 Excel\n整体：配色要深色模式')
    expect(call.metadata).toMatchObject({ source: 'card_option', selected_option_id: 'prd_confirm_adjust' })
    // 一轮只回传一次——不再一条一轮
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('[P6·收起保留] 收起面板 → 池不丢（actions 显示「继续调整（池里有 N 条）」），重开内容仍在', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('prd-confirm-disagree-F-001'))
    fireEvent.click(screen.getByTestId('prd-confirm-disagree-F-003'))
    fireEvent.click(screen.getByRole('button', { name: /收起/ }))
    const resume = screen.getByTestId('prd-confirm-adjust-resume')
    expect(resume.textContent).toContain('池里有 2 条')
    fireEvent.click(resume)
    expect(inputs()).toHaveLength(2)
    expect(inputs()[1].value).toBe('F-003 这条不对：')
  })

  it('[P7·空池禁用] 池空/全空白时提交按钮禁用', () => {
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /有要调整的/ }))
    expect((screen.getByTestId('prd-confirm-adjust-send') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('prd-confirm-adjust-add'))
    fireEvent.change(inputs()[0], { target: { value: '   ' } }) // 全空白同样禁用
    expect((screen.getByTestId('prd-confirm-adjust-send') as HTMLButtonElement).disabled).toBe(true)
  })

  it('[P8·确认拦截] 池有未提交修改时点「确认无误」→ 不发送，展开池+错误条提示（不静默丢池）', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('prd-confirm-disagree-F-001'))
    fireEvent.change(inputs()[0], { target: { value: 'F-001 这条不对：改成多账户' } })
    // 收起面板回到 actions 区（确认按钮可见，池内容保留）
    fireEvent.click(screen.getByRole('button', { name: /收起/ }))
    fireEvent.click(screen.getByRole('button', { name: /确认无误/ }))
    // 守卫拦截：不调 sendMessage，展开修改池+错误条，池内容原样保留
    expect(sendMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('prd-confirm-adjust-pool')).toBeTruthy()
    expect(screen.getByTestId('prd-confirm-submit-error').textContent).toContain('未提交')
    expect(inputs()).toHaveLength(1)
    expect(inputs()[0].value).toBe('F-001 这条不对：改成多账户')
  })

  it('[F1·失败恢复·ok:false] 弹窗恢复+池内容全保留+错误条，重试可成功', async () => {
    sendMessage.mockResolvedValueOnce({ ok: false, error: 'queue full' })
    renderDialog()
    fireEvent.click(screen.getByTestId('prd-confirm-disagree-F-001'))
    fireEvent.click(screen.getByTestId('prd-confirm-disagree-F-002'))
    fireEvent.change(inputs()[0], { target: { value: 'F-001 这条不对：改成多账户' } })
    fireEvent.change(inputs()[1], { target: { value: 'F-002 这条不对：要导出 Excel' } })
    fireEvent.click(screen.getByTestId('prd-confirm-adjust-send'))
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    // 恢复：弹窗回来、池 2 条内容原样、错误条可见
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeNull())
    const restored = await screen.findAllByTestId('prd-confirm-adjust-input')
    expect(restored.map((node) => (node as HTMLTextAreaElement).value)).toEqual([
      'F-001 这条不对：改成多账户',
      'F-002 这条不对：要导出 Excel',
    ])
    expect(screen.getByTestId('prd-confirm-submit-error').textContent).toContain('没有送达')
    // 原地重试成功
    fireEvent.click(screen.getByTestId('prd-confirm-adjust-send'))
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('[F2·失败恢复·throw] 同 F1（连接异常路径）', async () => {
    sendMessage.mockRejectedValueOnce(new Error('net down'))
    renderDialog()
    fireEvent.click(screen.getByTestId('prd-confirm-disagree-F-001'))
    fireEvent.change(inputs()[0], { target: { value: 'F-001 这条不对：改成多账户' } })
    fireEvent.click(screen.getByTestId('prd-confirm-adjust-send'))
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeNull())
    const restored = await screen.findAllByTestId('prd-confirm-adjust-input')
    expect((restored[0] as HTMLTextAreaElement).value).toBe('F-001 这条不对：改成多账户')
    expect(screen.getByTestId('prd-confirm-submit-error').textContent).toContain('连接中断')
  })

  it('[S1·成功清池] 提交成功 → 本地全清（新卡到达后池为空，无 resume 徽标）', async () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('prd-confirm-disagree-F-001'))
    fireEvent.change(inputs()[0], { target: { value: 'F-001 这条不对：改成多账户' } })
    fireEvent.click(screen.getByTestId('prd-confirm-adjust-send'))
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // 新一轮确认卡到达：池已清空——不应出现「继续调整（池里有 N 条）」
    store.set(prdConfirmFamily('session-pc'), {
      sessionId: 'session-pc',
      projectId: 'project-pc',
      title: '请确认这份 PRD（第二轮）',
      positioning: '个人记账工具',
      requirements: [{ id: 'F-001', priority: 'P0', story: '记录日常收支', assertions: ['列表实时刷新'] }],
      outOfScope: [],
      assumptions: [],
      constraints: [],
      expanded: false,
      ideas: [],
    })
    expect(screen.queryByTestId('prd-confirm-adjust-resume')).toBeNull()
    // 裸 store.set 不驱动 React 同步刷新——waitFor（含 act）等新卡上屏再断言
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /有要调整的/ }))
    expect(inputs()).toHaveLength(0)
  })
})
