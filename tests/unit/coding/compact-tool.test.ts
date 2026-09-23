/**
 * 显式压缩工具测试（Phase 10 W2，2026-09-16，同步 Proma CompactContext）。
 *
 * 锁定口径：
 * - BLOMA_COMPACT_TOOL 缺省 off：compact_context 不注册（工具面字节级现状）；
 * - on：模型调用 compact_context → 本轮工具对落盘后与自动压缩同路径执行
 *   （messages 重置为 task+交接、loop_compaction 事件 trigger=explicit）；
 * - 显式压缩独立计数（上限 4，不占自动压缩 LOOP_MAX_COMPACTIONS=2 预算）；
 * - 自动触发器失明（input_tokens 恒 0）时显式路径仍可用（W1-E6 结论的根治位）。
 *
 * 压缩机制本身的锁定在 agent-loop.test.ts「usage 竹节压缩」describe，此处只锁显式触发面。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent, SDKMessage } from '../../../shared/types'
import type { ConversationTurn, SDKQuery } from '../../../main/orchestration/orchestrator'
import { getAgentSessionPath } from '../../../storage/config-paths'
import { runAgentLoop, compactToolEnabled, MAX_EXPLICIT_COMPACTIONS, type AgentLoopInput, type AgentLoopTool, type ToolOutcome } from '../../../main/agent/loop/agent-loop'
import { buildAgentTools } from '../../../main/agent/tools/agent-tools'
import { createProject } from '../../../main/project/project-service'

const originalPromaHome = process.env.PROMA_HOME
const originalCompactTool = process.env.BLOMA_COMPACT_TOOL
const originalThreshold = process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS
const originalKeepRecent = process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS

function tool(name: string, behavior: (input: Record<string, unknown>) => ToolOutcome | Promise<ToolOutcome>): AgentLoopTool {
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

function baseInput(overrides: Partial<AgentLoopInput> = {}): AgentLoopInput {
  return {
    system: '测试系统提示',
    task: '测试任务',
    tools: [],
    query: async function* () {
      yield { type: 'result', subtype: 'success' }
    },
    env: {},
    sessionId: 'session-compact-tool',
    projectId: 'project-compact-tool',
    requestId: 'req-compact-tool',
    maxTokens: 256,
    maxTurns: 6,
    permissionMode: 'allow-all',
    signal: new AbortController().signal,
    publish: () => undefined,
    ...overrides,
  }
}

/** 脚本化 query：按序产出预设轮次；交接调用（tools 为空）不消耗脚本序号。 */
function scriptedQuery(turns: Array<{ emits: SDKMessage[]; result: SDKMessage }>): {
  query: SDKQuery
  received: Array<{ messages: ConversationTurn[]; toolCount: number }>
} {
  let call = 0
  const received: Array<{ messages: ConversationTurn[]; toolCount: number }> = []
  const query: SDKQuery = async function* (_prompt, options) {
    // 交接调用（无 tools）：返回固定交接文本，不推进脚本
    if (options.tools === undefined) {
      yield textMessage('交接：显式压缩测试的固定交接文本。')
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
      return
    }
    const index = call
    call += 1
    received.push({
      messages: (options.messages ?? []).map((turn) => ({ ...turn })),
      toolCount: (options.tools ?? []).length,
    })
    const scripted = turns[Math.min(index, turns.length - 1)]!
    yield* scripted.emits[Symbol.iterator]()
    yield scripted.result
  }
  return { query, received }
}

function textOf(turn: ConversationTurn | undefined): string {
  if (typeof turn?.content === 'string') return turn.content
  if (Array.isArray(turn?.content)) return turn.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
  return ''
}

