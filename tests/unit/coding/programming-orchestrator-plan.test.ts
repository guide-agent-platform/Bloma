import { restorePromaHome } from '../../support/proma-home-guard'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMvpTask, setProgrammingEventPublisher } from '../../../main/programming-orchestrator'
import { createProject, recordSketchGenerated } from '../../../main/project-service'
import { createChannel } from '../../../main/channel-manager'
import { setSafeStorageAdapter } from '../../../main/safe-storage'
import { clearSandboxRuntimeForTests, setSandboxRuntimeForTests } from '../../../main/platform-services'
import { getAgentSessionPath, getDocumentsDir } from '../../../storage/config-paths'
import { renderPlanInjection, type LoopPlan } from '../../../main/coding/loop-planner'
import type { SDKQuery, SDKQueryOptions } from '../../../main/orchestrator'

/**
 * P3 任务级三文档契约 · PR-A 接线（runMvpViaAgentLoop plan 腿）。
 *
 * 关键锁定（实施稿 §6 PR-A）：
 * - fail-open：plan 生成失败 → 注入字节级=现状 + plan_fallback 决策；
 * - 成功路径：system 尾部拼接合同段（base + '\n\n' + injection）+ plan.md 落盘 +
 *   plan_generated 决策；
 * - 开关：quick 缺省不起腿（generateLoopPlan 零调用）、longterm 缺省起腿、
 *   BLOMA_PLAN_LEG=0 强制关。
 *
 * mock 面：runAgentLoop（脚本化 completed）+ generateLoopPlan（按场景 null/plan）。
 * writePlanDocument / 决策日志真实落盘（临时 PROMA_HOME），断言裸关键词（陷阱 33）。
 */

const mocks = vi.hoisted(() => ({
  runAgentLoop: vi.fn(),
  generateLoopPlan: vi.fn(),
}))

vi.mock('../../../main/coding/agent-loop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/coding/agent-loop')>()
  return { ...actual, runAgentLoop: mocks.runAgentLoop }
})

// 编排器经 main/agent-loop.ts 原位桩 re-export 导入（R4 迁移手法），桩路径与真实路径
// 需分别登记同一 mock（delegation-failure 同款）；两个登记指向同一个 mock fn。
vi.mock('../../../main/agent-loop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/agent-loop')>()
  return { ...actual, runAgentLoop: mocks.runAgentLoop }
})

vi.mock('../../../main/coding/loop-planner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/coding/loop-planner')>()
  return { ...actual, generateLoopPlan: mocks.generateLoopPlan }
})

/** 语义侧 LLM 全部抛错（resolvePrdBackplane/autoName 走确定性回退，与修复测试同款）。 */
function junkQuery(): SDKQuery {
  return async function* (_prompt: string, _options: SDKQueryOptions) {
    throw new Error('LLM_FAILED (plan wiring junk query)')
  }
}

const SAMPLE_PLAN: LoopPlan = {
  filesToTouch: [
    { path: 'index.html', reason: '入口与布局' },
    { path: 'src/app.js', reason: '交互逻辑主体' },
  ],
  reuse: [{ from: 'src/styles.css（骨架）', how: '样式直接扩展不重写' }],
  verification: ['F-001 记录收入与支出：核心路径可交互'],
  risks: [],
  involvedRequirementIds: ['F-001'],
}

function loopCompleted() {
  return {
    status: 'completed' as const,
    turns: 3,
    finalText: '已生成',
    toolCalls: [{ name: 'write_file', turn: 1 }],
  }
}

