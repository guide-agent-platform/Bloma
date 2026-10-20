import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAgentLoop, type AgentLoopInput, type AgentLoopTool, type ToolContext, type ToolOutcome } from '../../../main/agent/loop/agent-loop'
import type { SDKMessage } from '../../../shared/types'
import type { ConversationTurn, SDKQuery, SDKQueryOptions } from '../../../main/orchestration/orchestrator'

/**
 * W5（Phase 8.5，2026-09-12 狗粮 dd6ba98d「工作流同步 2.0」）：任务清单驱动的生成 loop。
 * 锁定：
 * - renderTaskChecklist：分组编号/工作纪律/验证映射；
 * - 守卫4 重复写：同文件第二次全量 write_file → 批间注入「改用 edit_file」；
 *   edit_file 不触发；
 * - 进度投影：新文件完成后注入「清单 N/M + 勿重写 + 不要重读」，≥2 轮间隔抑制；
 * - 早验证：≥3 文件零验证且过 1/3 轮次 → 提醒（一次性）；
 * - 开关 off：全部零注入（字节级现状）。
 */

function tool(name: string, behavior: (input: Record<string, unknown>) => Promise<ToolOutcome> | ToolOutcome): AgentLoopTool {
  return {
    name,
    description: `测试工具 ${name}`,
    input_schema: { type: 'object', properties: {} },
    execute: async (input: Record<string, unknown>) => behavior(input),
  }
}

function toolUseMessage(id: string, name: string, input: Record<string, unknown> = {}): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }
}

function textMessage(text: string): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

function scriptedQuery(responses: SDKMessage[][]): { query: SDKQuery; receivedMessages: ConversationTurn[][] } {
  let call = 0
  const receivedMessages: ConversationTurn[][] = []
  const query: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
    receivedMessages.push((options.messages ?? []).map((turn) => ({ ...turn })))
    const script = responses[Math.min(call, responses.length - 1)] ?? []
    call += 1
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
    sessionId: 'session-w5',
    projectId: 'project-w5',
    requestId: 'req-w5',
    maxTokens: 256,
    maxTurns: 12,
    permissionMode: 'allow-all',
    signal: new AbortController().signal,
    publish: () => undefined,
    ...overrides,
  }
}

function userTexts(messages: ConversationTurn[]): string[] {
  return messages
    .filter((turn) => turn.role === 'user')
    .map((turn) => (typeof turn.content === 'string' ? turn.content : JSON.stringify(turn.content)))
}

describe('W5+（狗粮 52f19ab4 增强）：清单完成后零验证的重复强提醒 + grace 退化补口', () => {
  const originalHome = process.env.PROMA_HOME
  const PLAN_FILES = ['index.html', 'src/app.js']

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-w5p-'))
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalHome
  })

  it('清单全部完成后零验证 → 每 2 轮重复「不要再通读，自查后交卷」（JSONL 实次 ≥2）', async () => {
    const readTool = tool('read_file', () => ({ output: '内容' }))
    const writes: SDKMessage[][] = [
      [toolUseMessage('w1', 'write_file', { path: 'index.html', content: 'x' })],
      [toolUseMessage('w2', 'write_file', { path: 'src/app.js', content: 'x' })],
    ]
    // 之后 6 轮纯读（模型自查读档形态）
    const reads: SDKMessage[][] = Array.from({ length: 6 }, (_, i) => [toolUseMessage(`r${i}`, 'read_file', { path: 'src/game/m.js', offset: i * 100 })])
    const { query } = scriptedQuery([...writes, ...reads, [textMessage('总结')]] as SDKMessage[][])
    await runAgentLoop(baseInput({ query, tools: [readTool], planFiles: PLAN_FILES, maxTurns: 12 }))
    // 从会话 JSONL 数注入实次（每次注入追加一行 user；消息快照会重复，不能作计数源）。
    // 语义更新（2026-10-01 全链路审查 P1）：本工具面未装配任何验证工具——提醒不再点名
    // 已退役的幽灵工具（run_gwt_tests），改为「读不能代替测试 + 对照清单自查」的如实指引。
    const { readFileSync } = await import('node:fs')
    const { getAgentSessionPath } = await import('../../../storage/config-paths')
    const jsonl = readFileSync(getAgentSessionPath('session-w5'), 'utf8')
    const strongCount = jsonl.split('\n').filter((line) => line.includes('不要再通读自己写的文件') && line.includes('读不能代替测试')).length
    expect(strongCount).toBeGreaterThanOrEqual(2)
  })

  it('宽限交卷轮退化（DSML 读意图）→ 注入「工具已停用」后再给一次交卷机会，第二次干净文本 → completed', async () => {
    const readTool = tool('read_file', () => ({ output: '内容' }))
    const writeTool = tool('write_file', () => ({ output: '已写入' }))
    const dsml = [
      '<｜｜DSML｜｜ calls>',
      '<｜｜DSML｜｜ invoke name="read_file">',
      '<｜｜DSML｜｜ parameter name="path" string="true">src/app.js</｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ invoke>',
      '</｜｜DSML｜｜ calls>',
    ].join('\n')
    const { query, receivedMessages } = scriptedQuery([
      [toolUseMessage('w1', 'write_file', { path: 'src/app.js', content: 'x' })],
      [textMessage(dsml)],          // 最后一轮正常轮：退化（触发 D2 只读恢复执行 read）→ 下轮起 maxTurns 用尽
      [textMessage(dsml)],          // grace 第 1 次：仍想读 → 退化
      [textMessage('已完成：入口与逻辑均已写入，自测待外部终验。')], // grace 第 2 次：干净交卷
    ] as SDKMessage[][])
    const result = await runAgentLoop(baseInput({ query, tools: [readTool, writeTool], maxTurns: 2, planFiles: ['src/app.js'] }))
    expect(result.status).toBe('completed')
    expect(result.transport_recoveries).toBeGreaterThanOrEqual(1)
    const distinct = new Set(receivedMessages.flatMap(userTexts))
    expect([...distinct].some((t) => t.includes('工具调用已全部停用') && t.includes('read_file'))).toBe(true)
  })
})
