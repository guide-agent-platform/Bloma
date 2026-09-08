// @vitest-environment jsdom

import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Provider } from 'jotai'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../../renderer/components/ChatPanel'
import { WaitingFeedback } from '../../../renderer/components/WaitingFeedback'

const root = process.cwd()

describe('Sprint 1 waiting feedback acceptance', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('[S1-UI-005] 等待反馈应在超过 5 秒后显示当前操作但尚不显示安全感说明', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-25T00:00:00.000Z'))
    Element.prototype.scrollIntoView = vi.fn()

    render(
      <Provider>
        <ChatPanel
          isWaiting
          waitStartTime={Date.now()}
          waitActionLabel="生成验证草图"
        />
      </Provider>,
    )

    expect(screen.queryByRole('status')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(screen.queryByRole('status')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('生成验证草图')
    expect(status.textContent).not.toMatch(/安全|放心|不会影响/)
  })

  it('[S1-UI-010] 等待反馈应在超过 10 秒后加入安全感说明', () => {
    const { rerender } = render(
      <WaitingFeedback
        elapsedSeconds={10}
        actionLabel="生成验证草图"
      />,
    )

    const status = screen.getByRole('status')
    expect(status.textContent).toContain('生成验证草图')
    expect(status.textContent).not.toMatch(/安全|放心|不会影响/)

    rerender(
      <WaitingFeedback
        elapsedSeconds={11}
        actionLabel="生成验证草图"
      />,
    )
    expect(status.textContent).toMatch(/安全|放心|不会影响/)
  })

  it('[S1-UI-006] 超过 120 秒时应提供继续等待和查看进度两个操作', () => {
    const continueWaiting = vi.fn()
    const viewProgress = vi.fn()
    render(
      <WaitingFeedback
        elapsedSeconds={121}
        actionLabel="生成验证草图"
        onContinueWaiting={continueWaiting}
        onViewProgress={viewProgress}
      />,
    )

    screen.getByRole('button', { name: '继续等待' }).click()
    screen.getByRole('button', { name: '查看进度' }).click()
    expect(continueWaiting).toHaveBeenCalledOnce()
    expect(viewProgress).toHaveBeenCalledOnce()

    const appSource = readFileSync(join(root, 'renderer', 'components', 'App.tsx'), 'utf8')
    expect(appSource).toMatch(/onContinueWaiting=/)
    // v2（2026-09-08）：超时卡不再承诺「已生成部分」，进度接线在 ChatPanel（步骤映射 + 事件归约）
    const chatSource = readFileSync(join(root, 'renderer', 'components', 'ChatPanel.tsx'), 'utf8')
    expect(chatSource).toMatch(/onViewProgress=/)
    expect(chatSource).toMatch(/mapStageToRunSteps/)
  })

  it('超过 10 秒（long 态）即提供「查看进度」入口，无需等到 120 秒', () => {
    render(
      <WaitingFeedback
        elapsedSeconds={11}
        actionLabel="生成草图"
        onViewProgress={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: '查看进度' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '继续等待' })).toBeNull()
  })
})