describe('runMvpViaAgentLoop × plan 腿（P3 PR-A 接线）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalPlanLeg = process.env.BLOMA_PLAN_LEG
  let home = ''
  let channelId = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'proma-plan-'))
    process.env.PROMA_HOME = home
    delete process.env.BLOMA_PLAN_LEG
    mocks.runAgentLoop.mockReset()
    mocks.runAgentLoop.mockResolvedValue(loopCompleted())
    mocks.generateLoopPlan.mockReset()
    setProgrammingEventPublisher(() => undefined)
    setSandboxRuntimeForTests({
      portAllocator: async () => 4321,
      healthCheck: async () => true,
      processFactory: () => ({ stdout: { on: () => undefined }, stderr: { on: () => undefined }, once: () => undefined, kill: () => true }) as unknown as ChildProcess,
    })
    setSafeStorageAdapter({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
    })
    const channel = createChannel({
      name: 'plan-test',
      provider_type: 'anthropic',
      base_url: 'https://test.invalid',
      api_key: 'test-key',
      models: [{ id: 'm1', name: 'test-model', enabled: true, supports_tools: true }],
    })
    channelId = channel.id
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    if (originalPlanLeg === undefined) delete process.env.BLOMA_PLAN_LEG
    else process.env.BLOMA_PLAN_LEG = originalPlanLeg
    setProgrammingEventPublisher(() => undefined)
    clearSandboxRuntimeForTests()
  })

  /** 一次完整 runMvpTask：返回捕获的 loop system 与会话决策行。 */
  async function runOnce(mode: 'quick' | 'longterm', requirements: Array<{ id: string; description: string }>) {
    const project = createProject({ request_id: `req-${Math.random().toString(36).slice(2, 8)}`, mode })
    recordSketchGenerated(project.project_id, requirements)
    writeFileSync(join(project.root_path, 'index.html'), '<html><body><p>记录收入与支出</p></body></html>', 'utf8')
    const sessionId = `s-plan-${Math.random().toString(36).slice(2, 8)}`
    await runMvpTask({
      request_id: `req-${Math.random().toString(36).slice(2, 8)}`,
      session_id: sessionId,
      project_id: project.project_id,
      mode,
      channel_id: channelId,
      query: junkQuery(),
    })
    const system = mocks.runAgentLoop.mock.calls[mocks.runAgentLoop.mock.calls.length - 1][0].system as string
    const sessionPath = getAgentSessionPath(sessionId)
    const decisions = existsSync(sessionPath) ? readFileSync(sessionPath, 'utf8') : ''
    return { projectId: project.project_id, workspaceSlug: project.workspace_slug, system, decisions }
  }

  const REQUIREMENTS = [{ id: 'F-001', description: '记录收入与支出' }]

  it('fail-open 回退注入字节级=现状：开关关 / quick 缺省 / longterm+null 三者 system 完全一致', { timeout: 60_000 }, async () => {
    // ① BLOMA_PLAN_LEG=0（强制关）
    process.env.BLOMA_PLAN_LEG = '0'
    mocks.generateLoopPlan.mockResolvedValue(SAMPLE_PLAN) // 即便会返回 plan 也不得起腿
    const forcedOff = await runOnce('longterm', REQUIREMENTS)
    expect(mocks.generateLoopPlan).not.toHaveBeenCalled()

    // ② quick 缺省 off（D7）
    delete process.env.BLOMA_PLAN_LEG
    mocks.generateLoopPlan.mockClear()
    mocks.generateLoopPlan.mockResolvedValue(SAMPLE_PLAN)
    const quickDefault = await runOnce('quick', REQUIREMENTS)
    expect(mocks.generateLoopPlan).not.toHaveBeenCalled()

    // ③ longterm 缺省 on，但 plan 腿失败返回 null（fail-open）
    mocks.generateLoopPlan.mockClear()
    mocks.generateLoopPlan.mockResolvedValue(null)
    const fallback = await runOnce('longterm', REQUIREMENTS)
    expect(mocks.generateLoopPlan).toHaveBeenCalledTimes(1)

    // 字节级等价锁（注入=现状，零拼接零残留）
    expect(quickDefault.system).toBe(forcedOff.system)
    expect(fallback.system).toBe(forcedOff.system)
    expect(fallback.system).not.toContain('【技术合同')

    // plan_fallback 决策留痕（裸关键词断言，陷阱 33）
    expect(fallback.decisions).toContain('plan_fallback')
    expect(fallback.decisions).toContain('回退无合同现状')
  })

  it('成功路径：system 尾部拼合同段（base+\\n\\n+injection）+ plan.md 落盘 + plan_generated 决策', async () => {
    // 基线（无 plan）：同需求另开项目取现状 system
    process.env.BLOMA_PLAN_LEG = '0'
    const baseline = await runOnce('longterm', REQUIREMENTS)

    delete process.env.BLOMA_PLAN_LEG
    mocks.generateLoopPlan.mockResolvedValue(SAMPLE_PLAN)
    const planned = await runOnce('longterm', REQUIREMENTS)
    expect(mocks.generateLoopPlan).toHaveBeenCalledTimes(1)

    // 注入=现状 + '\n\n' + 合同段（字节级拼接锁，D2 参考合同话术在段内）
    const injection = renderPlanInjection(SAMPLE_PLAN)
    expect(planned.system).toBe(`${baseline.system}\n\n${injection}`)
    expect(planned.system).toContain('【技术合同')
    expect(planned.system).toContain('不构成硬约束')

    // plan.md 落盘 + 清单登记
    const dir = getDocumentsDir(planned.workspaceSlug, planned.projectId)
    const planMd = readFileSync(join(dir, 'plan.md'), 'utf8')
    expect(planMd).toContain('# 技术合同（plan 腿）')
    expect(planMd).toContain('index.html')

    // plan_generated 决策留痕
    expect(planned.decisions).toContain('plan_generated')
    expect(planned.decisions).toContain('loop 前单轮规划产出参考合同')

    // plan 腿与主 loop 同渠道同 env（D6）：generateLoopPlan 收到 loop.env（含解密后模型名）
    const legArgs = mocks.generateLoopPlan.mock.calls[0][0] as { env: Record<string, string>; skeletonMap: string | null }
    expect(legArgs.env.ANTHROPIC_MODEL).toBe('test-model')
    expect(legArgs.skeletonMap).toBeNull()
  })

  it('BLOMA_PLAN_LEG=1 强制开：quick 也起腿', { timeout: 60_000 }, async () => {
    process.env.BLOMA_PLAN_LEG = '1'
    mocks.generateLoopPlan.mockResolvedValue(SAMPLE_PLAN)
    const quickForced = await runOnce('quick', REQUIREMENTS)
    expect(mocks.generateLoopPlan).toHaveBeenCalledTimes(1)
    expect(quickForced.system).toContain('【技术合同')
  })
})
