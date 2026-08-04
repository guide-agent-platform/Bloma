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

  it('[S1-UI-006] 超过 120 秒时应提供继续等待和查看已有部分两个操作', () => {
    const continueWaiting = vi.fn()
    const viewPartial = vi.fn()
    render(
      <WaitingFeedback
        elapsedSeconds={121}
        actionLabel="生成验证草图"
        onContinueWaiting={continueWaiting}
        onViewPartial={viewPartial}
      />,
    )

    screen.getByRole('button', { name: '继续等待' }).click()
    screen.getByRole('button', { name: '看看已有的' }).click()
    expect(continueWaiting).toHaveBeenCalledOnce()
    expect(viewPartial).toHaveBeenCalledOnce()

    const appSource = readFileSync(join(root, 'renderer', 'components', 'App.tsx'), 'utf8')
    expect(appSource).toMatch(/onContinueWaiting=/)
    expect(appSource).toMatch(/onViewPartial=/)
  })
})
