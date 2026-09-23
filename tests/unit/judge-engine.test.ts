import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncDocuments } from '../../main/project/document-engine'
import { readGwtFeatureIds, runJudge } from '../../main/review/judge-engine'
import { createProject, recordSketchGenerated } from '../../main/project/project-service'

describe('JudgeEngine (A2-10)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  it('passes when PRD is present, every feature has a GWT scenario, and entries exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({ request_id: 'req-sync', session_id: 's', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
    writeFileSync(join(project.root_path, 'index.html'), '<p>记录收入与支出</p>', 'utf8')

    const verdict = runJudge({ project_id: project.project_id, mode: 'quick' })

    expect(verdict.verdict).toBe('pass')
    expect(verdict.repairable).toBe(false)
    expect(verdict.hard_constraints.every((item) => item.passed)).toBe(true)
    expect(verdict.user_visible_summary).toBeTruthy()
    expect(JSON.stringify(verdict)).not.toMatch(/node_modules|Error:|at /)
  })

  it('returns and marks missing GWT scenarios when a PRD feature has no feature file', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [
      { id: 'F-001', description: '记录收入与支出' },
      { id: 'F-002', description: '展示本月结余' },
    ])
    syncDocuments({ request_id: 'req-sync', session_id: 's', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
    // 手动删掉 F-002 的 feature，模拟 GWT 只覆盖部分功能项
    rmSync(join(home, 'agent-workspaces', project.workspace_slug, 'documents', project.project_id, 'features', 'F-002.feature'))

    const verdict = runJudge({ project_id: project.project_id, mode: 'quick' })

    expect(verdict.verdict).toBe('return')
    expect(verdict.repairable).toBe(true)
    const coverage = verdict.hard_constraints.find((item) => item.name === 'GWT 场景覆盖')
    expect(coverage?.passed).toBe(false)
    expect(coverage?.detail).toContain('F-002')
  })

  it('returns when the PRD has no confirmed core features', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })

    const verdict = runJudge({ project_id: project.project_id, mode: 'quick' })

    expect(verdict.verdict).toBe('return')
    expect(verdict.hard_constraints.find((item) => item.name === 'PRD 核心功能项')?.passed).toBe(false)
  })

  it('returns (not suggest) when a PRD feature has no interactive entry — 三方对齐收口', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({ request_id: 'req-sync', session_id: 's', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
    // 页面没有对应入口（既无需求原文，也无交互控件 + 脚本逻辑）——存在性基线退回
    writeFileSync(join(project.root_path, 'index.html'), '<p>其他内容</p>', 'utf8')

    const verdict = runJudge({ project_id: project.project_id, mode: 'quick' })

    expect(verdict.verdict).toBe('return')
    expect(verdict.repairable).toBe(true)
    const entry = verdict.hard_constraints.find((item) => item.name === 'P0 行为断言可满足性')
    expect(entry?.passed).toBe(false)
    expect(entry?.detail).toContain('F-001')
  })

  it('suggests (not returns) when only the test-result soft constraint fails', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({ request_id: 'req-sync', session_id: 's', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
    // 交互入口齐全（硬约束全过）
    writeFileSync(join(project.root_path, 'index.html'), '<p>记录收入与支出</p>', 'utf8')

    const verdict = runJudge({
      project_id: project.project_id,
      mode: 'quick',
      test_result: { total_count: 1, passed_count: 0, failed_count: 1, failure_summary: [{ scenario: 'F-001', reason: 'x' }] },
    })

    expect(verdict.verdict).toBe('suggest')
    expect(verdict.repairable).toBe(false)
    expect(verdict.hard_constraints.every((item) => item.passed)).toBe(true)
    expect(verdict.soft_constraints.find((item) => item.name === '测试结果')?.passed).toBe(false)
  })

  it('passes LLM product via domain-agnostic functional entry (interactive control + script logic) even without literal requirement text', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({ request_id: 'req-sync', session_id: 's', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
    // 模型产物用交互控件 + 脚本逻辑实现，不内嵌需求原文「记录收入与支出」
    writeFileSync(join(project.root_path, 'index.html'), '<button>开始使用</button><input type="text" />', 'utf8')
    mkdirSync(join(project.root_path, 'src'), { recursive: true })
    writeFileSync(join(project.root_path, 'src', 'app.js'), "document.querySelector('button').addEventListener('click', function () {})", 'utf8')

    const verdict = runJudge({ project_id: project.project_id, mode: 'quick' })

    expect(verdict.verdict).toBe('pass')
  })

  it('exposes GWT feature ids via readGwtFeatureIds', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({ request_id: 'req-sync', session_id: 's', project_id: project.project_id, checkpoint: 'mvp_before_generation' })

    expect(readGwtFeatureIds(project.project_id)).toContain('F-001')
  })
})

