import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAgentLoop, TOOL_WINDOW_ROUNDS, windowMessages, type AgentLoopInput, type AgentLoopTool, type ToolOutcome } from '../../main/agent-loop'
import type { AgentEvent } from '../../shared/types'
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
    // 宽限轮（2026-08-29）：最后一条是 maxTurns 耗尽后的无 tools 交卷调用，messages 同样有界
    const lastCall = receivedMessages.at(-1)!
    expect(lastCall.length).toBe(2 + TOOL_WINDOW_ROUNDS * 2) // system + task + 最近 8 轮 tool 对
    // 窗口内容断言：宽限轮看到 12 轮全量，保留最近 8 轮（第 5~12 轮，id t4..t11），早期轮被剪掉
    const toolUseIds = lastCall
      .filter((turn) => turn.role === 'assistant')
      .map((turn) => (turn.content as Array<{ type?: string; id?: string }>).find((block) => block.type === 'tool_use')?.id)
      .filter(Boolean)
    expect(toolUseIds).toEqual(['t4', 't5', 't6', 't7', 't8', 't9', 't10', 't11'])
    // JSONL 审计全量照落：12 个工作轮 + 1 条宽限轮 assistant 行
    const jsonl = readSessionJsonl('session-window')
    expect(jsonl.filter((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use'))).toHaveLength(13)
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

  it('网关脏增量清洗：词间独立 "\\n\\n" 丢弃、合法段落分隔保留（2026-08-25 线上案例）', async () => {
    // 复刻 ds 渠道带 tools 流的实测形态：词块自带前导空格，词间被插字面 "\n\n" 独立增量；
    // '.\n\n' 附着在词块尾部的合法段落分隔必须原样保留
    const deltas = ['Now', '\n\n', ' let', '\n\n', ' me', '\n\n', ' create', ' the', ' app', '.js', '.\n\n', 'The', ' ', 'end']
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const { query } = scriptedQuery([deltas.map(textMessage)])
    const result = await runAgentLoop(baseInput({ query, publish: (type, payload) => events.push({ type, payload }) }))

    expect(result.status).toBe('completed')
    expect(result.finalText).toBe('Now let me create the app.js.\n\nThe end')
    // 上屏增量同样清洗：拼接后与 finalText 一致
    const streamed = events.filter((event) => event.type === 'message_delta').map((event) => String(event.payload.text ?? '')).join('')
    expect(streamed).toBe(result.finalText)
  })

  it('连发多个词间空白工件一并丢弃', async () => {
    const { query } = scriptedQuery([['Now', '\n\n', '\n\n', '\n\n', ' let', ' me', ' add'].map(textMessage)])
    const result = await runAgentLoop(baseInput({ query }))
    expect(result.finalText).toBe('Now let me add')
  })

  it('连续 text 增量合并为单块落盘；工具块前挂起的空白如实放行', async () => {
    const echo = tool('echo', () => ({ output: 'ok' }))
    const { query } = scriptedQuery([[
      ...['do', ' it', '\n\n'].map(textMessage),
      toolUseMessage('t1', 'echo'),
    ], [textMessage('完成')]])
    await runAgentLoop(baseInput({ query, tools: [echo] }))

    const lines = readSessionJsonl('session-loop')
    const assistantLine = lines.find((line) => line.content.some((block) => block.type === 'tool_use'))
    // 文本段合并为一个 text 块（不再落几百个碎块），工具块紧随其后
    expect(assistantLine?.content).toHaveLength(2)
    expect(assistantLine?.content[0]).toMatchObject({ type: 'text', text: 'do it\n\n' })
    expect(assistantLine?.content[1]).toMatchObject({ type: 'tool_use', name: 'echo' })
  })
})

/** 构造一轮完整工具对（assistant tool_use + user tool_result）。 */
function pairOf(id: string): [ConversationTurn, ConversationTurn] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'echo', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `result-${id}` }] },
  ]
}

