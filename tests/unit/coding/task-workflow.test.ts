import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAgentLoop, taskWorkflowEnabled, type AgentLoopInput, type AgentLoopTool, type ToolContext, type ToolOutcome } from '../../../main/agent-loop'
import { renderTaskChecklist, type LoopPlan } from '../../../main/coding/loop-planner'
import type { SDKMessage } from '../../../shared/types'
import type { ConversationTurn, SDKQuery, SDKQueryOptions } from '../../../main/orchestrator'

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

describe('renderTaskChecklist — plan 合同 checklist 化', () => {
  const plan: LoopPlan = {
    filesToTouch: [
      { path: 'index.html', reason: '入口与承接位' },
      { path: 'src/styles.css', reason: '街机视觉基线' },
      { path: 'src/game/state.js', reason: '状态机' },
      { path: 'src/game/entities.js', reason: '实体系统' },
      { path: 'src/app.js', reason: '装配入口' },
      { path: 'server/routes/scores.js', reason: '最高分持久化' },
    ],
    reuse: [],
    verification: ['F-001 点击开始游戏按钮→开始页面消失', 'GET /api/scores 返回 {highScore:number}'],
    risks: [],
  }

  it('分组有序编号 + 工作纪律 + 验证口径按文件名映射', () => {
    const text = renderTaskChecklist(plan)
    expect(text).toContain('## 实施清单（按序推进，完成一项即勾选进入下一项）')
    expect(text).toContain('1. [ ] 入口与样式：index.html、src/styles.css')
    expect(text).toContain('src/game/ 模块：src/game/state.js、src/game/entities.js')
    expect(text).toContain('装配入口：src/app.js')
    expect(text).toContain('后端路由：server/routes/scores.js')
    // 验证映射：scores 命中 GET /api/scores 行；index/stem 无命中不硬挂
    expect(text).toContain('验证：GET /api/scores 返回 {highScore:number}')
    expect(text).not.toContain('F-001 点击开始游戏按钮')
    expect(text).toContain('禁止先全读再全写')
    expect(text).toContain('微调用 edit_file')
    // 编号连续
    for (const n of [1, 2, 3, 4]) expect(text).toContain(`${n}. [ ] `)
  })

  it('空 filesToTouch 返回空串', () => {
    expect(renderTaskChecklist({ filesToTouch: [], reuse: [], verification: [], risks: [] })).toBe('')
  })
})

