// @vitest-environment jsdom

/**
 * ThinkingIndicator 窄栏思考呈现（2026-10-04）：
 * - waiting：单行「正在思考…」占位（批 A：消掉发消息后的沉默期）
 * - done：单行「思考 Ns ▸」，点击展开原文（限高滚动、data-ai-id 锚点）
 * - live：实时走字（定时器驱动，此处锁结构不锁时间）
 */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ThinkingIndicator } from '../../renderer/components/ThinkingIndicator'

// 陷阱 42：锚点是 data-ai-id，非默认 data-testid
import { configure } from '@testing-library/react'
configure({ testIdAttribute: 'data-ai-id' })

describe('ThinkingIndicator', () => {
  afterEach(() => cleanup())

  it('waiting：单行占位，无正文无展开', () => {
    render(<ThinkingIndicator phase="waiting" />)
    const el = screen.getByTestId('thinking-indicator')
    expect(el.textContent).toContain('正在思考')
    expect(screen.queryByTestId('thinking-body')).toBeNull()
  })

  it('done：显示时长行，点击展开思考原文，再点收起', () => {
    render(<ThinkingIndicator phase="done" startedAt={Date.now() - 8200} endedAt={Date.now() - 100} text="先分析需求，再决定问什么。" />)
    expect(screen.getByTestId('thinking-duration').textContent).toContain('思考 8s')
    expect(screen.queryByTestId('thinking-body')).toBeNull()
    fireEvent.click(screen.getByTestId('thinking-duration'))
    expect(screen.getByTestId('thinking-body').textContent).toContain('先分析需求')
    fireEvent.click(screen.getByTestId('thinking-duration'))
    expect(screen.queryByTestId('thinking-body')).toBeNull()
  })

  it('done 且无思考原文：不可展开（无 pointer 光标语义）', () => {
    render(<ThinkingIndicator phase="done" startedAt={Date.now() - 1000} endedAt={Date.now()} />)
    fireEvent.click(screen.getByTestId('thinking-duration'))
    expect(screen.queryByTestId('thinking-body')).toBeNull()
  })

  it('live：显示「思考中」字样', () => {
    render(<ThinkingIndicator phase="live" startedAt={Date.now() - 500} />)
    expect(screen.getByTestId('thinking-duration').textContent).toContain('思考中')
  })
})
