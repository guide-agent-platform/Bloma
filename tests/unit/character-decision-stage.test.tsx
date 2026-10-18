// @vitest-environment jsdom
import React from 'react'
import { createStore, Provider } from 'jotai'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CharacterDecisionStage } from '../../renderer/components/CharacterDecisionStage'
import { SketchCharacterReminder } from '../../renderer/components/SketchCharacterReminder'
import { WorkspaceShell } from '../../renderer/components/WorkspaceShell'
import { activeAgentSessionIdAtom, currentProjectAtom, workflowStageAtom, prdConfirmFamily } from '../../renderer/agent-atoms'
import type { Project } from '../../shared/types'

const animate = vi.fn(() => ({ cancel: vi.fn() }))
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
beforeEach(() => {
  sessionStorage.clear()
  animate.mockClear()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup(); sessionStorage.clear(); vi.unstubAllGlobals()
  if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate)
  else Reflect.deleteProperty(Element.prototype, 'animate')
})
const flush = () => act(async () => { await Promise.resolve() })

describe('character-led decision presentation', () => {
  it('survives StrictMode, never confirms automatically and keeps the real form action', async () => {
    const confirm = vi.fn(), cue = { id: crypto.randomUUID() }
    const view = render(<React.StrictMode><CharacterDecisionStage kind="prd" cue={cue}><section role="dialog"><input aria-label="修改意见" /><button onClick={confirm}>真实确认</button></section></CharacterDecisionStage></React.StrictMode>)
    await flush()
    expect(animate).toHaveBeenCalledTimes(2)
    expect(confirm).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '保留我的修改' } })
    fireEvent.pointerDown(screen.getByRole('button', { name: '真实确认' }))
    fireEvent.click(screen.getByRole('button', { name: '真实确认' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('保留我的修改')
    view.unmount()
    expect(animate.mock.results.every(result => result.value.cancel.mock.calls.length > 0)).toBe(true)
  })

  it('does not replay the same decision on revisit; a new decision has its own reveal', async () => {
    const cue = { id: crypto.randomUUID() }
    const first = render(<CharacterDecisionStage kind="clarify" cue={cue}><button>选择</button></CharacterDecisionStage>)
    await flush(); expect(animate).toHaveBeenCalledTimes(2)
    first.unmount(); animate.mockClear()
    const second = render(<CharacterDecisionStage kind="clarify" cue={cue}><button>选择</button></CharacterDecisionStage>)
    await flush(); expect(animate).not.toHaveBeenCalled()
    second.rerender(<CharacterDecisionStage kind="clarify" cue={{ id: crypto.randomUUID() }}><button>选择</button></CharacterDecisionStage>)
    await flush(); expect(animate).toHaveBeenCalledTimes(2)
  })

  it('reduced motion keeps the character and interactive content static', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    render(<CharacterDecisionStage kind="requirements" cue={crypto.randomUUID()}><button>确认需求</button></CharacterDecisionStage>)
    await flush()
    expect(animate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '确认需求' })).toBeTruthy()
  })

  it('the sketch cue is only a dismissible character and one sentence, and a new sketch can remind again', async () => {
    const cue = crypto.randomUUID()
    const view = render(<SketchCharacterReminder cue={cue} />)
    await flush()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '收起角色提醒' }))
    expect(screen.queryByLabelText('人物草图提醒')).toBeNull()
    view.rerender(<SketchCharacterReminder cue={crypto.randomUUID()} />)
    await flush()
    expect(screen.getByRole('status').textContent).toBe('草图准备好啦，看看是不是你想要的？')
  })

  it('recognizes the current UX confirmation action without treating an MVP review as a sketch', async () => {
    const store = createStore(), confirm = vi.fn()
    store.set(activeAgentSessionIdAtom, 'character-gate')
    store.set(currentProjectAtom, { project_id: crypto.randomUUID(), name: '测试', mode: 'longterm' } as Project)
    store.set(workflowStageAtom, 'clarifying')
    const view = render(<Provider store={store}><WorkspaceShell previewUrl="bloma-file://p/00_UX/confirmed.html" cardOptions={[{ id: 'ux_confirm_go', label: '确认草图' }]} onConfirmSketch={confirm} /></Provider>)
    await flush()
    expect(screen.getByLabelText('人物草图提醒')).toBeTruthy()
    expect(confirm).not.toHaveBeenCalled()
    view.rerender(<Provider store={store}><WorkspaceShell previewUrl="bloma-file://p/review.html" cardOptions={[{ id: 'mvp_confirm_go', label: '确认试用' }]} onConfirmSketch={confirm} /></Provider>)
    expect(screen.queryByLabelText('人物草图提醒')).toBeNull()
    view.rerender(<Provider store={store}><WorkspaceShell previewUrl="bloma-file://p/00_UX/confirmed.html" cardOptions={[{ id: 'ux_confirm_go', label: '确认草图' }]} onConfirmSketch={confirm} /></Provider>)
    act(() => store.set(prdConfirmFamily('character-gate'), { title: '确认需求' } as never))
    expect(screen.queryByLabelText('人物草图提醒')).toBeNull()
  })
})
