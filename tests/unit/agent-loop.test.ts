import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAgentLoop, TOOL_WINDOW_ROUNDS, type AgentLoopInput, type AgentLoopTool, type ToolOutcome } from '../../main/agent-loop'
import type { SDKMessage } from '../../shared/types'
import type { ConversationTurn, SDKQuery, SDKQueryOptions } from '../../main/orchestrator'
import { getAgentSessionPath } from '../../storage/config-paths'

/**
 * PR2 L1 Agent Loop 执行器单元测试（不接线，纯模块级）。
 *
 * 锁定不变式（方案 §4.2 / §9.3 上游实证）：
 * - 同轮多个 tool_use 串行执行、tool_result 整批进同一条 user 消息（防 400）
 * - 工具异常/权限拒绝转 is_error tool_result，不崩循环
 * - 轮次上限 / 静态预算软着陆（连续 2 轮撞预算才终止）/ 取消收尾
 * - JSONL 落盘（assistant tool_use 轮 + user tool_result 轮，单条截断 4KB）
 */

function tool(name: string, behavior: (input: Record<string, unknown>) => Promise<ToolOutcome> | ToolOutcome): AgentLoopTool {
  return {
    name,
    description: `测试工具 ${name}`,
    input_schema: { type: 'object', properties: {} },
    execute: async (input) => behavior(input),
  }
}

function toolUseMessage(id: string, name: string, input: Record<string, unknown> = {}): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }
}

function textMessage(text: string): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

interface ScriptedQuery {
  query: SDKQuery
  /** 每次模型调用收到的 messages 快照 */
  receivedMessages: ConversationTurn[][]
  receivedToolCount: number[]
}

/** 脚本化 query：按调用序号返回预置响应流，记录每次调用收到的完整 messages。 */
function scriptedQuery(responses: SDKMessage[][]): ScriptedQuery {
  let call = 0
  const receivedMessages: ConversationTurn[][] = []
  const receivedToolCount: number[] = []
  const query: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
    const callIndex = call
    call += 1
    receivedMessages.push((options.messages ?? []).map((turn) => ({ ...turn })))
    receivedToolCount.push(options.tools?.length ?? 0)
    const script = responses[Math.min(callIndex, responses.length - 1)] ?? []
    for (const message of script) yield message
    yield { type: 'result', subtype: 'success', stop_reason: script.some((m) => m.message?.content.some((b) => b.type === 'tool_use')) ? 'tool_use' : 'end_turn' }
  }
  return { query, receivedMessages, receivedToolCount }
}

function baseInput(overrides: Partial<AgentLoopInput> = {}): AgentLoopInput {
  return {
    system: '测试系统提示',
    task: '测试任务',
    tools: [],
    query: async function* () {
      yield { type: 'result', subtype: 'success' }
    },
    env: {},
    sessionId: 'session-loop',
    projectId: 'project-loop',
    requestId: 'req-loop',
    maxTokens: 256,
    maxTurns: 6,
    permissionMode: 'allow-all',
    signal: new AbortController().signal,
    publish: () => undefined,
    ...overrides,
  }
}

