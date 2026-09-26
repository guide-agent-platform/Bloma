import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAgentLoop, TOOL_WINDOW_ROUNDS, windowMessages, keepRecentTurns, estimateBlocksText, renderCheckpointRecoveryHeader, type AgentLoopInput, type AgentLoopTool, type AgentLoopTurnInfo, type AgentLoopCompactionInfo, type LoopCheckpointSnapshot, type ToolContext, type ToolOutcome } from '../../main/agent/loop/agent-loop'
import { estimateTokenCount } from '../../main/agent/loop/usage-guard'
import { drainSteerQueue, enqueueSteer, getSteerStatuses, pendingSteerCount, registerSteer, resetSteerQueuesForTests, STEER_WRAP_PREFIX, wrapSteerContent } from '../../main/agent/loop/steer-queue'
import type { AgentEvent } from '../../shared/types'
import type { SDKMessage } from '../../shared/types'
import type { ConversationTurn, SDKQuery, SDKQueryOptions } from '../../main/orchestration/orchestrator'
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
    // P2a：真实跑满轮数不带 termination_detail（与输出退化出口区分）
    expect(result.termination_detail).toBeUndefined()
  })

  it('P2a：末轮零 tool_use 且正文退化 → 重试一次仍脏 → turn_limit 附 termination_detail（狗粮 94f449c6 形态）', async () => {
    const dsml = (text: string) => textMessage(`正在收口。\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="run_gwt_tests">\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>\n${text}`)
    const { query, receivedMessages } = scriptedQuery([[dsml('一')], [dsml('二')]])
    const result = await runAgentLoop(baseInput({ query, maxTurns: 6 }))
    expect(result.status).toBe('turn_limit')
    // R1-loop：意图不再无声丢弃——dropped_tool_intents 随出口留痕（狗粮 7601e5ae #496）
    expect(result.termination_detail).toEqual({ reason: 'degenerate_output', retries: 1, dropped_tool_intents: ['run_gwt_tests'] })
    // 传输事故反馈确实注入（重试轮收到的最后一条 user 消息是 DEGENERATE_RETRY_FEEDBACK 家族）
    const lastRetryMessages = receivedMessages[1]
    const lastUserContent = lastRetryMessages.at(-1)?.content
    const lastUserText = Array.isArray(lastUserContent)
      ? lastUserContent.some((b) => b.type === 'text')
      : typeof lastUserContent === 'string' && lastUserContent.length > 0
    expect(lastUserText).toBe(true)
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

  it('P1-04 批次取消配对完整：已完成工具结果+未执行占位随取消落盘（无悬空 tool_use）', async () => {
    const controller = new AbortController()
    const fast = tool('fast', () => ({ output: 'fast-done' }))
    const hung = tool('hung', () => new Promise<ToolOutcome>(() => {}))
    const query: SDKQuery = async function* () {
      yield toolUseMessage('t1', 'fast')
      yield toolUseMessage('t2', 'hung')
      yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
    }
    const input = baseInput({ query, tools: [fast, hung], signal: controller.signal })
    const promise = runAgentLoop(input)
    await new Promise((resolve) => setTimeout(resolve, 30))
    controller.abort(new Error('AGENT_CANCELLED: user'))
    const result = await promise
    expect(result.status).toBe('cancelled')
    // 会话历史：assistant tool_use(t1,t2) 之后的 user 消息必须含 t1 真结果 + t2 取消占位
    const lines = readSessionJsonl(input.sessionId)
    const assistantToolUse = lines.find((line) => line.role === 'assistant' && line.content?.some((b) => b.type === 'tool_use'))
    expect(assistantToolUse).toBeDefined()
    const userAfter = lines.find((line) => line.role === 'user' && Array.isArray(line.content) && line.content.some((b) => b.type === 'tool_result'))
    expect(userAfter).toBeDefined()
    const results = userAfter?.content ?? []
    expect(results.some((b) => b.type === 'tool_result' && b.content === 'fast-done')).toBe(true)
    expect(results.some((b) => b.type === 'tool_result' && b.is_error === true && (b.content ?? '').includes('取消'))).toBe(true)
    // 配对完整：每个 tool_use 都有对应 tool_result（重放不再 400）
    const useIds = new Set((assistantToolUse?.content ?? []).filter((b) => b.type === 'tool_use').map((b) => (b as { id?: string }).id))
    const resultIds = new Set(results.filter((b) => b.type === 'tool_result').map((b) => (b as { tool_use_id?: string }).tool_use_id))
    for (const id of useIds) expect(resultIds.has(id)).toBe(true)
  })

  it('流式中途取消：半截旁白如实落盘取证，且不含悬空 tool_use（2026-09-04「查。」墙案）', async () => {
    const controller = new AbortController()
    // 模拟退行重复：正常增量后用户在流中取消，query 抛 AGENT_CANCELLED
    const query: SDKQuery = async function* () {
      yield textMessage('看 hidden。读。')
      yield textMessage('查。查。查。查。查。')
      controller.abort(new Error('AGENT_CANCELLED: user'))
      throw new Error('AGENT_CANCELLED: user')
    }
    const result = await runAgentLoop(
      baseInput({ query, signal: controller.signal, sessionId: 'session-cancel-partial' }),
    )
    expect(result.status).toBe('cancelled')
    // W1-E1：取消触发源细分——流中取消被 model_stream 观察点捕获，reason 解析出 source
    expect(result.cancel_detail).toMatchObject({ phase: 'model_stream', source: 'user' })

    // 取证：半截文本进了 JSONL（此前该轮整体丢弃→「事后考察不到」）
    const messages = readSessionJsonl('session-cancel-partial')
    const partial = messages.find((message) => message.role === 'assistant')
    expect(partial).toBeDefined()
    const partialText = (partial!.content[0] as { text?: string }).text ?? ''
    expect(partialText).toContain('看 hidden。读。')
    expect(partialText).toContain('查。查。查。查。查。')
    // 可重放面不进残局：无悬空 tool_use（无 tool_result 配对的一律不落）
    expect(messages.some((message) => message.content.some((block) => block.type === 'tool_use'))).toBe(false)
  })

  it('流式中途取消且已有 tool_use 到达：仍只落 text 块（tool_use 剔除防重放 400）', async () => {
    const controller = new AbortController()
    const query: SDKQuery = async function* () {
      yield textMessage('我先看一眼文件。')
      yield toolUseMessage('t1', 'read_file', { path: 'index.html' })
      yield textMessage('再补充一点说明')
      controller.abort(new Error('AGENT_CANCELLED: user'))
      throw new Error('AGENT_CANCELLED: user')
    }
    await runAgentLoop(
      baseInput({ query, signal: controller.signal, sessionId: 'session-cancel-tooluse' }),
    )
    const messages = readSessionJsonl('session-cancel-tooluse')
    const partial = messages.find((message) => message.role === 'assistant')!
    // 两段文本都在（tool_use 前的已 flush 进 blocks + 取消后拼盘的 pending）
    const joined = partial.content.map((block) => (block as { text?: string }).text ?? '').join('')
    expect(joined).toContain('我先看一眼文件。')
    expect(joined).toContain('再补充一点说明')
    expect(partial.content.some((block) => block.type === 'tool_use')).toBe(false)
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
    // 09-16 缺省已翻全量历史；本用例显式回滑窗验证 F4 窗口语义
    process.env.BLOMA_LOOP_WINDOW_OFF = '0'
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
  // P1-1 keep-recent（2026-09-08）：本 describe 锁定压缩「机制」（触发/封顶/fallback/关闭/abort），
  // 保留段置 '0' 回归旧两段结构；保留段行为由下方「keep-recent 三段式压缩」describe 单独锁定。
  const originalKeepRecent = process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS
  const echo = tool('echo', () => ({ output: 'ok' }))

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-compact-'))
    process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS = '0'
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    if (originalThreshold === undefined) delete process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS
    else process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = originalThreshold
    if (originalKeepRecent === undefined) delete process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS
    else process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS = originalKeepRecent
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

  it('W1-E1：压缩观测埋点 onCompaction——段号/保留移除计数/交接口径/上限后首次 skip（max_compactions）', async () => {
    process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = '1000'
    const { query } = compactQuery({ inputTokens: 5000, handoff: 'text' })
    const observed: AgentLoopCompactionInfo[] = []
    const result = await runAgentLoop(baseInput({
      query,
      tools: [echo],
      maxTurns: 6,
      sessionId: 'session-compact-observe',
      onCompaction: (info) => observed.push(info),
    }))
    // echo 永不停工具 → turn_limit；途中两次压缩（turn<maxTurns-3=3）+ 第 3 轮首次上限跳过
    expect(result.status).toBe('turn_limit')
    expect(observed).toHaveLength(3)
    expect(observed[0]).toMatchObject({
      at_turn: 1,
      segment: 1,
      trigger_input_tokens: 5000,
      retained_turns: 0, // KEEP_RECENT='0'：旧两段结构，无保留段
      removed_turns: 2,  // [asst(tool_use), user(tool_result)] 两轮历史被移除
      handoff_fallback: false,
    })
    expect(observed[0]!.est_tokens_before!).toBeGreaterThan(0)
    expect(observed[0]!.est_tokens_after!).toBeGreaterThan(0)
    expect(observed[0]!.handoff_chars!).toBeGreaterThan(0)
    expect(observed[1]).toMatchObject({ at_turn: 2, segment: 2, removed_turns: 2 })
    // 上限后：阈值仍满足但静默跳过（E6 核查 1 定案），首次报一条 max_compactions
    expect(observed[2]).toMatchObject({
      at_turn: 3,
      segment: 2,
      skipped: true,
      skip_reason: 'max_compactions',
      trigger_input_tokens: 5000,
      retained_turns: 0,
      removed_turns: 0,
      handoff_chars: 0,
    })
  })

  it('W1-E1：末段保护跳过报 late_turn（turn ≥ maxTurns-3 后不再压缩）', async () => {
    process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = '1000'
    const { query } = compactQuery({ inputTokens: 5000, handoff: 'text' })
    const observed: AgentLoopCompactionInfo[] = []
    await runAgentLoop(baseInput({
      query,
      tools: [echo],
      maxTurns: 5, // turn < 5-3=2：仅第 1 轮可压缩；第 2 轮起末段保护
      sessionId: 'session-compact-late',
      onCompaction: (info) => observed.push(info),
    }))
    expect(observed).toHaveLength(2)
    expect(observed[0]).toMatchObject({ at_turn: 1, segment: 1 })
    expect(observed[1]).toMatchObject({ at_turn: 2, skipped: true, skip_reason: 'late_turn' })
  })

  it('W1-E1：交接失败兑底路径 handoff_fallback=true，est 口径照报', async () => {
    process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = '1000'
    const { query } = compactQuery({ inputTokens: 5000, handoff: 'throw' })
    const observed: AgentLoopCompactionInfo[] = []
    await runAgentLoop(baseInput({
      query,
      tools: [echo],
      maxTurns: 6,
      sessionId: 'session-compact-fallback-observe',
      onCompaction: (info) => observed.push(info),
    }))
    expect(observed[0]).toMatchObject({ segment: 1, handoff_fallback: true })
    expect(observed[0]!.handoff_chars!).toBeGreaterThan(0) // deterministicHandoff 兑底文本
    expect(observed[1]).toMatchObject({ segment: 2, handoff_fallback: true })
  })
})

describe('W1-E1 取消触发源细分（cancel_detail）', () => {
  const echo = tool('echo', () => ({ output: 'ok' }))

  it('启动前已中止：turn_start 观察点 + AGENT_CANCELLED source 解析', async () => {
    const controller = new AbortController()
    controller.abort(new Error('AGENT_CANCELLED: user_cancelled'))
    const result = await runAgentLoop(baseInput({
      query: async function* () { yield { type: 'result', subtype: 'success' } },
      tools: [echo],
      signal: controller.signal,
      sessionId: 'session-cancel-prestart',
    }))
    expect(result.status).toBe('cancelled')
    expect(result.cancel_detail).toMatchObject({ phase: 'turn_start', source: 'user_cancelled' })
  })

  it('无 reason 的 abort（委派 stop/程序化）：source=unattributed，reason 原样保留', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await runAgentLoop(baseInput({
      query: async function* () { yield { type: 'result', subtype: 'success' } },
      tools: [echo],
      signal: controller.signal,
      sessionId: 'session-cancel-noreason',
    }))
    expect(result.status).toBe('cancelled')
    expect(result.cancel_detail?.phase).toBe('turn_start')
    expect(result.cancel_detail?.source).toBe('unattributed')
    expect(result.cancel_detail?.reason).toBeTruthy()
  })

  it('abort 在交接等待中：handoff 观察点捕获（cancel_detail 而非裸 status）', async () => {
    process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = '1000'
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-compact-'))
    const { query } = compactQuery({ inputTokens: 5000, handoff: 'hang' })
    const controller = new AbortController()
    const pending = runAgentLoop(baseInput({
      query,
      tools: [echo],
      maxTurns: 6,
      sessionId: 'session-compact-abort-detail',
      signal: controller.signal,
    }))
    setTimeout(() => controller.abort(), 30)
    const result = await pending
    expect(result.status).toBe('cancelled')
    expect(result.cancel_detail).toMatchObject({ phase: 'handoff', source: 'unattributed' })
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
  // P1-1 keep-recent：同上——本 describe 锁钉轮坐标系机制，保留段置 '0'（配对断言不随保留段漂移）
  const originalKeepRecent = process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS
  const echo = tool('echo', () => ({ output: 'ok' }))

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-pinfix-'))
    process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = '1000'
    process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS = '0'
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    if (originalThreshold === undefined) delete process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS
    else process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = originalThreshold
    if (originalKeepRecent === undefined) delete process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS
    else process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS = originalKeepRecent
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

describe('keep-recent 三段式压缩（P1-1，2026-09-08 pi 差距方案）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalThreshold = process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS
  const originalKeepRecent = process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS
  const echo = tool('echo', () => ({ output: 'ok' }))

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-keeprecent-'))
    process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = '1000'
    // 缺省 8000（除非用例显式覆盖）；afterEach 按 originalKeepRecent 归一
    delete process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    if (originalThreshold === undefined) delete process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS
    else process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = originalThreshold
    if (originalKeepRecent === undefined) delete process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS
    else process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS = originalKeepRecent
  })

  // ---- keepRecentTurns 纯函数 ----

  function pairTurns(id: string, resultText: string): ConversationTurn[] {
    return [
      { role: 'assistant', content: [{ type: 'tool_use', id, name: 'echo', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: resultText }] },
    ]
  }
  function userTextTurn(text: string): ConversationTurn {
    return { role: 'user', content: text }
  }
  function pairCost(pair: ConversationTurn[]): number {
    return pair.reduce((n, turn) => n + estimateTokenCount(typeof turn.content === 'string' ? turn.content : estimateBlocksText(turn.content)), 0)
  }

  it('纯函数：预算充足 → tail 全保留且原序（首条 task/head 不进保留段）', () => {
    const messages: ConversationTurn[] = [userTextTurn('任务'), ...pairTurns('t1', '结果一'), userTextTurn('【用户中途补充】补充'), ...pairTurns('t2', '结果二')]
    const kept = keepRecentTurns(messages, 100_000)
    expect(kept).toHaveLength(5)
    expect(kept[0]).toEqual(pairTurns('t1', '结果一')[0])
    expect(kept[2]).toEqual(userTextTurn('【用户中途补充】补充'))
    expect(kept[4]).toEqual(pairTurns('t2', '结果二')[1])
    // head（task）绝不进保留段——新首消息已含 task+交接
    expect(kept.some((turn) => typeof turn.content === 'string' && turn.content === '任务')).toBe(false)
  })

  it('纯函数：预算恰够最新对 → 只保留该完整对（连续后缀，不拆对、不留中空）', () => {
    const pair2 = pairTurns('t2', '结果二')
    const messages: ConversationTurn[] = [userTextTurn('任务'), ...pairTurns('t1', '结果一'), userTextTurn('注入轮'), ...pair2]
    const kept = keepRecentTurns(messages, pairCost(pair2))
    expect(kept).toHaveLength(2)
    expect(kept).toEqual(pair2)
  })

  it('纯函数：文本注入轮紧邻最新对 → 预算内连带保留（对永不拆散）', () => {
    const pair2 = pairTurns('t2', '结果二')
    const steer = userTextTurn('【用户中途补充】补充')
    const steerCost = typeof steer.content === 'string' ? estimateTokenCount(steer.content) : 0
    const messages: ConversationTurn[] = [userTextTurn('任务'), ...pairTurns('t1', '结果一'), steer, ...pair2]
    const kept = keepRecentTurns(messages, pairCost(pair2) + steerCost)
    expect(kept).toHaveLength(3)
    expect(kept[0]).toEqual(steer)
    expect(kept[1]).toEqual(pair2[0])
    expect(kept[2]).toEqual(pair2[1])
  })

  it("纯函数：'0'/空 tail → 不保留（旧行为）", () => {
    const messages: ConversationTurn[] = [userTextTurn('任务'), ...pairTurns('t1', '结果一')]
    expect(keepRecentTurns(messages, 0)).toEqual([])
    expect(keepRecentTurns([userTextTurn('任务')], 8_000)).toEqual([])
  })

  it('纯函数：单对超出整个预算 → 整对丢弃（不截断内容、由交接文档兜底）', () => {
    const messages: ConversationTurn[] = [userTextTurn('任务'), ...pairTurns('t1', '超长结果'.repeat(200))]
    expect(keepRecentTurns(messages, 10)).toEqual([])
  })

  // ---- 集成（runAgentLoop 全链路） ----

  it('缺省预算：压缩重置为三段（task+交接+近期原文保留），保留段估算不超 8000 token', async () => {
    const { query, turnCalls, handoffCalls } = compactQuery({ inputTokens: 5000, handoff: 'text', handoffText: '交接：布局完成，GWT 场景 3 未过，下一步修点击。' })
    const events: Array<{ type: AgentEvent['type']; payload: Record<string, unknown> }> = []
    await runAgentLoop(baseInput({ query, tools: [echo], maxTurns: 8, sessionId: 'session-keeprecent-default', publish: (type, payload) => events.push({ type, payload }) }))

    // 第 2 轮模型调用看到三段：system + head(task+交接+保留段标记) + 保留的最新工具对（t0）
    expect(turnCalls[1]).toHaveLength(4)
    const head = textOf(turnCalls[1]![1])
    expect(head).toContain('测试任务')
    expect(head).toContain('【此前进度交接（第 1 段）】')
    expect(head).toContain('布局完成')
    expect(head).toContain('【近期原文保留】')
    const retained = turnCalls[1]!.slice(2)
    expect(retained[0]!.role).toBe('assistant')
    expect((retained[0]!.content as Array<{ type?: string; id?: string }>).find((b) => b.type === 'tool_use')?.id).toBe('t0')
    expect(retained[1]!.role).toBe('user')
    const retainedTokens = retained.reduce((n, turn) => n + estimateTokenCount(typeof turn.content === 'string' ? turn.content : estimateBlocksText(turn.content)), 0)
    expect(retainedTokens).toBeLessThanOrEqual(8_000)

    // 事件与 JSONL 审计均携带保留段信息
    const compaction = events.find((event) => event.type === 'loop_compaction')
    expect(compaction?.payload).toMatchObject({ keep_recent_turns: 2 })
    const lines = readSessionJsonl('session-keeprecent-default').map((line) => JSON.stringify(line))
    expect(lines.find((line) => line.includes('[loop-compaction]'))).toContain('keep_recent=2 轮')

    // 交接调用输入包含保留段之前的原文（交接在重置前发生，天然携带全量窗口）
    expect(handoffCalls).toHaveLength(2)
  })

  it("预算 '1'（装不下任何完整对）→ 回归两段结构：无保留段标记、无保留轮", async () => {
    process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS = '1'
    const { query, turnCalls } = compactQuery({ inputTokens: 5000, handoff: 'text' })
    const events: Array<{ type: AgentEvent['type']; payload: Record<string, unknown> }> = []
    await runAgentLoop(baseInput({ query, tools: [echo], maxTurns: 8, sessionId: 'session-keeprecent-tiny', publish: (type, payload) => events.push({ type, payload }) }))
    expect(turnCalls[1]).toHaveLength(2)
    expect(textOf(turnCalls[1]![1])).not.toContain('【近期原文保留】')
    expect(events.find((event) => event.type === 'loop_compaction')?.payload).toMatchObject({ keep_recent_turns: 0 })
  })

  it("KEEP_RECENT='0' 显式回归：三段完全退化为旧两段（task+交接，与 2026-08-29 行为一致）", async () => {
    process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS = '0'
    const { query, turnCalls } = compactQuery({ inputTokens: 5000, handoff: 'text' })
    await runAgentLoop(baseInput({ query, tools: [echo], maxTurns: 8, sessionId: 'session-keeprecent-off' }))
    expect(turnCalls[1]).toHaveLength(2)
    const head = textOf(turnCalls[1]![1])
    expect(head).toContain('【此前进度交接（第 1 段）】')
    expect(head).not.toContain('【近期原文保留】')
  })

  it('与钉轮共存：首个测试失败轮原文经保留段存活（交接文档之外双保险），压缩封顶仍 2 次', async () => {
    // 第 1 轮 gwt 失败（钉轮信号）→ 同轮末压缩：交接文档（LLM 文本）不含断言原文，
    // 保留段把失败工具对原文留下——修复不再依赖单一交接文档记忆
    const { query, turnCalls } = turnScriptQuery({ toolByTurn: (turn) => (turn === 1 ? 'gwt_fail' : 'echo'), handoff: 'text' })
    const events: Array<{ type: AgentEvent['type'] }> = []
    await runAgentLoop(baseInput({ query, tools: [echo, gwtFailTool()], maxTurns: 14, sessionId: 'session-keeprecent-pin', publish: (type) => events.push({ type }) }))

    // 第 2 轮模型调用：三段结构 + 保留段含 F-002 断言原文
    expect(JSON.stringify(turnCalls[1])).toContain('F-002')
    expect(textOf(turnCalls[1]![1])).toContain('【近期原文保留】')
    // 保留段把 token 加回上下文，但压缩次数仍受封顶约束（2 次）
    expect(events.filter((event) => event.type === 'loop_compaction')).toHaveLength(2)
  })

  it('交接 LLM 失败 → 确定性 fallback 同样带保留段（降级路径恰最需要细节）', async () => {
    const { query, turnCalls } = compactQuery({ inputTokens: 5000, handoff: 'throw' })
    await runAgentLoop(baseInput({ query, tools: [echo], maxTurns: 6, sessionId: 'session-keeprecent-fallback' }))
    expect(turnCalls[1]).toHaveLength(4)
    const head = textOf(turnCalls[1]![1])
    expect(head).toContain('【自动交接')
    expect(head).toContain('【近期原文保留】')
    expect(turnCalls[1]![2]!.role).toBe('assistant') // 保留的 t0 工具对
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

  // ---- P3 loop-log（2026-09-04 PR-B）：TurnInfo.toolCalls 可选 path 提取 ----

  it('P3：文件类工具的入参 path 提取进 TurnInfo（write_file 携带；非文件工具无 path 键）', async () => {
    const writeFile = tool('write_file', () => ({ output: 'written' }))
    const echo = tool('echo', () => ({ output: 'ok' }))
    const turns: AgentLoopTurnInfo[] = []
    const query: SDKQuery = async function* () {
      yield toolUseMessage('t1', 'write_file', { path: 'src/app.js', content: 'x' })
      yield toolUseMessage('t2', 'echo')
      yield { type: 'result', subtype: 'success', stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } }
    }
    const result = await runAgentLoop(baseInput({
      query,
      tools: [writeFile, echo],
      maxTurns: 1,
      onTurn: (info) => turns.push(info),
    }))
    // path 提取：仅文件类工具携带；同一轮内非文件工具不带 path 键
    expect(turns).toHaveLength(1)
    expect(turns[0].toolCalls).toEqual([
      { name: 'write_file', turn: 1, path: 'src/app.js' },
      { name: 'echo', turn: 1 },
    ])
    // result.toolCalls 同源继承（同一数组对象拼接）
    expect(result.toolCalls).toEqual(turns[0].toolCalls)
  })

  it('P3：path 入参非字符串/空白时不提取（防御）；既有埋点消费方零感知（无 path 键）', async () => {
    const echo = tool('echo', () => ({ output: 'ok' }))
    const turns: AgentLoopTurnInfo[] = []
    const query: SDKQuery = async function* () {
      yield toolUseMessage('t1', 'echo', { path: 42 })
      yield toolUseMessage('t2', 'echo', { path: '   ' })
      yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
    }
    await runAgentLoop(baseInput({ query, tools: [echo], maxTurns: 1, onTurn: (info) => turns.push(info) }))
    expect(turns[0].toolCalls).toEqual([
      { name: 'echo', turn: 1 },
      { name: 'echo', turn: 1 },
    ])
    // 非文件工具的既有形态一字不增（payload 不变形，硬约束 8）
    expect(Object.keys(turns[0].toolCalls[0])).toEqual(['name', 'turn'])
  })
})

describe('终轮退行守卫（P0，2026-09-06 地牢清怪录案）', () => {
  it('零 tool_use 但正文混入工具调用原文 → 带反馈重试一轮；重试干净 → completed', async () => {
    const { query, receivedMessages } = scriptedQuery([
      [textMessage('我先检查一下。\n<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="grep">')],
      [textMessage('检查完毕，全部完成。')],
    ])
    const result = await runAgentLoop(baseInput({ query, maxTurns: 3 }))
    expect(result.status).toBe('completed')
    expect(result.finalText).toBe('检查完毕，全部完成。')
    // 反馈 user 轮进了模型上下文（重试可见失败原因）
    const retryMessages = receivedMessages[1]
    const last = retryMessages[retryMessages.length - 1]
    expect(last.role).toBe('user')
    expect(JSON.stringify(last.content)).toContain('传输事故反馈')
  })

  it('退行重复墙同样触发重试；重试仍脏 → 如实 turn_limit（不判 completed）', async () => {
    const { query } = scriptedQuery([
      [textMessage('查。'.repeat(30))],
      [textMessage('查。'.repeat(30))],
    ])
    const result = await runAgentLoop(baseInput({ query, maxTurns: 3 }))
    expect(result.status).toBe('turn_limit')
  })

  it('正常零 tool_use 收工不受影响（零回归）', async () => {
    const { query } = scriptedQuery([[textMessage('全部完成，测试全绿。')]])
    const result = await runAgentLoop(baseInput({ query }))
    expect(result.status).toBe('completed')
    expect(result.finalText).toBe('全部完成，测试全绿。')
  })

  it('宽限收口轮交卷文本退行 → turn_limit（宽限轮不作完成总结）', async () => {
    const echo = tool('echo', () => ({ output: 'ok' }))
    const { query } = scriptedQuery([
      [toolUseMessage('t1', 'echo')],
      [textMessage('查。'.repeat(40))],
    ])
    const result = await runAgentLoop(baseInput({ query, tools: [echo], maxTurns: 1 }))
    expect(result.status).toBe('turn_limit')
  })
})

describe('steer 运行中转向（P0-1，2026-09-08 pi 差距方案）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-steer-'))
    resetSteerQueuesForTests()
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    resetSteerQueuesForTests()
  })

  /** echo 工具：execute 时把给定文本入队为 steer（模拟用户在当前运行会话中途补充）。 */
  function steerDuringTool(text: string): AgentLoopTool {
    return {
      name: 'steer_during',
      description: '执行时注入一条 steer',
      input_schema: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        enqueueSteer(ctx.sessionId, { queueMessageId: `steer-${text.length}-${Date.now()}`, content: text, enqueuedAt: Date.now() })
        return { output: 'ok' }
      },
    }
  }

  it('批间注入：工具执行中入队的 steer 在下一轮模型调用可见（包裹 + JSONL + 事件）', async () => {
    const steerTool = steerDuringTool('把按钮改成蓝色')
    const { query, receivedMessages } = scriptedQuery([
      [toolUseMessage('t1', 'steer_during')],
      [toolUseMessage('t2', 'echo')],
      [textMessage('完成')],
    ])
    const events: Array<{ type: AgentEvent['type']; payload: Record<string, unknown> }> = []
    const result = await runAgentLoop(baseInput({ query, tools: [steerTool, tool('echo', () => ({ output: 'ok' }))], maxTurns: 3, sessionId: 'session-steer', publish: (type, payload) => events.push({ type, payload }) }))
    expect(result.status).toBe('completed')

    // 第 2 轮模型调用（receivedMessages[1]）：task + t1 对后紧跟注入的 steer user 轮
    const secondCall = receivedMessages[1]!
    const steerTurn = secondCall.find((turn) => turn.role === 'user' && JSON.stringify(turn.content).includes(STEER_WRAP_PREFIX))
    expect(steerTurn).toBeDefined()
    expect(JSON.stringify(steerTurn!.content)).toContain(wrapSteerContent('把按钮改成蓝色'))
    // 第 3 轮调用里 steer 仍在（未丢）
    expect(JSON.stringify(receivedMessages[2])).toContain('把按钮改成蓝色')

    // steer_injected 事件：payload 含原文/包裹全文/轮号
    const injected = events.filter((event) => event.type === 'steer_injected')
    expect(injected).toHaveLength(1)
    expect(injected[0]!.payload).toMatchObject({ content: '把按钮改成蓝色', at_turn: 1 })

    // JSONL 审计：注入的 user 行已落盘（与模型所见一致）
    const lines = readSessionJsonl('session-steer')
    expect(JSON.stringify(lines)).toContain(wrapSteerContent('把按钮改成蓝色'))
    // 队列已排空（drain 单点取走，无残留）
    expect(pendingSteerCount('session-steer')).toBe(0)
  })

  it('多 steer 保序注入；同一批 drain 全部进 messages', async () => {
    let count = 0
    const steerTool: AgentLoopTool = {
      name: 'steer_many',
      description: '连续注入两条 steer',
      input_schema: { type: 'object', properties: {} },
      execute: async () => {
        count += 1
        enqueueSteer('session-steer-many', { queueMessageId: `s${count}a`, content: `第一条${count}`, enqueuedAt: Date.now() })
        enqueueSteer('session-steer-many', { queueMessageId: `s${count}b`, content: `第二条${count}`, enqueuedAt: Date.now() })
        return { output: 'ok' }
      },
    }
    const { query, receivedMessages } = scriptedQuery([
      [toolUseMessage('t1', 'steer_many')],
      [toolUseMessage('t2', 'steer_many')],
      [textMessage('完成')],
    ])
    await runAgentLoop(baseInput({ query, tools: [steerTool], maxTurns: 3, sessionId: 'session-steer-many' }))

    // 每次模型调用收到的 user 文本（保序）——steer 注入按源序出现在对应批后
    const userTextsOf = (messages: ConversationTurn[]): string[] =>
      messages.flatMap((turn) =>
        turn.role === 'user'
          ? (Array.isArray(turn.content) ? turn.content : [{ type: 'text' as const, text: turn.content }])
              .filter((block) => block.type === 'text')
              .map((block) => block.text ?? '')
          : [],
      )
    // 第 2 轮调用（turn 2 模型请求前，第 1 批两条已注入）；第 3 轮调用（第 2 批两条已注入）
    const call2Texts = userTextsOf(receivedMessages[1]!)
    const call3Texts = userTextsOf(receivedMessages[2]!)
    const hasText = (texts: string[], needle: string): boolean => texts.some((text) => text.includes(needle))
    expect(hasText(call2Texts, '第一条1')).toBe(true)
    expect(hasText(call2Texts, '第二条1')).toBe(true)
    expect(hasText(call3Texts, '第一条2')).toBe(true)
    expect(hasText(call3Texts, '第二条2')).toBe(true)
    expect(pendingSteerCount('session-steer-many')).toBe(0)
  })

  it('委派子会话（delegationDepth≥1）不开放 steer：入队被拒（不在 loopActive）、消息零注入', async () => {
    const steerTool = steerDuringTool('子会话不该收到')
    const { query, receivedMessages } = scriptedQuery([[toolUseMessage('t1', 'steer_during')], [textMessage('子任务完成')]])
    await runAgentLoop(baseInput({ query, tools: [steerTool], maxTurns: 2, sessionId: 'session-steer-child', delegationDepth: 1 }))
    // enqueue 门：子会话未 markLoopActive → enqueueSteer 直接拒绝，队列空
    expect(pendingSteerCount('session-steer-child')).toBe(0)
    // 模型消息里没有包裹文本
    expect(JSON.stringify(receivedMessages[1])).not.toContain('子会话不该收到')
  })

  it('主 loop 收尾时未及注入的残余 → 落 JSONL 保真（自然结束不丢内容）', async () => {
    const steerTool = steerDuringTool('收尾前到达')
    const { query } = scriptedQuery([
      [toolUseMessage('t1', 'steer_during')],
      [textMessage('做完')],
    ])
    await runAgentLoop(baseInput({ query, tools: [steerTool], maxTurns: 2, sessionId: 'session-steer-tail' }))
    // 入队发生在 t1 execute 时 → t1 批后已注入（非残余）；这里验证队列空 + 注入已落 JSONL
    expect(pendingSteerCount('session-steer-tail')).toBe(0)
    expect(JSON.stringify(readSessionJsonl('session-steer-tail'))).toContain(wrapSteerContent('收尾前到达'))
  })

  it('steer 注入发生在竹节压缩检查之前：注入轮进交接输入（无特判共存）', async () => {
    process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = '1000'
    process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS = '0'
    // 第 1 轮 steer_during（execute 内入队 steer + usage 超额）→ drain 先于压缩检查，
    // 注入的 user 轮已进 messages → requestHandoff 的窗口输入天然携带（「压缩时进交接输入」）
    const steerTool = steerDuringTool('压缩前补充的方向')
    let calls = 0
    const handoffInputs: ConversationTurn[][] = []
    const query: SDKQuery = async function* (_prompt, queryOptions) {
      const index = calls
      calls += 1
      if (queryOptions.tools === undefined) {
        handoffInputs.push((queryOptions.messages ?? []).map((turn) => ({ ...turn })))
        yield textMessage('交接：布局完成；未解决 GWT 场景 3；下一步修点击。')
        yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
        return
      }
      yield toolUseMessage(`t${index}`, index === 0 ? 'steer_during' : 'echo')
      yield { type: 'result', subtype: 'success', stop_reason: 'tool_use', usage: { input_tokens: 5000, output_tokens: 10 } }
    }
    const events: Array<{ type: AgentEvent['type'] }> = []
    await runAgentLoop(baseInput({
      query,
      tools: [steerTool, tool('echo', () => ({ output: 'ok' }))],
      maxTurns: 8,
      sessionId: 'session-steer-compact',
      publish: (type) => events.push({ type }),
    }))
    expect(events.filter((event) => event.type === 'steer_injected')).toHaveLength(1)
    // 压缩照常发生（封顶 2 次，不受注入影响）
    expect(events.filter((event) => event.type === 'loop_compaction')).toHaveLength(2)
    // 第 1 次压缩的交接调用输入（窗口化 messages）携带注入文本
    expect(handoffInputs.length).toBeGreaterThan(0)
    expect(JSON.stringify(handoffInputs[0])).toContain('压缩前补充的方向')
    expect(pendingSteerCount('session-steer-compact')).toBe(0)
  })
})