describe('JudgeEngine loop-aware（M4-B：异常终止态不凭产物放行）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  /** 备好「产物完美」的盘面：PRD 背板 + GWT 全覆盖 + 原文匹配入口，无 loop 时必 pass。 */
  function perfectProject(): { project_id: string } {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-loop-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-loop', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({ request_id: 'req-sync', session_id: 's', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
    writeFileSync(join(project.root_path, 'index.html'), '<p>记录收入与支出</p>', 'utf8')
    return project
  }

  it.each([
    ['turn_limit', '达到轮次上限'],
    ['budget_exhausted', '修复预算耗尽'],
    ['cancelled', '被取消'],
  ] as const)('loop 异常终止态 %s → 硬约束失败且 repairable=false（产物能跑也不放行）', (status, label) => {
    const project = perfectProject()
    const verdict = runJudge({
      project_id: project.project_id,
      mode: 'quick',
      loop: { status, turns: 12, finalText: '产物自述能用', toolCalls: [] },
    })

    expect(verdict.verdict).toBe('return')
    expect(verdict.repairable).toBe(false)
    const loopConstraint = verdict.hard_constraints.find((item) => item.name === 'Agent Loop 完成状态')
    expect(loopConstraint?.passed).toBe(false)
    expect(loopConstraint?.detail).toContain(label)
    expect(verdict.user_visible_summary).toContain(label)
    // 异常终止态在磁盘读判之前短路：不消费正常盘面
    expect(verdict.soft_constraints).toEqual([])
  })

  it('P2a：turn_limit + termination_detail(degenerate_output) → 用户话术如实标注「输出退化」而非「轮数耗尽」（狗粮 94f449c6）', () => {
    const project = perfectProject()
    const verdict = runJudge({
      project_id: project.project_id,
      mode: 'quick',
      loop: { status: 'turn_limit', turns: 37, finalText: '', toolCalls: [], termination_detail: { reason: 'degenerate_output', retries: 1 } },
    })
    expect(verdict.verdict).toBe('return')
    expect(verdict.user_visible_summary).toContain('末轮输出退化')
    expect(verdict.user_visible_summary).toContain('非轮数耗尽')
    expect(verdict.user_visible_summary).not.toContain('达到轮次上限')
    const loopConstraint = verdict.hard_constraints.find((item) => item.name === 'Agent Loop 完成状态')
    expect(loopConstraint?.detail).toContain('末轮输出退化')
  })

  it('loop completed → 走原读盘判定，产物达标即 pass', () => {
    const project = perfectProject()
    const verdict = runJudge({
      project_id: project.project_id,
      mode: 'quick',
      loop: { status: 'completed', turns: 8, finalText: '全部完成', toolCalls: [{ name: 'write_file', turn: 1 }] },
    })

    expect(verdict.verdict).toBe('pass')
    expect(verdict.hard_constraints.every((item) => item.passed)).toBe(true)
  })

  it('loop completed + 仅测试结果软约束失败 → suggest（与无 loop 语义一致）', () => {
    const project = perfectProject()
    const verdict = runJudge({
      project_id: project.project_id,
      mode: 'quick',
      loop: { status: 'completed', turns: 8, finalText: '完成', toolCalls: [] },
      test_result: { total_count: 1, passed_count: 0, failed_count: 1, failure_summary: [{ scenario: 'F-001', reason: 'x' }] },
    })

    expect(verdict.verdict).toBe('suggest')
    expect(verdict.repairable).toBe(false)
    expect(verdict.hard_constraints.every((item) => item.passed)).toBe(true)
  })
})