function readSessionJsonl(sessionId: string): Array<{ role: string; content: Array<{ type: string; content?: string; is_error?: boolean }> }> {
  return readFileSync(getAgentSessionPath(sessionId), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

describe('runAgentLoop（PR2 L1）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'bloma-loop-'))
    process.env.PROMA_HOME = home
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  it('模型只回文本（无 tool_use）→ completed，单轮收尾', async () => {
    const { query } = scriptedQuery([[textMessage('我做完了')]])
    const result = await runAgentLoop(baseInput({ query }))
    expect(result.status).toBe('completed')
    expect(result.turns).toBe(1)
    expect(result.finalText).toBe('我做完了')
    expect(result.toolCalls).toHaveLength(0)
  })

  it('调工具后下一轮收口 → completed，2 轮 1 次工具调用', async () => {
    const echo = tool('echo', () => ({ output: 'ok' }))
    const { query } = scriptedQuery([[toolUseMessage('t1', 'echo')], [textMessage('完成')]])
    const result = await runAgentLoop(baseInput({ query, tools: [echo] }))
    expect(result.status).toBe('completed')
    expect(result.turns).toBe(2)
    expect(result.toolCalls).toEqual([{ name: 'echo', turn: 1 }])
  })

  it('每轮都要求工具 → maxTurns 耗尽返回 turn_limit', async () => {
    const echo = tool('echo', () => ({ output: 'ok' }))
    const { query } = scriptedQuery([[toolUseMessage('t1', 'echo')], [toolUseMessage('t2', 'echo')], [toolUseMessage('t3', 'echo')]])
    const result = await runAgentLoop(baseInput({ query, tools: [echo], maxTurns: 3 }))
    expect(result.status).toBe('turn_limit')
    expect(result.turns).toBe(3)
    expect(result.toolCalls).toHaveLength(3)
  })

  it('同轮多个 tool_use：串行执行、整批 tool_result 打进同一条 user 消息（上游 400 不变式）', async () => {
    const order: string[] = []
    const first = tool('first', () => {
      order.push('first')
      return { output: '一' }
    })
    const second = tool('second', () => {
      order.push('second')
      return { output: '二' }
    })
    const { query, receivedMessages } = scriptedQuery([
      [toolUseMessage('t1', 'first'), toolUseMessage('t2', 'second')],
      [textMessage('完成')],
    ])
    const result = await runAgentLoop(baseInput({ query, tools: [first, second] }))

    expect(order).toEqual(['first', 'second']) // 串行执行
    expect(result.status).toBe('completed')
    // 第二次模型调用收到的消息序列：task(user) → assistant(tool_use×2) → user(单条，含两个 tool_result)
    const secondCallMessages = receivedMessages[1]
    const toolResultTurn = secondCallMessages.filter((turn) => turn.role === 'user').at(-1)!
    const blocks = toolResultTurn.content as Array<{ type: string; tool_use_id?: string; content?: string }>
    expect(secondCallMessages.filter((turn) => turn.role === 'user' && Array.isArray(turn.content))).toHaveLength(1)
    expect(blocks.map((block) => block.tool_use_id)).toEqual(['t1', 't2'])
    expect(blocks.map((block) => block.content)).toEqual(['一', '二'])
  })

  it('工具抛异常 → is_error tool_result 回给模型，循环继续不崩', async () => {
    const boom = tool('boom', () => {
      throw new Error('炸了：文件不存在')
    })
    const { query, receivedMessages } = scriptedQuery([[toolUseMessage('t1', 'boom')], [textMessage('知道了')]])
    const result = await runAgentLoop(baseInput({ query, tools: [boom] }))

    expect(result.status).toBe('completed')
    const toolResultTurn = receivedMessages[1].filter((turn) => turn.role === 'user').at(-1)!
    const block = (toolResultTurn.content as Array<{ type: string; is_error?: boolean; content?: string }>)[0]
    expect(block.is_error).toBe(true)
    expect(block.content).toContain('炸了')
  })

  it('权限拒绝（safe 模式拦 warning 工具）→ is_error tool_result，不崩循环', async () => {
    const writer = tool('write_file', () => ({ output: '写入成功' }))
    const { query, receivedMessages } = scriptedQuery([[toolUseMessage('t1', 'write_file')], [textMessage('好吧')]])
    const result = await runAgentLoop(baseInput({ query, tools: [writer], permissionMode: 'safe' }))

    expect(result.status).toBe('completed')
    const block = (receivedMessages[1].filter((turn) => turn.role === 'user').at(-1)!.content as Array<{ is_error?: boolean; content?: string }>)[0]
    expect(block.is_error).toBe(true)
    expect(block.content).toContain('权限拒绝')
  })

  it('静态 toolBudget：超预算的调用拿到软着陆提示，连续 2 轮撞预算 → budget_exhausted', async () => {
    const spinner = tool('spin', () => ({ output: '再转一次' }))
    // 第 1 轮成功调用（预算 1 用掉）；第 2、3 轮继续要 → 预算提示 ×2 → 终止
    const { query, receivedMessages } = scriptedQuery([
      [toolUseMessage('t1', 'spin')],
      [toolUseMessage('t2', 'spin')],
      [toolUseMessage('t3', 'spin')],
    ])
    const result = await runAgentLoop(baseInput({ query, tools: [spinner], toolBudget: { spin: 1 } }))

    expect(result.status).toBe('budget_exhausted')
    expect(result.turns).toBe(3)
    const budgetBlocks = receivedMessages
      .slice(1)
      .map((messages) => (messages.filter((turn) => turn.role === 'user').at(-1)!.content as Array<{ content?: string }>)[0]?.content ?? '')
    // 第 2 次调用收到的是第 1 轮成功结果；第 3 次调用收到的才是超预算软着陆提示
    expect(budgetBlocks[0]).toBe('再转一次')
    expect(budgetBlocks[1]).toContain('预算已用尽')
  })

  it('预算提示后模型收手（下一轮纯文本）→ 不算连续撞预算，completed', async () => {
    const spinner = tool('spin', () => ({ output: 'ok' }))
    const { query } = scriptedQuery([[toolUseMessage('t1', 'spin')], [toolUseMessage('t2', 'spin')], [textMessage('收尾总结')]])
    const result = await runAgentLoop(baseInput({ query, tools: [spinner], toolBudget: { spin: 1 } }))
    expect(result.status).toBe('completed')
    expect(result.finalText).toBe('收尾总结')
  })

  it('signal 取消 → status cancelled，不再发起下一次模型调用', async () => {
    const controller = new AbortController()
    const echo = tool('echo', () => ({ output: 'ok' }))
    let modelCalls = 0
    const query: SDKQuery = async function* () {
      modelCalls += 1
      yield toolUseMessage(`t${modelCalls}`, 'echo')
      yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
    }
    const input = baseInput({ query, tools: [echo], signal: controller.signal })
    const promise = runAgentLoop(input)
    controller.abort(new Error('AGENT_CANCELLED: user'))
    const result = await promise
    expect(result.status).toBe('cancelled')
    expect(modelCalls).toBeLessThan(3)
  })

  it('JSONL 落盘：assistant tool_use 轮 + user tool_result 轮；单条 tool_result 超 4KB 截断', async () => {
    const big = tool('big', () => ({ output: 'x'.repeat(5000) }))
    const { query } = scriptedQuery([[toolUseMessage('t1', 'big')], [textMessage('完成')]])
    await runAgentLoop(baseInput({ query, tools: [big], sessionId: 'session-jsonl' }))

    const messages = readSessionJsonl('session-jsonl')
    const assistantTurn = messages.find((message) => message.content.some((block) => block.type === 'tool_use'))
    expect(assistantTurn?.role).toBe('assistant')
    const userTurn = messages.find((message) => message.content.some((block) => block.type === 'tool_result'))
    expect(userTurn?.role).toBe('user')
    const toolResult = userTurn!.content.find((block) => block.type === 'tool_result')!
    expect(toolResult.content).toHaveLength(4096 + '…[截断，全文见事件流]'.length)
    expect(toolResult.content).toContain('[截断，全文见事件流]')
  })

  it('事件流：tool_call_started / tool_call_completed 带轮次与摘要', async () => {
    const echo = tool('echo', () => ({ output: '结果内容' }))
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const { query } = scriptedQuery([[toolUseMessage('t1', 'echo')], [textMessage('完成')]])
    await runAgentLoop(baseInput({
      query,
      tools: [echo],
      publish: (type, payload) => events.push({ type, payload }),
    }))

    const started = events.find((event) => event.type === 'tool_call_started')
    const completed = events.find((event) => event.type === 'tool_call_completed')
    expect(started?.payload).toMatchObject({ tool: 'echo', turn: 1 })
    expect(completed?.payload).toMatchObject({ tool: 'echo', status: 'ok' })
    expect(completed?.payload.duration_ms).toBeTypeOf('number')
    expect(completed?.payload.output_summary).toBe('结果内容')
  })

  it('onTurn 回调：逐轮工具清单与 usage（渠道返回时）', async () => {
    const echo = tool('echo', () => ({ output: 'ok' }))
    const turns: Array<{ turn: number; toolCalls: Array<{ name: string }>; inputTokens?: number }> = []
    const query: SDKQuery = async function* () {
      yield toolUseMessage('t1', 'echo')
      yield { type: 'result', subtype: 'success', stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 20 } }
    }
    await runAgentLoop(baseInput({
      query,
      tools: [echo],
      maxTurns: 1,
      onTurn: (info) => turns.push({ turn: info.turn, toolCalls: info.toolCalls, inputTokens: info.inputTokens }),
    }))
    expect(turns).toEqual([{ turn: 1, toolCalls: [{ name: 'echo', turn: 1 }], inputTokens: 100 }])
  })

  it('F4：长 loop 最后一次模型调用 messages 有界，JSONL 仍全量', async () => {
    const echo = tool('echo', () => ({ output: 'ok' }))
    const script = Array.from({ length: 12 }, (_, i) => [toolUseMessage(`t${i}`, 'echo')])
    const { query, receivedMessages } = scriptedQuery(script)
    const result = await runAgentLoop(baseInput({ query, tools: [echo], maxTurns: 12, sessionId: 'session-window' }))
    expect(result.status).toBe('turn_limit')
    const lastCall = receivedMessages.at(-1)!
    expect(lastCall.length).toBe(2 + TOOL_WINDOW_ROUNDS * 2) // system + task + 最近 8 轮 tool 对
    // 窗口内容断言：保留最近 8 轮（第 5~12 轮，id t3..t10），早期轮（t0..t2）被剪掉
    const toolUseIds = lastCall
      .filter((turn) => turn.role === 'assistant')
      .map((turn) => (turn.content as Array<{ type?: string; id?: string }>).find((block) => block.type === 'tool_use')?.id)
      .filter(Boolean)
    expect(toolUseIds).toEqual(['t3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'])
    const jsonl = readSessionJsonl('session-window')
    expect(jsonl.filter((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use'))).toHaveLength(12)
  })
})

describe('M4-C tool_call_completed detail 白名单透传', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-detail-'))
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  it('委派工具返回结构化 detail：白名单字段进事件，长文本 result_summary 丢弃', async () => {
    const delegate = tool('delegate_agent', () => ({
      output: '已启动委派',
      detail: {
        delegation_id: 'd-01',
        child_session_id: 'child-01',
        role: 'explore',
        goal: '检查 index.html',
        status: 'running',
        pending_question: undefined,
        result_summary: '非常长的结果摘要'.repeat(200),
      },
    }))
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const { query } = scriptedQuery([[toolUseMessage('t1', 'delegate_agent')], [textMessage('完成')]])
    await runAgentLoop(baseInput({
      query,
      tools: [delegate],
      publish: (type, payload) => events.push({ type, payload }),
    }))

    const completed = events.find((event) => event.type === 'tool_call_completed')
    expect(completed?.payload.detail).toEqual({
      delegation_id: 'd-01',
      child_session_id: 'child-01',
      role: 'explore',
      goal: '检查 index.html',
      status: 'running',
    })
    // 白名单外字段不进事件流（§7 防敏感/超长泄漏）
    expect(JSON.stringify(completed?.payload.detail)).not.toContain('result_summary')
    expect(JSON.stringify(completed?.payload.detail)).not.toContain('非常长的结果摘要')
  })

  it('detail 无白名单字段（或非委派工具）→ 事件不带 detail', async () => {
    const plain = tool('echo', () => ({ output: 'ok', detail: { foo: 'bar', content: 'x'.repeat(600) } }))
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const { query } = scriptedQuery([[toolUseMessage('t1', 'echo')], [textMessage('完成')]])
    await runAgentLoop(baseInput({
      query,
      tools: [plain],
      publish: (type, payload) => events.push({ type, payload }),
    }))

    const completed = events.find((event) => event.type === 'tool_call_completed')
    expect(completed?.payload.detail).toBeUndefined()
    // 白名单外 detail 不进事件流，事件仍保留 output_summary（模型可见摘要不受影响）
    expect(completed?.payload.output_summary).toBe('ok')
  })
})