describe('I3 转向生效确认链（P7-7）：注入点与账本联动（BLOMA_STEER_CONFIRM）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalConfirm = process.env.BLOMA_STEER_CONFIRM

  /** 注册式工具：execute 时走 registerSteer（与生产 IPC 入口同链：低档直接入队） */
  function registeredSteerTool(text: string, queueId: string): AgentLoopTool {
    return {
      name: 'steer_registered',
      description: '执行时登记一条 steer（I3 链）',
      input_schema: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        registerSteer(ctx.sessionId, { queueMessageId: queueId, content: text, enqueuedAt: Date.now() })
        return { output: 'ok' }
      },
    }
  }

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-i3-'))
    resetSteerQueuesForTests()
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    if (originalConfirm === undefined) delete process.env.BLOMA_STEER_CONFIRM
    else process.env.BLOMA_STEER_CONFIRM = originalConfirm
    resetSteerQueuesForTests()
  })

  it('on：低档 registerSteer → 批间注入 → steer_injected 带 steer_id/status 且账本推进 merged', async () => {
    process.env.BLOMA_STEER_CONFIRM = '1'
    const steerTool = registeredSteerTool('把按钮改成蓝色', 'steer-low-1')
    const { query } = scriptedQuery([
      [toolUseMessage('t1', 'steer_registered')],
      [textMessage('完成')],
    ])
    const events: Array<{ type: AgentEvent['type']; payload: Record<string, unknown> }> = []
    const result = await runAgentLoop(baseInput({
      query,
      tools: [steerTool],
      maxTurns: 2,
      sessionId: 'session-i3-on',
      publish: (type, payload) => events.push({ type, payload }),
    }))
    expect(result.status).toBe('completed')
    const injected = events.filter((event) => event.type === 'steer_injected')
    expect(injected).toHaveLength(1)
    expect(injected[0]!.payload).toMatchObject({
      content: '把按钮改成蓝色',
      steer_id: 'steer-low-1',
      status: 'merged_this_run',
    })
    // 账本同步推进（getSteerStatuses 是「这轮会做吗」权威答案源）
    const statuses = getSteerStatuses('session-i3-on')
    expect(statuses).toHaveLength(1)
    expect(statuses[0]).toMatchObject({ steerId: 'steer-low-1', status: 'merged_this_run', impact: 'low' })
  })

  it('off：enqueueSteer 无 steerId → steer_injected payload 字节级无新键、账本恒空', async () => {
    delete process.env.BLOMA_STEER_CONFIRM
    const steerTool: AgentLoopTool = {
      name: 'steer_during',
      description: '执行时入队一条 steer',
      input_schema: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        enqueueSteer(ctx.sessionId, { queueMessageId: `steer-${Date.now()}`, content: '把按钮改成蓝色', enqueuedAt: Date.now() })
        return { output: 'ok' }
      },
    }
    const { query } = scriptedQuery([
      [toolUseMessage('t1', 'steer_during')],
      [textMessage('完成')],
    ])
    const events: Array<{ type: AgentEvent['type']; payload: Record<string, unknown> }> = []
    await runAgentLoop(baseInput({
      query,
      tools: [steerTool],
      maxTurns: 2,
      sessionId: 'session-i3-off',
      publish: (type, payload) => events.push({ type, payload }),
    }))
    const injected = events.filter((event) => event.type === 'steer_injected')
    expect(injected).toHaveLength(1)
    expect(injected[0]!.payload).not.toHaveProperty('steer_id')
    expect(injected[0]!.payload).not.toHaveProperty('status')
    expect(getSteerStatuses('session-i3-off')).toEqual([])
  })

  it('on：loop 自然收尾时未及注入的残余 → 账本如实转留待下一轮（不取 merged）', async () => {
    process.env.BLOMA_STEER_CONFIRM = '1'
    // 终轮模型调用期间入队（模型正在流式输出时 IPC 到达）：批间注入点已过 → finally 残余路径
    let call = 0
    const combined: SDKQuery = async function* () {
      call += 1
      if (call === 1) {
        yield toolUseMessage('t1', 'echo')
        yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
      } else {
        registerSteer('session-i3-tail', { queueMessageId: 'steer-late-1', content: '收尾前到达的补充', enqueuedAt: Date.now() })
        yield textMessage('做完')
        yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
      }
    }
    await runAgentLoop(baseInput({ query: combined, tools: [tool('echo', () => ({ output: 'ok' }))], maxTurns: 2, sessionId: 'session-i3-tail' }))
    // 残余内容落 JSONL 保真（现状不变）+ 账本状态留待下一轮（非 merged——本轮没做）
    expect(JSON.stringify(readSessionJsonl('session-i3-tail'))).toContain(wrapSteerContent('收尾前到达的补充'))
    expect(getSteerStatuses('session-i3-tail')[0]?.status).toBe('deferred_next_run')
  })
})