describe('W5 批间注入（进度投影 / 守卫4 重复写 / 早验证）', () => {
  const originalHome = process.env.PROMA_HOME
  const originalW5 = process.env.BLOMA_TASK_WORKFLOW
  const PLAN_FILES = ['index.html', 'src/game/state.js', 'src/game/entities.js', 'src/app.js']

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-w5-'))
    delete process.env.BLOMA_TASK_WORKFLOW
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalHome
    if (originalW5 === undefined) delete process.env.BLOMA_TASK_WORKFLOW
    else process.env.BLOMA_TASK_WORKFLOW = originalW5
  })

  it('守卫4：同文件第二次全量 write_file → 注入「改用 edit_file 勿整文件重写」', async () => {
    const writeTool = tool('write_file', (input) => ({ output: `已写入 ${String(input.path)}` }))
    const { query, receivedMessages } = scriptedQuery([
      [toolUseMessage('t1', 'write_file', { path: 'src/game/state.js', content: 'v1' })],
      [toolUseMessage('t2', 'write_file', { path: 'src/game/state.js', content: 'v2 重写' })],
      [textMessage('完成总结')], // 收口
    ])
    await runAgentLoop(baseInput({ query, tools: [writeTool], planFiles: PLAN_FILES }))
    const injections = userTexts(receivedMessages[2]).filter((t) => t.includes('任务清单工作流'))
    expect(injections.some((t) => t.includes('src/game/state.js') && t.includes('edit_file') && t.includes('不要整文件重写'))).toBe(true)
  })

  it('edit_file 微调不触发守卫4（正确姿势不打扰）', async () => {
    const writeTool = tool('write_file', () => ({ output: '已写入' }))
    const editTool = tool('edit_file', () => ({ output: '已编辑' }))
    const { query, receivedMessages } = scriptedQuery([
      [toolUseMessage('t1', 'write_file', { path: 'src/game/state.js', content: 'v1' })],
      [toolUseMessage('t2', 'edit_file', { path: 'src/game/state.js', oldText: 'a', newText: 'b' })],
      [textMessage('完成总结')],
    ])
    await runAgentLoop(baseInput({ query, tools: [writeTool, editTool], planFiles: PLAN_FILES }))
    const injections = userTexts(receivedMessages[2]).filter((t) => t.includes('任务清单工作流'))
    expect(injections.some((t) => t.includes('不要整文件重写'))).toBe(false)
  })

  it('进度投影：新文件完成后注入清单 N/M 与「读过的内容不要重读」（≥2 轮间隔防刷屏）', async () => {
    const writeTool = tool('write_file', () => ({ output: '已写入' }))
    const { query, receivedMessages } = scriptedQuery([
      [toolUseMessage('t1', 'write_file', { path: 'index.html', content: 'x' })],
      [toolUseMessage('t2', 'write_file', { path: 'src/game/state.js', content: 'x' })],
      [toolUseMessage('t3', 'write_file', { path: 'src/game/entities.js', content: 'x' })],
      [textMessage('完成总结')],
    ])
    await runAgentLoop(baseInput({ query, tools: [writeTool], planFiles: PLAN_FILES }))
    // 轮 1 投影 1/4；轮 2 被间隔抑制；轮 3 投影 3/4（同一注入会出现在后续轮的
    // messages 快照里，断言用去重后的全文集合）
    const distinct = new Set(receivedMessages.flatMap(userTexts))
    const projections = [...distinct].filter((t) => t.includes('清单进度'))
    expect(projections.some((t) => t.includes('1/4'))).toBe(true)
    expect(projections.some((t) => t.includes('3/4'))).toBe(true)
    expect(projections.some((t) => t.includes('读过的内容不要重读'))).toBe(true)
  })

  it('早验证：≥3 文件零验证且过 1/3 轮次 → 一次性提醒（去重后恰一条）', async () => {
    const writeTool = tool('write_file', () => ({ output: '已写入' }))
    const fillers = Array.from({ length: 5 }, (_, i) => [toolUseMessage(`t${i}`, 'write_file', { path: `src/game/m${i}.js`, content: 'x' })] as SDKMessage[])
    const { query, receivedMessages } = scriptedQuery([...fillers, [textMessage('完成总结')]] as SDKMessage[][])
    await runAgentLoop(baseInput({ query, tools: [writeTool], planFiles: [...PLAN_FILES, 'src/game/m0.js', 'src/game/m1.js'], maxTurns: 12 }))
    const distinct = new Set(receivedMessages.flatMap(userTexts))
    const early = [...distinct].filter((t) => t.includes('尚未运行任何自测：现在就 run_preview'))
    expect(early).toHaveLength(1)
    expect(early[0]).toContain('尽早暴露问题')
  })

  it('开关 off：全部零注入（字节级现状）', async () => {
    process.env.BLOMA_TASK_WORKFLOW = '0'
    expect(taskWorkflowEnabled()).toBe(false)
    const writeTool = tool('write_file', () => ({ output: '已写入' }))
    const { query, receivedMessages } = scriptedQuery([
      [toolUseMessage('t1', 'write_file', { path: 'src/game/state.js', content: 'v1' })],
      [toolUseMessage('t2', 'write_file', { path: 'src/game/state.js', content: 'v2' })],
      [textMessage('完成总结')],
    ])
    await runAgentLoop(baseInput({ query, tools: [writeTool], planFiles: PLAN_FILES }))
    const allUsers = receivedMessages.flatMap(userTexts).join('\n')
    expect(allUsers).not.toContain('任务清单工作流')
    expect(allUsers).not.toContain('清单进度')
  })
})

describe('W5+（狗粮 52f19ab4 增强）：清单完成后零验证的重复强提醒 + grace 退化补口', () => {
  const originalHome = process.env.PROMA_HOME
  const PLAN_FILES = ['index.html', 'src/app.js']

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-w5p-'))
    delete process.env.BLOMA_TASK_WORKFLOW
    delete process.env.BLOMA_DSML_RECOVERY
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalHome
  })

  it('清单全部完成后零验证 → 每 2 轮重复「不要再通读，立即 run_gwt_tests」（JSONL 实次 ≥2）', async () => {
    const readTool = tool('read_file', () => ({ output: '内容' }))
    const writes: SDKMessage[][] = [
      [toolUseMessage('w1', 'write_file', { path: 'index.html', content: 'x' })],
      [toolUseMessage('w2', 'write_file', { path: 'src/app.js', content: 'x' })],
    ]
    // 之后 6 轮纯读（模型自查读档形态）
    const reads: SDKMessage[][] = Array.from({ length: 6 }, (_, i) => [toolUseMessage(`r${i}`, 'read_file', { path: 'src/game/m.js', offset: i * 100 })])
    const { query } = scriptedQuery([...writes, ...reads, [textMessage('总结')]] as SDKMessage[][])
    await runAgentLoop(baseInput({ query, tools: [readTool], planFiles: PLAN_FILES, maxTurns: 12 }))
    // 从会话 JSONL 数注入实次（每次注入追加一行 user；消息快照会重复，不能作计数源）
    const { readFileSync } = await import('node:fs')
    const { getAgentSessionPath } = await import('../../../storage/config-paths')
    const jsonl = readFileSync(getAgentSessionPath('session-w5'), 'utf8')
    const strongCount = jsonl.split('\n').filter((line) => line.includes('不要再通读自己写的文件') && line.includes('立即运行 run_gwt_tests')).length
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
