// @vitest-environment jsdom
import React from 'react'
import {createStore,Provider} from 'jotai'
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {PreviewPanel} from '../../renderer/components/PreviewPanel'
import {activeAgentSessionIdAtom,currentProjectAtom,workflowStageAtom} from '../../renderer/agent-atoms'
afterEach(()=>{cleanup();delete(window as unknown as {electronAPI?:unknown}).electronAPI})
it('accepts picks only from its iframe and retries a rejected submission with the same durable identity',async()=>{
  const submit=vi.fn().mockResolvedValueOnce({ok:false,error:{message:'busy'}}).mockResolvedValueOnce({ok:true,data:{status:'accepted'}})
  ;(window as unknown as {electronAPI:unknown}).electronAPI={composer:{submit}}
  const store=createStore();store.set(currentProjectAtom,{project_id:'p',current_stage:'sketch_ready',mode:'quick'} as never);store.set(activeAgentSessionIdAtom,'s');store.set(workflowStageAtom,'sketch_ready')
  const {container}=render(<Provider store={store}><PreviewPanel status="running" previewUrl="bloma-file://p/00_UX/sketch.html" onConfirmSketch={()=>{}} /></Provider>)
  const frame=container.querySelector('iframe')!
  const payload={label:'bloma-sketch-pick',pick:{seq:1,kindLabel:'外观',target:'#save',text:'保存',note:'改为紫色'}}
  act(()=>window.dispatchEvent(new MessageEvent('message',{source:window,data:payload})))
  expect(screen.queryByText('发送调整意见')).toBeNull()
  act(()=>window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:payload})))
  fireEvent.click(await screen.findByText('发送调整意见'))
  await screen.findByText('修改意见未被接收，点选已保留，请重试')
  fireEvent.click(screen.getByText('发送调整意见'))
  await waitFor(()=>expect(submit).toHaveBeenCalledTimes(2))
  expect(submit.mock.calls[0][0]).toMatchObject({project_id:'p',session_id:'s',metadata:{source:'sketch_correction'},content:expect.stringContaining('改为紫色')})
  expect(submit.mock.calls[1][0].client_message_id).toBe(submit.mock.calls[0][0].client_message_id)
  await waitFor(()=>expect(screen.queryByText('发送调整意见')).toBeNull())
})