describe('compact_context 显式压缩（Phase 10 W2）', () => {
  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-compact-tool-'))
    // 自动压缩阈值推到不可达：显式路径与自动路径解耦观察
    process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = '999999'
    process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS = '0'
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    if (originalCompactTool === undefined) delete process.env.BLOMA_COMPACT_TOOL
    else process.env.BLOMA_COMPACT_TOOL = originalCompactTool
    if (originalThreshold === undefined) delete process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS
    else process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = originalThreshold
    if (originalKeepRecent === undefined) delete process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS
    else process.env.BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS = originalKeepRecent
  })

  it('开关缺省 off：compact_context 不注册（工具面字节级现状）', () => {
    delete process.env.BLOMA_COMPACT_TOOL
    expect(compactToolEnabled()).toBe(false)
    const project = createProject({ request_id: 'req-ct-off', mode: 'quick' })
    const names = buildAgentTools({ projectId: project.project_id }).map((tool) => tool.name)
    expect(names).not.toContain('compact_context')
  })

  it('开关 on：注册进主 loop 工具面（子角色不注册）', () => {
    process.env.BLOMA_COMPACT_TOOL = '1'
    const project = createProject({ request_id: 'req-ct-on', mode: 'quick' })
    const parent = buildAgentTools({ projectId: project.project_id }).map((tool) => tool.name)
    expect(parent).toContain('compact_context')
    for (const role of ['review', 'implement', 'research'] as const) {
      expect(buildAgentTools({ projectId: project.project_id, role }).map((tool) => tool.name)).not.toContain('compact_context')
    }
  })

  it('工具调用 → 本轮落盘后压缩生效：loop_compaction trigger=explicit、窗口重置为 task+交接', async () => {
    process.env.BLOMA_COMPACT_TOOL = '1'
    const { query, received } = scriptedQuery([
      { emits: [toolUseMessage('t1', 'compact_context')], result: { type: 'result', subtype: 'success', stop_reason: 'tool_use', usage: { input_tokens: 0, output_tokens: 5 } } },
      { emits: [toolUseMessage('t2', 'echo')], result: { type: 'result', subtype: 'success', stop_reason: 'tool_use', usage: { input_tokens: 0, output_tokens: 5 } } },
      { emits: [textMessage('完成总结')], result: { type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 5 } } },
    ])
    const events: Array<{ type: AgentEvent['type']; payload: Record<string, unknown> }> = []
    const result = await runAgentLoop(
      baseInput({
        query,
        tools: [tool('echo', () => ({ output: 'ok' })), ...buildAgentTools({ projectId: createProject({ request_id: 'req-ct-run', mode: 'quick' }).project_id }).filter((entry) => entry.name === 'compact_context')],
        maxTurns: 6,
        sessionId: 'session-ct-run',
        projectId: 'project-ct-run',
        publish: (type, payload) => events.push({ type, payload }),
      }),
    )
    expect(result.status).toBe('completed')
    const compaction = events.find((event) => event.type === 'loop_compaction')
    expect(compaction).toBeDefined()
    expect(compaction!.payload).toMatchObject({ trigger: 'explicit', explicit_compactions: 1 })
    // 第 2 轮模型可见：窗口已重置（messages[0] 是 system，messages[1] 是 task+交接）
    const secondTurnTask = textOf(received[1]!.messages[1])
    expect(secondTurnTask).toContain('测试任务')
    expect(secondTurnTask).toContain('【此前进度交接（第 1 段）】')
    // 工具结果如实回执（JSONL 审计可见登记文案）
    const jsonl = readFileSync(getAgentSessionPath('session-ct-run'), 'utf-8')
    expect(jsonl).toContain('已登记压缩')
  })

  it('显式压缩上限独立计数：连续调用 ' + (MAX_EXPLICIT_COMPACTIONS + 1) + ' 次时第 ' + (MAX_EXPLICIT_COMPACTIONS + 1) + ' 次被工具层拒绝', async () => {
    process.env.BLOMA_COMPACT_TOOL = '1'
    const totalCalls = MAX_EXPLICIT_COMPACTIONS + 1
    const turns: Array<{ emits: SDKMessage[]; result: SDKMessage }> = []
    for (let i = 0; i < totalCalls; i += 1) {
      turns.push({
        emits: [toolUseMessage(`tc${i}`, 'compact_context')],
        result: { type: 'result', subtype: 'success', stop_reason: 'tool_use', usage: { input_tokens: 0, output_tokens: 5 } },
      })
    }
    turns.push({ emits: [textMessage('收尾')], result: { type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 5 } } })
    const { query } = scriptedQuery(turns)
    const events: Array<{ type: AgentEvent['type']; payload: Record<string, unknown> }> = []
    await runAgentLoop(
      baseInput({
        query,
        tools: buildAgentTools({ projectId: createProject({ request_id: 'req-ct-cap', mode: 'quick' }).project_id }).filter((entry) => entry.name === 'compact_context'),
        maxTurns: totalCalls + 2,
        sessionId: 'session-ct-cap',
        projectId: 'project-ct-cap',
        publish: (type, payload) => events.push({ type, payload }),
      }),
    )
    const explicitEvents = events.filter((event) => event.type === 'loop_compaction')
    expect(explicitEvents).toHaveLength(MAX_EXPLICIT_COMPACTIONS)
    const jsonl = readFileSync(getAgentSessionPath('session-ct-cap'), 'utf-8')
    expect(jsonl).toContain('显式压缩已达上限')
  })

  it('自动压缩预算不被显式消耗：显式 1 次后自动路径仍可用（compactions 字段分离观察）', async () => {
    process.env.BLOMA_COMPACT_TOOL = '1'
    // 第 1 轮显式压缩；第 2 轮把自动阈值拉低触发自动压缩
    process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = '1'
    const { query } = scriptedQuery([
      { emits: [toolUseMessage('e1', 'compact_context')], result: { type: 'result', subtype: 'success', stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5 } } },
      { emits: [toolUseMessage('e2', 'echo')], result: { type: 'result', subtype: 'success', stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5 } } },
      { emits: [textMessage('结束')], result: { type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } } },
    ])
    const events: Array<{ type: AgentEvent['type']; payload: Record<string, unknown> }> = []
    await runAgentLoop(
      baseInput({
        query,
        tools: [tool('echo', () => ({ output: 'ok' })), ...buildAgentTools({ projectId: createProject({ request_id: 'req-ct-mix', mode: 'quick' }).project_id }).filter((entry) => entry.name === 'compact_context')],
        maxTurns: 6,
        sessionId: 'session-ct-mix',
        projectId: 'project-ct-mix',
        publish: (type, payload) => events.push({ type, payload }),
      }),
    )
    const all = events.filter((event) => event.type === 'loop_compaction')
    expect(all.length).toBeGreaterThanOrEqual(2)
    expect(all[0]!.payload).toMatchObject({ trigger: 'explicit' })
    expect(all[1]!.payload).toMatchObject({ trigger: 'auto' })
  })
})