describe('W2 E2+F1（咨询 D3/D4）：loop_checkpoint v0', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalCheckpoint = process.env.BLOMA_LOOP_CHECKPOINT
  const originalThreshold = process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS
  const originalKeepRecent = process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS
  const echo = tool('echo', () => ({ output: 'ok' }))

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-ckpt-'))
    process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS = '0'
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    for (const [key, value] of [
      ['BLOMA_LOOP_CHECKPOINT', originalCheckpoint],
      ['BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS', originalThreshold],
      ['BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS', originalKeepRecent],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('renderCheckpointRecoveryHeader：目标/指纹/仍有效转向过滤 superseded/未闭环失败/验证状态', () => {
    const snapshot: LoopCheckpointSnapshot = {
      session_id: 's1',
      at_turn: 9,
      trigger: 'compaction',
      decisions: [
        { id: 'steer-3-1', kind: 'steer', text: '改成月度统计口径', at_turn: 3, superseded_by: 'steer-6-1' },
        { id: 'steer-6-1', kind: 'steer', text: '改回周口径并保留导出', at_turn: 6 },
      ],
      progress_files: { 'src/app.js': 'abc123-120' },
      validation: {
        gwt_runs: 2,
        api_contract_runs: 0,
        last_gwt_failures: ['F-005 搜索过滤'],
        gwt_all_passed: false,
        api_all_passed: true,
        security_all_passed: false,
        file_revisions: { 'src/app.js': 'abc123-120' },
        candidate_fingerprint: 'fp-deadbeef-1',
      },
    }
    const header = renderCheckpointRecoveryHeader('做一个记账工具\n更多细节', snapshot)
    expect(header).toContain('【检查点恢复头')
    expect(header).toContain('做一个记账工具')
    expect(header).toContain('fp-deadbeef-1')
    expect(header).toContain('改回周口径并保留导出')
    expect(header).not.toContain('改成月度统计口径') // superseded 不注入
    expect(header).toContain('F-005 搜索过滤')
    expect(header).toContain('GWT 有失败')
    expect(header).toContain('read_file/grep')
  })

  it('E3：onCheckpoint 终态触发 + result.validation 快照（gwt_runs=0 如实）', async () => {
    const snapshots: LoopCheckpointSnapshot[] = []
    const result = await runAgentLoop(baseInput({
      query: async function* () {
        yield toolUseMessage('t1', 'echo')
        yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
      },
      tools: [echo],
      maxTurns: 1,
      sessionId: 'session-ckpt-final',
      onCheckpoint: (snapshot) => snapshots.push(snapshot),
    }))
    expect(result.status).toBe('turn_limit')
    expect(result.validation).toMatchObject({ gwt_runs: 0, api_contract_runs: 0, last_gwt_failures: [] })
    expect(snapshots.some((s) => s.trigger === 'final')).toBe(true)
  })

  it('压缩后恢复头由 checkpoint 生成（BLOMA_LOOP_CHECKPOINT on；off=零注入字节级现状）', async () => {
    process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = '1000'
    const { query, turnCalls } = compactQuery({ inputTokens: 5000, handoff: 'text' })
    // on：压缩后下一轮模型请求携带恢复头
    process.env.BLOMA_LOOP_CHECKPOINT = '1'
    await runAgentLoop(baseInput({
      query,
      tools: [echo],
      maxTurns: 6,
      sessionId: 'session-ckpt-on',
    }))
    const afterCompaction = JSON.stringify(turnCalls[1])
    expect(afterCompaction).toContain('检查点恢复头')
    expect(afterCompaction).toContain('候选指纹')
    // off：恢复头不出现（字节级现状）
    const { query: query2, turnCalls: turnCalls2 } = compactQuery({ inputTokens: 5000, handoff: 'text' })
    delete process.env.BLOMA_LOOP_CHECKPOINT
    await runAgentLoop(baseInput({
      query: query2,
      tools: [echo],
      maxTurns: 6,
      sessionId: 'session-ckpt-off',
    }))
    expect(JSON.stringify(turnCalls2[1])).not.toContain('检查点恢复头')
  })

  it('E3：压缩事件触发 onCheckpoint(trigger=compaction)，快照含段后验证状态', async () => {
    process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = '1000'
    process.env.BLOMA_LOOP_CHECKPOINT = '1'
    const { query } = compactQuery({ inputTokens: 5000, handoff: 'text' })
    const snapshots: LoopCheckpointSnapshot[] = []
    await runAgentLoop(baseInput({
      query,
      tools: [echo],
      maxTurns: 6,
      sessionId: 'session-ckpt-compaction',
      onCheckpoint: (snapshot) => snapshots.push(snapshot),
    }))
    const compaction = snapshots.find((s) => s.trigger === 'compaction')
    expect(compaction).toBeDefined()
    expect(compaction!.validation.candidate_fingerprint).toMatch(/^fp-[0-9a-f]+-\d+$/)
  })
})

describe('W3-D2：收口条件升级为预检通过（BLOMA_PREFLIGHT）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalPreflight = process.env.BLOMA_PREFLIGHT

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-w3-'))
    delete process.env.BLOMA_PREFLIGHT
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    if (originalPreflight === undefined) delete process.env.BLOMA_PREFLIGHT
    else process.env.BLOMA_PREFLIGHT = originalPreflight
  })

  it('预检开启：全验证面（含 preflight_passed）置位后才收口停工具；预检未过不收口', async () => {
    // finish 工具把 gwt/security 置 true 但不动 preflight —— 预检开关 on 时不得收口
    const finish = (extraPreflight = false): AgentLoopTool => ({
      name: 'finish',
      description: '测试工具 finish',
      input_schema: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        ctx.state.gwt_all_passed = true
        ctx.state.security_all_passed = true
        ctx.state.api_all_passed = true
        if (extraPreflight) ctx.state.preflight_passed = true
        return { output: 'ok' }
      },
    })
    const calls: Array<{ tools: unknown; system: string }> = []
    const query: SDKQuery = async function* (_prompt, queryOptions) {
      calls.push({ tools: queryOptions.tools, system: String((queryOptions.messages ?? [])[0]?.content ?? '') })
      yield toolUseMessage(`t${calls.length}`, 'finish')
      yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
    }
    // on：preflight 未过 → 第二轮仍带工具（不收口）
    process.env.BLOMA_PREFLIGHT = '1'
    await runAgentLoop(baseInput({ query, tools: [finish()], maxTurns: 2, sessionId: 'session-w3-on' }))
    expect(calls[1]!.tools).not.toHaveLength(0)
    // off：gwt+security 过即收口（现状口径）→ 第二轮停用工具 + 收口指令
    delete process.env.BLOMA_PREFLIGHT
    calls.length = 0
    await runAgentLoop(baseInput({ query, tools: [finish()], maxTurns: 2, sessionId: 'session-w3-off' }))
    expect(calls[1]!.tools).toHaveLength(0)
    expect(calls[1]!.system).toContain('【收口】')
    // on 且 preflight_passed 也置位 → 收口（D2 完整链）
    process.env.BLOMA_PREFLIGHT = '1'
    calls.length = 0
    await runAgentLoop(baseInput({ query, tools: [finish(true)], maxTurns: 2, sessionId: 'session-w3-all' }))
    expect(calls[1]!.tools).toHaveLength(0)
    expect(calls[1]!.system).toContain('【收口】')
  })
})