/** head（task）+ N 轮完整工具对。 */
function buildLoopMessages(turns: number): ConversationTurn[] {
  const messages: ConversationTurn[] = [{ role: 'user', content: 'task' }]
  for (let index = 0; index < turns; index += 1) messages.push(...pairOf(`t${index}`))
  return messages
}

describe('F4 窗口钉住首个 test_failed 轮（闭环治理 PR2）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-pin-'))
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  it('钉住后窗口外的首个失败轮对仍在：40 轮、失败轮第 2 轮、窗口 8 对', () => {
    const messages = buildLoopMessages(40)
    const windowed = windowMessages(messages, 8, 8, 2)

    // head + 钉住的第 2 轮对（t1）+ 最近 8 轮对（t32..t39），保持原顺序
    const expected: ConversationTurn[] = [
      messages[0],
      ...pairOf('t1'),
      ...Array.from({ length: 8 }, (_, i) => pairOf(`t${32 + i}`)).flat(),
    ]
    expect(windowed).toEqual(expected)
    expect(windowed).toHaveLength(1 + 2 + 16)
  })

  it('无钉轮时行为与现状逐字节一致（回归锁）', () => {
    const messages = buildLoopMessages(40)
    const expected: ConversationTurn[] = [
      messages[0],
      ...Array.from({ length: 8 }, (_, i) => pairOf(`t${32 + i}`)).flat(),
    ]
    // 不传第 4 参与显式传 undefined 均为固定窗口语义，输出完全一致
    expect(windowMessages(messages, 8, 8)).toEqual(expected)
    expect(windowMessages(messages, 8, 8, undefined)).toEqual(expected)
  })

  it('失败对不完整（cancelled 残局）不钉：角色不成对即放弃', () => {
    // 40 轮里第 2 轮只剩 assistant（user tool_result 缺席），索引错位下不得误钉
    const messages = buildLoopMessages(40)
    messages.splice(3, 1) // 删掉 t1 对的 user tool_result，后续整体前移
    const windowed = windowMessages(messages, 8, 8, 2)

    // 未钉住：结果与固定窗口一致（t1 只剩 assistant 一条，也不在最近 8 轮内）
    const ids = windowed
      .filter((turn) => turn.role === 'assistant' && Array.isArray(turn.content))
      .map((turn) => (turn.content as Array<{ type?: string; id?: string }>).find((b) => b.type === 'tool_use')?.id)
    expect(ids).not.toContain('t1')
    expect(windowed).toHaveLength(1 + 16)
  })

  it('主循环接线：首个 test_failed 轮被钉住，后续失败轮不重复钉；JSONL 仍全量', async () => {
    const echo = tool('echo', () => ({ output: 'ok' }))
    const gwtFail: AgentLoopTool = {
      name: 'gwt_fail',
      description: '模拟 run_gwt_tests 失败',
      input_schema: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        // 与真实 run_gwt_tests 同款信号：test_failed 置位 + repair_round 增长（审查 P1-1 修复后钉轮按 repair_round 门控）
        ctx.state.test_failed = true
        ctx.state.repair_round += 1
        return { output: '共 1 个场景：通过 0、失败 1。\n失败场景：\n- F-001：断言未满足' }
      },
    }
    // 第 2、3 轮都失败；只有第 2 轮（t1）应被钉住，第 3 轮（t2）不钉且出窗
    const script = Array.from({ length: 12 }, (_, i) => [toolUseMessage(`t${i}`, i === 1 || i === 2 ? 'gwt_fail' : 'echo')])
    const { query, receivedMessages } = scriptedQuery(script)
    const result = await runAgentLoop(baseInput({ query, tools: [echo, gwtFail], maxTurns: 12, sessionId: 'session-pin' }))

    expect(result.status).toBe('turn_limit')
    // 宽限轮（2026-08-29）：最后一条为耗尽后的无 tools 调用，窗口 = 钉住的 t1 对 + 最近 8 对（t4..t11）
    const lastCall = receivedMessages.at(-1)!
    // system + task + 钉住的 t1 对 + 最近 8 轮对（t4..t11）
    expect(lastCall).toHaveLength(1 + 1 + 2 + TOOL_WINDOW_ROUNDS * 2)
    const toolUseIds = lastCall
      .filter((turn) => turn.role === 'assistant')
      .map((turn) => (turn.content as Array<{ type?: string; id?: string }>).find((block) => block.type === 'tool_use')?.id)
      .filter(Boolean)
    expect(toolUseIds).toEqual(['t1', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11'])
    // JSONL 审计全量照落，不受窗口化影响：12 个工作轮 + 1 条宽限轮 assistant 行
    const jsonl = readSessionJsonl('session-pin')
    expect(jsonl.filter((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use'))).toHaveLength(13)
  })

  it('主循环接线：无失败时模型可见消息与固定窗口完全一致（回归）', async () => {
    const echo = tool('echo', () => ({ output: 'ok' }))
    const script = Array.from({ length: 12 }, (_, i) => [toolUseMessage(`t${i}`, 'echo')])
    const { query, receivedMessages } = scriptedQuery(script)
    await runAgentLoop(baseInput({ query, tools: [echo], maxTurns: 12, sessionId: 'session-pin-nofail' }))

    const lastCall = receivedMessages.at(-1)!
    expect(lastCall).toHaveLength(2 + TOOL_WINDOW_ROUNDS * 2)
    const toolUseIds = lastCall
      .filter((turn) => turn.role === 'assistant')
      .map((turn) => (turn.content as Array<{ type?: string; id?: string }>).find((block) => block.type === 'tool_use')?.id)
      .filter(Boolean)
    expect(toolUseIds).toEqual(['t4', 't5', 't6', 't7', 't8', 't9', 't10', 't11'])
  })
})

interface CompactQueryOptions {
  inputTokens: number
  handoff: 'text' | 'throw' | 'hang'
  handoffText?: string
}

/** 压缩测试 query：带 tools 的正常轮回 toolUse+usage；无 tools 的交接调用按 handoff 行为。 */
function compactQuery(options: CompactQueryOptions): {
  query: SDKQuery
  turnCalls: ConversationTurn[][]
  handoffCalls: ConversationTurn[][]
} {
  let calls = 0
  const turnCalls: ConversationTurn[][] = []
  const handoffCalls: ConversationTurn[][] = []
  const query: SDKQuery = async function* (_prompt, queryOptions) {
    const index = calls
    calls += 1
    if (queryOptions.tools === undefined) {
      handoffCalls.push((queryOptions.messages ?? []).map((turn) => ({ ...turn })))
      if (options.handoff === 'throw') throw new Error('渠道 429')
      if (options.handoff === 'hang') {
        await new Promise<never>((_resolve, reject) => {
          queryOptions.signal.addEventListener('abort', () => reject(new Error('AGENT_CANCELLED')))
        })
      }
      yield textMessage(options.handoffText ?? '交接：已完成布局与样式；未解决 GWT 场景 3；下一步修点击。')
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
      return
    }
    turnCalls.push((queryOptions.messages ?? []).map((turn) => ({ ...turn })))
    yield toolUseMessage(`t${index}`, 'echo')
    yield { type: 'result', subtype: 'success', stop_reason: 'tool_use', usage: { input_tokens: options.inputTokens, output_tokens: 10 } }
  }
  return { query, turnCalls, handoffCalls }
}

function textOf(turn: ConversationTurn | undefined): string {
  return typeof turn?.content === 'string' ? turn.content : ''
}

describe('usage 竹节压缩（闭环 PR6）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalThreshold = process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS
  const echo = tool('echo', () => ({ output: 'ok' }))

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-compact-'))
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    if (originalThreshold === undefined) delete process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS
    else process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = originalThreshold
  })

  it('超阈值触发：messages 重置为 task+交接（task+2 次交接=3 节），交接调用无 tools 且带交接 system', async () => {
    process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = '1000'
    const { query, turnCalls, handoffCalls } = compactQuery({ inputTokens: 5000, handoff: 'text', handoffText: '交接：布局完成，GWT 场景 3 未过，下一步修点击。' })
    const events: Array<{ type: AgentEvent['type']; payload: Record<string, unknown> }> = []
    const result = await runAgentLoop(baseInput({
      query,
      tools: [echo],
      maxTurns: 8,
      sessionId: 'session-compact',
      publish: (type, payload) => events.push({ type, payload }),
    }))

    expect(result.status).toBe('turn_limit')
    // 恰好两次压缩：第 1、2 轮后（封顶），后续轮不再触发
    const compactions = events.filter((event) => event.type === 'loop_compaction')
    expect(compactions).toHaveLength(2)
    expect(compactions[0]!.payload).toMatchObject({ at_turn: 1, compactions: 1 })
    expect(compactions[1]!.payload).toMatchObject({ at_turn: 2, compactions: 2 })

    // 交接调用：无 tools、system 为交接助手、携带窗口化消息
    expect(handoffCalls).toHaveLength(2)
    expect(textOf(handoffCalls[0]![0])).toContain('工程交接助手')

    // 第 2 轮模型调用看到的已是重置后的 messages：task + 第 1 段交接
    expect(turnCalls[1]).toHaveLength(2)
    const secondTurnTask = textOf(turnCalls[1]![1])
    expect(secondTurnTask).toContain('测试任务')
    expect(secondTurnTask).toContain('【此前进度交接（第 1 段）】')
    expect(secondTurnTask).toContain('布局完成')

    // 第 3 轮：task + 第 2 段交接（重置会把压缩轮自身的工具对一并抹掉，其内容进交接文档）
    expect(turnCalls[2]).toHaveLength(2)
    expect(textOf(turnCalls[2]![1])).toContain('第 2 段')
    // 第 4 轮：重置后的新工具对（第 3 轮的 t4）重新累积；第 1 轮旧对永久丢弃
    expect(turnCalls[3]).toHaveLength(4)
    const turn4ToolIds = turnCalls[3]!
      .filter((turn) => turn.role === 'assistant')
      .map((turn) => (turn.content as Array<{ type?: string; id?: string }>).find((b) => b.type === 'tool_use')?.id)
    expect(turn4ToolIds).toEqual(['t4'])

    // JSONL 审计全量照落：8 轮工具行 + 1 条宽限轮（2026-08-29，耗尽后的无 tools 调用）一条不少
    expect(readSessionJsonl('session-compact').filter((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use'))).toHaveLength(9)
  })

  it('压缩封顶 2 次：阈值持续超额、可触发轮次充足也不超出', async () => {
    process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = '1000'
    const { query } = compactQuery({ inputTokens: 999_999, handoff: 'text' })
    const events: Array<{ type: AgentEvent['type'] }> = []
    await runAgentLoop(baseInput({
      query,
      tools: [echo],
      maxTurns: 12,
      sessionId: 'session-compact-cap',
      publish: (type) => events.push({ type }),
    }))
    expect(events.filter((event) => event.type === 'loop_compaction')).toHaveLength(2)
  })

  it('交接 LLM 失败 → 确定性 fallback（轮次/工具统计/最近进展），不阻断 loop', async () => {
    process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = '1000'
    const { query, turnCalls } = compactQuery({ inputTokens: 5000, handoff: 'throw' })
    const result = await runAgentLoop(baseInput({ query, tools: [echo], maxTurns: 6, sessionId: 'session-compact-fallback' }))

    expect(result.status).toBe('turn_limit')
    const secondTurnTask = textOf(turnCalls[1]![1])
    expect(secondTurnTask).toContain('【此前进度交接（第 1 段）】')
    expect(secondTurnTask).toContain('自动交接')
    expect(secondTurnTask).toContain('echo×1')
  })

  it('BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS=0 完全关闭（回归锁）：usage 再大也不重置', async () => {
    process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = '0'
    const { query, turnCalls } = compactQuery({ inputTokens: 999_999, handoff: 'text' })
    const events: Array<{ type: AgentEvent['type'] }> = []
    const result = await runAgentLoop(baseInput({
      query,
      tools: [echo],
      maxTurns: 6,
      sessionId: 'session-compact-off',
      publish: (type) => events.push({ type }),
    }))

    expect(result.status).toBe('turn_limit')
    expect(events.filter((event) => event.type === 'loop_compaction')).toHaveLength(0)
    // 最后一轮是宽限轮（2026-08-29）：看到全部 6 对（无交接段、无压缩），窗口保留 6 对
    const lastCall = turnCalls.at(-1)!
    expect(JSON.stringify(lastCall)).not.toContain('此前进度交接')
    expect(lastCall).toHaveLength(1 + 1 + 6 * 2) // system + task + 6 轮对
  })

  it('abort 在交接等待中正确退出：交接调用挂起，主 signal 取消后立即收尾', async () => {
    process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = '1000'
    const { query } = compactQuery({ inputTokens: 5000, handoff: 'hang' })
    const controller = new AbortController()
    const events: Array<{ type: AgentEvent['type'] }> = []

    const pending = runAgentLoop(baseInput({
      query,
      tools: [echo],
      maxTurns: 6,
      sessionId: 'session-compact-abort',
      signal: controller.signal,
      publish: (type) => events.push({ type }),
    }))
    setTimeout(() => controller.abort(), 30)
    const result = await pending // 交接等待应随 abort 立即解除，而非阻塞

    expect(result.status).toBe('cancelled')
    expect(events.filter((event) => event.type === 'loop_compaction')).toHaveLength(0)
  })
})

/** 压缩×钉轮交互修复测试 query：可按轮指定工具名（gwt_fail/echo），usage 恒超额。 */
function turnScriptQuery(options: {
  toolByTurn: (turn: number) => string
  handoff: 'text' | 'throw'
  handoffText?: string
}): { query: SDKQuery; turnCalls: ConversationTurn[][] } {
  let calls = 0
  let turn = 0
  const turnCalls: ConversationTurn[][] = []
  const query: SDKQuery = async function* (_prompt, queryOptions) {
    const index = calls
    calls += 1
    if (queryOptions.tools === undefined) {
      if (options.handoff === 'throw') throw new Error('渠道 429')
      yield textMessage(options.handoffText ?? '交接：已完成布局；未解决 GWT；下一步修点击。')
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
      return
    }
    turn += 1
    turnCalls.push((queryOptions.messages ?? []).map((m) => ({ ...m })))
    yield toolUseMessage(`t${index}`, options.toolByTurn(turn))
    yield { type: 'result', subtype: 'success', stop_reason: 'tool_use', usage: { input_tokens: 5000, output_tokens: 10 } }
  }
  return { query, turnCalls }
}

/** 模拟 run_gwt_tests 失败：置位 test_failed 并增长 repair_round（与真实工具同款信号）。 */
function gwtFailTool(): AgentLoopTool {
  return {
    name: 'gwt_fail',
    description: '模拟测试失败',
    input_schema: { type: 'object', properties: {} },
    execute: async (_input, ctx) => {
      ctx.state.test_failed = true
      ctx.state.repair_round += 1
      return { output: '共 2 个场景：通过 0、失败 2。\n- F-002 按右方向键→列表高亮右移：断言未满足（预期高亮右移，实际无变化）' }
    },
  }
}

function toolUseIdOf(turn: ConversationTurn): string | undefined {
  return Array.isArray(turn.content)
    ? (turn.content as Array<{ type?: string; id?: string }>).find((b) => b.type === 'tool_use')?.id
    : undefined
}

describe('压缩×钉轮交互修复（审查 P1-1/P1-2）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalThreshold = process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS
  const echo = tool('echo', () => ({ output: 'ok' }))

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-pinfix-'))
    process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = '1000'
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    if (originalThreshold === undefined) delete process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS
    else process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = originalThreshold
  })

  it('压缩后无新失败 → 无幻影钉（不误钉无关轮对）', async () => {
    // 第 1 轮失败（钉轮）→ 同轮末压缩（钉轮随重置进交接文档）→ 后续轮不再失败
    const { query, turnCalls } = turnScriptQuery({ toolByTurn: (turn) => (turn === 1 ? 'gwt_fail' : 'echo'), handoff: 'text' })
    await runAgentLoop(baseInput({ query, tools: [echo, gwtFailTool()], maxTurns: 14, sessionId: 'session-pinfix-phantom' }))

    // 最后一轮（第 14 轮）调用：tail 为重置后第 2..13 轮共 12 对，窗口保留最近 8 对（第 6..13 轮）
    const lastCall = turnCalls.at(-1)!
    const ids = lastCall.filter((t) => t.role === 'assistant').map(toolUseIdOf).filter(Boolean)
    expect(lastCall).toHaveLength(1 + 1 + 16)
    // 第 4/5 轮对不在窗口内且不被幻影钉住（旧缺陷会钉 tail[2..3]=第 4 轮对）
    expect(ids).toHaveLength(8)
  })

  it('压缩后出现新测试失败 → 新失败轮被钉住（相对轮号映射正确）', async () => {
    // 前 2 轮 echo 触发两次压缩（封顶）；第 3 轮新失败 → 钉重置后的第 1 对
    const { query, turnCalls } = turnScriptQuery({ toolByTurn: (turn) => (turn === 3 ? 'gwt_fail' : 'echo'), handoff: 'text' })
    await runAgentLoop(baseInput({ query, tools: [echo, gwtFailTool()], maxTurns: 14, sessionId: 'session-pinfix-repin' }))

    const lastCall = turnCalls.at(-1)!
    const ids = lastCall.filter((t) => t.role === 'assistant').map(toolUseIdOf).filter(Boolean)
    expect(lastCall).toHaveLength(1 + 1 + 2 + 16) // system + task + 钉住的第 3 轮对 + 最近 8 对
    // 钉住的第 3 轮（重置后相对第 1 对）在最前，其余为第 6..13 轮；第 4/5 轮出窗且不钉
    // （第 3 轮自己的 pair 在第 4 轮调用里才可见）
    const turn4Call = turnCalls[3]!
    const turn3Id = turn4Call.filter((t) => t.role === 'assistant').map(toolUseIdOf).find(Boolean)
    expect(ids[0]).toBe(turn3Id)
    expect(ids).toHaveLength(9)
  })

  it('交接 LLM 失败 → 确定性 fallback 携带钉轮失败断言原文；交接文档落 JSONL 审计', async () => {
    const { query, turnCalls } = turnScriptQuery({ toolByTurn: () => 'gwt_fail', handoff: 'throw' })
    await runAgentLoop(baseInput({ query, tools: [echo, gwtFailTool()], maxTurns: 6, sessionId: 'session-pinfix-fallback' }))

    // 第 2 轮调用看到的交接段含失败断言原文（而非只有工具计数）
    const secondTask = textOf(turnCalls[1]![1])
    expect(secondTask).toContain('【此前进度交接（第 1 段）】')
    expect(secondTask).toContain('F-002')
    expect(secondTask).toContain('断言未满足')

    // 交接文档落 JSONL（system 行，与 [channel-switch] 同一呈现模式）
    const lines = readSessionJsonl('session-pinfix-fallback').map((line) => JSON.stringify(line))
    const compactionLine = lines.find((line) => line.includes('[loop-compaction]'))
    expect(compactionLine).toContain('F-002')
  })
})

