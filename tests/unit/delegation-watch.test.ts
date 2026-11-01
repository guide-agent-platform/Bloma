import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKQuery } from '../../main/orchestration/orchestrator'
import { createToolState, type AgentLoopTool, type ToolContext } from '../../main/agent/loop/agent-loop'
import { drainSteerQueue, markLoopActive, markLoopInactive } from '../../main/agent/loop/steer-queue'
import {
  findDelegation,
  registerParentLoopContext,
  setChildToolsBuilder,
  startDelegation,
  stopDelegations,
  settleParentDelegationRuns,
  unregisterParentLoopContext,
} from '../../main/agent/delegation/agent-collaboration'
import {
  scanDelegationsForWatch,
  setDelegationHardTimeoutObserver,
  setDelegationWatchThresholdsForTests,
  stopDelegationWatchForTests,
  type DelegationHardTimeoutInfo,
} from '../../main/agent/delegation/delegation-watch'

/**
 * C4 委派观察哨单测（协作机制改造清单批次 2，2026-09-24）。
 *
 * 锁定：
 * - ask 挂起（pendingQuestion）期间时钟重置——挂起不计费，恢复后重新计时
 * - 软超时：经 steer 队列注入催办（父有活跃 loop）且只催一次；父无活跃 loop 降级 console.warn
 * - 硬超时：stopDelegation 强停（cancelled）+ 观察者回调（含有效时长与渠道）
 * - 终态委派的观察状态惰性清理
 * - 集成腿：开关 on + 真实定时器，阈值 seam 缩短后软注入与硬强停真实发生
 */

/** 挂起工具：execute 永不 resolve（但响应 abort——withAbort 包装 reject），子 loop 停在工具执行性 running。 */
let toolEntered=false
function hangTool(): AgentLoopTool {
  return {
    name: 'hang_tool',
    description: '测试用挂起工具',
    input_schema: { type: 'object', properties: {} },
    execute: () => {toolEntered=true;return new Promise<{ output: string }>(() => undefined)},
  }
}

/** 每轮都发 tool_use 的 query：配挂起工具让子 loop 停在 running（abort 可收尾）。 */
function toolUseQuery(): SDKQuery {
  return async function* () {
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'h1', name: 'hang_tool', input: {} }] } }
    yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
  }
}

let parentSessionId = 'session-watch'

function parentContext(): ToolContext {
  return {
    projectId: 'project-watch',
    sessionId: parentSessionId,
    requestId: 'req-watch',
    signal: new AbortController().signal,
    state: createToolState(0),
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
    system: '父系统提示',
    editFormat: 'diff',
    publish: () => undefined,
  })
}

async function settleChildLoops(): Promise<void> {
  await settleParentDelegationRuns(parentSessionId)
}

