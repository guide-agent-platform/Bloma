// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolCallFeed, ToolBlocksReplay, deriveToolCallRecords, toolLabel } from '../../../renderer/components/ToolCallBlock'
import { ChatPanel } from '../../../renderer/components/ChatPanel'
import {
  activeAgentSessionIdAtom,
  agentMessagesFamily,
  stageIndicatorLabelAtom,
  workflowStageAtom,
  setupGlobalAgentListeners,
} from '../../../renderer/agent-atoms'
import type { AgentEvent, ElectronAPI } from '../../../shared/types'

/**
 * PR4 渲染端验收：ToolCallFeed 实时流 / ToolBlocksReplay 历史回放 /
 * ChatPanel 集成 / 阶段指示器「第 N 轮 · 正在 {工具}」。
 * 锚点用 data-ai-id（陷阱 30）；非 globals 模式 RTL 手动 cleanup。
 */

configure({ testIdAttribute: 'data-ai-id' })

function event(type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent {
  return {
    event_id: crypto.randomUUID(),
    session_id: 'session-ui',
    project_id: 'project-ui',
    type,
    payload,
    created_at: new Date().toISOString(),
  }
}

describe('ToolCallFeed（实时工具流）', () => {
  afterEach(() => cleanup())

  it('started → completed：折叠行显示轮次/工具/状态/耗时，点击展开输出', () => {
    const events = [
      event('tool_call_started', { tool: 'write_file', turn: 1, input_summary: '{"path":"index.html"}' }),
      event('tool_call_completed', { tool: 'write_file', turn: 1, status: 'ok', duration_ms: 1200, output_summary: '已写入 index.html（2048 字节）' }),
    ]
    render(<ToolCallFeed events={events} />)

    const row = screen.getAllByTestId('tool-call-row')[0]
    expect(row.textContent).toContain('第 1 轮')
    expect(row.textContent).toContain('写入文件')
    expect(row.textContent).toContain('完成')
    expect(row.textContent).toContain('1.2s')
    // 默认折叠，点击展开输出摘要（点击目标是有 role=button 的内层行）
    expect(screen.queryByTestId('tool-call-output')).toBeNull()
    fireEvent.click(row.querySelector('[role="button"]')!)
    expect(screen.getByTestId('tool-call-output').textContent).toContain('已写入 index.html')
  })

  it('进行中/出错状态如实呈现；无工具事件时不渲染', () => {
    render(<ToolCallFeed events={[event('tool_call_started', { tool: 'run_gwt_tests', turn: 2 })]} />)
    expect(screen.getByTestId('tool-call-row').textContent).toContain('进行中')

    cleanup()
    render(<ToolCallFeed events={[event('message_delta', { text: '无关事件' })]} />)
    expect(screen.queryByTestId('tool-call-row')).toBeNull()
  })

  it('deriveToolCallRecords：completed 按轮次+工具名回填，error/budget 状态保真', () => {
    const records = deriveToolCallRecords([
      event('tool_call_started', { tool: 'edit_file', turn: 3, input_summary: '{}' }),
      event('tool_call_completed', { tool: 'edit_file', turn: 3, status: 'error', duration_ms: 40, output_summary: 'old_string 未命中' }),
      event('tool_call_started', { tool: 'write_file', turn: 4, input_summary: '{}' }),
      event('tool_call_completed', { tool: 'write_file', turn: 4, status: 'budget', output_summary: '预算已用尽' }),
    ])
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ tool: 'edit_file', turn: 3, status: 'error', durationMs: 40 })
    expect(records[1]).toMatchObject({ tool: 'write_file', turn: 4, status: 'budget' })
  })
})

