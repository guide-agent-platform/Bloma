import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgentLoop, withAbort, type AgentLoopInput, type AgentLoopTool, type ToolOutcome } from '../../main/agent-loop'
import { canUseTool } from '../../main/permission-service'
import type { SDKMessage } from '../../shared/types'
import type { ConversationTurn, SDKQuery, SDKQueryOptions } from '../../main/orchestrator'

/**
 * F3 权限防御单测：Agent Loop 的 executeToolCall 在非 allow-all 下不得落 pending 挂起。
 *
 * 与 agent-loop.test.ts 隔离：该文件测真实 canUseTool 的 safe 拒绝链路，这里 vi.mock
 * 整个 permission-service，只验证 loop 侧的两个守卫：
 * - 方案 B：非 allow-all（ask）直接拒绝 is_error，不进入 canUseTool（不产生 pending）
 * - 方案 D：withAbort 把 canUseTool 等待纳入 AbortSignal 竞速，取消可中断
 */

vi.mock('../../main/permission-service', () => ({ canUseTool: vi.fn() }))

const mockCanUseTool = vi.mocked(canUseTool)

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
  receivedMessages: ConversationTurn[][]
}

function scriptedQuery(responses: SDKMessage[][]): ScriptedQuery {
  let call = 0
  const receivedMessages: ConversationTurn[][] = []
  const query: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
    const callIndex = call
    call += 1
    receivedMessages.push((options.messages ?? []).map((turn) => ({ ...turn })))
    const script = responses[Math.min(callIndex, responses.length - 1)] ?? []
    for (const message of script) yield message
    yield { type: 'result', subtype: 'success', stop_reason: script.some((m) => m.message?.content.some((b) => b.type === 'tool_use')) ? 'tool_use' : 'end_turn' }
  }
  return { query, receivedMessages }
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
    sessionId: 'session-loop-perm',
    projectId: 'project-loop-perm',
    requestId: 'req-loop-perm',
    maxTokens: 256,
    maxTurns: 6,
    permissionMode: 'allow-all',
    signal: new AbortController().signal,
    publish: () => undefined,
    ...overrides,
  }
}

describe('runAgentLoop 权限防御（F3）', () => {
  beforeEach(() => {
    mockCanUseTool.mockReset()
  })
  afterEach(() => {
    mockCanUseTool.mockReset()
  })

  it('B：非 allow-all（ask）模式 warning 工具直接拒绝 is_error，不进入 canUseTool、不挂起', async () => {
    const writer = tool('write_file', () => ({ output: 'ok' }))
    const { query, receivedMessages } = scriptedQuery([[toolUseMessage('t1', 'write_file')], [textMessage('收尾')]])
    const result = await Promise.race([
      runAgentLoop(baseInput({ query, tools: [writer], permissionMode: 'ask' })),
      new Promise((_, rej) => setTimeout(() => rej(new Error('AGENT_LOOP_HUNG')), 2000)),
    ])
    expect((result as { status: string }).status).toBe('completed')
    expect(mockCanUseTool).not.toHaveBeenCalled() // 红：当前会调用（且 ask 下挂起）
    const userBlock = (receivedMessages[1].filter((turn) => turn.role === 'user').at(-1)!.content as Array<{ type: string; is_error?: boolean; content?: string }>)[0]
    expect(userBlock.is_error).toBe(true)
    expect(userBlock.content).toContain('权限拒绝')
  })

  it('B：非 allow-all 下 safe 工具（read_file）也被连带拒绝（锁定行为，防止未来无意放宽）', async () => {
    const reader = tool('read_file', () => ({ output: '内容' }))
    const { query } = scriptedQuery([[toolUseMessage('t1', 'read_file')], [textMessage('收尾')]])
    const result = await Promise.race([
      runAgentLoop(baseInput({ query, tools: [reader], permissionMode: 'safe' })),
      new Promise((_, rej) => setTimeout(() => rej(new Error('AGENT_LOOP_HUNG')), 2000)),
    ])
    expect((result as { status: string }).status).toBe('completed')
    expect(mockCanUseTool).not.toHaveBeenCalled()
  })

  it('D：canUseTool 挂起（pending）时取消可中断，收尾 cancelled', async () => {
    mockCanUseTool.mockReturnValue(new Promise(() => {}))
    const controller = new AbortController()
    const { query } = scriptedQuery([[toolUseMessage('t1', 'write_file')], [textMessage('收尾')]])
    const promise = runAgentLoop(
      baseInput({ query, tools: [tool('write_file', () => ({ output: 'ok' }))], permissionMode: 'allow-all', signal: controller.signal }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    const result = await Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('AGENT_LOOP_HUNG')), 2000))])
    expect((result as { status: string }).status).toBe('cancelled')
  })

  it('withAbort：signal 已 abort 立即 reject AGENT_CANCELLED', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(withAbort(Promise.resolve('x'), controller.signal)).rejects.toThrow('AGENT_CANCELLED')
  })

  it('withAbort：正常 resolve / reject 透传', async () => {
    const controller = new AbortController()
    await expect(withAbort(Promise.resolve('ok'), controller.signal)).resolves.toBe('ok')
    await expect(withAbort(Promise.reject(new Error('boom')), controller.signal)).rejects.toThrow('boom')
  })
})
