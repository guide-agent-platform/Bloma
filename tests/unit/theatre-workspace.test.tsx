// @vitest-environment jsdom
import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../renderer/components/ChatPanel'
import { activeAgentSessionIdAtom, agentMessagesFamily, currentProjectAtom, globalUserErrorAtom } from '../../renderer/agent-atoms'
import { workspaceScene } from '../../renderer/lib/workspace-scene'
import type { Project } from '../../shared/types'
afterEach(() => { cleanup(); delete window.electronAPI })
describe('软件剧场的完整性', () => {
  it('完整历史切换保留输入；长回复可展开，错误不会进入折叠摘要', () => {
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
    const details=document.querySelector('[data-ai-id="compact-reply"]') as HTMLDetailsElement
    expect(details.open).toBe(false)
    fireEvent.click(details.querySelector('summary')!)
    expect(details.textContent).toContain('未验证的窗口关闭行为仍需确认')
    fireEvent.click(screen.getByRole('button',{name:/完整对话/}))
    expect(screen.getByText('最开始的需求')).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('不能丢失的草稿')
    expect(screen.getByRole('textbox')).toBe(input)
  })
  it('desktop delivered 但项目未 completed 时不宣称已交付，暂停不伪装继续制作', () => {
    const project={status:'active',current_stage:'clarifying',desktop_phase:'delivered'} as Project
    expect(workspaceScene(project,'clarifying','delivered',false).title).toBe('先亲自试一试。')
    expect(workspaceScene({...project,desktop_blocked:{reason:'user-stop',at:'now'}},'clarifying','desktop-implement',false).title).toContain('停一下')
    expect(workspaceScene({...project,status:'completed'},'completed','delivered',false).title).toContain('属于你')
  })
})