describe('ToolBlocksReplay（历史回放）', () => {
  afterEach(() => cleanup())

  it('tool_use 行展示工具名与输入摘要；tool_result 行经 tool_use_id 回填工具名并保真 is_error', () => {
    render(
      <ToolBlocksReplay
        toolNamesById={{ toolu_01: 'write_file' }}
        blocks={[
          { type: 'tool_use', id: 'toolu_01', name: 'write_file', input: { path: 'index.html' } },
          { type: 'tool_result', tool_use_id: 'toolu_01', content: '已写入 index.html', is_error: false },
          { type: 'tool_result', tool_use_id: 'toolu_unknown', content: '失败原因', is_error: true },
        ]}
      />,
    )
    const rows = screen.getAllByTestId('tool-call-row')
    expect(rows).toHaveLength(3)
    expect(rows[0].textContent).toContain('写入文件')
    expect(rows[0].textContent).toContain('index.html')
    // tool_use_id 可关联 → 显示工具名；不可关联 → 「工具结果」兜底
    expect(rows[1].textContent).toContain('写入文件')
    expect(rows[2].textContent).toContain('工具结果')
    expect(rows[2].textContent).toContain('出错')
  })

  it('纯文本消息不渲染回放行', () => {
    render(<ToolBlocksReplay blocks={[{ type: 'text', text: '普通消息' }]} />)
    expect(screen.queryByTestId('tool-call-row')).toBeNull()
  })
})

describe('ChatPanel 集成（loop 轮次进消息列表）', () => {
  afterEach(() => cleanup())

  it('纯工具轮渲染为回放行，不产生空气泡；文本+工具轮两段都呈现', () => {
    // jsdom 无 scrollIntoView（ChatPanel 自动滚底用）
    Element.prototype.scrollIntoView = () => undefined
    const store = createStore()
    store.set(activeAgentSessionIdAtom, 'session-ui')
    store.set(agentMessagesFamily('session-ui'), [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我先把页面写出来。' },
          { type: 'tool_use', id: 'toolu_01', name: 'write_file', input: { path: 'index.html' } },
        ],
        timestamp: 1,
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '已写入 index.html（2048 字节）', is_error: false }],
        timestamp: 2,
      },
    ])
    render(
      <Provider store={store}>
        <ChatPanel />
      </Provider>,
    )
    const replayRows = screen.getAllByTestId('tool-call-replay')
    expect(replayRows).toHaveLength(2)
    // 文本气泡与回放行同框
    expect(screen.getByText('我先把页面写出来。')).toBeTruthy()
    // tool_result 行回填了工具名
    expect(replayRows[1].textContent).toContain('写入文件')
  })
})

describe('阶段指示器细化（第 N 轮 · 正在 {工具}）', () => {
  afterEach(() => cleanup())

  it('编程阶段的 tool_call_started 更新阶段文案；其他阶段不受影响', () => {
    const store = createStore()
    window.__jotai_store__ = store as never
    let emit: ((event: AgentEvent) => void) | undefined
    window.electronAPI = {
      agent: { onStreamEvent: (listener: (event: AgentEvent) => void) => { emit = listener; return () => undefined } },
    } as unknown as ElectronAPI
    const cleanupListeners = setupGlobalAgentListeners()

    store.set(workflowStageAtom, 'generating_mvp')
    emit!(event('tool_call_started', { tool: 'write_file', turn: 3 }))
    expect(store.get(stageIndicatorLabelAtom)).toBe('第 3 轮 · 正在写入文件')

    // 澄清阶段无轮次语义，不细化
    store.set(workflowStageAtom, 'clarifying')
    emit!(event('tool_call_started', { tool: 'write_file', turn: 4 }))
    expect(store.get(stageIndicatorLabelAtom)).toBe('第 3 轮 · 正在写入文件')

    // stage_changed 重置回标准阶段文案
    emit!(event('stage_changed', { stage: 'testing' }))
    expect(store.get(stageIndicatorLabelAtom)).toBe('正在检查能不能正常使用')

    cleanupListeners()
    delete window.electronAPI
    delete window.__jotai_store__
  })

  it('toolLabel：已知工具映射中文，未知工具原样展示', () => {
    expect(toolLabel('run_gwt_tests')).toBe('运行功能测试')
    expect(toolLabel('mystery_tool')).toBe('mystery_tool')
  })
})
