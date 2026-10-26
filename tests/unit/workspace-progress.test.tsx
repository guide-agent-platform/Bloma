// @vitest-environment jsdom
import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveWorkspaceProgress } from '../../renderer/lib/workspace-progress'
import { WorkspaceProgress } from '../../renderer/components/WorkspaceProgress'
import { ChatPanel } from '../../renderer/components/ChatPanel'
import { activeAgentSessionIdAtom, agentMessagesFamily, currentProjectAtom, workflowStageAtom } from '../../renderer/components/atoms'
import type { Project } from '../../shared/types'

const project = { project_id: 'p', name: '笔记', status: 'active', mode: 'quick', current_stage: 'clarifying' } as Project
afterEach(() => { cleanup(); localStorage.clear() })
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn() })
const progress = (overrides: Partial<Parameters<typeof deriveWorkspaceProgress>[0]> = {}) => deriveWorkspaceProgress({ project, stage: 'clarifying', phase: null, busy: false, hasSketch: true, ...overrides })

describe('workspace stage evidence', () => {
  it('waits without moving blue and never advances based on elapsed time', () => {
    expect(progress().map(step => step.state)).toEqual(['active', 'pending', 'pending', 'pending', 'pending'])
    expect(progress().every(step => !step.moving)).toBe(true)
    expect(progress({ phase: 'desktop-verify', busy: true }).map(step => step.state)).toEqual(['done', 'done', 'done', 'active', 'pending'])
  })
  it('distinguishes interruption, running repair and human delivery confirmation', () => {
    const paused = { ...project, desktop_blocked: { reason: 'user-stop', at: 'now' } } as Project
    expect(progress({ project: paused, phase: 'desktop-verify' })[3]?.state).toBe('attention')
    expect(progress({ project: paused, phase: 'desktop-verify', busy: true })[3]?.state).toBe('active')
    expect(progress({ phase: 'delivered' })[4]?.state).toBe('active')
    expect(progress({ project: { ...project, status: 'completed' }, stage: 'completed', phase: 'delivered' }).every(step => step.state === 'done')).toBe(true)
  })
  it('new confirmations and unknown phases cannot borrow a finished old flow', () => {
    expect(progress({ phase: 'delivered', decision: 'requirements' }).map(step => step.state)).toEqual(['active', 'pending', 'pending', 'pending', 'pending'])
    expect(progress({ phase: 'desktop-future' }).every(step => step.state === 'pending')).toBe(true)
    expect(progress({ phase: 'desktop-implement', hasSketch: false })[1]?.state).toBe('pending')
    expect(progress({ phase: 'desktop-verify', error: '检查失败' })[3]?.state).toBe('attention')
  })
})

describe('stage details are read-only and accessible', () => {
  it('focus/hover show distinct comics; Escape closes without reopening and returns focus', () => {
    const records = vi.fn()
    render(<WorkspaceProgress steps={progress({ phase: 'desktop-implement', busy: true })} onRecords={records} liveDetail="正在保存记录" />)
    const trigger = screen.getByRole('button', { name: '制作：进行中' })
    fireEvent.focus(trigger)
    expect(screen.getByRole('dialog', { name: '制作阶段详情' }).textContent).toContain('正在保存记录')
    const build = screen.getByRole('img', { name: '制作阶段三格小漫画' }).getAttribute('src')
    fireEvent.pointerEnter(screen.getByRole('button', { name: '需求：已结束' }))
    expect(screen.getByRole('img', { name: '需求阶段三格小漫画' }).getAttribute('src')).not.toBe(build)
    expect(records).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: '工作记录' }))
    expect(records).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('click pins details, permits expansion and closes on outside input', () => {
    render(<WorkspaceProgress steps={progress()} onRecords={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '界面：未开始' }))
    fireEvent.click(screen.getByRole('button', { name: '放大阶段漫画' }))
    expect(screen.getByRole('dialog').getAttribute('data-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '进展' }))
    expect(screen.queryByRole('img')).toBeNull()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

it('decorates only the latest actual reply and preserves text and draft when quiet changes', () => {
  const store = createStore()
  store.set(currentProjectAtom, project)
  store.set(workflowStageAtom, 'sketch_ready')
  store.set(activeAgentSessionIdAtom, 'character-replies')
  const long = Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 项：这是完整的实际回答。`).join('\n')
  store.set(agentMessagesFamily('character-replies'), [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '做一个笔记工具' }], timestamp: 1 },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '先确认范围' }], timestamp: 2 },
    { id: 'a2', role: 'assistant', content: [{ type: 'text', text: long }], timestamp: 3 },
  ])
  render(<Provider store={store}><ChatPanel presentation="theatre" /></Provider>)
  expect(document.querySelectorAll('[data-character="true"]')).toHaveLength(1)
  expect(document.querySelector('[data-character="true"]')?.textContent).toContain(long)
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: '未发出的意见' } })
  fireEvent.click(screen.getByRole('button', { name: '收起人物' }))
  expect(document.querySelectorAll('.conversation-reply-character')).toHaveLength(0)
  expect((input as HTMLTextAreaElement).value).toBe('未发出的意见')
  fireEvent.click(screen.getByRole('button', { name: '显示人物' }))
  expect(document.querySelectorAll('.conversation-reply-character')).toHaveLength(1)
  expect(screen.getByRole('textbox')).toBe(input)
})
