// @vitest-environment jsdom
import { createStore } from 'jotai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { submitInitialProjectIdea } from '../../renderer/lib/initial-project-idea'
import { composerDraftFamily } from '../../renderer/composer-state'
import type { ElectronAPI, Project } from '../../shared/types'
import type { ChatSubmitInput } from '../../shared/attachment-types'
const project={project_id:'p',mode:'longterm',current_stage:'clarifying'} as Project
afterEach(() => { delete window.electronAPI })
describe('想法入口首次消息', () => {
  it('先持久保存待确认身份再 submit；接收后清理草稿，首条话真正进入聊天通道', async () => {
    const store=createStore(), calls:string[]=[]
    const save=vi.fn(async ({draft}) => { calls.push(draft.pending_send?'save-pending':'save-cleared'); return {ok:true,data:draft} })
    const submit=vi.fn(async input => { calls.push('submit'); expect(store.get(composerDraftFamily('p|s')).pending_send?.client_message_id).toBe(input.client_message_id); return {ok:true,data:{client_message_id:input.client_message_id,status:'accepted'}} })
    window.electronAPI={composer:{save,submit}} as unknown as ElectronAPI
    const receipt=vi.fn()
    await submitInitialProjectIdea(project,'s','我想做一本离线读书摘记',store,receipt)
    expect(calls).toEqual(['save-pending','submit','save-cleared'])
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({mode:'longterm',project_id:'p',session_id:'s',content:'我想做一本离线读书摘记',draft_id:'draft-s'}))
    expect(receipt).toHaveBeenCalledOnce()
    expect(store.get(composerDraftFamily('p|s')).text).toBe('')
  })
  it('接收失败保留原文字与 client_message_id，供既有 composer 重试', async () => {
    const store=createStore()
    const submit=vi.fn(async (_input: ChatSubmitInput) => { throw new Error('网络中断') })
    window.electronAPI={composer:{save:vi.fn(async ({draft})=>({ok:true,data:draft})),submit}} as unknown as ElectronAPI
    const receipt=vi.fn()
    await expect(submitInitialProjectIdea(project,'s','关掉重开还在',store,receipt)).rejects.toThrow('网络中断')
    const draft=store.get(composerDraftFamily('p|s'))
    expect(draft.text).toBe('关掉重开还在')
    expect(draft.pending_send?.client_message_id).toBe(submit.mock.calls[0]?.[0]?.client_message_id)
    expect(receipt).not.toHaveBeenCalled()
  })
  it('接收在途的新输入不被首条消息的清理覆盖', async () => {
    const store=createStore()
    window.electronAPI={composer:{save:vi.fn(async ({draft})=>({ok:true,data:draft})),submit:vi.fn(async input => {
      const atom=composerDraftFamily('p|s'), current=store.get(atom)
      store.set(atom,{...current,text:'再加一个搜索',revision:current.revision+1})
      return {ok:true,data:{client_message_id:input.client_message_id,status:'accepted'}}
    })}} as unknown as ElectronAPI
    await submitInitialProjectIdea(project,'s','读书摘记',store,vi.fn())
    expect(store.get(composerDraftFamily('p|s')).text).toBe('再加一个搜索')
    expect(store.get(composerDraftFamily('p|s')).pending_send).toBeUndefined()
  })
})
