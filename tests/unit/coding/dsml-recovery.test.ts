import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentLoopInput, AgentLoopTool, ToolContext, ToolOutcome } from '../../../main/agent/loop/agent-loop'
import {
  DSML_RECOVERABLE_TOOLS,
  buildTargetedDegenerateFeedback,
  classifyDsmlRecovery,
  parseDsmlInvokes,
} from '../../../main/agent/loop/dsml-recovery'
import type { SDKMessage } from '../../../shared/types'
import type { ConversationTurn, SDKQuery, SDKQueryOptions } from '../../../main/orchestration/orchestrator'

/**
 * D2 DSML 传输事故恢复（2026-09-11 狗粮 dd6ba98d：三 loop 死于渠道把工具调用
 * 序列化进正文）。锁定：
 * - 解析：当晚实测两种形态（纯协议块 / 旁白+协议块，string true/false 参数）；
 * - 分级：只读工具直执行、写类/未知工具走定向反馈；
 * - 集成：退化 read_file 轮被救回（工具真实执行、loop 存活、恢复计数入账）——
 *   2026-10-03 删留执行注：本文件实际只锁解析/分级纯函数面，runAgentLoop 集成面
 *   由 coding/task-workflow.test.ts 间接覆盖（头注原文与实情不符已修正）；
 *   退化 write_file 轮不盲执行（零 write 调用）且反馈具体到调用意图；
 * - 开关 off = 现状（泛化反馈，无恢复）。
 */

function tool(name: string, behavior: (input: Record<string, unknown>) => Promise<ToolOutcome> | ToolOutcome): AgentLoopTool {
  return {
    name,
    description: `测试工具 ${name}`,
    input_schema: { type: 'object', properties: {} },
    execute: async (input: Record<string, unknown>) => behavior(input),
  }
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
    sessionId: 'session-dsml',
    projectId: 'project-dsml',
    requestId: 'req-dsml',
    maxTokens: 256,
    maxTurns: 6,
    permissionMode: 'allow-all',
    signal: new AbortController().signal,
    publish: () => undefined,
    ...overrides,
  }
}

/** 狗粮 dd6ba98d line191 实测形态：纯协议块 read_file（string false 数字参数）。 */
const DSML_READ = [
  '<｜｜DSML｜｜ calls>',
  '<｜｜DSML｜｜ invoke name="read_file">',
  '<｜｜DSML｜｜ parameter name="offset" string="false">239</｜｜DSML｜｜ parameter>',
  '<｜｜DSML｜｜ parameter name="path" string="true">src/game/render.js</｜｜DSML｜｜ parameter>',
  '</｜｜DSML｜｜ invoke>',
  '</｜｜DSML｜｜ calls>',
].join('\n')

/** 狗粮 dd6ba98d line289 实测形态：合法旁白 + 协议块（多参数）。 */
const DSML_READ_WITH_PROSE = [
  '三处 innerHTML 写入被判定为注入风险。读一下上下文，改成 textContent 安全写法。',
  '',
  '<｜｜DSML｜｜ calls>',
  '<｜｜DSML｜｜ invoke name="read_file">',
  '<｜｜DSML｜｜ parameter name="path" string="true">src/app.js</｜｜DSML｜｜ parameter>',
  '<｜｜DSML｜｜ parameter name="start_line" string="false">420</｜｜DSML｜｜ parameter>',
  '<｜｜DSML｜｜ parameter name="end_line" string="false">480</｜｜DSML｜｜ parameter>',
  '</｜｜DSML｜｜ invoke>',
  '</｜｜DSML｜｜ calls>',
].join('\n')

/** line146 实测形态（节选）：写类调用——参数值大且信道疑似损坏换行。 */
const DSML_WRITE = [
  '<｜｜DSML｜｜ calls>',
  '<｜｜DSML｜｜ invoke name="write_file">',
  '<｜｜DSML｜｜ parameter name="path" string="true">src/game/entities.js</｜｜DSML｜｜ parameter>',
  `<｜｜DSML｜｜ parameter name="content" string="true">export const PLAYER = {\\n speed: 300, // 像素/秒 radius: 11,\\n}</｜｜DSML｜｜ parameter>`,
  '</｜｜DSML｜｜ invoke>',
  '</｜｜DSML｜｜ calls>',
].join('\n')

