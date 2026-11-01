import { expect, it } from 'vitest';
import { createIpcHarness } from '../support/ipc-harness';
import { useTemporaryPromaHome } from '../support/test-environment';
import { findProject, updateProject } from '../../../main/project/project-service';
import {registerBackgroundRun,unregisterBackgroundRun} from '../../../main/orchestration/stages/run-registry';
import type { ApiResult, Project } from '../../../shared/types';
it('cannot mark an undelivered software project completed through the finalize IPC', async () => {
    const env = useTemporaryPromaHome('bloma-finalize-accept-');
    try {
        const ipc = createIpcHarness(), created = await ipc.invoke('project:create', { request_id: 'create', mode: 'quick' }) as ApiResult<Project>;
        expect(created.ok).toBe(true);
        if (!created.ok)
            throw Error('create failed');
        const id = created.data.project_id, result = await ipc.invoke('project:finalize', { request_id: 'finish', project_id: id, session_id: 's' }) as ApiResult<Project>;
        expect(result.ok).toBe(false);
        if(!result.ok)expect(result.error).toMatchObject({code:'PROJECT_NOT_DELIVERED',user_visible_message:'请先完成当前版本的制作和验证，再标记完成。'});
        expect(findProject(id)).toMatchObject({ status: 'active', current_stage: 'clarifying' });
    }
    finally {
        env.cleanup();
    }
});
it('does not finalize a previous delivered state while a new project run is active',async()=>{
 const env=useTemporaryPromaHome('bloma-finalize-busy-');let runId:string|undefined
 try{
  const ipc=createIpcHarness(),created=await ipc.invoke('project:create',{request_id:'create',mode:'quick'}) as ApiResult<Project>
  if(!created.ok)throw Error('create failed')
  const id=created.data.project_id;updateProject(id,{status:'active',current_stage:'completed'})
  runId=registerBackgroundRun('finalize-busy',new AbortController(),id,()=>{})
  const result=await ipc.invoke('project:finalize',{request_id:'finish',project_id:id,session_id:'s'}) as ApiResult<Project>
  expect(result.ok).toBe(false);if(!result.ok)expect(result.error.code).toBe('AGENT_PROJECT_BUSY')
  expect(findProject(id).status).toBe('active')
 }finally{if(runId)unregisterBackgroundRun('finalize-busy',runId);env.cleanup()}
})
