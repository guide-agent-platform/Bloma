import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SDKMessage } from '../../shared/types'
import type { SDKQuery, SDKQueryOptions } from '../../main/orchestrator'
import { createToolState, type AgentLoopTool, type ToolContext } from '../../main/agent-loop'
import { buildAgentTools } from '../../main/agent-tools'
import {
  MAX_RUNNING_DELEGATIONS_PER_PARENT,
  answerDelegationQuestion,
  askDelegationQuestion,
  buildChildSystemPrompt,
  buildDelegationPrompt,
  continueDelegation,
  delegateAgentOnce,
  disposeParentDelegationState,
  findDelegation,
  getDelegationSummary,
  listDelegations,
  registerParentLoopContext,
  setChildToolsBuilder,
  startDelegation,
  stopDelegation,
  unregisterParentLoopContext,
  waitForDelegations,
  type StartDelegationResult,
} from '../../main/agent-collaboration'

/**
 * 委派协作 M1 单元测试（委派协作嫁接方案 §4.1/§5，2026-08-24）。
 *
 * 锁定 Proma 模式不变式：
 * - startDelegation fire-and-forget：立即返回 delegation_id，子 loop 后台独立跑（独立 sessionId）
 * - 深度限制：state.delegation_depth ≥ 1 拒绝（仅 1 层）
 * - 并行上限：每父 running 数 ≤ MAX_RUNNING_DELEGATIONS_PER_PARENT
 * - 幂等：同 (sessionId, toolCallId) 只 create 一次
 * - wait_for_delegations：all/any + timeout，超时不抛错返回当前状态
 * - role 裁剪：explore/research 只读，implement/review 全量，parent 含 delegate_agent
 */

function textMessage(text: string): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

/** 一轮完成（无 tool_use）的 query；子 loop 第一轮即 completed。 */
function oneShotQuery(finalText: string): SDKQuery {
  return async function* () {
    yield textMessage(finalText)
    yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
  }
}

/** 每轮都发 tool_use 的 query（配挂起工具让子 loop 停在 running，测并行上限/超时）。 */
function toolUseQuery(toolName: string): SDKQuery {
  return async function* () {
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `h-${toolName}`, name: toolName, input: {} }] } }
    yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
  }
}

let parentSessionId = 'session-parent'

function parentContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    projectId: 'project-parent',
    sessionId: parentSessionId,
    requestId: 'req-parent',
    signal: new AbortController().signal,
    state: createToolState(0),
    ...overrides,
  }
}

function registerParent(query: SDKQuery): void {
  registerParentLoopContext(parentSessionId, {
    query,
    env: {},
    maxTokens: 256,
    maxTurns: 6,
    delegationMaxTurns: 4,
    permissionMode: 'allow-all',
    temperature: 0.5,
    system: '父系统提示（PRD 背板锚定）',
    editFormat: 'diff',
    publish: () => undefined,
  })
}

