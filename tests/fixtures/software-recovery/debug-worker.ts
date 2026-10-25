import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createProject } from '../../../main/project/project-service'
import { buildSoftwareInspectTool } from '../../../main/software/inspect-tool'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { createToolState } from '../../../main/agent/loop/agent-loop'
import { closeDebugSessions } from '../../../main/software/debug-sessions'

export async function main() {
  const home = process.env.SOFTWARE_CRASH_HOME!, phase = process.env.SOFTWARE_CRASH_PHASE!, port = process.env.SOFTWARE_CRASH_PORT!
  process.env.PROMA_HOME = home; app.setPath('userData', join(home, `profile-${phase}`)); await app.whenReady()
  const first = phase === 'before'
  const project = first ? createProject({ request_id: 'c', mode: 'longterm' }, { workflowVersion: 'software-v1' })
    : JSON.parse(readFileSync(join(home, 'identity.json'), 'utf8'))
  if (first) {
    writeFileSync(join(project.root_path, 'app.cjs'), `const fs=require('fs'),path=require('path'),file=path.join(process.env.APP_DATA_DIR,'count');require('http').createServer((q,s)=>{if(q.url==='/inc'){fs.writeFileSync(file,String(Number(fs.existsSync(file)?fs.readFileSync(file):0)+1));s.end('ok')}else if(q.url==='/count')s.end(fs.existsSync(file)?fs.readFileSync(file):'0');else{s.setHeader('Content-Type','text/html');s.end('<title>Durable debug</title><input id="draft"><button id="inc">Add</button><p id="count"></p><script>draft.value=localStorage.getItem("draft")||"";draft.oninput=()=>localStorage.setItem("draft",draft.value);async function refresh(){count.textContent=await(await fetch("/count")).text()}inc.onclick=async()=>{await fetch("/inc");await refresh()};refresh()</script>')}}).listen(${port},'127.0.0.1')`)
    writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, ui: 'browser', command: ['node', 'app.cjs'], url: `http://127.0.0.1:${port}` }))
    writeFileSync(join(home, 'identity.json'), JSON.stringify(project))
  }
  const tool = buildSoftwareInspectTool(project.project_id, createSoftwareCollaborationPolicy(project.project_id, project.root_path, 'debug-crash'))
  const ctx = { projectId: project.project_id, sessionId: 'debug-crash', requestId: phase, state: createToolState(), signal: AbortSignal.timeout(90000) }
  if (first) {
    const result = await tool.execute({ steps: [{ id: 'inc', kind: 'click', selector: '#inc' }, { id: 'count', kind: 'expect', selector: '#count', equals: '1' },
      { id: 'draft', kind: 'fill', selector: '#draft', value: 'survived actual host crash' }] }, ctx)
    assert(!result.isError, result.output)
    writeFileSync(join(home, 'ready.json'), JSON.stringify({ ...JSON.parse(result.output), pid: process.pid }))
    setInterval(() => {}, 1000)
    await new Promise<void>(() => {}) // Parent test must terminate this live host.
  } else {
    const old = JSON.parse(readFileSync(join(home, 'ready.json'), 'utf8'))
    const result = await tool.execute({ mode: 'act', debug_session_id: old.debug_session_id, steps: [
      { id: 'count-kept', kind: 'expect', selector: '#count', equals: '1' },
      { id: 'browser-kept', kind: 'expect', property: 'value', selector: '#draft', equals: 'survived actual host crash' }] }, ctx)
    assert(!result.isError, result.output)
    const value = JSON.parse(result.output)
    assert.notEqual(value.debug_session_id, old.debug_session_id); assert.equal(value.resumed_from, old.debug_session_id); assert.equal(value.data_dir, old.data_dir)
    await closeDebugSessions(project.project_id, 'debug-crash')
    writeFileSync(join(home, 'resumed.json'), JSON.stringify({ status: 'passed', pid: process.pid, old_id: old.debug_session_id, new_id: value.debug_session_id, data_dir: value.data_dir }))
    app.quit()
  }
}
