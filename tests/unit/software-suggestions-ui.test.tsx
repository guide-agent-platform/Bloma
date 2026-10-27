// @vitest-environment jsdom
import React from 'react'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { it, expect, vi, afterEach } from 'vitest'
import { Provider, createStore } from 'jotai'
import { SoftwareSuggestions } from '../../renderer/components/SoftwareSuggestions'
import { activeAgentSessionIdAtom, hasActiveStreamAtom, agentStreamStateFamily } from '../../renderer/agent-atoms'
import type { SoftwareSuggestions as Value } from '../../shared/types'
afterEach(cleanup)
it('shows optional choices and only submits an explicit user decision without changing the running task',async()=>{
  const value:Value={version:1,id:'set',project_id:'p',session_id:'s',scope:'scope',operation:'op',items:[{id:'S-1',title:'备份',description:'导出笔记',benefit:'保留数据',expected:'可导出',state:'offered'}]}
  const decideSuggestion=vi.fn(async()=>({ok:true,data:{suggestions:value,detail:'已记录选择'}}))
  window.electronAPI={projectDeliverables:{decideSuggestion}} as never
  const store=createStore();store.set(activeAgentSessionIdAtom,'s');store.set(agentStreamStateFamily('s'),value=>({...value,running:true}))
  render(<Provider store={store}><SoftwareSuggestions value={value} refresh={vi.fn()} /></Provider>)
  expect(decideSuggestion).not.toHaveBeenCalled();expect(screen.getByText(/可忽略/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'本轮采用'}))
  await waitFor(()=>expect(decideSuggestion).toHaveBeenCalledWith(expect.objectContaining({set_id:'set',suggestion_id:'S-1',action:'adopt'})))
  expect(store.get(hasActiveStreamAtom)).toBe(true)
})