describe('委派协作 M1', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-collab-'))
    // 每测试独立父 sessionId，避免并行上限等用例留下的 running 委派污染共享 registry
    parentSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
    // 默认子工具集 = 真实 buildAgentTools（role 裁剪）；个别用例覆盖
    setChildToolsBuilder((projectId, role, editFormat) => buildAgentTools({ projectId, role, editFormat }))
  })
  afterEach(() => {
    // 中止本测试遗留的 running 子循环（防挂起泄漏），再卸载上下文
    for (const record of listDelegations(parentSessionId)) {
      if (record.status === 'running') record.abort.abort()
    }
    unregisterParentLoopContext(parentSessionId)
    process.env.PROMA_HOME = originalPromaHome
  })

  it('startDelegation fire-and-forget：立即返回 delegation_id，子 loop 独立 session 跑完 → completed', async () => {
    registerParent(oneShotQuery('子任务完成，结果：xxx'))
    const created = startDelegation(parentContext(), {
      task: '检查 index.html 并报告',
      role: 'explore',
      expectedOutput: '文件清单 + 结论',
    })

    expect(created.delegation_id).toBeTruthy()
    expect(created.role).toBe('explore')
    expect(created.child_session_id).toBeTruthy()
    expect(created.child_session_id).not.toBe('session-parent') // 独立会话

    const record = findDelegation(parentSessionId,created.delegation_id)
    expect(record).toBeDefined()
    // fire-and-forget：先记录 running，子循环后台收敛
    expect(record!.status).toBe('running')

    await record!.completion
    const summary = getDelegationSummary(record!)
    expect(summary.status).toBe('completed')
    expect(summary.result_summary).toContain('子任务完成')
    expect(summary.result_summary).toContain('completed')
  })

  it('深度限制：父 agent 已是子会话（delegation_depth ≥ 1）→ 拒绝再派', () => {
    registerParent(oneShotQuery('ok'))
    const deepParent = parentContext({ state: createToolState(1) })
    expect(() => startDelegation(deepParent, { task: '再派一个' })).toThrow(/委派深度限制|不能继续创建/)
  })

  it('并行上限：running 数达 MAX_RUNNING_DELEGATIONS_PER_PARENT → 拒绝；完成后可再派', async () => {
    // 挂起工具让子 loop 停在 running
    const hang: AgentLoopTool = {
      name: 'hang',
      description: '挂起',
      input_schema: { type: 'object', properties: {} },
      execute: () => new Promise<never>(() => {}),
    }
    setChildToolsBuilder(() => [hang])
    registerParent(toolUseQuery('hang'))

    const ids: string[] = []
    for (let index = 0; index < MAX_RUNNING_DELEGATIONS_PER_PARENT; index += 1) {
      ids.push(startDelegation(parentContext(), { task: `并行 ${index}` }).delegation_id)
    }
    expect(() => startDelegation(parentContext(), { task: '超额' })).toThrow(/并行.*上限/)
    expect(ids).toHaveLength(MAX_RUNNING_DELEGATIONS_PER_PARENT)

    // 停止一个释放额度（stop 语义：abort 子循环）→ 可再派
    const first = findDelegation(parentSessionId,ids[0])!
    first.abort.abort()
  })

  it('幂等：同 (sessionId, toolCallId) 只 create 一次（tool-call 重放防御）', () => {
    let calls = 0
    const createFn = (): StartDelegationResult => {
      calls += 1
      return { delegation_id: 'd1', child_session_id: 'c1', role: 'custom', goal: 'g', status: 'running' }
    }
    const first = delegateAgentOnce('session-parent', 't1', createFn)
    const second = delegateAgentOnce('session-parent', 't1', createFn)
    const other = delegateAgentOnce('session-parent', 't2', createFn)

    expect(calls).toBe(2) // t1 幂等、t2 独立
    expect(second).toBe(first)
    expect(other).not.toBe(first)
  })

  it('wait_for_delegations：all 策略等全部收敛返回 completed 摘要', async () => {
    registerParent(oneShotQuery('子结果'))
    const a = startDelegation(parentContext(), { task: '任务 A' })
    const b = startDelegation(parentContext(), { task: '任务 B' })

    const summaries = await waitForDelegations(parentContext(), {
      delegationIds: [a.delegation_id, b.delegation_id],
      strategy: 'all',
    })
    expect(summaries).toHaveLength(2)
    expect(summaries.every((summary) => summary.status === 'completed')).toBe(true)
    expect(summaries.some((summary) => summary.result_summary?.includes('子结果'))).toBe(true)
  })

  it('wait_for_delegations：any 策略（任一完成即返回）；timeout 超时不抛错返回当前状态', async () => {
    const hang: AgentLoopTool = {
      name: 'hang',
      description: '挂起',
      input_schema: { type: 'object', properties: {} },
      execute: () => new Promise<never>(() => {}),
    }
    setChildToolsBuilder(() => [hang])
    registerParent(toolUseQuery('hang'))
    const slow = startDelegation(parentContext(), { task: '慢任务' })
    const fast = startDelegation(parentContext(), { task: '快任务' })

    // any + 极短超时：子 loop 停在 running → 返回当前状态而非抛错
    const timedOut = await waitForDelegations(parentContext(), {
      delegationIds: [slow.delegation_id, fast.delegation_id],
      strategy: 'any',
      timeout_ms: 1,
    })
    expect(timedOut.some((summary) => summary.status === 'running')).toBe(true)

    // 释放挂起循环
    findDelegation(parentSessionId,slow.delegation_id)!.abort.abort()
    findDelegation(parentSessionId,fast.delegation_id)!.abort.abort()
  })

  it('role 裁剪：explore/research 只读+ask；implement/review 全量+ask；parent 含全部委派工具', () => {
    const readOnly = ['read_file', 'list_files', 'grep', 'web_fetch', 'ask_delegation_question']
    expect(buildAgentTools({ projectId: 'p', role: 'explore' }).map((tool) => tool.name)).toEqual(readOnly)
    expect(buildAgentTools({ projectId: 'p', role: 'research' }).map((tool) => tool.name)).toEqual(readOnly)

    const full = ['read_file', 'list_files', 'grep', 'web_fetch', 'write_file', 'edit_file', 'run_preview', 'run_gwt_tests', 'run_security_scan']
    const implementTools = [...full, 'ask_delegation_question']
    expect(buildAgentTools({ projectId: 'p', role: 'implement' }).map((tool) => tool.name)).toEqual(implementTools)
    expect(buildAgentTools({ projectId: 'p', role: 'review' }).map((tool) => tool.name)).toEqual(implementTools)

    const parentTools = buildAgentTools({ projectId: 'p' }).map((tool) => tool.name)
    expect(parentTools).toEqual([
      ...full,
      'delegate_agent',
      'wait_for_delegations',
      'get_delegation_results',
      'stop_delegation',
      'stop_delegations',
      'answer_delegation_question',
      'continue_delegation',
    ])
    // 子 agent 无委派/代答/续跑工具（深度限制双保险）；parent 无 ask（父不是子会话）
    expect(implementTools).not.toContain('delegate_agent')
    expect(implementTools).not.toContain('answer_delegation_question')
    expect(implementTools).not.toContain('continue_delegation')
    expect(parentTools).not.toContain('ask_delegation_question')
  })

  it('提示词纯函数：buildChildSystemPrompt 保留父 system + role 指令；buildDelegationPrompt 含 task 与期望输出', () => {
    const childSystem = buildChildSystemPrompt('父系统提示（背板）', 'explore')
    expect(childSystem).toContain('父系统提示（背板）')
    expect(childSystem).toContain('role=explore')
    expect(childSystem).toContain('探索代码库')
    expect(childSystem).toContain('不能再委派其他子 agent')

    const prompt = buildDelegationPrompt({ role: 'implement', task: '创建 src/app.js', expectedOutput: '返回文件清单' })
    expect(prompt).toContain('创建 src/app.js')
    expect(prompt).toContain('期望输出：返回文件清单')
  })
})