describe('W5-G3：检查点活跃投影每轮注入（BLOMA_LOOP_CHECKPOINT 复用）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalCheckpoint = process.env.BLOMA_LOOP_CHECKPOINT
  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-g3-'))
    delete process.env.BLOMA_LOOP_CHECKPOINT
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    if (originalCheckpoint === undefined) delete process.env.BLOMA_LOOP_CHECKPOINT
    else process.env.BLOMA_LOOP_CHECKPOINT = originalCheckpoint
  })
  it('on：每轮 system 尾部带【检查点投影】；off：system 原样字节不变', async () => {
    const echo = tool('echo', () => ({ output: 'ok' }))
    const systems: string[] = []
    const query: SDKQuery = async function* (_prompt, queryOptions) {
      systems.push(String((queryOptions.messages ?? [])[0]?.content ?? ''))
      yield toolUseMessage(`t${systems.length}`, 'echo')
      yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
    }
    process.env.BLOMA_LOOP_CHECKPOINT = '1'
    await runAgentLoop(baseInput({ query, tools: [echo], maxTurns: 2, sessionId: 'session-g3-on' }))
    expect(systems[0]).toContain('检查点投影')
    expect(systems[0]).toContain('候选指纹')
    expect(systems[0]).toContain('未闭环失败：无')
    // off：不注入（system === 原文）
    delete process.env.BLOMA_LOOP_CHECKPOINT
    systems.length = 0
    await runAgentLoop(baseInput({ query, tools: [echo], maxTurns: 2, sessionId: 'session-g3-off' }))
    expect(systems[0]).toBe('测试系统提示')
  })
})

