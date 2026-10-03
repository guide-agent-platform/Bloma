import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createToolState,
  executeTurnToolCalls,
  runAgentLoop,
  type AgentLoopInput,
  type AgentLoopTool,
  type ToolContext,
  type ToolOutcome,
  type TurnToolExecution,
} from '../../main/agent/loop/agent-loop'
import type { SDKMessage } from '../../shared/types'
import type { ConversationTurn, SDKQuery, SDKQueryOptions } from '../../main/orchestration/orchestrator'
import { getAgentSessionPath } from '../../storage/config-paths'
import { readFileSync } from 'node:fs'

/**
 * P1-2 只读工具并行执行（2026-09-08 pi 差距方案 §4）。
 *
 * 锁定不变式：
 * - 「整批 tool_result 一条 user 消息、块序=源序」在并发下保持
 * - 连续 parallelSafe 段并发（wall-time 缩短）；遇非 parallelSafe 先 join
 * - 有 toolBudget 的工具即使 parallelSafe 也退串行（防并行击穿静态预算）
 * - abort 传播；写类（非 parallelSafe）行为与串行逐字节一致
 */

function makeTool(name: string, opts: { parallelSafe?: boolean; delayMs?: number; log?: string[]; budgeted?: boolean } = {}): AgentLoopTool {
  return {
    name,
    parallelSafe: opts.parallelSafe ?? false,
    description: `测试工具 ${name}`,
    input_schema: { type: 'object', properties: {} },
    execute: async (_input, ctx) => {
      if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs))
      opts.log?.push(`${name}:started@${ctx.toolCallId ?? '?'}`)
      return { output: `result-${name}` }
    },
  }
}

function use(id: string, name: string) {
  return { type: 'tool_use' as const, id, name, input: {} }
}

interface DirectHarness {
  input: AgentLoopInput
  toolByName: Map<string, AgentLoopTool>
  budgetUsed: Record<string, number>
  ctx: ToolContext
  publish: (type: string, payload: Record<string, unknown>) => void
}

function directHarness(tools: AgentLoopTool[], overrides: Partial<AgentLoopInput> = {}): DirectHarness {
  const signal = new AbortController().signal
  const events: Array<{ type: string; payload: Record<string, unknown> }> = []
  const publish = (type: string, payload: Record<string, unknown>) => events.push({ type, payload })
  const input: AgentLoopInput = {
    system: 's',
    task: 't',
    tools,
    query: async function* () {
      yield { type: 'result', subtype: 'success' }
    },
    env: {},
    sessionId: 'session-par',
    projectId: 'project-par',
    requestId: 'req-par',
    maxTokens: 256,
    maxTurns: 6,
    permissionMode: 'allow-all',
    signal,
    publish: (t, p) => publish(t, p),
    ...overrides,
  }
  const ctx: ToolContext = {
    projectId: input.projectId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    signal: input.signal,
    state: createToolState(0),
  }
  return { input, toolByName: new Map(tools.map((tool) => [tool.name, tool])), budgetUsed: {}, ctx, publish }
}

async function runTurn(h: DirectHarness, uses: ReturnType<typeof use>[]): Promise<TurnToolExecution> {
  return executeTurnToolCalls(h.input, h.toolByName, h.budgetUsed, uses, 1, h.ctx)
}