describe('M2 委派工具（agent-tools 接线，委派协作嫁接方案 §4.2）', () => {
  const hang: AgentLoopTool = {
    name: 'hang',
    description: '挂起',
    input_schema: { type: 'object', properties: {} },
    execute: () => new Promise<never>(() => {}),
  }

  // M2 describe 独立于 M1，需自备隔离：每测试独立父 sessionId + 默认子工具构建器 + 清理
  beforeEach(() => {
    parentSessionId = `session-m2-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setChildToolsBuilder((projectId, role, editFormat) => buildAgentTools({ projectId, role, editFormat }))
  })
  afterEach(() => {
    for (const record of listDelegations(parentSessionId)) {
      if (record.status === 'running') record.abort.abort()
    }
    unregisterParentLoopContext(parentSessionId)
  })

  function parentTools(): Map<string, AgentLoopTool> {
    return new Map(
      buildAgentTools({ projectId: 'project-parent', role: 'parent' }).map((tool) => [tool.name, tool]),
    )
  }

  it('wait_for_delegations：阻塞等待子会话收敛 → completed 摘要（含子结果）', async () => {
    registerParent(oneShotQuery('子结果 M2'))
    startDelegation(parentContext(), { task: '任务', role: 'explore' })
    const outcome = await parentTools().get('wait_for_delegations')!.execute({}, parentContext())
    expect(outcome.isError).toBeUndefined()
    expect(outcome.output).toContain('status=completed')
    expect(outcome.output).toContain('子结果 M2')
    expect(outcome.detail).toHaveProperty('summaries')
  })

  it('wait_for_delegations：strategy=any + timeout_ms 超时不抛错返回当前状态', async () => {
    setChildToolsBuilder(() => [hang])
    registerParent(toolUseQuery('hang'))
    startDelegation(parentContext(), { task: '慢任务' })
    const outcome = await parentTools().get('wait_for_delegations')!.execute(
      { strategy: 'any', timeout_ms: 1 },
      parentContext(),
    )
    expect(outcome.isError).toBeUndefined()
    expect(outcome.output).toContain('status=running')
  })

  it('get_delegation_results：非阻塞读多个委派（running 与 completed 并存）', async () => {
    setChildToolsBuilder(() => [hang])
    registerParent(toolUseQuery('hang'))
    startDelegation(parentContext(), { task: '慢任务' })
    // 切回默认 builder 让快任务一轮完成
    setChildToolsBuilder((projectId, role, editFormat) => buildAgentTools({ projectId, role, editFormat }))
    const fast = startDelegation(parentContext(), { task: '快任务' })
    // StartDelegationResult 无 completion 字段：经 findDelegation 取 record 的 completion
    await findDelegation(parentSessionId, fast.delegation_id)!.completion

    const outcome = await parentTools().get('get_delegation_results')!.execute({}, parentContext())
    expect(outcome.output).toContain('status=running')
    expect(outcome.output).toContain('status=completed')
  })

  it('stop_delegation：中止 running 子会话 → cancelled，并解除 wait 阻塞（不等到超时）', async () => {
    setChildToolsBuilder(() => [hang])
    registerParent(toolUseQuery('hang'))
    const slow = startDelegation(parentContext(), { task: '慢任务' })

    const outcome = await parentTools().get('stop_delegation')!.execute(
      { delegation_id: slow.delegation_id },
      parentContext(),
    )
    expect(outcome.output).toContain('status=cancelled')
    expect(findDelegation(parentSessionId, slow.delegation_id)!.status).toBe('cancelled')

    // stop 已 resolve completion：wait 应立即返回 cancelled，而非等 timeout
    const waited = await waitForDelegations(parentContext(), {
      delegationIds: [slow.delegation_id],
      timeout_ms: 2000,
    })
    expect(waited[0]!.status).toBe('cancelled')
  })

  it('stop_delegations：缺省（无 delegation_ids）停止当前全部 running 委派', async () => {
    setChildToolsBuilder(() => [hang])
    registerParent(toolUseQuery('hang'))
    const a = startDelegation(parentContext(), { task: 'A' })
    const b = startDelegation(parentContext(), { task: 'B' })

    const outcome = await parentTools().get('stop_delegations')!.execute({}, parentContext())
    expect(outcome.output).toContain('已停止 2 个')
    expect(findDelegation(parentSessionId, a.delegation_id)!.status).toBe('cancelled')
    expect(findDelegation(parentSessionId, b.delegation_id)!.status).toBe('cancelled')
  })

  it('role 裁剪：parent 含全部委派工具；implement 子 agent 只含 ask 不含委派/代答/续跑', () => {
    const full = ['read_file', 'list_files', 'grep', 'web_fetch', 'write_file', 'edit_file', 'run_preview', 'run_gwt_tests', 'run_security_scan']
    const delegationTools = [
      'delegate_agent',
      'wait_for_delegations',
      'get_delegation_results',
      'stop_delegation',
      'stop_delegations',
      'answer_delegation_question',
      'continue_delegation',
    ]
    expect(buildAgentTools({ projectId: 'p' }).map((tool) => tool.name)).toEqual([...full, ...delegationTools])

    const implementNames = buildAgentTools({ projectId: 'p', role: 'implement' }).map((tool) => tool.name)
    expect(implementNames).toEqual([...full, 'ask_delegation_question'])
    for (const name of delegationTools) expect(implementNames).not.toContain(name)
    expect(implementNames).toContain('ask_delegation_question')
  })
})

describe('M3 提问冒泡 / 续跑（委派协作嫁接方案 §6）', () => {
  const hang: AgentLoopTool = {
    name: 'hang',
    description: '挂起',
    input_schema: { type: 'object', properties: {} },
    execute: () => new Promise<never>(() => {}),
  }

  // M3 describe 独立隔离（同 M2）：每测试独立父 sessionId + 默认子工具构建器 + 清理
  beforeEach(() => {
    parentSessionId = `session-m3-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setChildToolsBuilder((projectId, role, editFormat) => buildAgentTools({ projectId, role, editFormat }))
  })
  afterEach(() => {
    for (const record of listDelegations(parentSessionId)) {
      if (record.status === 'running') record.abort.abort()
    }
    unregisterParentLoopContext(parentSessionId)
  })

  /**
   * 有状态的 ask 模拟：runAgentLoop 每轮重新调用 query()。
   * 第一次 yield ask_delegation_question（挂起等父答），拿到回答后的后续轮次正常收尾。
   */
  function askQuery(question: string): SDKQuery {
    let asked = false
    return async function* () {
      if (!asked) {
        asked = true
        yield {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'ask-1', name: 'ask_delegation_question', input: { question } }],
          },
        }
        yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
        return
      }
      yield textMessage('收到回答，继续并完成')
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
  }

  function parentTools(): Map<string, AgentLoopTool> {
    return new Map(
      buildAgentTools({ projectId: 'project-parent', role: 'parent' }).map((tool) => [tool.name, tool]),
    )
  }

  it('冒泡链路：子 agent ask 挂起 → wait 提前返回 pending_question → 父 answer → 子 loop 拿到回答完成', async () => {
    registerParent(askQuery('是否允许重命名 index.html？'))
    const created = startDelegation(parentContext(), { task: '审查文件命名', role: 'implement' })

    // wait 不干等 timeout：子 agent 提问（askSignal resolve）时提前返回
    const waited = await waitForDelegations(parentContext(), {
      delegationIds: [created.delegation_id],
      timeout_ms: 2000,
    })
    expect(waited[0]!.status).toBe('running')
    expect(waited[0]!.pending_question).toBe('是否允许重命名 index.html？')

    // 父代答 → 答案回传子 loop 挂起点，子 agent 继续并完成
    answerDelegationQuestion(parentSessionId, created.delegation_id, '可以，保留旧文件备份')
    await findDelegation(parentSessionId, created.delegation_id)!.completion
    const summary = getDelegationSummary(findDelegation(parentSessionId, created.delegation_id)!)
    expect(summary.status).toBe('completed')
    // 子 loop 走到第二轮收尾：证明 ask 挂起被 answer 解除（否则永远卡第一轮）。
    // ask 的回答作为 tool_result 进子会话消息历史（JSONL），不在 finalText 里。
    expect(summary.result_summary).toContain('子代理状态：completed（2 轮')
    expect(summary.result_summary).toContain('收到回答')
  })

  it('父侧 answer 工具接线：answer_delegation_question 回传回答并解除子挂起', async () => {
    registerParent(askQuery('测试用例放哪个目录？'))
    const created = startDelegation(parentContext(), { task: '写测试', role: 'implement' })
    await waitForDelegations(parentContext(), { delegationIds: [created.delegation_id], timeout_ms: 2000 })

    const outcome = await parentTools().get('answer_delegation_question')!.execute(
      { delegation_id: created.delegation_id, answer: 'tests/unit' },
      parentContext(),
    )
    expect(outcome.isError).toBeUndefined()
    expect(outcome.output).toContain('已回答委派')

    await findDelegation(parentSessionId, created.delegation_id)!.completion
    expect(findDelegation(parentSessionId, created.delegation_id)!.status).toBe('completed')
  })

  it('ask 只在委派子会话可用：parent/主 loop（delegation_depth=0）拒绝', async () => {
    const askTool = buildAgentTools({ projectId: 'p', role: 'implement' }).find(
      (tool) => tool.name === 'ask_delegation_question',
    )!
    const outcome = await askTool.execute({ question: '任何问题' }, parentContext())
    expect(outcome.isError).toBe(true)
    expect(outcome.output).toContain('只在委派子会话')
  })

  it('continue 协调层：已终结委派续跑复用 childSessionId；running 拒绝', async () => {
    setChildToolsBuilder(() => [hang])
    registerParent(toolUseQuery('hang'))
    const slow = startDelegation(parentContext(), { task: '慢任务' })
    expect(() => continueDelegation(parentContext(), slow.delegation_id, '续跑')).toThrow(/仍在运行/)

    // 释放慢任务，改为正常委派测续跑
    findDelegation(parentSessionId, slow.delegation_id)!.abort.abort()
    setChildToolsBuilder((projectId, role, editFormat) => buildAgentTools({ projectId, role, editFormat }))
    registerParent(oneShotQuery('初稿完成'))
    const done = startDelegation(parentContext(), { task: '写初稿', role: 'implement' })
    await findDelegation(parentSessionId, done.delegation_id)!.completion
    expect(findDelegation(parentSessionId, done.delegation_id)!.status).toBe('completed')

    const continued = continueDelegation(parentContext(), done.delegation_id, '基于初稿补充测试')
    expect(continued.delegation_id).toBe(done.delegation_id)
    expect(continued.child_session_id).toBe(done.child_session_id) // 复用同一子会话（JSONL 追加）
    expect(continued.status).toBe('running')

    await findDelegation(parentSessionId, done.delegation_id)!.completion
    const summary = getDelegationSummary(findDelegation(parentSessionId, done.delegation_id)!)
    expect(summary.status).toBe('completed')
    expect(summary.result_summary).toContain('初稿完成')
  })

  it('continue 工具接线：已终结委派经 continue_delegation 工具续跑', async () => {
    registerParent(oneShotQuery('初版完成'))
    const created = startDelegation(parentContext(), { task: '初版', role: 'review' })
    await findDelegation(parentSessionId, created.delegation_id)!.completion

    const outcome = await parentTools().get('continue_delegation')!.execute(
      { delegation_id: created.delegation_id, task: '按新要求再查一遍安全点' },
      parentContext(),
    )
    expect(outcome.isError).toBeUndefined()
    expect(outcome.output).toContain('已继续委派')
    expect(outcome.output).toContain(`child_session=${created.child_session_id}`)

    await findDelegation(parentSessionId, created.delegation_id)!.completion
    expect(findDelegation(parentSessionId, created.delegation_id)!.status).toBe('completed')
  })
})

