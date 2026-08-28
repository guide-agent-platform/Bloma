import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtempSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAgentLoop, TOOL_WINDOW_ROUNDS, type AgentLoopInput, type AgentLoopTool, type ToolOutcome } from '../../main/agent-loop'
import type { MessageContentBlock, SDKMessage } from '../../shared/types'
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
    restorePromaHome(originalPromaHome)
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
    // compacting-window（2026-08-28）：本场景全为 'ok' 无标记句 → 纯噪音零浪费，head 无 digest——
    // 长度 = system + task + 最近 8 轮 tool 对（有标记句的 digest 场景见下个用例）
    expect(lastCall.length).toBe(2 + TOOL_WINDOW_ROUNDS * 2)
    // 窗口内容断言：保留最近 8 轮（第 5~12 轮，id t3..t10），早期轮（t0..t2）被剪掉
    const toolUseIds = lastCall
      .filter((turn) => turn.role === 'assistant')
      .map((turn) => (turn.content as Array<{ type?: string; id?: string }>).find((block) => block.type === 'tool_use')?.id)
      .filter(Boolean)
    expect(toolUseIds).toEqual(['t3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'])
    const jsonl = readSessionJsonl('session-window')
    expect(jsonl.filter((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use'))).toHaveLength(12)
  })

  it('historyTurns：重放历史进模型上下文且不重复写 JSONL（delegation continue 阶段 3）', async () => {
    const echo = tool('echo', () => ({ output: 'ok' }))
    const { query, receivedMessages } = scriptedQuery([[textMessage('已读取历史，继续')]])
    const historyTurns: ConversationTurn[] = [
      { role: 'user', content: '目标: 修复登录超时' },
      { role: 'assistant', content: [{ type: 'text', text: '根因是 dns 阻塞' }] },
    ]
    const result = await runAgentLoop(baseInput({
      query,
      tools: [echo],
      task: '把 dns 预热同样加到注册页',
      historyTurns,
      sessionId: 'session-replay',
    }))
    expect(result.status).toBe('completed')
    const firstCall = receivedMessages[0]!
    // system + 重放历史 2 轮 + task（最新 user 轮）
    expect(firstCall.length).toBe(1 + 2 + 1)
    expect(firstCall[1]!.content).toBe('目标: 修复登录超时')
    expect(firstCall[3]!.content).toBe('把 dns 预热同样加到注册页')
    // JSONL 审计只记新轮次，重放历史不重复落盘
    const jsonl = readSessionJsonl('session-replay')
    const replayedInJsonl = jsonl.filter(
      (m) => Array.isArray(m.content) && (m.content as Array<{ text?: string }>).some((b) => b.text === '目标: 修复登录超时'),
    )
    expect(replayedInJsonl).toHaveLength(0)
  })

  it('compacting-window：早期轮关键标记句滑出后以 digest 消息保留在窗口头（长循环不失忆）', async () => {
    // echo 工具返回 seq 文本作为 tool_result 内容——第 1 轮 result 含失败标记句
    const seqEcho = tool('echo', (input) => ({ output: String(input['seq'] ?? '') }))
    const script: SDKMessage[][] = []
    // 12 轮：第 1 轮 result 含失败标记句（会被清出窗口），后续轮无标记
    for (let i = 0; i < 12; i += 1) {
      script.push([toolUseMessage(`c${i}`, 'echo', { seq: i === 0 ? '失败: 首轮探测超时，方案 A 已排除' : `过程轮次 ${i}` })])
    }
    script.push([textMessage('完成')])
    const { query, receivedMessages } = scriptedQuery(script)
    const result = await runAgentLoop(baseInput({ query, tools: [seqEcho], maxTurns: 13, sessionId: 'session-digest' }))
    expect(result.status).toBe('completed')
    const lastCall = receivedMessages.at(-1)!
    // digest 并入 head content（审查 fail 点修复：不新增独立消息，避免连续 user）——
    // 长度仍 = system + task + 最近 8 轮 tool 对
    expect(lastCall.length).toBe(2 + TOOL_WINDOW_ROUNDS * 2)
    const headContent = lastCall[1].content
    expect(typeof headContent).toBe('string')
    expect(headContent as string).toContain('[早期轮次简报')
    expect(headContent as string).toContain('失败: 首轮探测超时，方案 A 已排除')
    // JSONL 全量审计不受窗口/digest 影响
    const jsonl = readSessionJsonl('session-digest')
    expect(jsonl.filter((m) => m.role === 'assistant')).toHaveLength(13)
  })
})

