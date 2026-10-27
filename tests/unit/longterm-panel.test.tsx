// @vitest-environment jsdom
import React from 'react'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { it, expect, vi, afterEach } from 'vitest'
import { createStore, Provider } from 'jotai'
import { activeAgentSessionIdAtom, agentStreamStateFamily } from '../../renderer/agent-atoms'
import { LongtermProjectPanel } from '../../renderer/components/LongtermProjectPanel'
import { workspaceScene } from '../../renderer/lib/workspace-scene'
import { deriveWorkspaceProgress } from '../../renderer/lib/workspace-progress'
import { longtermStatusLabel } from '../../renderer/lib/project-status'
import type { LongtermProjectState, Project } from '../../shared/types'
afterEach(cleanup)
const value=():LongtermProjectState=>({version:1,project_id:'p',revision:3,current_id:'m',milestones:[{id:'m',title:'本阶段目标',scope_hash:'a'.repeat(64),session_id:'s',operation_id:'op',status:'awaiting_confirmation',features:[{id:'F-001',description:'保存',expected:'可读回'}],candidate_id:'b'.repeat(64),created_at:new Date().toISOString()}],backlog:[{id:'S-1',title:'导出',description:'导出备份',benefit:'保留副本',expected:'文件含记录',origin_scope:'a'.repeat(64),state:'deferred',at:new Date().toISOString()}],decisions:[]})
function panel(state=value(),sid='s',busy=false,archived=false){
  const store=createStore();store.set(activeAgentSessionIdAtom,sid);store.set(agentStreamStateFamily(sid),prior=>({...prior,running:busy}))
  const action=vi.fn(async()=>({ok:true,data:{state,detail:'本阶段已确认'}}));window.electronAPI={projectDeliverables:{longtermAction:action}} as never
  render(<Provider store={store}><LongtermProjectPanel projectId="p" state={state} refresh={vi.fn()} archived={archived}/></Provider>);return{store,action}
}
it('shows the pending version and backlog without adopting work, and sends only explicit revision-bound confirmation',async()=>{
  const{action}=panel();expect(action).not.toHaveBeenCalled();expect(screen.getByText('本阶段待核对')).toBeTruthy();expect(screen.getAllByText(/bbbbbbbbbbbb/).length).toBeGreaterThan(0)
  expect((screen.getByRole('button',{name:'纳入下一轮并确认'}) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button',{name:'确认本阶段，保留版本'}));await waitFor(()=>expect(action).toHaveBeenCalledWith(expect.objectContaining({project_id:'p',session_id:'s',revision:3,action:'confirm'})))
})
it('keeps foreign-session and archived views read-only',()=>{
  const{action}=panel(value(),'other',false,true)
  expect((screen.getByRole('button',{name:'确认本阶段，保留版本'}) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/仅查看记录/)).toBeTruthy();expect(action).not.toHaveBeenCalled()
})
it('defers updates while a writer is active and renders restored decisions/version records',()=>{
  const state=value();state.milestones[0].status='delivered';state.decisions=[{id:'d',decision:'保持格式',reason:'保留迁移路径',author:'agent',scope:'a'.repeat(64),at:new Date().toISOString()}]
  panel(state,'s',true);expect((screen.getByRole('button',{name:'纳入下一轮并确认'}) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText('保持格式')).toBeTruthy();expect(screen.getByText('本阶段已交付')).toBeTruthy()
})
it('projects milestone state without presenting pending review or a backlog as a finished whole product',()=>{
  const project={mode:'longterm',workflow_version:'software-v1',status:'active',current_stage:'blocked_for_user_decision',desktop_phase:'desktop-verify',longterm_summary:{status:'awaiting_confirmation',pending_items:1}} as Project
  expect(workspaceScene(project,project.current_stage,project.desktop_phase!,false).title).toBe('本阶段待你核对')
  expect(deriveWorkspaceProgress({project,stage:project.current_stage,phase:project.desktop_phase!,busy:false})[4]).toMatchObject({state:'attention',detail:expect.stringContaining('核对')})
  project.status='completed';project.current_stage='completed';project.desktop_phase='delivered';project.longterm_summary!.status='backlog_pending'
  expect(longtermStatusLabel(project)).toBe('阶段已交付 · 待办 1');expect(workspaceScene(project,project.current_stage,project.desktop_phase,false).title).toBe('本阶段已交付')
})