describe('绿灯收口与宽限轮（2026-08-29 turn_limit 线上案例 eb900c57）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-wrapup-'))
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  /** 模拟 run_gwt_tests 全过：置位 gwt_all_passed（与真实工具同款信号）。 */
  function gwtPassTool(): AgentLoopTool {
    return {
      name: 'run_gwt_tests',
      description: '模拟测试全过',
      input_schema: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        ctx.state.gwt_all_passed = true
        return { output: '全部通过（5/5 个场景）。' }
      },
    }
  }

  /** 模拟 run_security_scan 通过：置位 security_all_passed（与真实工具同款信号）。 */
  function scanPassTool(): AgentLoopTool {
    return {
      name: 'run_security_scan',
      description: '模拟安全扫描通过',
      input_schema: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        ctx.state.security_all_passed = true
        return { output: '安全扫描通过：无高危/严重问题。' }
      },
    }
  }

  it('测试+扫描全过后下一轮停用工具并追加收口指令 → 模型交卷 completed（线上案例根因回归）', async () => {
    // 剧本：第 1 轮同时要测试+扫描（都全过）→ 收口轮（无 tools）输出总结
    const { query, receivedToolCount, receivedMessages } = scriptedQuery([
      [toolUseMessage('t1', 'run_gwt_tests'), toolUseMessage('t2', 'run_security_scan')],
      [textMessage('完成：8Bit 模拟器全部功能就绪。')],
    ])
    const result = await runAgentLoop(baseInput({ query, tools: [gwtPassTool(), scanPassTool()] }))

    expect(result.status).toBe('completed')
    expect(result.turns).toBe(2)
    expect(result.finalText).toBe('完成：8Bit 模拟器全部功能就绪。')
    // 收口轮不带任何工具（tools 为空数组），system 追加收口指令
    expect(receivedToolCount).toEqual([2, 0])
    expect(String((receivedMessages[1]![0] as { content: string }).content)).toContain('【收口】')
  })

  it('测试全过但安全扫描未跑 → 不收口，继续给工具（收口需两个绿灯同时成立）', async () => {
    const { query, receivedToolCount } = scriptedQuery([
      [toolUseMessage('t1', 'run_gwt_tests')],
      [toolUseMessage('t2', 'run_security_scan')],
      [textMessage('完成')],
    ])
    const result = await runAgentLoop(baseInput({ query, tools: [gwtPassTool(), scanPassTool()] }))
    expect(result.status).toBe('completed')
    // 第 2 轮仍带工具定义（安全扫描还没跑，不得提前收口）；第 3 轮收口停用全部工具
    expect(receivedToolCount).toEqual([2, 2, 0])
  })

  it('maxTurns 耗尽 → 宽限轮纯文本交卷 → completed（宽限轮不计 turns）', async () => {
    const echo = tool('echo', () => ({ output: 'ok' }))
    let call = 0
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const query: SDKQuery = async function* () {
      call += 1
      if (call <= 3) {
        yield toolUseMessage(`t${call}`, 'echo')
        yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
      } else {
        yield textMessage('总结：基础功能已完成。')
        yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
      }
    }
    const result = await runAgentLoop(baseInput({
      query,
      tools: [echo],
      maxTurns: 3,
      publish: (type, payload) => events.push({ type, payload }),
    }))

    expect(result.status).toBe('completed')
    expect(result.turns).toBe(3) // 宽限轮不计入 turns
    expect(result.finalText).toBe('总结：基础功能已完成。')
    expect(result.toolCalls).toHaveLength(3)
    // 宽限轮文本照进事件流（UI 可见交卷内容）
    expect(events.some((event) => event.type === 'message_delta' && String(event.payload.text).includes('总结'))).toBe(true)
  })

  it('宽限轮仍坚持要工具 → 如实 turn_limit（不谎报完成）', async () => {
    const echo = tool('echo', () => ({ output: 'ok' }))
    const { query } = scriptedQuery([[toolUseMessage('t1', 'echo')]])
    const result = await runAgentLoop(baseInput({ query, tools: [echo], maxTurns: 2 }))
    expect(result.status).toBe('turn_limit')
    expect(result.turns).toBe(2)
  })
})
