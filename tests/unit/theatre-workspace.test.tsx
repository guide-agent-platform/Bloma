// @vitest-environment jsdom
import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../renderer/components/ChatPanel'
import { WorkspaceShell } from '../../renderer/components/WorkspaceShell'
import { workflowStageAtom } from '../../renderer/components/atoms'
import { activeAgentSessionIdAtom, agentMessagesFamily, currentProjectAtom, globalUserErrorAtom } from '../../renderer/agent-atoms'
import { workspaceScene } from '../../renderer/lib/workspace-scene'
import type { Project } from '../../shared/types'
afterEach(() => { cleanup(); delete window.electronAPI })
describe('软件剧场的完整性', () => {
  it('the footer keeps the real sketch confirmation callback and disables it only while confirming', () => {
    const store = createStore()
    store.set(currentProjectAtom, { project_id: 'footer-project', name: '测试草图', mode: 'quick' } as Project)
    store.set(workflowStageAtom, 'sketch_ready')
    const confirm = vi.fn()
    const view = render(<Provider store={store}><WorkspaceShell previewUrl="bloma-file://footer-project/00_UX/ux-sketch.html" onConfirmSketch={confirm} /></Provider>)
    const button = document.querySelector('[data-ai-id="confirm-sketch-button"]') as HTMLButtonElement
    expect(document.querySelectorAll('[data-ai-id="confirm-sketch-button"]')).toHaveLength(1)
    expect(button.closest('.studio-footer')).toBeTruthy()
    fireEvent.click(button)
    expect(confirm).toHaveBeenCalledTimes(1)
    view.rerender(<Provider store={store}><WorkspaceShell previewUrl="bloma-file://footer-project/00_UX/ux-sketch.html" onConfirmSketch={confirm} confirming /></Provider>)
    expect(button.disabled).toBe(true)
  })
  it('完整历史切换保留输入；回复不截断折叠，错误直接可见', () => {
    const store=createStore()
    store.set(activeAgentSessionIdAtom,'s'); store.set(currentProjectAtom,{project_id:'p'} as Project)
    store.set(globalUserErrorAtom,'启动失败：尚未验证，请重试')
    store.set(agentMessagesFamily('s'),[
      {role:'user',content:[{type:'text',text:'最开始的需求'}],timestamp:1},
      {role:'assistant',content:[{type:'text',text:'很早的回答'}],timestamp:2},
      {role:'user',content:[{type:'text',text:'这一次的修改'}],timestamp:3},
      {role:'assistant',content:[{type:'text',text:'当前结果。\n\n'+Array.from({length:40},(_,i)=>`验收条件 ${i+1}：记录内容应与输入一致。`).join('\n')+'\n未验证的窗口关闭行为仍需确认。'}],timestamp:4},
    ])
    Element.prototype.scrollIntoView=vi.fn()
    render(<Provider store={store}><ChatPanel presentation="theatre" /></Provider>)
    const input=screen.getByRole('textbox')
    fireEvent.change(input,{target:{value:'不能丢失的草稿'}})
    expect(screen.queryByText('最开始的需求')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('尚未验证')
    expect(document.querySelector('[data-ai-id="compact-reply"]')).toBeNull()
    expect(document.body.textContent).toContain('未验证的窗口关闭行为仍需确认')
    fireEvent.click(screen.getByRole('button',{name:/完整对话/}))
    expect(screen.getByText('最开始的需求')).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('不能丢失的草稿')
    expect(screen.getByRole('textbox')).toBe(input)
  })
  it('desktop delivered 但项目未 completed 时不宣称已交付，暂停不伪装继续制作', () => {
    const project={status:'active',current_stage:'clarifying',desktop_phase:'delivered'} as Project
    expect(workspaceScene(project,'clarifying','delivered',false).title).toBe('先试一试')
    expect(workspaceScene({...project,desktop_blocked:{reason:'user-stop',at:'now'}},'clarifying','desktop-implement',false).title).toBe('制作暂时停止')
    expect(workspaceScene({...project,desktop_blocked:{reason:'user-stop',at:'now'}},'clarifying','desktop-implement',false,true).title).toBe('制作')
    expect(workspaceScene({...project,status:'completed'},'completed','delivered',false).title).toBe('你的软件')
  })
})