describe('M4-C 委派生命周期事件（delegation_started/completed/failed/cancelled 发布）', () => {
  const hang: AgentLoopTool = {
    name: 'hang',
    description: '挂起',
    input_schema: { type: 'object', properties: {} },
    execute: () => new Promise<never>(() => {}),
  }
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-collab-evt-'))
    parentSessionId = `session-evt-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setChildToolsBuilder((projectId, role, editFormat) => buildAgentTools({ projectId, role, editFormat }))
  })
  afterEach(() => {
    for (const record of listDelegations(parentSessionId)) {
      if (record.status === 'running') record.abort.abort()
    }
    unregisterParentLoopContext(parentSessionId)
    process.env.PROMA_HOME = originalPromaHome
  })

  function registerParentCapturing(query: SDKQuery): Array<{ type: string; payload: Record<string, unknown> }> {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    registerParentLoopContext(parentSessionId, {
      query,
      env: {},
      maxTokens: 256,
      maxTurns: 6,
      delegationMaxTurns: 4,
      permissionMode: 'allow-all',
      temperature: 0.5,
      system: '父系统提示（背板）',
      editFormat: 'diff',
      publish: (type, payload) => events.push({ type, payload }),
    })
    return events
  }

  it('start → completed：生命周期事件发到父 session，payload 含 id/child_session/role/goal/status', async () => {
    const events = registerParentCapturing(oneShotQuery('子任务完成'))
    const created = startDelegation(parentContext(), { task: '检查 index.html', role: 'explore' })
    await findDelegation(parentSessionId, created.delegation_id)!.completion

    const started = events.find((event) => event.type === 'delegation_started')
    expect(started).toBeTruthy()
    expect(started!.payload).toMatchObject({
      delegation_id: created.delegation_id,
      child_session_id: created.child_session_id,
      role: 'explore',
      status: 'running',
    })
    expect(started!.payload.goal).toBe('检查 index.html')

    const completed = events.find((event) => event.type === 'delegation_completed')
    expect(completed).toBeTruthy()
    expect(completed!.payload).toMatchObject({
      delegation_id: created.delegation_id,
      child_session_id: created.child_session_id,
      status: 'completed',
    })
  })

  it('stop_delegation → delegation_cancelled；子循环失败 → delegation_failed', async () => {
    setChildToolsBuilder(() => [hang])
    const events = registerParentCapturing(toolUseQuery('hang'))
    const created = startDelegation(parentContext(), { task: '慢任务' })
    stopDelegation(parentSessionId, created.delegation_id)

    const cancelled = events.find((event) => event.type === 'delegation_cancelled')
    expect(cancelled).toBeTruthy()
    expect(cancelled!.payload.delegation_id).toBe(created.delegation_id)
    expect(cancelled!.payload.status).toBe('cancelled')
  })

  it('continue_delegation：复用同一 child_session_id 并重发 delegation_started', async () => {
    const events = registerParentCapturing(oneShotQuery('初稿完成'))
    const created = startDelegation(parentContext(), { task: '写初稿', role: 'implement' })
    await findDelegation(parentSessionId, created.delegation_id)!.completion

    const continued = continueDelegation(parentContext(), created.delegation_id, '补充测试')
    expect(continued.child_session_id).toBe(created.child_session_id)

    const startedEvents = events.filter((event) => event.type === 'delegation_started')
    expect(startedEvents).toHaveLength(2)
    // 续跑复用同一 child_session_id（JSONL 追加）；goal 跟随本次续跑任务（审计 P2-6 修复：
    // 事件与渲染端不再显示旧 goal）
    expect(startedEvents[1]!.payload.child_session_id).toBe(created.child_session_id)
    expect(startedEvents[1]!.payload.goal).toBe('补充测试')
  })

  it('ask 提问 → delegation_question 事件（question 原样）；父答后子 loop 完成', async () => {
    let asked = false
    const askQuery: SDKQuery = async function* () {
      if (!asked) {
        asked = true
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'ask-1', name: 'ask_delegation_question', input: { question: '目录用哪个？' } }] },
        }
        yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
        return
      }
      yield textMessage('收到回答，收尾完成')
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
    const events = registerParentCapturing(askQuery)
    const created = startDelegation(parentContext(), { task: '写测试', role: 'implement' })

    // 等子 agent 挂起提问（wait 提前返回），再代答
    await waitForDelegations(parentContext(), { delegationIds: [created.delegation_id], timeout_ms: 2000 })
    const questionEvent = events.find((event) => event.type === 'delegation_question')
    expect(questionEvent).toBeTruthy()
    expect(questionEvent!.payload).toMatchObject({
      delegation_id: created.delegation_id,
      question: '目录用哪个？',
    })

    answerDelegationQuestion(parentSessionId, created.delegation_id, 'tests/unit')
    await findDelegation(parentSessionId, created.delegation_id)!.completion
    const completed = events.find((event) => event.type === 'delegation_completed')
    expect(completed?.payload.status).toBe('completed')
  })
})

describe('审计修复回归（审计报告 2026-08-25：P1-1/P1-2/P2-4/P2-5/P2-6/P3-7）', () => {
  const hang: AgentLoopTool = {
    name: 'hang',
    description: '挂起',
    input_schema: { type: 'object', properties: {} },
    execute: () => new Promise<never>(() => {}),
  }

  /** 协调层直连版 ask 工具：不经 buildAgentTools，便于与 hang 组合裁剪。 */
  const askTool: AgentLoopTool = {
    name: 'ask_delegation_question',
    description: '向主 agent 提问',
    input_schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    execute: async (input, ctx) => ({
      output: `主 agent 回答：${await askDelegationQuestion(ctx, String(input.question ?? ''))}`,
    }),
  }

  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-collab-fix-'))
    parentSessionId = `session-fix-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setChildToolsBuilder((projectId, role, editFormat) => buildAgentTools({ projectId, role, editFormat }))
  })
  afterEach(() => {
    for (const record of listDelegations(parentSessionId)) {
      if (record.status === 'running') record.abort.abort()
    }
    unregisterParentLoopContext(parentSessionId)
    process.env.PROMA_HOME = originalPromaHome
  })

  it('P1-1：answer 后再次 wait 不因旧 askSignal 假提前返回（等满 timeout 而非立即返回）', async () => {
    // 子 loop：第一轮 ask 挂起；answer 后第二轮调 hang（保持 running）
    let asked = false
    const query: SDKQuery = async function* () {
      if (!asked) {
        asked = true
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'ask-1', name: 'ask_delegation_question', input: { question: '允许重命名吗？' } }] },
        }
        yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
        return
      }
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'hang-1', name: 'hang', input: {} }] } }
      yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
    }
    setChildToolsBuilder(() => [askTool, hang])
    registerParent(query)
    const created = startDelegation(parentContext(), { task: '任务', role: 'implement' })

    // 第一次 wait：ask 挂起时经 askSignal 提前返回 pending_question
    const first = await waitForDelegations(parentContext(), { delegationIds: [created.delegation_id], timeout_ms: 2000 })
    expect(first[0]!.pending_question).toBe('允许重命名吗？')

    answerDelegationQuestion(parentSessionId, created.delegation_id, '可以')

    // 第二次 wait：askSignal 已重建（未 resolve），子 agent 挂在 hang → 只能等满 timeout。
    // 若沿用旧 resolved signal，此处立即假提前返回（耗时 ~0），标准流程「answer 后再 wait」即触发。
    const start = Date.now()
    const second = await waitForDelegations(parentContext(), { delegationIds: [created.delegation_id], timeout_ms: 300 })
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(250)
    expect(second[0]!.status).toBe('running')
    expect(second[0]!.pending_question).toBeUndefined()
  })

  it('P2-5：continue 复用并行上限门禁——running 数已达上限时拒绝续跑', async () => {
    registerParent(oneShotQuery('初稿完成'))
    const done = startDelegation(parentContext(), { task: '初稿' })
    await findDelegation(parentSessionId, done.delegation_id)!.completion

    setChildToolsBuilder(() => [hang])
    registerParent(toolUseQuery('hang')) // 覆盖注册：后续子 loop 挂在 running
    for (let index = 0; index < MAX_RUNNING_DELEGATIONS_PER_PARENT; index += 1) {
      startDelegation(parentContext(), { task: `并行 ${index}` })
    }
    expect(() => continueDelegation(parentContext(), done.delegation_id, '续跑任务')).toThrow(/并行.*上限/)
  })

  it('P2-6：continue 更新 goal/startedAt——摘要与事件不再显示旧任务', async () => {
    registerParent(oneShotQuery('初稿完成'))
    const done = startDelegation(parentContext(), { task: '旧任务目标' })
    await findDelegation(parentSessionId, done.delegation_id)!.completion
    const oldStartedAt = findDelegation(parentSessionId, done.delegation_id)!.startedAt

    const continued = continueDelegation(parentContext(), done.delegation_id, '新任务目标')
    expect(continued.goal).toBe('新任务目标')

    const record = findDelegation(parentSessionId, done.delegation_id)!
    expect(record.goal).toBe('新任务目标')
    expect(record.startedAt).toBeGreaterThanOrEqual(oldStartedAt)
  })

  it('P3-7：toolCallId 缺失不走幂等缓存——两次调用各自 create，不共享结果', () => {
    let calls = 0
    const createFn = (): StartDelegationResult => {
      calls += 1
      return { delegation_id: `d-${calls}`, child_session_id: `c-${calls}`, role: 'custom', goal: 'g', status: 'running' }
    }
    const first = delegateAgentOnce(parentSessionId, undefined, createFn)
    const second = delegateAgentOnce(parentSessionId, undefined, createFn)
    expect(calls).toBe(2)
    expect(second.delegation_id).not.toBe(first.delegation_id)
  })

  it('P1-2/P2-4：disposeParentDelegationState——stop running 子委派 + 清幂等缓存 + 注销父上下文', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    registerParentLoopContext(parentSessionId, {
      query: toolUseQuery('hang'),
      env: {},
      maxTokens: 256,
      maxTurns: 6,
      delegationMaxTurns: 4,
      permissionMode: 'allow-all',
      temperature: 0.5,
      system: 's',
      editFormat: 'diff',
      publish: (type, payload) => events.push({ type, payload }),
    })
    setChildToolsBuilder(() => [hang])
    const created = startDelegation(parentContext(), { task: '慢任务' })
    delegateAgentOnce(parentSessionId, 'tool-1', () => ({
      delegation_id: 'd-x',
      child_session_id: 'c-x',
      role: 'custom',
      goal: 'g',
      status: 'running',
    }))

    disposeParentDelegationState(parentSessionId)

    // ① running 子委派被停止 → cancelled；cancelled 事件在注销前发出（顺序：stop 先于 unregister）
    expect(findDelegation(parentSessionId, created.delegation_id)!.status).toBe('cancelled')
    expect(
      events.some((event) => event.type === 'delegation_cancelled' && event.payload.delegation_id === created.delegation_id),
    ).toBe(true)
    // ② 幂等缓存被清空：同 key 再调用会重新 create
    let calls = 0
    delegateAgentOnce(parentSessionId, 'tool-1', () => {
      calls += 1
      return { delegation_id: 'd-y', child_session_id: 'c-y', role: 'custom', goal: 'g', status: 'running' }
    })
    expect(calls).toBe(1)
    // ③ 父上下文已注销：再派新委派被拒
    expect(() => startDelegation(parentContext(), { task: '新任务' })).toThrow(/未找到父循环上下文/)
  })
})
