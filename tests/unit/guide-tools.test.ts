/**
 * 向导决策工具测试（2026-09-25 自由度批二）：判型回溯钩子——
 * confirm_requirements 需求涌现桌面形态诉求而品类非 desktop_tool 时，
 * 工具输出带改道提示（F-009 案根治：网页品类被要求桌面部署不再无声吞下）。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../main/project/project-service', () => ({
  findProject: vi.fn(),
}))

import { findProject } from '../../main/project/project-service'
import { buildGuideTools, type GuideDecision } from '../../main/guide/guide-tools'

const mockFindProject = vi.mocked(findProject)

beforeEach(() => {
  vi.clearAllMocks()
  mockFindProject.mockReturnValue({ template_type: 'personal_tool' } as never)
})

describe('判型回溯钩子（桌面形态诉求错配提示）', () => {
  it('需求命中「以桌面应用形式部署」且品类 personal_tool → 输出带改道提示', async () => {
    const tools = buildGuideTools('p1', { onDecide: () => undefined })
    const tool = tools.find((t) => t.name === 'guide_decide')!
    const result = await tool.execute({
      action: 'confirm_requirements',
      reply: '需求好了',
      requirements: [
        { id: 'F-001', description: '做一个计算器', origin: 'user' },
        { id: 'F-002', description: '计算器以桌面应用形式部署，可在桌面环境直接启动运行', origin: 'user' },
      ],
    }, { projectId: 'p1', sessionId: 's1', requestId: 'r1', signal: new AbortController().signal, state: {} as never })
    expect(result.output).toContain('品类形态提示')
    expect(result.output).toContain('桌面程序')
    expect(result.detail?.desktop_form_mismatch).toBe(true)
  })

  it('品类已是 desktop_tool → 无提示（正确品类不误报）', async () => {
    mockFindProject.mockReturnValue({ template_type: 'desktop_tool' } as never)
    const tools = buildGuideTools('p1', { onDecide: () => undefined })
    const tool = tools.find((t) => t.name === 'guide_decide')!
    const result = await tool.execute({
      action: 'confirm_requirements', reply: 'ok',
      requirements: [{ id: 'F-001', description: '桌面程序计算器' }],
    }, { projectId: 'p1', sessionId: 's1', requestId: 'r1', signal: new AbortController().signal, state: {} as never })
    expect(result.output).not.toContain('品类形态提示')
  })

  it('无桌面诉求的普通需求 → 无提示', async () => {
    const tools = buildGuideTools('p1', { onDecide: () => undefined })
    const tool = tools.find((t) => t.name === 'guide_decide')!
    const result = await tool.execute({
      action: 'confirm_requirements', reply: 'ok',
      requirements: [{ id: 'F-001', description: '记账并保存记录' }],
    }, { projectId: 'p1', sessionId: 's1', requestId: 'r1', signal: new AbortController().signal, state: {} as never })
    expect(result.output).not.toContain('品类形态提示')
  })
})

// ── 自 guide-loop.test.ts 迁入（2026-10-03 删留执行：原文件其余 loop 化口径用例已随
//    旧单次 JSON 路径删除而失实，仅存这两个 buildGuideTools 单元行为例） ──
const decideAskJson = {
  action: 'ask_clarification',
  reply: '想先确认一下：主要记个人流水还是家庭共享账本？',
  questions: [
    { id: 'answer-a', label: '个人流水', description: '单用户快速记账' },
    { id: 'auto', label: '你帮我决定', description: '交给我，按常见做法先出一版' },
  ],
}

describe('guide-tools 单元（自 guide-loop 迁入）', () => {
  const ORIGINAL_PROMA_HOME = process.env.PROMA_HOME

  afterEach(() => {
    if (ORIGINAL_PROMA_HOME === undefined) delete process.env.PROMA_HOME
    else process.env.PROMA_HOME = ORIGINAL_PROMA_HOME
  })

  it('guide_decide：合法决策入持有者；非法 action 拒绝；每 run 只收一次', async () => {
    const decisions: GuideDecision[] = []
    const tools = buildGuideTools('proj-1', { onDecide: (d) => decisions.push(d) })
    const decide = tools.find((t) => t.name === 'guide_decide')!
    const ok = await decide.execute({ ...decideAskJson }, {} as never)
    expect(ok.isError).toBeUndefined()
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.action).toBe('ask_clarification')
    const bad = await decide.execute({ action: 'run_away', reply: 'x' }, {} as never)
    expect(bad.isError).toBe(true)
    const again = await decide.execute({ ...decideAskJson }, {} as never)
    expect(again.isError).toBe(true)
    expect(again.output).toContain('不要重复调用')
  })

  it('read_test_report：无报告如实返回；有报告给出摘要', async () => {
    // 本文件全局 mock 的 findProject 无 workspace_slug（其余例不依赖）；本例的文档目录
    // 定位依赖它，参照原 guide-loop.test.ts 的 mock 形状补齐。
    mockFindProject.mockReturnValue({ template_type: 'personal_tool', workspace_slug: 'default-software-builder' } as never)
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-guide-tools-'))
    const docDir = join(process.env.PROMA_HOME, 'agent-workspaces', 'default-software-builder', 'documents', 'proj-1')
    mkdirSync(docDir, { recursive: true })
    const tools = buildGuideTools('proj-1', { onDecide: () => undefined })
    const report = tools.find((t) => t.name === 'read_test_report')!
    const before = await report.execute({}, {} as never)
    expect(before.output).toContain('尚未生成测试报告')
    writeFileSync(
      join(docDir, 'test-report.json'),
      JSON.stringify({ total_count: 8, passed_count: 6, failed_count: 2, failure_summary: [{ scenario: 'F-002 点击新增', reason: '输入框未出现' }] }),
      'utf-8',
    )
    const after = await report.execute({}, {} as never)
    expect(after.output).toContain('通过 6')
    expect(after.output).toContain('F-002 点击新增')
  })
})
