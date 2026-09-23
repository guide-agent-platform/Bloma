import { restorePromaHome } from '../../support/proma-home-guard'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMvpTask, setProgrammingEventPublisher } from '../../../main/coding/programming-orchestrator'
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
vi.mock('../../../main/coding/agent-loop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/coding/agent-loop')>()
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
  const originalLoopLog = process.env.BLOMA_LOOP_LOG
  const originalFocusAnchor = process.env.BLOMA_FOCUS_ANCHOR
  const originalModules = process.env.BLOMA_MODULES
  const originalTaskWorkflow = process.env.BLOMA_TASK_WORKFLOW
  let home = ''
  let channelId = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'proma-plan-'))
    process.env.PROMA_HOME = home
    delete process.env.BLOMA_PLAN_LEG
    delete process.env.BLOMA_LOOP_LOG
    delete process.env.BLOMA_FOCUS_ANCHOR
    // W5（Phase 8.5）：本文件锁 plan 注入组合的原口径——钉 W5 关（checklist 追加
    // 属新行为，正向覆盖见 task-workflow.test.ts）
    process.env.BLOMA_TASK_WORKFLOW = '0'
    // 官方模块库是新增增强：P3 plan 腿「字节级现状」回归锁关闭模块库，保持现状语义
    //（独立开关 BLOMA_MODULES 关闭=现状；模块库正向接线见 module-library 测试）
    process.env.BLOMA_MODULES = '0'
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
    if (originalLoopLog === undefined) delete process.env.BLOMA_LOOP_LOG
    else process.env.BLOMA_LOOP_LOG = originalLoopLog
    if (originalFocusAnchor === undefined) delete process.env.BLOMA_FOCUS_ANCHOR
    else process.env.BLOMA_FOCUS_ANCHOR = originalFocusAnchor
    if (originalModules === undefined) delete process.env.BLOMA_MODULES
    else process.env.BLOMA_MODULES = originalModules
    if (originalTaskWorkflow === undefined) delete process.env.BLOMA_TASK_WORKFLOW
    else process.env.BLOMA_TASK_WORKFLOW = originalTaskWorkflow
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
    expect(planned.system).toContain('默认架构')

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
    // P0-1（2026-09-18 本月流水账案止血）：personal_tool 复用 web_fullstack 骨架，
    // 骨架图非空且含路由样例条目（旧断言 toBeNull() 钉的是「无骨架现状」，已随止血批废弃）
    expect(legArgs.skeletonMap).toContain('server/routes/_example.js')
  })

  it('BLOMA_PLAN_LEG=1 强制开：quick 也起腿', { timeout: 60_000 }, async () => {
    process.env.BLOMA_PLAN_LEG = '1'
    mocks.generateLoopPlan.mockResolvedValue(SAMPLE_PLAN)
    const quickForced = await runOnce('quick', REQUIREMENTS)
    expect(mocks.generateLoopPlan).toHaveBeenCalledTimes(1)
    expect(quickForced.system).toContain('【技术合同')
  })

  it('W1 真实脚手架（BLOMA_REAL_SCAFFOLD=1，无后端契约→ real-static）：骨架图换包+决策留痕变体', { timeout: 60_000 }, async () => {
    const previous = process.env.BLOMA_REAL_SCAFFOLD
    process.env.BLOMA_REAL_SCAFFOLD = '1'
    mocks.generateLoopPlan.mockResolvedValue(SAMPLE_PLAN)
    try {
      const run = await runOnce('longterm', REQUIREMENTS)
      // 两态判定：REQUIREMENTS「记录收入与支出」命中留存信号词 → deriveInterfaceSpec 派生
      // records 契约 → interface_spec 非空 → real-fullstack（Express 真实工程；与旧路径派生口径一致）
      expect(run.decisions).toContain('真实脚手架变体=real-fullstack')
      // 骨架地图换包：real-fullstack 含 server.js/package.json 工程件；不含旧包的 _example.js（两者互斥可辨）
      expect(run.system).toContain('工程骨架已就位')
      expect(run.system).toContain('server.js')
      expect(run.system).not.toContain('server/routes/_example.js')
      // 交接面治理：real-fullstack 的 loop system【前后端分离】段换 Express 口径（旧 CJS
      // 挂载约定不再与背板锚 Express 口径同时注入——狗粮实锤模型曾按旧约定自建挂载器）
      expect(run.system).toContain('【前后端分离·Express】')
      expect(run.system).not.toContain('文件名即路由前缀')
    } finally {
      if (previous === undefined) delete process.env.BLOMA_REAL_SCAFFOLD
      else process.env.BLOMA_REAL_SCAFFOLD = previous
    }
  })

  // ---- P3 PR-B：loop-log 接线（同一 harness；onTurn 经 mock 的 runAgentLoop 入参驱动） ----

  function readLoopLog(workspaceSlug: string, projectId: string): string {
    return readFileSync(join(getDocumentsDir(workspaceSlug, projectId), 'loop-log.md'), 'utf8')
  }

  it('loop-log 全链：会话头（含 plan 摘要行）+ 逐轮 append（带 path）+ 终态节', { timeout: 60_000 }, async () => {
    mocks.generateLoopPlan.mockResolvedValue(SAMPLE_PLAN)
    mocks.runAgentLoop.mockImplementation(async (loopInput: { onTurn?: (info: unknown) => void }) => {
      loopInput.onTurn?.({ turn: 1, toolCalls: [{ name: 'write_file', turn: 1, path: 'index.html' }, { name: 'run_preview', turn: 1 }], inputTokens: 100, outputTokens: 20 })
      loopInput.onTurn?.({ turn: 2, toolCalls: [{ name: 'edit_file', turn: 2, path: 'src/app.js' }] })
      return loopCompleted()
    })
    const run = await runOnce('longterm', REQUIREMENTS)

    const log = readLoopLog(run.workspaceSlug, run.projectId)
    expect(log).toContain('# Agent Loop 过程记录（loop-log）')
    expect(log).toContain('## MVP 生成（')
    expect(log).toContain('- 模式：longterm｜轮次上限：40')
    // plan 摘要行引用 plan 腿产物（B 依赖 A）
    expect(log).toContain('2 个目标文件：index.html、src/app.js')
    expect(log).toContain('- 轮 1：write_file(index.html) → run_preview ｜ tokens in 100/out 20')
    expect(log).toContain('- 轮 2：edit_file(src/app.js)')
    expect(log).toContain('### 终态：completed（3 轮 / 1 次工具调用）')
  })

  it('loop 异常抛错：终态节如实写 error（已写轮次在盘）后原样上抛', { timeout: 60_000 }, async () => {
    mocks.runAgentLoop.mockImplementation(async (loopInput: { onTurn?: (info: unknown) => void }) => {
      loopInput.onTurn?.({ turn: 1, toolCalls: [{ name: 'write_file', turn: 1, path: 'index.html' }] })
      throw new Error('LOOP_BLEW_UP')
    })
    await expect(runOnce('quick', REQUIREMENTS)).rejects.toThrow('LOOP_BLEW_UP')

    // 崩溃续写口径：已写轮次与 error 终态节都在盘上（runOnce 抛错拿不到返回值，从盘上反查最新 log）
    const log = findLatestLoopLog()
    expect(log).toContain('- 轮 1：write_file(index.html)')
    expect(log).toContain('### 终态：error（1 轮 / 1 次工具调用）')
  })

  it('BLOMA_LOOP_LOG=0：零写盘（逃生门）', { timeout: 60_000 }, async () => {
    process.env.BLOMA_LOOP_LOG = '0'
    mocks.runAgentLoop.mockImplementation(async (loopInput: { onTurn?: (info: unknown) => void }) => {
      loopInput.onTurn?.({ turn: 1, toolCalls: [{ name: 'write_file', turn: 1, path: 'index.html' }] })
      return loopCompleted()
    })
    const run = await runOnce('quick', REQUIREMENTS)
    expect(existsSync(join(getDocumentsDir(run.workspaceSlug, run.projectId), 'loop-log.md'))).toBe(false)
  })

  it('P3 分级锚定：focusRequirementIds 透传 plan 腿 + system 聚焦提示行与分级渲染', { timeout: 60_000 }, async () => {
    process.env.BLOMA_FOCUS_ANCHOR = '1' // quick + 强制开（缺省 quick off，D7 连锁）
    process.env.BLOMA_PLAN_LEG = '1' // quick 缺省不起 plan 腿，这里显式开以便断言透传
    mocks.generateLoopPlan.mockResolvedValue(SAMPLE_PLAN)
    const requirements = [
      { id: 'F-001', description: '记录收入与支出', behavior_assertions: ['点击保存按钮→列表新增一条记录'], priority: 'P0' as const },
      { id: 'F-003', description: '搜索历史', behavior_assertions: ['在搜索框输入关键词→列表过滤'], priority: 'P1' as const },
    ]
    const project = createProject({ request_id: `req-${Math.random().toString(36).slice(2, 8)}`, mode: 'quick' })
    recordSketchGenerated(project.project_id, requirements)
    writeFileSync(join(project.root_path, 'index.html'), '<html><body><p>记录收入与支出</p></body></html>', 'utf8')
    const sessionId = `s-focus-${Math.random().toString(36).slice(2, 8)}`
    await runMvpTask({
      request_id: `req-${Math.random().toString(36).slice(2, 8)}`,
      session_id: sessionId,
      project_id: project.project_id,
      mode: 'quick',
      channel_id: channelId,
      query: junkQuery(),
      focusRequirementIds: ['F-003'],
    })

    // plan 腿收到 focus（prompt 分级渲染）
    const legArgs = mocks.generateLoopPlan.mock.calls[0][0] as { focusRequirementIds?: string[] }
    expect(legArgs.focusRequirementIds).toEqual(['F-003'])

    // system：聚焦提示行 + 命中项断言全文 + 未聚焦项摘要（断言折叠；prd_document
    // 全文段按规则不裁，负向断言锁定结构化功能项区块）
    const system = mocks.runAgentLoop.mock.calls[mocks.runAgentLoop.mock.calls.length - 1][0].system as string
    expect(system).toContain('本轮迭代聚焦：F-003')
    expect(system).toContain('在搜索框输入关键词→列表过滤')
    expect(system).toContain('- [F-001]（P0）记录收入与支出（断言 1 条）——本轮未聚焦')
    expect(system).not.toContain('- [F-001]（P0）记录收入与支出\n  行为断言：')
  })

  it('P3 分级锚定开关关（BLOMA_FOCUS_ANCHOR=0）：focus 传入也不分级=全量现状', { timeout: 60_000 }, async () => {
    process.env.BLOMA_FOCUS_ANCHOR = '0'
    mocks.generateLoopPlan.mockResolvedValue(SAMPLE_PLAN)
    const requirements = [
      { id: 'F-001', description: '记录收入与支出', behavior_assertions: ['点击保存按钮→列表新增一条记录'], priority: 'P0' as const },
    ]
    const project = createProject({ request_id: `req-${Math.random().toString(36).slice(2, 8)}`, mode: 'longterm' })
    recordSketchGenerated(project.project_id, requirements)
    writeFileSync(join(project.root_path, 'index.html'), '<html><body><p>记录收入与支出</p></body></html>', 'utf8')
    await runMvpTask({
      request_id: `req-${Math.random().toString(36).slice(2, 8)}`,
      session_id: `s-focus-off-${Math.random().toString(36).slice(2, 8)}`,
      project_id: project.project_id,
      mode: 'longterm',
      channel_id: channelId,
      query: junkQuery(),
      focusRequirementIds: ['F-001'],
    })
    const system = mocks.runAgentLoop.mock.calls[mocks.runAgentLoop.mock.calls.length - 1][0].system as string
    expect(system).not.toContain('本轮迭代聚焦')
    expect(system).toContain('点击保存按钮→列表新增一条记录')
    // plan 腿也不分 focus（开关是分级锚定总闸，plan 腿输入同受门控）
    const legArgs = mocks.generateLoopPlan.mock.calls[0][0] as { focusRequirementIds?: string[] }
    expect(legArgs.focusRequirementIds).toBeUndefined()
  })

  it('localOnly（「提出意见」局部修改）：开关显式关也强制聚焦（其余保持现状勿重做）', { timeout: 60_000 }, async () => {
    process.env.BLOMA_FOCUS_ANCHOR = '0' // 开关显式关，localOnly 仍应强制生效
    mocks.generateLoopPlan.mockResolvedValue(SAMPLE_PLAN)
    const requirements = [
      { id: 'F-001', description: '记录收入与支出', behavior_assertions: ['点击保存按钮→列表新增一条记录'], priority: 'P0' as const },
      { id: 'F-003', description: '搜索历史', behavior_assertions: ['在搜索框输入关键词→列表过滤'], priority: 'P0' as const },
    ]
    const project = createProject({ request_id: `req-${Math.random().toString(36).slice(2, 8)}`, mode: 'quick' })
    recordSketchGenerated(project.project_id, requirements)
    writeFileSync(join(project.root_path, 'index.html'), '<html><body><p>记录收入与支出</p></body></html>', 'utf8')
    await runMvpTask({
      request_id: `req-${Math.random().toString(36).slice(2, 8)}`,
      session_id: `s-localonly-${Math.random().toString(36).slice(2, 8)}`,
      project_id: project.project_id,
      mode: 'quick',
      channel_id: channelId,
      query: junkQuery(),
      focusRequirementIds: ['F-003'],
      localOnly: true,
    })
    const system = mocks.runAgentLoop.mock.calls[mocks.runAgentLoop.mock.calls.length - 1][0].system as string
    // 强制聚焦：命中项断言全文锚定，未聚焦项降为「保持现状勿重做」摘要
    expect(system).toContain('本轮迭代聚焦：F-003')
    expect(system).toContain('- [F-001]（P0）记录收入与支出（断言 1 条）——本轮未聚焦')
  })

  it('rebuild（整版重做）：即使 focus 传入也全量锚定（不聚焦、允许大改）', { timeout: 60_000 }, async () => {
    process.env.BLOMA_FOCUS_ANCHOR = '1' // 开关显式开，rebuild 仍应不聚焦
    mocks.generateLoopPlan.mockResolvedValue(SAMPLE_PLAN)
    const requirements = [
      { id: 'F-001', description: '记录收入与支出', behavior_assertions: ['点击保存按钮→列表新增一条记录'], priority: 'P0' as const },
      { id: 'F-003', description: '搜索历史', behavior_assertions: ['在搜索框输入关键词→列表过滤'], priority: 'P0' as const },
    ]
    const project = createProject({ request_id: `req-${Math.random().toString(36).slice(2, 8)}`, mode: 'longterm' })
    recordSketchGenerated(project.project_id, requirements)
    writeFileSync(join(project.root_path, 'index.html'), '<html><body><p>记录收入与支出</p></body></html>', 'utf8')
    await runMvpTask({
      request_id: `req-${Math.random().toString(36).slice(2, 8)}`,
      session_id: `s-rebuild-${Math.random().toString(36).slice(2, 8)}`,
      project_id: project.project_id,
      mode: 'longterm',
      channel_id: channelId,
      query: junkQuery(),
      focusRequirementIds: ['F-003'],
      rebuild: true,
    })
    const system = mocks.runAgentLoop.mock.calls[mocks.runAgentLoop.mock.calls.length - 1][0].system as string
    // 整版重做：不聚焦（无聚焦提示行，两项全文渲染）
    expect(system).not.toContain('本轮迭代聚焦')
    expect(system).toContain('在搜索框输入关键词→列表过滤')
  })

  it('P3 全关路径（三开关全 0）：字节级现状一次性回归锁（§7 实验对照组）', { timeout: 60_000 }, async () => {
    // 基线：三开关全 0，不传 focus，plan mock 不参与（plan 腿关）
    process.env.BLOMA_PLAN_LEG = '0'
    process.env.BLOMA_LOOP_LOG = '0'
    process.env.BLOMA_FOCUS_ANCHOR = '0'
    mocks.generateLoopPlan.mockResolvedValue(SAMPLE_PLAN) // 即便会返回 plan 也不得起腿
    const baseline = await runOnce('longterm', REQUIREMENTS)
    expect(mocks.generateLoopPlan).not.toHaveBeenCalled()

    // 全关 + focus 传入 + plan 可返回：三通道都被短路，输出与基线字节级一致
    const focusForced = await runMvpTask({
      request_id: `req-${Math.random().toString(36).slice(2, 8)}`,
      session_id: `s-all-off-${Math.random().toString(36).slice(2, 8)}`,
      project_id: (() => {
        const project = createProject({ request_id: `req-${Math.random().toString(36).slice(2, 8)}`, mode: 'longterm' })
        recordSketchGenerated(project.project_id, REQUIREMENTS)
        writeFileSync(join(project.root_path, 'index.html'), '<html><body><p>记录收入与支出</p></body></html>', 'utf8')
        return project.project_id
      })(),
      mode: 'longterm',
      channel_id: channelId,
      query: junkQuery(),
      focusRequirementIds: ['F-001'],
    }).then(() => {
      const system = mocks.runAgentLoop.mock.calls[mocks.runAgentLoop.mock.calls.length - 1][0].system as string
      const planCalls = mocks.generateLoopPlan.mock.calls.length
      return { system, planCalls }
    })

    expect(focusForced.planCalls).toBe(0) // plan 腿全关
    expect(focusForced.system).toBe(baseline.system) // 字节级现状
    expect(focusForced.system).not.toContain('本轮迭代聚焦')
    expect(focusForced.system).not.toContain('【技术合同')

    // loop-log 零写盘（基线与全关两次运行都不落盘）
    const docsRoot = join(home, 'agent-workspaces')
    let anyLoopLog = false
    for (const slug of readdirSync(docsRoot)) {
      const documentsRoot = join(docsRoot, slug, 'documents')
      if (!existsSync(documentsRoot)) continue
      for (const id of readdirSync(documentsRoot)) {
        if (existsSync(join(documentsRoot, id, 'loop-log.md'))) anyLoopLog = true
      }
    }
    expect(anyLoopLog).toBe(false)
  })
})

/** 反查本测试 PROMA_HOME 里最新写入的 loop-log 内容（崩溃用例无法拿到 runOnce 返回值时用）。 */
function findLatestLoopLog(): string {
  const workspacesDir = join(process.env.PROMA_HOME as string, 'agent-workspaces')
  let best: { path: string; mtime: number } | undefined
  for (const slug of readdirSync(workspacesDir)) {
    const documentsRoot = join(workspacesDir, slug, 'documents')
    if (!existsSync(documentsRoot)) continue
    for (const id of readdirSync(documentsRoot)) {
      const logPath = join(documentsRoot, id, 'loop-log.md')
      if (!existsSync(logPath)) continue
      const mtime = statSync(logPath).mtimeMs
      if (!best || mtime > best.mtime) best = { path: logPath, mtime }
    }
  }
  if (!best) throw new Error('no loop-log found')
  return readFileSync(best.path, 'utf8')
}
