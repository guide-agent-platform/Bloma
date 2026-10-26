// @vitest-environment jsdom
// ProgressCard v2 单测（2026-09-08）：步骤式「查看进度」。
// mapStageToRunSteps（后端权威 stage → 用户可读步骤）、computeStepProgress（完成度）、
// buildProgressLines/countDoneSteps/pickLiveLine（当前步活体 detail）、组件三态渲染。

import React from 'react'
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProgressCard,
  buildProgressLines,
  computeStepProgress,
  countDoneSteps,
  mapStageToRunSteps,
  pickLiveLine,
  PROGRESS_STATUS_TEXT,
  type ProgressLine,
} from '../../renderer/components/ProgressCard'
import type { AgentEvent } from '../../shared/types'
import type { DelegationView } from '../../renderer/agent-atoms'

configure({ testIdAttribute: 'data-ai-id' })

function started(tool: string, turn: number, input = ''): AgentEvent {
  return {
    event_id: `started-${turn}-${tool}`,
    session_id: 's1',
    type: 'tool_call_started',
    payload: { tool, turn, input_summary: input },
    created_at: '2026-09-08T00:00:00.000Z',
  }
}

function completed(tool: string, turn: number, status: 'ok' | 'error' | 'budget' = 'ok'): AgentEvent {
  return {
    event_id: `completed-${turn}-${tool}`,
    session_id: 's1',
    type: 'tool_call_completed',
    payload: { tool, turn, status, duration_ms: 120 },
    created_at: '2026-09-08T00:00:01.000Z',
  }
}

function delegation(over: Partial<DelegationView> = {}): DelegationView {
  return {
    delegation_id: 'd1',
    child_session_id: 'c1',
    role: 'research',
    goal: '调研竞品定价',
    status: 'running',
    ...over,
  }
}

afterEach(cleanup)

describe('mapStageToRunSteps', () => {
  it('generating_sketch → 2 步模板，第 1 步进行中', () => {
    const steps = mapStageToRunSteps('generating_sketch')
    expect(steps).not.toBeNull()
    expect(steps).toHaveLength(2)
    expect(steps![0]).toMatchObject({ label: '画草图给你看', status: 'in_progress' })
    expect(steps![1]).toMatchObject({ status: 'pending' })
  })

  it('generating_mvp → 3 步模板（制作应用→检查关键功能→最后验收），第 1 步进行中', () => {
    const steps = mapStageToRunSteps('generating_mvp')
    expect(steps).toHaveLength(3)
    expect(steps![0]).toMatchObject({ label: '制作应用', status: 'in_progress' })
    expect(steps![1]).toMatchObject({ status: 'pending' })
  })

  it('testing → 3 步第 2 步「检查关键功能」进行中（修复步不出现，仅发生时）', () => {
    const steps = mapStageToRunSteps('testing')
    expect(steps).toHaveLength(3)
    expect(steps![0]).toMatchObject({ status: 'done' })
    expect(steps![1]).toMatchObject({ label: '检查关键功能', status: 'in_progress' })
    expect(steps![2]).toMatchObject({ label: '最后验收', status: 'pending' })
  })

  it('repairing → 4 步模板（I1：修复作为独立里程碑仅发生时插入，不回退已完成）', () => {
    const steps = mapStageToRunSteps('repairing')
    expect(steps).toHaveLength(4)
    expect(steps![0]).toMatchObject({ status: 'done' })
    expect(steps![1]).toMatchObject({ label: '检查关键功能', status: 'done' })
    expect(steps![2]).toMatchObject({ label: '修复发现的问题', status: 'in_progress' })
    expect(steps![3]).toMatchObject({ label: '最后验收', status: 'pending' })
  })

  it('judge_review → 前两步完成、第 3 步进行中', () => {
    const steps = mapStageToRunSteps('judge_review')
    expect(steps![0].status).toBe('done')
    expect(steps![1].status).toBe('done')
    expect(steps![2]).toMatchObject({ status: 'in_progress' })
  })

  it('ready → 全部完成', () => {
    const steps = mapStageToRunSteps('ready')
    expect(steps!.every((step) => step.status === 'done')).toBe(true)
  })

  it('未覆盖阶段返回 null（不套模板，避免误导）', () => {
    for (const stage of ['clarifying', 'iterating', 'upgrading', 'blocked_for_user_decision', 'sketch_ready']) {
      expect(mapStageToRunSteps(stage)).toBeNull()
    }
  })
})

describe('computeStepProgress', () => {
  it('MVP 第 2 步进行中 → current 2 / total 3 / done 1 / 33%', () => {
    const progress = computeStepProgress(mapStageToRunSteps('testing')!)
    expect(progress).toMatchObject({ current: 2, total: 3, done: 1, percent: 33, allDone: false })
  })

  it('ready → 全完成 100%', () => {
    const progress = computeStepProgress(mapStageToRunSteps('ready')!)
    expect(progress).toMatchObject({ current: 3, total: 3, done: 3, percent: 100, allDone: true })
  })

  it('空数组 → 0', () => {
    expect(computeStepProgress([])).toMatchObject({ current: 0, total: 0, done: 0, percent: 0 })
  })
})