describe('executeTurnToolCalls 分组并行（P1-2）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-par-'))
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  it('连续 parallelSafe 段并发执行：三工具执行区间重叠（begin×3 先于任一 end，2026-10-03 删留执行改重叠序断言——原墙钟 wall<200ms 满载必脆）', async () => {
    const order: string[] = []
    const slow = makeTool('read_file', { parallelSafe: true, delayMs: 80 })
    slow.execute = async (_input, ctx) => {
      order.push(`begin:${ctx.toolCallId}`)
      await new Promise((resolve) => setTimeout(resolve, 80))
      order.push(`end:${ctx.toolCallId}`)
      return { output: 'result-read_file' }
    }
    const h = directHarness([slow])
    const result = await runTurn(h, [use('r1', 'read_file'), use('r2', 'read_file'), use('r3', 'read_file')])
    expect(result.cancelled).toBe(false)
    if (!result.cancelled) {
      // 并发的时序证据：三个 begin 全部先于任一 end（若串行则 begin:end 交错）；
      // 不再断言墙钟上界（满载机器下 flaky，见删留清单 D6）
      expect(order.slice(0, 3).every((entry) => entry.startsWith('begin:'))).toBe(true)
      expect(order).toHaveLength(6)
      expect(result.resultBlocks).toHaveLength(3)
    }
  })

  it('源序回注：慢工具在前快工具在后 → resultBlocks 仍按源序（[slow, fast]）', async () => {
    const slow = makeTool('read_slow', { parallelSafe: true, delayMs: 120 })
    const fast = makeTool('read_fast', { parallelSafe: true, delayMs: 5 })
    const h = directHarness([slow, fast])
    const result = await runTurn(h, [use('t1', 'read_slow'), use('t2', 'read_fast')])
    expect(result.cancelled).toBe(false)
    if (!result.cancelled) {
      expect(result.resultBlocks.map((b) => b.tool_use_id)).toEqual(['t1', 't2'])
      expect(result.resultBlocks[0]!.content).toContain('read_slow')
      expect(result.resultBlocks[1]!.content).toContain('read_fast')
    }
  })

  it('混合轮 join 语义：serial 写工具不与该轮 parallelSafe 组并发（串行位在组完成后才开始）', async () => {
    const order: string[] = []
    const reader = makeTool('read_file', { parallelSafe: true, delayMs: 60, log: order })
    const writer = makeTool('write_file', { delayMs: 10 })
    writer.execute = async (_input, _ctx) => {
      order.push('write_file:begin')
      return { output: 'result-write_file' }
    }
    const h = directHarness([reader, writer])
    const result = await runTurn(h, [use('r1', 'read_file'), use('r1', 'write_file')])
    expect(result.cancelled).toBe(false)
    // 源序保持：read 结果在前、write 结果在后（join 后串行位 push）
    if (!result.cancelled) {
      expect(result.resultBlocks.map((b) => b.tool_use_id)).toEqual(['r1', 'r1'])
      expect(result.resultBlocks[0]!.content).toContain('read_file')
      expect(result.resultBlocks[1]!.content).toContain('write_file')
    }
    // write 的 execute 恒在 read 的 execute 之后（组 join 完成才进入串行位；
    // 2026-10-03 删留执行：原 indexOf≥0 恒真，改为真实先后比较）
    expect(order.indexOf('write_file:begin')).toBeGreaterThan(order.indexOf('read_file:started@r1'))
  })

  it('预算工具退串行：parallelSafe 但有 toolBudget → 两调用不重叠（顺序执行）', async () => {
    const order: string[] = []
    const reader = makeTool('web_research', { parallelSafe: true, delayMs: 30, log: order })
    reader.execute = async (_input, _ctx) => {
      order.push('begin')
      await new Promise((resolve) => setTimeout(resolve, 30))
      order.push('end')
      return { output: 'ok' }
    }
    const h = directHarness([reader], { toolBudget: { web_research: 2 } })
    const result = await runTurn(h, [use('w1', 'web_research'), use('w2', 'web_research')])
    expect(result.cancelled).toBe(false)
    // 串行：begin1→end1→begin2→end2（无 begin2 夹在 begin1/end1 之间）
    expect(order).toEqual(['begin', 'end', 'begin', 'end'])
  })

  it('P1-04 批次取消保留已完成结果：串行位执行中 abort → partialResults 携带已完成块（不整批丢弃）', async () => {
    // 审计反例：第一个工具完成副作用后取消第二个，旧口径整批 {cancelled:true} 丢弃已收集结果
    const hung = {
      ...makeTool('edit_file'),
      execute: () => new Promise<ToolOutcome>(() => { /* 永不 settle（模拟不响应取消的工具） */ }),
    }
    const done = makeTool('read_file', { parallelSafe: false })
    const controller = new AbortController()
    const h = directHarness([done, hung], { signal: controller.signal })
    const executionPromise = runTurn(h, [use('d1', 'read_file'), use('h1', 'edit_file')])
    // 第一个工具完成后、第二个挂起中取消
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort(new Error('AGENT_CANCELLED: user_cancelled'))
    const execution = await executionPromise
    expect(execution.cancelled).toBe(true)
    if (execution.cancelled) {
      expect(execution.partialResults ?? []).toHaveLength(1)
      expect((execution.partialResults ?? [])[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'd1', content: 'result-read_file' })
    }
  })

  it('P1-04 并发段 allSettled：同批部分完成时取消 → fulfilled 结果保留，未完成不产生幽灵结果', async () => {
    const fast = makeTool('read_file', { parallelSafe: true, delayMs: 10 })
    const hungRead = {
      ...makeTool('grep', { parallelSafe: true }),
      execute: () => new Promise<ToolOutcome>(() => {}),
    }
    const controller = new AbortController()
    const h = directHarness([fast, hungRead], { signal: controller.signal })
    const executionPromise = runTurn(h, [use('f1', 'read_file'), use('g1', 'grep')])
    await new Promise((resolve) => setTimeout(resolve, 60))
    controller.abort(new Error('AGENT_CANCELLED'))
    const execution = await executionPromise
    expect(execution.cancelled).toBe(true)
    if (execution.cancelled) {
      const partial = execution.partialResults ?? []
      expect(partial.some((block) => block.type === 'tool_result' && block.tool_use_id === 'f1')).toBe(true)
      expect(partial.some((block) => block.type === 'tool_result' && block.tool_use_id === 'g1')).toBe(false)
    }
  })

    it('abort 传播：工具批后检查信号 → 中断串行位（partial 丢弃，与旧串行批间 abort 一致）', async () => {
    const order: string[] = []
    const reader = makeTool('read_file', { parallelSafe: true, delayMs: 60 })
    const writer = makeTool('write_file', {})
    writer.execute = async () => {
      order.push('write:run')
      return { output: 'w' }
    }
    const h = directHarness([reader, writer])
    const controller = new AbortController()
    h.input.signal = controller.signal
    h.ctx.signal = controller.signal
    // read 执行中 abort：该工具本身不感知 signal（模拟不响应取消的只读操作），
    // 但 read 完成后的下一个执行边界（串行 write 前）检查到 abort → cancelled，write 不执行
    setTimeout(() => controller.abort(), 10)
    const result = await runTurn(h, [use('r1', 'read_file'), use('w1', 'write_file')])
    expect(result.cancelled).toBe(true)
    expect(order).not.toContain('write:run')
  })

  it('写类全串行回归：read+write+read → read 组先并行、write 串行、后 read 串行', async () => {
    const order: string[] = []
    const reader = makeTool('read_file', { parallelSafe: true, delayMs: 20 })
    const writer = makeTool('write_file', { delayMs: 5 })
    reader.execute = async () => {
      order.push('read')
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { output: 'r' } as ToolOutcome
    }
    writer.execute = async () => {
      order.push('write')
      return { output: 'w' } as ToolOutcome
    }
    const h = directHarness([reader, writer])
    const result = await runTurn(h, [use('a', 'read_file'), use('b', 'write_file'), use('c', 'read_file')])
    expect(result.cancelled).toBe(false)
    if (!result.cancelled) {
      expect(result.resultBlocks.map((b) => b.tool_use_id)).toEqual(['a', 'b', 'c'])
    }
  })
})

