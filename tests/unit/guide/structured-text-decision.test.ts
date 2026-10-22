import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runGuideLoopTurn } from '../../../main/guide/stages/guide-pipeline'
import type { GuideModelOptions, SDKQuery } from '../../../main/orchestration/orchestrator'
import type { AgentSendMessageInput } from '../../../shared/types'

const input = { project_id: 'p', session_id: 's', request_id: 'r', mode: 'quick', current_stage: 'clarifying', content: '继续' } as AgentSendMessageInput
const captured = readFileSync(resolve('tests/fixtures/guide/real-structured-decision.json'), 'utf8')
async function run(text: string, signal = new AbortController().signal) {
  const events: any[] = []
  const query: SDKQuery = vi.fn(async function* () {
    yield { type: 'assistant' as const, message: { role: 'assistant' as const, content: [{ type: 'text' as const, text }] } }
    yield { type: 'result' as const, subtype: 'success' as const, stop_reason: 'end_turn' }
  })
  const model = { query, env: {}, signal, sessionId: 's', history: [], maxTokens: 2048, persistAssistant: vi.fn() } as GuideModelOptions
  const result = await runGuideLoopTurn(input, event => events.push(event), model, '通过向导决策工具提交结构化决策。')
  return { result, events, query }
}
describe('real provider structured-text decision compatibility', () => {
  it('validates the captured real model reply once without inventing a tool call or streaming JSON to users', async () => {
    const { result, events, query } = await run(captured)
    expect(result.kind).toBe('decision')
    if (result.kind === 'decision') expect(result.decision.action).toBe('generate_sketch')
    expect(query).toHaveBeenCalledOnce()
    expect(events.some(event => event.type === 'tool_call_started')).toBe(false)
    expect(events.filter(event => event.type === 'message_delta')).toEqual([])
  })
  it('accepts a fenced complete decision through the same validator', async () => {
    expect((await run('```json\n' + captured + '\n```')).result.kind).toBe('decision')
  })
  it.each(['{"action":"execute_shell","reply":"x"}', '{"action":', '{"action":"generate_sketch"}', '{"action":"generate_sketch","reply":"x"}', '{"action":"ask_clarification","reply":"x","questions":[]}'])('cannot execute invalid or incomplete structured output %s', async text => {
    expect((await run(text)).result.kind).toBe('failed')
  })
  it('continues to stream ordinary dialogue', async () => {
    const { result, events } = await run('你更常用整数还是小数？')
    expect(result.kind).toBe('free_chat')
    expect(events.some(event => event.payload.text === '你更常用整数还是小数？')).toBe(true)
  })
  it('does not accept a late decision after cancellation', async () => {
    const controller = new AbortController(); controller.abort()
    expect((await run(captured, controller.signal)).result.kind).toBe('failed')
  })
})
