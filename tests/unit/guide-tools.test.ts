/**
 * 向导决策工具测试（2026-09-25 自由度批二）：判型回溯钩子——
 * confirm_requirements 需求涌现桌面形态诉求而品类非 desktop_tool 时，
 * 工具输出带改道提示（F-009 案根治：网页品类被要求桌面部署不再无声吞下）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../../main/project/project-service', () => ({
  findProject: vi.fn(),
}))

import { findProject } from '../../main/project/project-service'
import { buildGuideTools } from '../../main/guide/guide-tools'

const mockFindProject = vi.mocked(findProject)

beforeEach(() => {
  vi.clearAllMocks()
  mockFindProject.mockReturnValue({ template_type: 'personal_tool' } as never)
})

function decideOnce(decision: Record<string, unknown>): string {
  const tools = buildGuideTools('p1', { onDecide: () => undefined })
  const tool = tools.find((t) => t.name === 'guide_decide')!
  // execute 是 async：同步拿 output 用 Promise.resolve 链
  let output = ''
  void tool.execute(decision, {
    projectId: 'p1', sessionId: 's1', requestId: 'r1',
    signal: new AbortController().signal,
    state: { test_failed: false, gwt_all_passed: false, security_all_passed: false, api_all_passed: false, edits_after_test_failure: 0, repair_round: 0, delegation_depth: 0 },
  } as never).then((r) => { output = r.output })
  return output
}

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