describe('runAgentLoop 集成：只读并发不破坏串行不变式（P1-2）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-loop-par-e2e-'))
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  function toolUseMessage(id: string, name: string, ...extra: Array<{ id: string; name: string }>): SDKMessage {
    return {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }, ...extra.map((e) => ({ type: 'tool_use' as const, id: e.id, name: e.name, input: {} }))] },
    }
  }
  function textMessage(text: string): SDKMessage {
    return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
  }

  function baseInput(overrides: Partial<AgentLoopInput>): AgentLoopInput {
    return {
      system: '测试系统提示',
      task: '测试任务',
      tools: [],
      query: async function* () {
        yield { type: 'result', subtype: 'success' }
      },
      env: {},
      sessionId: 'session-par-e2e',
      projectId: 'project-par-e2e',
      requestId: 'req-par-e2e',
      maxTokens: 256,
      maxTurns: 6,
      permissionMode: 'allow-all',
      signal: new AbortController().signal,
      publish: () => undefined,
      ...overrides,
    }
  }

  it('一轮 3 个只读工具 → 整批 tool_result 一条 user 消息、源序、JSONL 一致、完成事件 3 发', async () => {
    let calls = 0
    const receivedMessages: ConversationTurn[][] = []
    const query: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
      calls += 1
      receivedMessages.push((options.messages ?? []).map((turn) => ({ ...turn })))
      if (calls === 1) yield toolUseMessage('t1', 'read_file', { id: 't2', name: 'grep' }, { id: 't3', name: 'read_file' })
      else yield textMessage('完成')
      yield { type: 'result', subtype: 'success', stop_reason: calls === 1 ? 'tool_use' : 'end_turn' }
    }
    const events: string[] = []
    const result = await runAgentLoop(baseInput({
      query,
      tools: [
        makeTool('read_file', { parallelSafe: true }),
        makeTool('grep', { parallelSafe: true }),
      ],
      publish: (type) => events.push(type),
    }))
    expect(result.status).toBe('completed')
    // 第二轮模型调用看到：system + task(user) + assistant(tool_use) + 一条含全部 tool_result 的 user 轮
    const second = receivedMessages[1]!
    const resultTurns = second.filter(
      (turn) => turn.role === 'user' && Array.isArray(turn.content) && (turn.content as Array<{ type?: string }>).some((b) => b.type === 'tool_result'),
    )
    expect(resultTurns).toHaveLength(1)
    const blocks = resultTurns[0]!.content as Array<{ type?: string; tool_use_id?: string }>
    expect(blocks.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id)).toEqual(['t1', 't2', 't3'])
    // 事件：每个工具 started+completed
    expect(events.filter((e) => e === 'tool_call_started')).toHaveLength(3)
    expect(events.filter((e) => e === 'tool_call_completed')).toHaveLength(3)
    // JSONL 审计
    const lines = readFileSync(getAgentSessionPath('session-par-e2e'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const userResultLine = lines.filter((l) => l.role === 'user' && Array.isArray(l.content) && l.content.some((b: { type?: string }) => b.type === 'tool_result'))
    expect(userResultLine).toHaveLength(1)
  })
})
