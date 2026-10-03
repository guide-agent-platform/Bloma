import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAgentLoop, resolveLoopCostLimitTokens, type AgentLoopInput, type AgentLoopTool, type ToolOutcome } from '../../main/agent/loop/agent-loop'
import type { SDKMessage } from '../../shared/types'
import type { SDKQuery } from '../../main/orchestration/orchestrator'

/**
 * P2-02（2026-09-26 运行审计）：上下文/成本硬约束——
 * ① usage 可信度区分（input_tokens=0 视为盲，估算兜底启用）；
 * ② 主循环/交接/宽限成本统一累计；
 * ③ 成本硬上限（opt-in）进入可解释 cost_limit 终态。
 */

function tool(name: string, behavior: () => Promise<ToolOutcome> | ToolOutcome): AgentLoopTool {
  return {
    name,
    description: name,
    input_schema: { type: 'object', properties: {} },
    execute: async () => behavior(),
  }
}

function toolUseMessage(id: string, name: string, input: Record<string, unknown> = {}): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }
}

function textMessage(text: string): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

/** 脚本化 query：逐轮吐响应 + 轮末 result（带 usage——成本口径的渠道来源，
 *  与真实渠道一致：usage 挂在 result 消息上）。 */
function scriptedQuery(
  rounds: SDKMessage[][],
  usage?: { input_tokens: number; output_tokens: number },
): SDKQuery {
  let call = 0
  return async function* (_prompt: string) {
    const round = rounds[Math.min(call, rounds.length - 1)] ?? []
    call += 1
    for (const message of round) yield message
    const hasToolUse = round.some(
      (m) => m.type === 'assistant' && (m.message?.content ?? []).some((b) => b.type === 'tool_use'),
    )
    yield { type: 'result', subtype: 'success', stop_reason: hasToolUse ? 'tool_use' : 'end_turn', ...(usage ? { usage } : {}) }
  }
}

function baseInput(overrides: Partial<AgentLoopInput> = {}): AgentLoopInput {
  return {
    system: 's',
    task: 't',
    tools: [],
    query: async function* () {
      yield { type: 'result', subtype: 'success' }
    },
    env: {},
    sessionId: 'session-cost',
    projectId: 'project-cost',
    requestId: 'req-cost',
    maxTokens: 256,
    maxTurns: 4,
    permissionMode: 'allow-all',
    signal: new AbortController().signal,
    publish: () => undefined,
    ...overrides,
  }
}

describe('P2-02 成本硬上限（BLOMA_LOOP_COST_LIMIT_TOKENS）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-cost-'))
    delete process.env.BLOMA_LOOP_COST_LIMIT_TOKENS
  })
  afterEach(() => {
    restorePromaHome(originalPromaHome)
    delete process.env.BLOMA_LOOP_COST_LIMIT_TOKENS
  })

  it('累计超限 → 可解释 cost_limit 终态（limit/observed 随 termination_detail）', async () => {
    process.env.BLOMA_LOOP_COST_LIMIT_TOKENS = '150'
    const echo = tool('echo', () => ({ output: 'ok' }))
    const query = scriptedQuery(
      [[toolUseMessage('t1', 'echo')], [toolUseMessage('t2', 'echo')], [textMessage('完成')]],
      { input_tokens: 100, output_tokens: 50 },
    )
    const result = await runAgentLoop(baseInput({ query, tools: [echo] }))
    expect(result.status).toBe('budget_exhausted')
    expect(result.termination_detail?.reason).toBe('cost_limit')
    expect(result.termination_detail?.limit).toBe(150)
    expect(result.termination_detail?.observed).toBeGreaterThanOrEqual(150)
  })

  it('缺省不限：正常收口不被误判（行为零变化）', async () => {
    expect(resolveLoopCostLimitTokens()).toBe(0)
    const query = scriptedQuery([[textMessage('完成')]], { input_tokens: 999_999, output_tokens: 1 })
    const result = await runAgentLoop(baseInput({ query }))
    expect(result.status).toBe('completed')
    expect(result.termination_detail?.reason).not.toBe('cost_limit')
  })

  it('宽限交卷调用计入统一成本口径（graceCalls 可见；不计 turns 但计成本）', async () => {
    const echo = tool('echo', () => ({ output: 'ok' }))
    // maxTurns=1：工作轮用尽 → 宽限交卷调用（无 tools，纯文本）
    // agent-loop 的 query 第一参数恒为 ''（system/messages 走 options）——用 tools 空否判别宽限轮
    const graceQuery: SDKQuery = async function* (_prompt: string, options) {
      const opts = options as { tools?: unknown[] } | undefined
      if (!opts?.tools || opts.tools.length === 0) {
        yield textMessage('已交卷总结')
        return
      }
      yield toolUseMessage('t1', 'echo')
      yield { type: 'result', subtype: 'success', stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } }
    }
    const result = await runAgentLoop(baseInput({ query: graceQuery, tools: [echo], maxTurns: 1 }))
    expect(result.usage?.graceCalls).toBeGreaterThanOrEqual(1)
    expect(result.usage?.estTotalTokens).toBeGreaterThan(0)
  })
})

describe('P2-02 usage 可信度（input_tokens=0 视为盲 → 估算兜底）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-blind-'))
    delete process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS
  })
  afterEach(() => {
    restorePromaHome(originalPromaHome)
    delete process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS
  })

  it('渠道恒返 input_tokens=0：估算兜底仍触发压缩（旧口径仅 undefined 算盲，触发器失明）', async () => {
    process.env.BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS = '300' // 阈值降到历史估算可达
    const echo = tool('echo', () => ({ output: 'x'.repeat(1200) })) // 工具结果撑大历史估算
    const compactions: number[] = []
    const query = scriptedQuery(
      [
        [toolUseMessage('t1', 'echo')],
        [toolUseMessage('t2', 'echo')],
        [textMessage('完成')],
      ],
      { input_tokens: 0, output_tokens: 0 }, // 渠道盲：恒 0
    )
    const result = await runAgentLoop(
      baseInput({
        query,
        tools: [echo],
        maxTurns: 6,
        onCompaction: (info) => {
          if (!info.skipped) compactions.push(info.at_turn)
        },
      }),
    )
    expect(compactions.length).toBeGreaterThanOrEqual(1)
    expect(result.status).not.toBe('error')
  })
})