describe('M4-C tool_call_completed detail 白名单透传', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-detail-'))
  })
  afterEach(() => {
    restorePromaHome(originalPromaHome)
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

describe('AgentLoop providerType 透传（omit 推广 2026-08-27）', () => {
  it('[S4-REASON-023] runAgentLoop 将 providerType 透传到 query options', async () => {
    let receivedProviderType: string | undefined
    const query: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
      receivedProviderType = options.providerType
      yield { type: 'result', subtype: 'success' }
    }
    await runAgentLoop(baseInput({ query, providerType: 'deepseek' }))
    expect(receivedProviderType).toBe('deepseek')
  })

  it('[S4-REASON-024] 缺省不传 providerType → options 字段缺失（零回归：omit 不触发、走 thinking:disabled 现状）', async () => {
    let hasProviderType = true
    const query: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
      hasProviderType = 'providerType' in options
      yield { type: 'result', subtype: 'success' }
    }
    await runAgentLoop(baseInput({ query }))
    expect(hasProviderType).toBe(false)
  })
})

describe('AgentLoop 会话级 usage 聚合（2026-08-28，费用守卫 Hook 1）', () => {
  const savedHome3 = process.env.PROMA_HOME
  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-usage-'))
  })
  afterEach(() => {
    if (savedHome3 === undefined) delete process.env.PROMA_HOME
    else process.env.PROMA_HOME = savedHome3
  })

  it('[S4-AGENT-050] 两轮 usage 累计 input/output + turnsWithUsage；estContextTokens 为正（渠道全盲时唯一占用信号）', async () => {
    const echo: AgentLoopTool = {
      name: 'echo',
      description: 'echo',
      input_schema: { type: 'object', properties: {} },
      execute: async () => ({ output: 'ok' }),
    }
    let turn = 0
    const query: SDKQuery = async function* () {
      turn += 1
      if (turn === 1) {
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'echo', input: {} }] } }
        yield { type: 'result', subtype: 'success', stop_reason: 'tool_use', usage: { input_tokens: 1200, output_tokens: 60 } }
        return
      }
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '完成' }] } }
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: { input_tokens: 800, output_tokens: 40 } }
    }
    const result = await runAgentLoop(baseInput({ query, task: '测试用量聚合', tools: [echo] }))
    expect(result.status).toBe('completed')
    expect(result.usage?.inputTokens).toBe(2000)
    expect(result.usage?.outputTokens).toBe(100)
    expect(result.usage?.turnsWithUsage).toBe(2)
    expect(result.usage?.estContextTokens).toBeGreaterThan(0)
  })
})

describe('AgentLoop 占用估算准确性（2026-08-28，r55 审查 low 池采纳）', () => {
  const savedHome4 = process.env.PROMA_HOME
  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-est-'))
  })
  afterEach(() => {
    if (savedHome4 === undefined) delete process.env.PROMA_HOME
    else process.env.PROMA_HOME = savedHome4
  })

  it('[S4-AGENT-056] estContextTokens 计入 tool_result 内容成本（tool_result 4000 ASCII = 1000 tokens 下限）', async () => {
    const echo: AgentLoopTool = {
      name: 'echo',
      description: 'echo',
      input_schema: { type: 'object', properties: {} },
      execute: async () => ({ output: 'B'.repeat(4000) }),
    }
    let turn = 0
    const query: SDKQuery = async function* () {
      turn += 1
      if (turn === 1) {
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'echo', input: {} }] } }
        yield { type: 'result', subtype: 'success', stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 10 } }
        return
      }
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10 } }
    }
    const result = await runAgentLoop(baseInput({ query, task: 'run echo', tools: [echo] }))
    // tool_result 4000 ASCII 字符 ≈ 1000 tokens 必须计入（text-only 口径会漏掉）
    expect(result.usage?.estContextTokens ?? 0).toBeGreaterThanOrEqual(1000)
  })
})

