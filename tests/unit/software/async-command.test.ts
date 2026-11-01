import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { buildSoftwareExecutionTools } from '../../../main/software/execution-tools'
import { activeSoftwareCommands, readSoftwareProcess, softwareProcess, stopSoftwareSession } from '../../../main/software/process-manager'
import { createProcessOutput } from '../../../main/software/process-output'
import { createToolState, runAgentLoop, type ToolContext } from '../../../main/agent/loop/agent-loop'
import type { SDKQuery } from '../../../main/orchestration/stages/orchestration-contracts'
import { softwareStatusView } from '../../../main/software/state-view'
import { buildSoftwareVerifyTool } from '../../../main/software/verification-tool'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { guardDispatcherCompletion } from '../../../main/desktop/production-completion'

let home: string, previous: string | undefined, project: ReturnType<typeof createProject>, ctx: ToolContext
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-command-')); process.env.PROMA_HOME = home; project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }); ctx = { projectId: project.project_id, sessionId: 's', requestId: 'r', state: createToolState(), signal: new AbortController().signal } })
afterEach(async () => { await stopSoftwareSession(project.project_id, 's'); if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
const tools = () => Object.fromEntries(buildSoftwareExecutionTools(project.project_id).map(t => [t.name, t]))
async function finished(id: string) {
  let cursor = 0, result: Awaited<ReturnType<typeof readSoftwareProcess>>
  for (let i = 0; i < 15; i++) { result = await readSoftwareProcess(project.project_id, id, 's', cursor, 1000); cursor = result.next_seq; if (!['starting','running','stopping'].includes(result.state)) return result }
  throw Error('command did not finish')
}
it('keeps one real command alive, reads incremental UTF-8 logs, sends stdin/EOF and reports exit separately from product verification', async () => {
  writeFileSync(join(project.root_path, 'command.cjs'), `const fs=require('fs');fs.writeFileSync('starts.txt',String(Number(fs.existsSync('starts.txt')?fs.readFileSync('starts.txt'):0)+1));console.log('开始');process.stdout.write('api_key=PRIVATE_');setTimeout(()=>process.stdout.write('SECRET\\n'),50);let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>console.log('received:'+input.trim()));`)
  const t = tools(), started = await t.run_command.execute({ command: ['node', 'command.cjs'], yield_ms: 0, timeout_ms: 10000 }, ctx), id = JSON.parse(started.output).process_id
  expect(started.isError).not.toBe(true); expect(JSON.parse(started.output)).toMatchObject({ execution_status: 'running', task_completion: 'unverified' })
  let read = JSON.parse((await t.read_process.execute({ process_id: id, wait_ms: 3000 }, ctx)).output)
  expect(read.output.some((line: { text: string }) => line.text.includes('开始'))).toBe(true)
  if (!read.output.some((line: { text: string }) => line.text.includes('api_key='))) read = JSON.parse((await t.read_process.execute({ process_id: id, since_seq: read.next_seq, wait_ms: 1000 }, ctx)).output)
  expect(JSON.stringify(read.output)).toContain('[REDACTED]')
  const next = read.next_seq
  expect((await t.read_process.execute({ process_id: id }, { ...ctx, sessionId: 'foreign' })).isError).toBe(true)
  expect((await t.write_process.execute({ process_id: id, text: 'hello', close_stdin: true }, ctx)).isError).not.toBe(true)
  const complete = await finished(id); expect(complete.state).toBe('exited'); expect(complete.code).toBe(0)
  read = JSON.parse((await t.read_process.execute({ process_id: id, since_seq: next }, ctx)).output)
  expect(read).toMatchObject({ execution_status: 'completed', exit_code: 0, verification: 'not_applicable', task_completion: 'unverified' })
  expect(read.output.every((line: { seq: number }) => line.seq > next)).toBe(true)
  expect(read.stdout).toContain('received:hello'); expect(JSON.stringify(read)).not.toContain('PRIVATE_SECRET')
  expect(readFileSync(join(project.root_path, 'starts.txt'), 'utf8')).toBe('1')
}, 25000)
it('wait cancellation does not falsely resolve or restart the owned command; stop and timeout release its process', async () => {
  const t = tools(), command = ['node', '-e', 'setInterval(()=>{},1000)']
  const started = JSON.parse((await t.run_command.execute({ command, yield_ms: 0, timeout_ms: 10000 }, ctx)).output)
  const abort = new AbortController(), reason = Error('wait cancelled')
  const waiting = readSoftwareProcess(project.project_id, started.process_id, 's', 0, 5000, abort.signal)
  setTimeout(() => abort.abort(reason), 100); await expect(waiting).rejects.toBe(reason)
  expect(softwareProcess(project.project_id, started.process_id, 's').state).toBe('running')
  await t.stop_process.execute({ process_id: started.process_id }, ctx)
  expect((await finished(started.process_id)).completion_reason).toBe('cancelled')
  const timeout = JSON.parse((await t.run_command.execute({ command, yield_ms: 0, timeout_ms: 1500 }, ctx)).output)
  expect((await finished(timeout.process_id)).completion_reason).toBe('timeout')
  const view = JSON.parse((await t.read_process.execute({ process_id: timeout.process_id }, ctx)).output)
  expect(view).toMatchObject({ execution_status: 'failed', code: 'COMMAND_TIMEOUT' }); expect(activeSoftwareCommands(project.project_id, 's')).toEqual([])
}, 20000)
it('does not freeze or cancel unfinished commands when the model asks to finish or verify', async () => {
  const t = tools(), id = JSON.parse((await t.run_command.execute({ command: ['node', '-e', 'setInterval(()=>{},1000)'], yield_ms: 0, timeout_ms: 10000 }, ctx)).output).process_id
  const verifier = buildSoftwareVerifyTool(project.project_id, createSoftwareCollaborationPolicy(project.project_id, project.root_path, 's'))
  const result = await verifier.execute({ script: 'tests/not-created-yet.mjs' }, ctx)
  expect(JSON.parse(result.output).code).toBe('COMMANDS_STILL_RUNNING'); expect(result.feedback?.verification).toBe('unverified')
  expect(await guardDispatcherCompletion(ctx)).toContain(id); expect(softwareProcess(project.project_id, id, 's').state).toBe('running')
}, 20000)
it('never adopts or writes to a persisted PID from another host instance', async () => {
  const id = '11111111-1111-4111-8111-111111111111'; mkdirSync(join(home, 'software-processes'), { recursive: true })
  writeFileSync(join(home, 'software-processes', id + '.json'), JSON.stringify({ id, projectId: project.project_id, sessionId: 's', kind: 'command', state: 'running', pid: process.pid, output_seq: 0, stdout: '', stderr: '' }))
  const t = tools(), result = JSON.parse((await t.read_process.execute({ process_id: id, since_seq: 7 }, ctx)).output)
  expect(result).toMatchObject({ state: 'interrupted', code: 'COMMAND_HOST_INTERRUPTED' })
  expect(result.output_truncated).toBe(true)
  expect((await t.write_process.execute({ process_id: id, text: 'must not send' }, ctx)).isError).toBe(true)
  expect(process.kill(process.pid, 0)).toBe(true)
})
it('buffers split UTF-8 and credential lines and marks bounded output with a monotonic cursor', () => {
  const buffer = createProcessOutput(text => text.replace(/api_key=\S+/g, 'api_key=[REDACTED]'))
  const chinese = Buffer.from('中文\n'); buffer.push('stdout', chinese.subarray(0, 2)); buffer.push('stdout', chinese.subarray(2))
  buffer.push('stderr', Buffer.from('api_key=PRIVATE_')); expect(buffer.snapshot().output).toHaveLength(1)
  buffer.push('stderr', Buffer.from('SECRET\n')); expect(JSON.stringify(buffer.snapshot())).not.toContain('PRIVATE')
  expect(buffer.snapshot().output[0].text).toBe('中文\n')
  for (let i = 0; i < 300; i++) buffer.push('stdout', Buffer.from('log ' + i + '\n'))
  expect(buffer.snapshot().output_seq).toBe(302); expect(buffer.snapshot().output.length).toBeLessThanOrEqual(256)
})
it('lets a real Pi session continue reading one async command without replaying it or claiming product delivery', async () => {
  writeFileSync(join(project.root_path, 'once.cjs'), `const fs=require('fs');fs.appendFileSync('once.txt','1');console.log('working');setTimeout(()=>console.log('finished'),700)`)
  let id: string | undefined, cursor = 0, calls = 0
  const query: SDKQuery = async function* (_, options) {
    const blocks = options.messages?.flatMap(message => Array.isArray(message.content) ? message.content : []) ?? []
    const last = [...blocks].reverse().find(block => block.type === 'tool_result')
    if (last?.type === 'tool_result' && typeof last.content === 'string') {
      const value = JSON.parse(last.content.replace(/^<tool-feedback>[\s\S]*?<\/tool-feedback>\s*/, ''))
      id = value.process_id; cursor = value.next_seq
      if (value.execution_status === 'completed') {
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'command finished; product remains unverified' }] } }
        yield { type: 'result', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }; return
      }
    }
    const name = id ? 'read_process' : 'run_command', input = id ? { process_id: id, since_seq: cursor, wait_ms: 1000 } : { command: ['node','once.cjs'], yield_ms: 0, timeout_ms: 10000 }
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c' + (++calls), name, input }] } }
    yield { type: 'result', stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } }
  }
  const result = await runAgentLoop({ runtimeScope: 'async-command-test', projectId: project.project_id, sessionId: 's', requestId: 'r',
    system: 'run fixture once and read it', task: 'finish command', query, env: {}, tools: buildSoftwareExecutionTools(project.project_id), maxTokens: 1000, maxTurns: 10,
    permissionMode: 'allow-all', workMode: 'implementation', signal: ctx.signal, publish: () => {}, beforeComplete: guardDispatcherCompletion })
  expect(result.status).toBe('completed'); expect(result.toolCalls.filter(call => call.name === 'run_command')).toHaveLength(1)
  expect(result.toolCalls.some(call => call.name === 'read_process')).toBe(true)
  expect(readFileSync(join(project.root_path, 'once.txt'), 'utf8')).toBe('1'); expect(softwareStatusView(project.project_id, false).goal.status).toBe('not_delivered')
}, 60000)