describe('W6（咨询 D3/D4）：预算层四件', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalCheckpoint = process.env.BLOMA_LOOP_CHECKPOINT
  const originalThreshold = process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS
  const originalEstFallback = process.env.BLOMA_COMPACT_EST_FALLBACK
  const originalKeepRecent = process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS
  const echo = tool('echo', () => ({ output: 'ok' }))

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-w6-'))
    delete process.env.BLOMA_LOOP_CHECKPOINT
    delete process.env.BLOMA_COMPACT_EST_FALLBACK
    process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS = '0'
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    for (const [key, value] of [
      ['BLOMA_LOOP_CHECKPOINT', originalCheckpoint],
      ['BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS', originalThreshold],
      ['BLOMA_COMPACT_EST_FALLBACK', originalEstFallback],
      ['BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS', originalKeepRecent],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('F6：预算耗尽产出结构化受阻报告（检查点开着；含未闭环失败/验证面/建议下一步+JSONL 审计行）', async () => {
    process.env.BLOMA_LOOP_CHECKPOINT = '1'
    const query: SDKQuery = async function* () {
      yield toolUseMessage('t1', 'echo')
      yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' } // 无 usage 也可
    }
    const result = await runAgentLoop(baseInput({ query, tools: [echo], maxTurns: 1, sessionId: 'session-w6-blocked' }))
    expect(result.status).toBe('turn_limit')
    expect(result.blocked_report).toBeDefined()
    expect(result.blocked_report!.reason).toBe('turn_limit')
    expect(result.blocked_report!.candidate_fingerprint).toMatch(/^fp-/)
    expect(result.blocked_report!.unresolved_failures).toEqual([])
    expect(result.blocked_report!.verification).toMatchObject({ gwt: '未测', api: '过/豁免', security: '未测' })
    expect(result.blocked_report!.suggested_next).toBeTruthy()
    const jsonl = readSessionJsonl('session-w6-blocked') as Array<{ role: string; content: Array<{ type: string; text?: string }> }>
    const reportLine = jsonl.find((m) => m.role === 'system' && m.content.some((b) => b.text?.includes('[loop-blocked-report]')))
    expect(reportLine).toBeDefined()
    // 开关 off：无受阻报告（字节级现状）
    delete process.env.BLOMA_LOOP_CHECKPOINT
    const plain = await runAgentLoop(baseInput({ query, tools: [echo], maxTurns: 1, sessionId: 'session-w6-plain' }))
    expect(plain.blocked_report).toBeUndefined()
  })

  it('E4：渠道 usage 盲时 est 兜底触发压缩（以撒案根治位；2026-09-16 缺省翻转 on，=0 为逃生口）', async () => {
    // 渠道不回 usage 的查询：缺省（on）按 est 触发；显式 =0 回触发器失明现状（逃生口）
    const queryFactory = () => {
      const turnCalls: ConversationTurn[][] = []
      const events: Array<{ type: AgentEvent['type'] }> = []
      const query: SDKQuery = async function* (_prompt, queryOptions) {
        if (queryOptions.tools === undefined) {
          yield textMessage('交接：完成一半，场景 3 未过。')
          yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
          return
        }
        turnCalls.push((queryOptions.messages ?? []).map((turn) => ({ ...turn })))
        yield toolUseMessage(`t${turnCalls.length}`, 'echo')
        yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' } // 无 usage 字段
      }
      return { query, turnCalls }
    }
    process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = '1'
    // 缺省 on（2026-09-16 起缺省，上下文同步 Proma 批）：est 兜底触发
    const onByDefault = queryFactory()
    await runAgentLoop(baseInput({ query: onByDefault.query, tools: [echo], maxTurns: 6, sessionId: 'session-w6-on-default' }))
    expect(JSON.stringify(onByDefault.turnCalls[1])).toContain('此前进度交接')
    // 显式 off（逃生口，=旧现状）：永不压缩
    process.env.BLOMA_COMPACT_EST_FALLBACK = '0'
    const off = queryFactory()
    await runAgentLoop(baseInput({ query: off.query, tools: [echo], maxTurns: 6, sessionId: 'session-w6-off' }))
    expect(off.turnCalls[1]).toHaveLength(1 + 1 + 2) // system+task+首轮对（无重置全量累积）
  })

  it('E4：确定性交接兑底附带检查点段（硬阈值兜底从检查点拼装）', async () => {
    process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = '1000'
    process.env.BLOMA_LOOP_CHECKPOINT = '1'
    const { query, handoffCalls } = (() => {
      const handoffCalls: ConversationTurn[][] = []
      const query: SDKQuery = async function* (_prompt, queryOptions) {
        if (queryOptions.tools === undefined) {
          handoffCalls.push((queryOptions.messages ?? []).map((turn) => ({ ...turn })))
          throw new Error('渠道 429')
        }
        yield toolUseMessage('t0', 'echo')
        yield { type: 'result', subtype: 'success', stop_reason: 'tool_use', usage: { input_tokens: 5000, output_tokens: 10 } }
      }
      return { query, handoffCalls }
    })()
    await runAgentLoop(baseInput({ query, tools: [echo], maxTurns: 6, sessionId: 'session-w6-handoff' }))
    const compactSystemLine = readSessionJsonl('session-w6-handoff') as Array<{ role: string; content: Array<{ type: string; text?: string }> }>
    const line = compactSystemLine.find((m) => m.role === 'system' && m.content.some((b) => b.text?.includes('[loop-compaction]')))
    expect(line).toBeDefined()
    const text = line!.content.map((b) => b.text ?? '').join('')
    expect(text).toContain('检查点状态')
    expect(text).toContain('候选指纹')
  })
})

// ==== B3（P0-B，2026-09-11 审计案 35c1a633）：loop 进度对账三守卫 ====

describe('B3 loop 进度对账三守卫（BLOMA_LOOP_PROGRESS_NUDGE）', () => {
  const previousEnv = process.env.BLOMA_LOOP_PROGRESS_NUDGE

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.BLOMA_LOOP_PROGRESS_NUDGE
    else process.env.BLOMA_LOOP_PROGRESS_NUDGE = previousEnv
  })

  const readFile = tool('read_file', () => ({ output: '内容' }))
  const writeFile = tool('write_file', () => ({ output: '已写' }))
  const gwt = tool('run_gwt_tests', () => ({ output: '2 过 1 败' }))

  /** N 轮只读脚本 + 末轮交卷（脚本末项重复兜底，N+1 次调用内必到交卷或 turn_limit） */
  function readOnlyScript(turns: number): SDKMessage[][] {
    return Array.from({ length: turns }, (_, i) => [toolUseMessage(`r${i}`, 'read_file', { path: `src/mod${i}.js` })])
  }

  function userTextsOf(messages: ConversationTurn[]): string {
    return messages
      .filter((turn) => turn.role === 'user')
      .map((turn) => (typeof turn.content === 'string' ? turn.content : JSON.stringify(turn.content)))
      .join('\n')
  }

  it('守卫1：连续 6 轮只读 → 第 7 次模型调用前注入【进度对账】提醒落盘；有写入则不注入', async () => {
    process.env.BLOMA_LOOP_PROGRESS_NUDGE = '1'
    // 全只读 8 轮：第 6 轮批间 streak=6 触发注入
    const stalled = scriptedQuery([...readOnlyScript(8), [textMessage('完成')]])
    await runAgentLoop(baseInput({ query: stalled.query, tools: [readFile], maxTurns: 12, sessionId: 'session-b3-stall' }))
    expect(userTextsOf(stalled.receivedMessages[6])).toContain('【进度对账（宿主注入）】')
    expect(userTextsOf(stalled.receivedMessages[6])).toContain('已连续 6 轮只读')
    // 注入后重置：第 7 轮批间 streak=1，不重复注入
    expect(userTextsOf(stalled.receivedMessages[7])).not.toContain('已连续 1 轮只读')

    // 第 3 轮有写入 → 失速清零，后续 4 轮只读（streak 4<6）全程零注入
    const mixed = scriptedQuery([
      [toolUseMessage('m1', 'read_file', { path: 'src/a.js' })],
      [toolUseMessage('m2', 'run_gwt_tests', {})],
      [toolUseMessage('m3', 'write_file', { path: 'src/app.js' })],
      ...readOnlyScript(4).map((turn, i) => turn.map((m) => m)),
      [textMessage('完成')],
    ])
    await runAgentLoop(baseInput({ query: mixed.query, tools: [readFile, writeFile, gwt], maxTurns: 12, sessionId: 'session-b3-write' }))
    for (const messages of mixed.receivedMessages) {
      expect(userTextsOf(messages)).not.toContain('进度对账')
    }
  })

  it('守卫2：轮次 ≥75% 且 plan 清单未触达 → 列名注入；全部触达不注入', async () => {
    process.env.BLOMA_LOOP_PROGRESS_NUDGE = '1'
    const planFiles = ['index.html', 'src/app.js', 'server/routes/records.js']
    // maxTurns=8，75%=第 6 轮批间触发（此时零写入，清单全部未触达）
    const untouched = scriptedQuery([...readOnlyScript(6), [textMessage('完成')]])
    await runAgentLoop(baseInput({ query: untouched.query, tools: [readFile], maxTurns: 8, sessionId: 'session-b3-plan', planFiles }))
    const text = userTextsOf(untouched.receivedMessages[6])
    expect(text).toContain('尚未写入')
    expect(text).toContain('index.html')
    expect(text).toContain('server/routes/records.js')
    expect(text).toContain('dist/app.js')

    // 前 3 轮把清单全部写完 → 守卫2 不注入（守卫1 也因每轮有写入不触发）
    const covered = scriptedQuery([
      [toolUseMessage('w1', 'write_file', { path: './index.html' })],
      [toolUseMessage('w2', 'write_file', { path: 'src/app.js' })],
      [toolUseMessage('w3', 'write_file', { path: 'server/routes/records.js' })],
      ...readOnlyScript(4),
      [textMessage('完成')],
    ])
    await runAgentLoop(baseInput({ query: covered.query, tools: [readFile, writeFile], maxTurns: 8, sessionId: 'session-b3-covered', planFiles }))
    for (const messages of covered.receivedMessages) {
      expect(userTextsOf(messages)).not.toContain('尚未写入')
    }
  })

  it('守卫3：进入后 1/3 轮次仍零验证调用 → 自测提醒；有 run_gwt_tests 则不注入', async () => {
    process.env.BLOMA_LOOP_PROGRESS_NUDGE = '1'
    // maxTurns=9，后 1/3=第 6 轮起；前 5 轮只读（streak 5<6 不触发守卫1，无 planFiles 不触发守卫2）
    const unverified = scriptedQuery([...readOnlyScript(6), [textMessage('完成')]])
    await runAgentLoop(baseInput({ query: unverified.query, tools: [readFile], maxTurns: 9, sessionId: 'session-b3-verify' }))
    expect(userTextsOf(unverified.receivedMessages[6])).toContain('尚未运行过任何自测工具')

    // 第 1 轮跑过 run_gwt_tests → verificationSeen，守卫3 全程不注入
    const verified = scriptedQuery([
      [toolUseMessage('v1', 'run_gwt_tests', {})],
      ...readOnlyScript(6),
      [textMessage('完成')],
    ])
    await runAgentLoop(baseInput({ query: verified.query, tools: [readFile, gwt], maxTurns: 9, sessionId: 'session-b3-gwt' }))
    for (const messages of verified.receivedMessages) {
      expect(userTextsOf(messages)).not.toContain('自测工具')
    }
  })

  it('off 字节锁：开关未设零注入（messages 与 JSONL 无【进度对账】）', async () => {
    delete process.env.BLOMA_LOOP_PROGRESS_NUDGE
    const { query, receivedMessages } = scriptedQuery([...readOnlyScript(7), [textMessage('完成')]])
    await runAgentLoop(baseInput({ query, tools: [readFile], maxTurns: 12, sessionId: 'session-b3-off', planFiles: ['index.html'] }))
    for (const messages of receivedMessages) {
      expect(userTextsOf(messages)).not.toContain('进度对账')
    }
    expect(readSessionJsonl('session-b3-off').some((line) => JSON.stringify(line).includes('进度对账'))).toBe(false)
  })
})