describe('buildProgressLines / countDoneSteps / pickLiveLine', () => {
  it('已映射工具显示中文动作并收尾为完成态', () => {
    const lines = buildProgressLines([started('write_file', 0, 'a.txt'), completed('write_file', 0)], [])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ kind: 'tool', label: '写入文件', status: 'ok' })
  })

  it('未映射工具回退「正在处理任务」，不暴露英文工具名', () => {
    const lines = buildProgressLines([started('mystery_tool', 1, 'x')], [])
    expect(lines[0]).toMatchObject({ label: '正在处理任务' })
    expect(lines[0].label).not.toContain('mystery_tool')
  })

  it('budget 状态单独成态显示「预算已满」，不误报出错（P3-2）', () => {
    const lines = buildProgressLines([started('write_file', 0, 'a.txt'), completed('write_file', 0, 'budget')], [])
    expect(lines[0]).toMatchObject({ status: 'budget' })
    expect(PROGRESS_STATUS_TEXT.budget).toBe('预算已满')
  })

  it('委派行使用角色中文', () => {
    const lines = buildProgressLines([], [delegation()])
    expect(lines[0]).toMatchObject({ kind: 'delegation', label: '派出调研子助手', detail: '调研竞品定价', status: 'running' })
  })

  it('只保留最近 max 条（默认 4）', () => {
    const events: AgentEvent[] = []
    for (let i = 0; i < 8; i += 1) events.push(started(`tool_${i}`, i))
    expect(buildProgressLines(events, [])).toHaveLength(4)
  })

  it('countDoneSteps 统计成功收尾工具与已完成委派', () => {
    const events: AgentEvent[] = [
      started('write_file', 0),
      completed('write_file', 0, 'ok'),
      started('run_gwt_tests', 1),
      completed('run_gwt_tests', 1, 'error'),
    ]
    expect(countDoneSteps(events, [delegation({ status: 'completed' }), delegation({ delegation_id: 'd2', status: 'running' })])).toBe(2)
  })

  it('pickLiveLine 优先 running，否则取最新一条', () => {
    const lines: ProgressLine[] = [
      { key: 'a', kind: 'tool', label: '读取文件', detail: '', status: 'ok' },
      { key: 'b', kind: 'tool', label: '写入文件', detail: 'index.html', status: 'running' },
    ]
    expect(pickLiveLine(lines)).toMatchObject({ label: '写入文件', status: 'running' })
    expect(pickLiveLine([lines[0]])).toMatchObject({ label: '读取文件' })
    expect(pickLiveLine([])).toBeNull()
  })
})

describe('ProgressCard', () => {
  it('有步骤模板：显示第 N/共 M 步 + 完成百分比 + 进行中/待开始', () => {
    const steps = mapStageToRunSteps('generating_mvp')!
    const live: ProgressLine[] = [
      { key: 't', kind: 'tool', label: '写入文件', detail: 'app.js', status: 'running' },
    ]
    render(<ProgressCard stageLabel="制作应用" steps={steps} lines={live} doneSteps={0} onClose={vi.fn()} />)
    expect(screen.getByText('第 1 / 3 步 · 已结束 0 步')).toBeTruthy()
    expect(screen.getByText('进行中')).toBeTruthy()
    expect(screen.getByText('检查关键功能')).toBeTruthy()
    expect(screen.getByText(/正在：写入文件 · app\.js/)).toBeTruthy()
  })

  it('judge_review 显示已完成步与进行中步并存', () => {
    const steps = mapStageToRunSteps('judge_review')!
    render(<ProgressCard stageLabel="审查生成的版本" steps={steps} lines={[]} doneSteps={2} onClose={vi.fn()} />)
    expect(screen.getByText('第 3 / 3 步 · 已结束 2 步')).toBeTruthy()
    // 已完成步骤出现两次"完成"：第 1、2 步行右侧
    expect(screen.getAllByText('完成').length).toBeGreaterThanOrEqual(2)
  })

  it('无步骤模板且无活动：回退阶段文案 + 空态', () => {
    render(<ProgressCard stageLabel="正在理解你的需求" steps={[]} lines={[]} doneSteps={0} onClose={vi.fn()} />)
    expect(screen.getByText('正在理解你的需求')).toBeTruthy()
    expect(screen.getByText('正在准备 / 理解你的需求…')).toBeTruthy()
  })

  it('无步骤模板但有动作：阶段文案 + 已完成 N 步 + 动作行', () => {
    const live: ProgressLine[] = [{ key: 'a', kind: 'tool', label: '读取文件', detail: '', status: 'running' }]
    render(<ProgressCard stageLabel="正在理解你的需求" steps={[]} lines={live} doneSteps={1} onClose={vi.fn()} />)
    expect(screen.getByText('正在理解你的需求 · 已完成 1 步')).toBeTruthy()
    expect(screen.getByText('读取文件')).toBeTruthy()
  })

  it('点击收起触发 onClose', () => {
    const onClose = vi.fn()
    render(<ProgressCard stageLabel="生成可运行版本" steps={mapStageToRunSteps('generating_mvp')!} lines={[]} doneSteps={0} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('提供「补充或修改要求」与「停止本轮制作」入口并触发回调（I1/I4）', () => {
    const onSuggestIdea = vi.fn()
    const onStopGeneration = vi.fn()
    render(
      <ProgressCard
        stageLabel="制作应用"
        steps={mapStageToRunSteps('generating_mvp')!}
        lines={[]}
        doneSteps={0}
        onClose={vi.fn()}
        onSuggestIdea={onSuggestIdea}
        onStopGeneration={onStopGeneration}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '补充或修改要求' }))
    expect(onSuggestIdea).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByTestId('progress-stop-button'))
    expect(onStopGeneration).toHaveBeenCalledOnce()
  })
})