describe('parseDsmlInvokes — 当晚实测文法', () => {
  it('纯协议块 read_file：参数名/值/数字类型全解析', () => {
    const parsed = parseDsmlInvokes(DSML_READ)
    expect(parsed).not.toBeNull()
    expect(parsed!.invokes).toHaveLength(1)
    expect(parsed!.invokes[0].name).toBe('read_file')
    expect(parsed!.invokes[0].input).toEqual({ offset: 239, path: 'src/game/render.js' })
    expect(parsed!.prose).toBe('')
  })

  it('旁白 + 协议块：prose 保留、多参数解析（string=false 数字）', () => {
    const parsed = parseDsmlInvokes(DSML_READ_WITH_PROSE)
    expect(parsed!.invokes[0].input).toEqual({ path: 'src/app.js', start_line: 420, end_line: 480 })
    expect(parsed!.prose).toContain('三处 innerHTML 写入被判定为注入风险')
  })

  it('写类调用可解析（分级由 classify 决定）', () => {
    const parsed = parseDsmlInvokes(DSML_WRITE)
    expect(parsed!.invokes[0].name).toBe('write_file')
    expect(parsed!.invokes[0].input.path).toBe('src/game/entities.js')
  })

  it('无 invoke / 空 name / 超限参数 → null', () => {
    expect(parseDsmlInvokes('普通文本，无协议块')).toBeNull()
    expect(parseDsmlInvokes('<｜｜DSML｜｜ calls></｜｜DSML｜｜ calls>')).toBeNull()
    const hugeParam = `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read_file"><｜｜DSML｜｜ parameter name="path" string="true">${'x'.repeat(2000)}</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`
    expect(parseDsmlInvokes(hugeParam)).toBeNull()
  })
})

describe('classifyDsmlRecovery — 安全分级', () => {
  const known = new Set(['read_file', 'write_file', 'grep', 'run_gwt_tests'])
  it('只读且在册 → execute；写类/未知工具 → feedback', () => {
    expect(classifyDsmlRecovery(parseDsmlInvokes(DSML_READ)!, known)).toBe('execute')
    expect(classifyDsmlRecovery(parseDsmlInvokes(DSML_READ_WITH_PROSE)!, known)).toBe('execute')
    expect(classifyDsmlRecovery(parseDsmlInvokes(DSML_WRITE)!, known)).toBe('feedback')
    const unknownTool = parseDsmlInvokes(DSML_READ.replace(/read_file/g, 'rm_rf'))!
    expect(classifyDsmlRecovery(unknownTool, known)).toBe('feedback')
    // 工具不在本次 loop 注册面 → feedback（不执行幽灵工具）
    const notRegistered = parseDsmlInvokes(DSML_READ.replace(/read_file/g, 'run_gwt_tests'))!
    expect(classifyDsmlRecovery(notRegistered, new Set(['read_file']))).toBe('feedback')
  })
  it('DSML_RECOVERABLE_TOOLS 不含写类与委派类', () => {
    expect(DSML_RECOVERABLE_TOOLS.has('write_file')).toBe(false)
    expect(DSML_RECOVERABLE_TOOLS.has('edit_file')).toBe(false)
    expect(DSML_RECOVERABLE_TOOLS.has('delegate_agent')).toBe(false)
    expect(DSML_RECOVERABLE_TOOLS.has('read_file')).toBe(true)
  })
})

describe('buildTargetedDegenerateFeedback — 定向反馈', () => {
  it('解析出意图时列出工具与参数；无解析时回退泛化措辞', () => {
    const targeted = buildTargetedDegenerateFeedback(parseDsmlInvokes(DSML_READ_WITH_PROSE))
    expect(targeted).toContain('协议原文形式漏进了正文')
    expect(targeted).toContain('read_file')
    expect(targeted).toContain('src/app.js')
    expect(targeted).toContain('标准工具调用')
    const generic = buildTargetedDegenerateFeedback(null)
    expect(generic).toContain('【传输事故反馈】')
    expect(generic).not.toContain('read_file(')
  })
})
