// @vitest-environment jsdom
import React from 'react'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { afterEach, it, expect, vi } from 'vitest'
import { SoftwareModelSettingsPanel } from '../../renderer/components/SoftwareModelSettingsPanel'
import { currentProjectAtom } from '../../renderer/agent-atoms'
import type { SoftwareModelSettings } from '../../shared/types'
afterEach(cleanup)
const state: SoftwareModelSettings={project_id:'p',revision:'revision',variant:'single',locked:false,channels:[{id:'b',name:'渠道 B',models:['model-b']}],design_status:'not_prepared',admission:'not_checked'}
function setup(value=state){
  const save=vi.fn(async input=>({ok:true,data:{...value,variant:input.variant,channel_id:input.channel_id,model:input.model}}))
  Object.assign(window,{electronAPI:{projectDeliverables:{modelSettings:vi.fn(async()=>({ok:true,data:value})),saveModelSettings:save}}})
  const store=createStore();store.set(currentProjectAtom,{project_id:'p',workflow_version:'software-v1',name:'测试项目'} as never)
  render(<Provider store={store}><SoftwareModelSettingsPanel /></Provider>);return save
}
it('requires explicit consent, resets it when the budget changes and sends exact project configuration',async()=>{
  const save=setup();await screen.findByText('预算准入：开工时检查 · 设计：尚未准备')
  fireEvent.click(screen.getByRole('radio',{name:/A＋B/}))
  fireEvent.change(screen.getByLabelText('B 的渠道'),{target:{value:'b'}});fireEvent.change(screen.getByLabelText('B 的模型'),{target:{value:'model-b'}})
  for(const [label,value]of [['B 独立设计预算','1'],['上下文上限','4096'],['输入单价','1'],['输出单价','2']])fireEvent.change(screen.getByLabelText(label),{target:{value}})
  expect((screen.getByRole('button',{name:'保存并授权 B 预算'}) as HTMLButtonElement).disabled).toBe(true)
  const consent=screen.getByRole('checkbox');fireEvent.click(consent)
  fireEvent.change(screen.getByLabelText('B 独立设计预算'),{target:{value:'2'}});expect((consent as HTMLInputElement).checked).toBe(false)
  fireEvent.click(consent);fireEvent.click(screen.getByRole('button',{name:'保存并授权 B 预算'}))
  await waitFor(()=>expect(save).toHaveBeenCalledTimes(1))
  expect(save.mock.calls[0][0]).toMatchObject({project_id:'p',revision:'revision',variant:'independent',channel_id:'b',model:'model-b',authorize_budget:true,budget:{cap_rmb:2}})
  await screen.findByText(/配置已保存；未调用模型/)
})
it('renders locked state and cannot save even through form submission',async()=>{
  const save=setup({...state,locked:true,lock_reason:'RUN_ALREADY_STARTED'})
  await screen.findByText(/本轮已开始或已登记对照/)
  fireEvent.submit(screen.getByRole('form',{name:'项目验收模型配置'}));expect(save).not.toHaveBeenCalled()
  expect((screen.getByRole('button',{name:'保存仅 A 的验收配置'}) as HTMLButtonElement).disabled).toBe(true)
})
it('shows a failed read instead of presenting an editable default single-model selection',async()=>{
  Object.assign(window,{electronAPI:{projectDeliverables:{modelSettings:vi.fn(async()=>({ok:false,error:{message:'配置损坏'}}))}}})
  const store=createStore();store.set(currentProjectAtom,{project_id:'bad',workflow_version:'software-v1'} as never)
  render(<Provider store={store}><SoftwareModelSettingsPanel /></Provider>)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent','配置损坏')
  expect((screen.getByRole('button',{name:'保存仅 A 的验收配置'}) as HTMLButtonElement).disabled).toBe(true)
})