describe('C4 委派观察哨（纯逻辑扫描）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const SOFT = 8 * 60_000
  const HARD = 12 * 60_000

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-watch-'))
    parentSessionId = `session-watch-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setChildToolsBuilder(() => [hangTool()])
    registerParent(toolUseQuery())
    setDelegationWatchThresholdsForTests()
    setDelegationHardTimeoutObserver(null)
    markLoopActive(parentSessionId)
  })
  afterEach(async () => {
    // 同步置终态（stopDelegations 立即改 status+abort+resolve），再等收尾链落定——
    // 杜绝 running 委派泄漏到后续用例的扫描（JSONL 异步收尾仍在写，PROMA_HOME 未变）
    stopDelegations(parentSessionId)
    await settleChildLoops()
    unregisterParentLoopContext(parentSessionId)
    markLoopInactive(parentSessionId)
    stopDelegationWatchForTests()
    setDelegationWatchThresholdsForTests()
    setDelegationHardTimeoutObserver(null)
    if (originalPromaHome === undefined) delete process.env.PROMA_HOME
    else process.env.PROMA_HOME = originalPromaHome
  })

  it('ask 挂起期间时钟重置：挂起中扫描不触发软/硬；恢复后从挂起点重新计时', () => {
    const created = startDelegation(parentContext(), { task: '挂起观察', role: 'research' })
    const record = findDelegation(parentSessionId, created.delegation_id)!
    const t0 = record.startedAt

    record.pendingQuestion = '子代理提问：需要补充什么？'
    scanDelegationsForWatch(t0 + HARD + 60_000) // 挂起中即使远超硬超时也不动作
    expect(record.status).toBe('running')
    expect(drainSteerQueue(parentSessionId)).toHaveLength(0)

    const resumedAt = t0 + HARD + 60_000
    record.pendingQuestion = undefined
    scanDelegationsForWatch(resumedAt + SOFT - 1_000) // 恢复后未到软超时
    expect(drainSteerQueue(parentSessionId)).toHaveLength(0)
    scanDelegationsForWatch(resumedAt + SOFT + 1_000) // 到软超时才催
    const entries = drainSteerQueue(parentSessionId)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.content).toContain('stop_delegation')
    expect(record.status).toBe('running')
  })

  it('软超时催办只发一次；父无活跃 loop 时降级 console.warn', () => {
    markLoopInactive(parentSessionId) // 先测无 loop 降级路径
    const created = startDelegation(parentContext(), { task: '无 loop 父', role: 'explore' })
    const record = findDelegation(parentSessionId, created.delegation_id)!
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    scanDelegationsForWatch(record.startedAt + SOFT + 1)
    scanDelegationsForWatch(record.startedAt + SOFT + 2) // 第二次不再催
    expect(drainSteerQueue(parentSessionId)).toHaveLength(0) // 无活跃 loop → 无注入
    const softWarns = warnSpy.mock.calls.map((args) => String(args[0])).filter((text) => text.includes('软超时'))
    expect(softWarns).toHaveLength(1)
    warnSpy.mockRestore()

    markLoopActive(parentSessionId)
    // 重新走一轮：新委派 + 活跃 loop → steer 注入成功
    const second = startDelegation(parentContext(), { task: '有 loop 父', role: 'explore' })
    const secondRecord = findDelegation(parentSessionId, second.delegation_id)!
    scanDelegationsForWatch(secondRecord.startedAt + SOFT + 1)
    const entries = drainSteerQueue(parentSessionId)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.content).toContain('委派')
    expect(entries[0]!.queueMessageId).toBe(`delegation-watch-${second.delegation_id}`)
  })

  it('硬超时：强停（cancelled）+ 观察者回调（有效时长/渠道/goal）', () => {
    const observed: DelegationHardTimeoutInfo[] = []
    setDelegationHardTimeoutObserver((info) => observed.push(info))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const created = startDelegation(parentContext(), { task: '硬超时观察', role: 'research' })
    const record = findDelegation(parentSessionId, created.delegation_id)!
    scanDelegationsForWatch(record.startedAt + HARD + 1)

    expect(record.status).toBe('cancelled')
    expect(observed).toHaveLength(1)
    expect(observed[0]!.delegationId).toBe(created.delegation_id)
    expect(observed[0]!.effectiveMs).toBeGreaterThanOrEqual(HARD)
    expect(observed[0]!.goal).toContain('硬超时观察')
    warnSpy.mockRestore()
  })

  it('终态委派的观察状态惰性清理（扫描不抛错、Map 收缩）', async () => {
    const created = startDelegation(parentContext(), { task: '清理观察', role: 'research' })
    const record = findDelegation(parentSessionId, created.delegation_id)!
    scanDelegationsForWatch(record.startedAt + 1_000) // 建立状态
    record.abort.abort()
    await settleChildLoops()
    scanDelegationsForWatch(record.startedAt + 2_000) // 终态后扫描 → 清理路径
    expect(record.status).not.toBe('running')
  })
})

describe('C4 委派观察哨（真实定时器集成）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalWatch = process.env.BLOMA_DELEGATION_WATCH

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-watch-int-'))
    toolEntered=false
    process.env.BLOMA_DELEGATION_WATCH = '1'
    parentSessionId = `session-watch-int-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setChildToolsBuilder(() => [hangTool()])
    registerParent(toolUseQuery())
    // Pi initialization is not the hung tool being measured. Start scanning
    // with production deadlines, then arm the short thresholds at tool entry.
    setDelegationWatchThresholdsForTests({ scanIntervalMs: 40 })
    markLoopActive(parentSessionId)
  })
  afterEach(async () => {
    stopDelegations(parentSessionId)
    await settleChildLoops()
    unregisterParentLoopContext(parentSessionId)
    markLoopInactive(parentSessionId)
    stopDelegationWatchForTests()
    setDelegationWatchThresholdsForTests()
    if (originalWatch === undefined) delete process.env.BLOMA_DELEGATION_WATCH
    else process.env.BLOMA_DELEGATION_WATCH = originalWatch
    if (originalPromaHome === undefined) delete process.env.PROMA_HOME
    else process.env.PROMA_HOME = originalPromaHome
  })

  it('开关 on + 真实定时器：软催办经 steer 到达，硬超时自动强停', async () => {
    const created = startDelegation(parentContext(), { task: '集成观察', role: 'research' })
    const record = findDelegation(parentSessionId, created.delegation_id)!
    expect(record.status).toBe('running')

    await vi.waitFor(()=>expect(toolEntered).toBe(true),{timeout:10000,interval:10})
    scanDelegationsForWatch(Date.now())
    setDelegationWatchThresholdsForTests({scanIntervalMs:40,softMs:150,hardMs:400})

    // 软超时（~150ms + 扫描间隔 40ms）
    await new Promise((resolve) => setTimeout(resolve, 320))
    const entries = drainSteerQueue(parentSessionId)
    expect(entries.length).toBeGreaterThanOrEqual(1)
    expect(entries[0]!.content).toContain('委派')

    // 硬超时（~400ms + 扫描间隔）
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(record.status).toBe('cancelled')
  })

  it('活动感知（2026-10-06 狗粮挂死实锤后回归锁）：子会话 JSONL 还在增长 → 不强停；停止增长 → 硬超时强停', async () => {
    const { appendFileSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { getAgentSessionPath } = await import('../../storage/config-paths')
    const created = startDelegation(parentContext(), { task: '长任务活动感知', role: 'research' })
    const record = findDelegation(parentSessionId, created.delegation_id)!
    await vi.waitFor(()=>expect(toolEntered).toBe(true),{timeout:10000,interval:10})
    scanDelegationsForWatch(Date.now())
    setDelegationWatchThresholdsForTests({scanIntervalMs:40,softMs:150,hardMs:400})
    const childPath = getAgentSessionPath(created.child_session_id)
    mkdirSync(require('node:path').dirname(childPath), { recursive: true })
    writeFileSync(childPath, '', 'utf8')

    // 持续写入子会话（模拟正常工作）：跨过软硬阈值也不应强停
    for (let tick = 0; tick < 8; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 110))
      appendFileSync(childPath, `{"role":"assistant","content":[{"type":"text","text":"tick ${tick}"}]}\n`, 'utf8')
    }
    expect(record.status).toBe('running') // ~0.9s 活跃期 > hardMs 400ms，仍在跑

    // 停止写入（模拟渠道挂死）：硬超时后强停（最后一次活动起算 400ms + 扫描间隔）
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(record.status).toBe('cancelled')
  })
})
