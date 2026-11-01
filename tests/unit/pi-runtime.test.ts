import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '../../shared/types'
import type { SDKQueryOptions, SDKQuery } from '../../main/orchestration/stages/orchestration-contracts'
import { runAgentLoop, type AgentLoopInput, type AgentLoopTool } from '../../main/agent/loop/agent-loop'
import { openPiSession, piSessionPath } from '../../main/agent/loop/pi-session-store'
import { emptyAssistant } from '../../main/agent/loop/pi-messages'
import { createProductionBudget } from '../../main/desktop/production-budget'
import { enqueueSteer } from '../../main/agent/loop/steer-queue'
import { AssistantTurnCollector } from '../support/assistant-turn-collector'

let home: string, oldHome: string | undefined
beforeEach(() => { oldHome = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-pi-')); process.env.PROMA_HOME = home })
afterEach(() => {
  if (oldHome === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = oldHome
  rmSync(home, { recursive: true, force: true })
})
const text = (text: string): SDKMessage => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const call = (id: string, name: string, input: Record<string, unknown> = {}): SDKMessage => ({ type: 'assistant', message: {
  role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const done: SDKMessage = { type: 'result', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20 } }
function scripted(scripts: SDKMessage[][]) {
  const received: SDKQueryOptions[] = []
  const query: SDKQuery = async function* (_prompt, options) {
    received.push(options)
    const script = scripts[Math.min(received.length - 1, scripts.length - 1)]
    for (const item of script) yield item
    yield done
  }
  return { query, received }
}
function input(query: SDKQuery, extra: Partial<AgentLoopInput> = {}): AgentLoopInput {
  return { runtime: 'pi', runtimeScope: 'desktop-implement', projectId: 'test-project', sessionId: 'test-session', requestId: 'r1',
    system: 'test controlled system', task: '完成一个最小修改并验证', tools: [], query, env: {}, maxTokens: 1000, maxTurns: 5,
    permissionMode: 'allow-all', signal: new AbortController().signal, publish: vi.fn(), ...extra }
}
function tool(name: string, execute: AgentLoopTool['execute']): AgentLoopTool {
  return { name, description: name, input_schema: { type: 'object', properties: {} }, execute }
}
function nativeFile() { return piSessionPath('test-project', 'test-session', 'desktop-implement:', process.cwd()) }

describe('real upstream Pi AgentSession integration', () => {
  it.each(['pi', undefined] as const)('stops repeated host failures despite intervening successful commands (runtime=%s)', async runtime => {
    const scripts: SDKMessage[][] = Array.from({ length: 8 }, (_, i) => [call('print-' + i, 'run_command'), call('failed-' + i, 'verify_app')])
    const source = scripted([...scripts, [text('must not reach completion')]])
    const result = await runAgentLoop(input(source.query, { runtime, maxTurns: 30, workMode: 'implementation', tools: [
      tool('run_command', async () => ({ output: '{"exit_code":0}' })),
      tool('verify_app', async () => ({ output: '{"failure":{"code":"GUI_EXISTING_EXPECTATIONS_CHANGED"}}', isError: true })),
    ] }))
    expect(result.status).toBe('budget_exhausted')
    expect(result.termination_detail).toMatchObject({ reason: 'no_progress', limit: 8, observed: 8 })
    expect(source.received).toHaveLength(8)
    expect(result.toolCalls.filter(c => c.name === 'verify_app').every(c => c.failureKey?.startsWith('GUI_EXISTING_EXPECTATIONS_CHANGED:'))).toBe(true)
  }, 60000)
  it('executes tools through Pi, pairs transport results, persists native history and reports real usage', async () => {
    const observed=vi.fn()
    const write = vi.fn(async () => ({ output: 'written', detail: { path: 'main.py' } }))
    const check = vi.fn(async () => ({ output: 'verified' }))
    const { query, received } = scripted([[call('w', 'write_file'), call('v', 'run_project_script')], [text('已修改并验证')]])
    const result = await runAgentLoop(input(query, { tools: [tool('write_file', write), tool('run_project_script', check)],onRuntimeObservation:observed,
      env:{ANTHROPIC_AUTH_TOKEN:'secret-not-in-identity',ANTHROPIC_MODEL:'fixture',ANTHROPIC_BASE_URL:'https://user:password@fixture.invalid/v1?key=private',ANTHROPIC_PROVIDER_TYPE:'fixture'} }))
    expect(observed).toHaveBeenCalledTimes(1)
    expect(observed.mock.calls[0][0]).toMatchObject({runtime:{engine:'pi',packages:{'pi-coding-agent':'0.85.1'}},settings:{contextWindow:128000,tool_execution:'sequential'},route:{model:'fixture',endpoint_origin:'https://fixture.invalid'},skills:{mode:'explicit-bloma',names:[]}})
    expect(JSON.stringify(observed.mock.calls)).not.toMatch(/secret-not-in-identity|password|key=private/)
    expect(result.status).toBe('completed')
    expect(write).toHaveBeenCalledTimes(1); expect(check).toHaveBeenCalledTimes(1)
    expect(result.files_changed).toEqual(['main.py'])
    expect(result.toolCalls).toMatchObject([{ name: 'write_file', status: 'ok' }, { name: 'run_project_script', status: 'ok' }])
    expect(received[1].messages?.at(-1)?.content).toMatchObject([{ type: 'tool_result', tool_use_id: 'w' }, { type: 'tool_result', tool_use_id: 'v' }])
    expect(result.usage).toMatchObject({ inputTokens: 60, outputTokens: 10, turnsWithUsage: 2 })
    const native = readFileSync(nativeFile(), 'utf8')
    expect(native).toContain('"type":"session"'); expect(native).toContain('"role":"toolResult"')
    expect(native).toContain('bloma-tool-receipt')
    expect(received.every(options => options.accounting?.scope === 'loop')).toBe(true)
  })

  it('resumes the native transcript without importing duplicate audit history or replaying writes', async () => {
    const write = vi.fn(async () => ({ output: 'durable-write-result' }))
    const first = scripted([[call('w', 'write_file')], [text('第一轮完成')]])
    await runAgentLoop(input(first.query, { tools: [tool('write_file', write)] }))
    const second = scripted([[text('沿用既有结果继续')]])
    await runAgentLoop(input(second.query, { task: '继续', requestId: 'r2', historyTurns: [{ role: 'user', content: 'DUPLICATE_AUDIT' }] }))
    const history = JSON.stringify(second.received[0].messages)
    expect(history).toContain('durable-write-result'); expect(history).not.toContain('DUPLICATE_AUDIT')
    expect(write).toHaveBeenCalledTimes(1)
    const other = scripted([[text('新阶段')]])
    await runAgentLoop(input(other.query, { runtimeScope: 'desktop-verify' }))
    expect(JSON.stringify(other.received[0].messages)).not.toContain('durable-write-result')
  })

  it.each([true, false])('recovers an interrupted tool without replaying it (receipt=%s), including a torn final append', async receipt => {
    const { manager, release } = await openPiSession('test-project', 'test-session', 'desktop-implement:', process.cwd())
    const assistant = emptyAssistant({ id: 'bridge', name: 'bridge', api: 'openai-completions', provider: 'bloma-transport',
      baseUrl: '', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 })
    assistant.content = [{ type: 'toolCall', id: 'crash', name: 'write_file', arguments: {} }]; assistant.stopReason = 'toolUse'
    const assistantEntryId = manager.appendMessage(assistant)
    manager.appendCustomEntry('bloma-tool-receipt', { id: 'crash', assistantEntryId: receipt ? assistantEntryId : 'stale-entry-id',
      name: 'write_file', content: 'already-written-before-crash', isError: false })
    release()
    appendFileSync(nativeFile(), '{"type":"message","incomplete":')
    const write = vi.fn(async () => ({ output: 'unexpected' }))
    const next = scripted([[text('恢复完成')]])
    await runAgentLoop(input(next.query, { tools: [tool('write_file', write)] }))
    expect(JSON.stringify(next.received[0].messages)).toContain(receipt ? 'already-written-before-crash' : '执行结果未知')
    expect(readdirSync(dirname(nativeFile())).some(file => file.includes('.interrupted-'))).toBe(true)
    expect(write).not.toHaveBeenCalled()
  })

  it('keeps completion prerequisites open and never marks a truncated response completed', async () => {
    const flow = scripted([[text('准备好了')], [text('满足条件')]])
    const beforeComplete = vi.fn().mockResolvedValueOnce('缺少真实结果，继续').mockResolvedValue(undefined)
    const result = await runAgentLoop(input(flow.query, { beforeComplete }))
    expect(result.turns).toBe(2); expect(beforeComplete).toHaveBeenCalledTimes(2)
    const cutoff: SDKQuery = async function* () { yield text('partial'); yield { type: 'result', stop_reason: 'max_tokens' } }
    const stopped = await runAgentLoop(input(cutoff, { sessionId: 'cutoff', maxTurns: 2 }))
    expect(stopped.status).toBe('turn_limit'); expect(stopped.termination_detail?.reason).toBe('output_token_limit')
  })

  it('resumes past a failed assistant with a leftover result without sending orphan results or replaying writes', async () => {
    const {manager,release}=await openPiSession('test-project','test-session','desktop-implement:',process.cwd())
    const failed=emptyAssistant({id:'bridge',name:'bridge',api:'openai-completions',provider:'bloma-transport',baseUrl:'',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:1000})
    failed.content=[{type:'toolCall',id:'failed-call',name:'write_file',arguments:{}}];failed.stopReason='error'
    manager.appendMessage(failed)
    manager.appendMessage({role:'toolResult',toolCallId:'failed-call',toolName:'write_file',content:[{type:'text',text:'orphan-native-evidence'}],isError:true,timestamp:Date.now()})
    release()
    const query:SDKQuery=async function*(_prompt,options){
      expect(JSON.stringify(options.messages)).not.toContain('failed-call')
      yield text('继续核对现场，不重放写入');yield done
    }
    const write=vi.fn(async()=>({output:'must-not-replay'}))
    expect((await runAgentLoop(input(query,{tools:[tool('write_file',write)]}))).status).toBe('completed')
    expect(write).not.toHaveBeenCalled()
    expect(readFileSync(nativeFile(),'utf8')).toContain('orphan-native-evidence')
  })

  it('preserves denied permissions and stops mixed tool batches on persistent host budget exhaustion', async () => {
    const write = vi.fn(async () => ({ output: 'unexpected' }))
    const denied = scripted([[call('no', 'write_file')], [text('已受阻')]])
    const result = await runAgentLoop(input(denied.query, { tools: [tool('write_file', write)], permissionMode: 'safe' }))
    expect(result.toolCalls[0].status).toBe('error'); expect(write).not.toHaveBeenCalled()
    const exhausted = scripted([[call('budget', 'run_project_script'), call('write', 'write_file')], [text('must-not-call')]])
    const blocked = await runAgentLoop(input(exhausted.query, { sessionId: 'budget', tools: [tool('run_project_script', async () => ({
      output: 'exhausted', budgetExhausted: true, feedback: { schema_version: 1, execution: 'not_run', verification: 'unverified', category: 'budget', recovery: 'resume',
        budget: { resource: 'script_runs', scope: 'project', used: 1, limit: 1, remaining: 0, resets_on: 'none' } },
    })), tool('write_file', write)] }))
    expect(blocked.status).toBe('budget_exhausted'); expect(write).not.toHaveBeenCalled(); expect(exhausted.received).toHaveLength(1)
  })

  it('cancels a non-cooperative model stream without starting tools or another request', async () => {
    const abort = new AbortController()
    const query: SDKQuery = async function* () { yield text('partial'); abort.abort('test-cancel'); await new Promise(() => {}) }
    const result = await runAgentLoop(input(query, { signal: abort.signal }))
    expect(result.status).toBe('cancelled'); expect(result.toolCalls).toHaveLength(0)
  })

  it('honors the physical request guard and rejects corrupt native history', async () => {
    const budget = createProductionBudget('test-project', 'digest', 'desktop-implement', { requests: 1, output: 5000,
      phaseRequests: 1, perResponse: 1000 })
    const physical: SDKQuery = async function* (_prompt, options) {
      options.requestGuard?.({ url: 'https://model.invalid', body: JSON.stringify({ max_tokens: options.maxTokens }) })
      yield call('r', 'read_file'); yield done
    }
    await expect(runAgentLoop(input(budget.wrap(physical), { tools: [tool('read_file', async () => ({ output: 'read' }))] }))).rejects.toThrow('HARNESS_')
    expect(budget.snapshot().requests).toBe(1)
    const badFile = nativeFile(); mkdirSync(dirname(badFile), { recursive: true }); writeFileSync(badFile, 'corrupt')
    const safe = scripted([[text('unexpected')]])
    await expect(runAgentLoop(input(safe.query))).rejects.toThrow()
    expect(safe.received).toHaveLength(0)
  })

  it('uses native compaction and routes summary requests through the guarded transport', async () => {
    let requests = 0
    const scopes: string[] = []
    const loopInputs: string[] = []
    const query: SDKQuery = async function* (_prompt, options) {
      scopes.push(options.accounting?.scope ?? '')
      if (options.accounting?.scope === 'loop') loopInputs.push(JSON.stringify(options.messages))
      requests += 1
      yield text(requests === 1 ? 'completed first task' : 'Preserved durable task facts')
      yield { type: 'result', stop_reason: 'end_turn', usage: { input_tokens: requests === 1 ? 110000 : 100, output_tokens: 10 } }
    }
    const compaction = vi.fn()
    const historyTurns = Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `history ${index}: ` + 'context fact '.repeat(5000) }))
    let recoveries = 0
    const result = await runAgentLoop(input(query, { onCompaction: compaction, historyTurns, recoveryContext: () => 'CURRENT_HOST_FACTS_' + (++recoveries) }))
    expect(result.status).toBe('completed'); expect(compaction).toHaveBeenCalled()
    expect(scopes).toContain('handoff')
    expect(readFileSync(nativeFile(), 'utf8')).toContain('"type":"compaction"')
    expect(result.usage?.handoffCalls).toBeGreaterThan(0)
    expect(recoveries).toBeGreaterThanOrEqual(2)
    expect(loopInputs.some(text => text.includes('CURRENT_HOST_FACTS_2'))).toBe(true)
  })

  it('lets Pi retry a failed provider turn without replaying a completed write', async () => {
    let requests = 0
    const write = vi.fn(async () => ({ output: 'preserved write' }))
    const query: SDKQuery = async function* () {
      requests += 1
      if (requests === 1) yield call('write-once', 'write_file')
      else if (requests === 2) { yield text('FAILED_STREAM_ADVANCE_MARK'); throw new Error('503 service unavailable') }
      else yield text('恢复后完成')
      yield done
    }
    const collector = new AssistantTurnCollector()
    const result = await runAgentLoop(input(query, { tools: [tool('write_file', write)], publish: collector.onPublish,
      onTurn: info => info.failed ? collector.discardCurrentTurn() : collector.onTurnBoundary() }))
    expect(result.status).toBe('completed'); expect(requests).toBe(3); expect(write).toHaveBeenCalledTimes(1)
    expect(result.turns).toBe(3)
    expect(JSON.stringify(collector.flush())).not.toContain('FAILED_STREAM_ADVANCE_MARK')
  })

  it('injects running corrections at the Pi queue boundary and defers them at the turn limit', async () => {
    const correction = tool('read_file', async () => {
      enqueueSteer('test-session', { queueMessageId: 'correction-1', content: '把标题改成知识库', enqueuedAt: Date.now() })
      return { output: 'read' }
    })
    const flow = scripted([[call('read', 'read_file')], [text('已采纳补充')]])
    const publish = vi.fn()
    await runAgentLoop(input(flow.query, { tools: [correction], publish }))
    expect(JSON.stringify(flow.received[1].messages)).toContain('把标题改成知识库')
    expect(publish.mock.calls.filter(([type]) => type === 'steer_injected')).toHaveLength(1)
    const capped = scripted([[call('last-read', 'read_file')]])
    publish.mockClear()
    const result = await runAgentLoop(input(capped.query, { tools: [correction], publish, maxTurns: 1 }))
    expect(result.status).toBe('turn_limit')
    expect(publish.mock.calls.filter(([type]) => type === 'steer_injected')).toHaveLength(0)
    const resumed = scripted([[text('续跑处理补充')]])
    await runAgentLoop(input(resumed.query))
    expect(JSON.stringify(resumed.received[0].messages)).toContain('把标题改成知识库')
  })

  it('ignores ambient agent instructions and preserves short image references', async () => {
    const dir = join(home, 'bloma-pi-runtime'); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'AGENTS.md'), 'AMBIENT_INSTRUCTION_MUST_NOT_LOAD')
    writeFileSync(join(dir, 'APPEND_SYSTEM.md'), 'AMBIENT_APPEND_MUST_NOT_LOAD')
    const flow = scripted([[text('完成')]])
    await runAgentLoop(input(flow.query, { images: [{ imageId: 'test-session/image.png', media_type: 'image/png' }] }))
    const serialized = JSON.stringify(flow.received[0].messages)
    expect(serialized).not.toContain('AMBIENT_')
    expect(serialized).toContain('test-session/image.png'); expect(serialized).not.toContain('bloma-image-ref:')
    expect(readFileSync(nativeFile(), 'utf8')).not.toContain('"source":{"type":"base64"')
  })
  it('delivers actual tool image references to the next model request and preserves them in replay without base64 logs', async () => {
    const flow = scripted([[call('see', 'see_image')], [text('看到实际截图')]])
    const images = [{ imageId: 'test-session/actual-screenshot.png', media_type: 'image/png' }]
    const see = tool('see_image', async () => ({ output: 'actual screenshot', images }))
    await runAgentLoop(input(flow.query, { tools: [see] }))
    expect(JSON.stringify(flow.received[1].messages)).toContain('actual-screenshot.png')
    expect(readFileSync(nativeFile(), 'utf8')).toContain('actual-screenshot.png')
    const resumed = scripted([[text('继续检查')]])
    await runAgentLoop(input(resumed.query, { tools: [see], task: '沿上次截图继续' }))
    expect(JSON.stringify(resumed.received[0].messages)).toContain('actual-screenshot.png')
    expect(readFileSync(nativeFile(), 'utf8')).not.toContain('"source":{"type":"base64"')
  })

  it('respects permanent quota denial and rejects an empty completion', async () => {
    let requests = 0
    const denied: SDKQuery = async function* () { requests++; throw Object.assign(new Error('HTTP 429 code 1308 fixed account limit'), { nonRetryable: true }) }
    await expect(runAgentLoop(input(denied))).rejects.toThrow('1308')
    expect(requests).toBe(1)
    const empty: SDKQuery = async function* () { yield done }
    await expect(runAgentLoop(input(empty, { sessionId: 'empty' }))).rejects.toThrow('EMPTY_MODEL_STREAM')
  })
})