describe('AgentLoop session-recall 注入 hook（2026-08-28，guidance v5 ②）', () => {
  const savedHome2 = process.env.PROMA_HOME
  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-recall-'))
  })
  afterEach(() => {
    if (savedHome2 === undefined) delete process.env.PROMA_HOME
    else process.env.PROMA_HOME = savedHome2
  })

  it('[S4-RECALL-010] 指代词任务 → 首条 user 消息前置 <session-recall> 块，任务原文在最后', async () => {
    const sessDir = join(process.env.PROMA_HOME ?? '', 'agent-sessions')
    await mkdir(sessDir, { recursive: true })
    await writeFile(
      join(sessDir, 'hist.jsonl'),
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: '渠道配置页面用 tab 布局' }], timestamp: Date.now() }) + '\n',
      'utf8',
    )
    let receivedTask = ''
    const query: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
      receivedTask = String((options.messages ?? []).find((t) => t.role === 'user')?.content ?? '')
      yield { type: 'result', subtype: 'success' }
    }
    await runAgentLoop(baseInput({ query, task: '继续上次的渠道配置' }))
    expect(receivedTask.startsWith('<session-recall>')).toBe(true)
    expect(receivedTask).toContain('渠道配置页面')
    expect(receivedTask.endsWith('继续上次的渠道配置')).toBe(true)
  })
})

describe('AgentLoop skill 注入 hook（2026-08-28，skill 机制转正）', () => {
  // 独立于上方 describe 的 PROMA_HOME 隔离（vitest beforeEach 仅作用于自身 describe 作用域）
  const savedHome = process.env.PROMA_HOME
  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-skill-'))
  })
  afterEach(() => {
    if (savedHome === undefined) delete process.env.PROMA_HOME
    else process.env.PROMA_HOME = savedHome
  })

  it('[S4-AGENT-033] 任务含 /skill: 命令 → 首条 user 消息前置 skill block；JSONL 审计同文', async () => {
    const globalRoot = join(process.env.PROMA_HOME ?? '', 'skills')
    await mkdir(join(globalRoot, 'sop'), { recursive: true })
    await writeFile(join(globalRoot, 'sop', 'SKILL.md'), '---\nname: dev-sop\ndescription: 开发 SOP\n---\n\n步骤一：取号', 'utf8')
    let receivedUserTurns: Array<string | MessageContentBlock[]> = []
    const query: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
      receivedUserTurns = (options.messages ?? []).filter((t) => t.role === 'user').map((t) => t.content)
      yield { type: 'result', subtype: 'success' }
    }
    await runAgentLoop(baseInput({ query, task: '执行 /skill:dev-sop' }))
    const firstUserTurn = String(receivedUserTurns[0] ?? '')
    expect(firstUserTurn.startsWith('<skill name="dev-sop"')).toBe(true)
    expect(firstUserTurn.endsWith('执行 /skill:dev-sop')).toBe(true)
    // JSONL 审计 = 模型实际所见（continue 重放一致）
    const firstLine = readSessionJsonl('session-loop')[0]
    expect(firstLine?.role).toBe('user')
    expect((firstLine?.content[0] as { text?: string })?.text).toContain('步骤一：取号')
  })

  it('[S4-AGENT-038] JSONL 后续行不含注入块（deepseek high：skill 只随当条消息，不污染后续轮次）', async () => {
    const globalRoot = join(process.env.PROMA_HOME ?? '', 'skills')
    await mkdir(join(globalRoot, 'sop2'), { recursive: true })
    await writeFile(join(globalRoot, 'sop2', 'SKILL.md'), '---\nname: dev-sop2\n---\n\n正文', 'utf8')
    let turnCount = 0
    const echo: AgentLoopTool = {
      name: 'echo',
      description: 'echo',
      input_schema: { type: 'object', properties: {} },
      execute: async () => ({ output: 'ok' }),
    }
    const query: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
      turnCount += 1
      if (turnCount === 1) {
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'echo', input: {} }] } }
        yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
        return
      }
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
    await runAgentLoop(baseInput({ query, task: '执行 /skill:dev-sop2', tools: [echo] }))
    const lines = readSessionJsonl('session-loop')
    expect(lines.length).toBeGreaterThanOrEqual(3) // user(注入) + assistant(tool_use) + user(tool_result)
    for (const [index, line] of lines.entries()) {
      const text = JSON.stringify(line)
      if (index === 0) expect(text).toContain('<skill name=')
      else expect(text).not.toContain('<skill name=')
    }
  })

  it('[S4-AGENT-034] 无 /skill: 命令 → task 原样（零注入零回归）', async () => {
    let receivedFirst: string | MessageContentBlock[] = ''
    const query: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
      receivedFirst = (options.messages ?? []).find((t) => t.role === 'user')?.content ?? ''
      yield { type: 'result', subtype: 'success' }
    }
    await runAgentLoop(baseInput({ query, task: '普通任务' }))
    expect(receivedFirst).toBe('普通任务')
  })
})
