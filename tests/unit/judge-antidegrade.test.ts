/**
 * Phase 3 B4 裁判反退化 + 门禁自测（2026-09-09，P1 稿 §3 M4 + P0 稿 §4.3 合并）。
 *
 * 门禁自测口径（已知坏实现三层归位）：
 * - 固定 AI 回答 → 静态检测 ai-mock-frontend（有 CAP 而产物无 /api/llm——平台唯一合法 AI 通道）
 * - 无需求依据控件（模拟失败按钮）→ 静态检测 cheat-control
 * - 总返回成功/空数组 → 语义裁判反退化规则（证据不足不得判 implemented）+ GWT/api-contract 运行时探针
 * 本文件覆盖前两层（确定性可测）+ prompt 规则装配；第三层在 bench L1 实跑验证。
 */
import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncDocuments } from '../../main/document-engine'
import { runJudge } from '../../main/judge-engine'
import { buildSemanticJudgeSystemPrompt, SEMANTIC_JUDGE_SYSTEM_PROMPT } from '../../main/review/judge-semantic'
import { antidegradeEnabled, detectAntidegrade } from '../../main/review/judge-antidegrade'
import { createProject, recordSketchGenerated } from '../../main/project-service'
import type { AiCapability } from '../../main/model/prd-backplane'

afterEach(() => {
  vi.unstubAllEnvs()
})

const cap: AiCapability = {
  capability_id: 'CAP-01',
  task: '根据笔记内容生成智能总结',
  keyProcessing: '真实模型调用',
  ioDependency: '笔记变化→总结变化',
  forbiddenSubstitutions: ['固定模板冒充'],
  evidence: ['修改笔记后总结随之变化'],
  source: 'user_explicit',
}

describe('antidegradeEnabled（BLOMA_JUDGE_ANTIDEGRADE）', () => {
  it('缺省 off；1/on/true 开', () => {
    expect(antidegradeEnabled()).toBe(false)
    vi.stubEnv('BLOMA_JUDGE_ANTIDEGRADE', '1')
    expect(antidegradeEnabled()).toBe(true)
    vi.stubEnv('BLOMA_JUDGE_ANTIDEGRADE', 'off')
    expect(antidegradeEnabled()).toBe(false)
  })
})

describe('detectAntidegrade（静态高精度检测）', () => {
  it('坏实现①固定 AI 回答：有 CAP 而产物无 /api/llm → ai-mock-frontend', () => {
    const artifact = '<div>AI 总结区</div><script>function gen(){render("根据你的笔记，本月重点有三件事……")}</script>'
    const findings = detectAntidegrade({ artifact, caps: [cap] })
    expect(findings.map((f) => f.code)).toContain('ai-mock-frontend')
    expect(findings[0].detail).toContain('CAP-01')
  })
  it('合法实现：前端经 fetch(/api/llm) 调真实通道 → 无 finding', () => {
    const artifact = `fetch('/api/llm', { method: 'POST', body: JSON.stringify({messages:[{role:'user',content:text}]}) }).then(r=>r.json())`
    expect(detectAntidegrade({ artifact, caps: [cap] })).toEqual([])
  })
  it('纯 CRUD（无 CAP）不触发 ai-mock-frontend', () => {
    expect(detectAntidegrade({ artifact: '<div>记账列表</div>', caps: [] })).toEqual([])
  })
  it('坏实现②教学控件：模拟失败按钮 → cheat-control；相邻正常文案不误杀', () => {
    const bad = '<button id="f2-sim">模拟失败</button>'
    expect(detectAntidegrade({ artifact: bad, caps: [] }).map((f) => f.code)).toContain('cheat-control')
    expect(detectAntidegrade({ artifact: '<button>模拟用户输入</button>', caps: [] })).toEqual([])
    expect(detectAntidegrade({ artifact: 'const engine = simulatePhysics(dt)', caps: [] })).toEqual([])
  })
})

describe('buildSemanticJudgeSystemPrompt（prompt 反退化规则装配）', () => {
  it('off=内置常量字节级；on=追加三条规则', () => {
    expect(buildSemanticJudgeSystemPrompt()).toBe(SEMANTIC_JUDGE_SYSTEM_PROMPT)
    vi.stubEnv('BLOMA_JUDGE_ANTIDEGRADE', '1')
    const prompt = buildSemanticJudgeSystemPrompt()
    expect(prompt.startsWith(SEMANTIC_JUDGE_SYSTEM_PROMPT)).toBe(true)
    expect(prompt).toContain('CRUD 闭环 ≠ 能力完成')
    expect(prompt).toContain('证据不足不得判 implemented')
    expect(prompt).toContain('无需求依据控件直接判 deviated')
  })
})

describe('runJudge 集成（门禁自测：坏实现被拒）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  function setupProject(artifactHtml: string): string {
    const home = mkdtempSync(join(tmpdir(), 'proma-antidegrade-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-ad', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: 'AI 智能总结笔记' }])
    syncDocuments({ request_id: 'req-ad', session_id: 's', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
    // 直接写 prd.json（mvp_before_generation 检查点不落盘，sketch_confirmed 才写；
    // readPrdBackplane 见到文件即读）——模拟 BLOMA_CAP_CONTRACT=on 产出的含 CAP 背板
    const prdPath = join(home, 'agent-workspaces', project.workspace_slug, 'documents', project.project_id, 'prd.json')
    writeFileSync(
      prdPath,
      JSON.stringify({
        project_id: project.project_id,
        name: project.name,
        positioning: 'AI 智能总结笔记',
        requirements: [{ id: 'F-001', description: 'AI 智能总结笔记', priority: 'P0' }],
        acceptance: {},
        out_of_scope: [],
        assumptions: [],
        ai_capabilities: [cap],
      }),
      'utf8',
    )
    writeFileSync(join(project.root_path, 'index.html'), artifactHtml, 'utf8')
    return project.project_id
  }

  it('开关 off：坏实现也不追加反退化约束（字节级现状回归锁）', () => {
    const projectId = setupProject('<div>总结：今天记了 3 条</div>')
    const verdict = runJudge({ project_id: projectId, mode: 'quick' })
    expect(verdict.hard_constraints.map((c) => c.name)).not.toContain('能力反退化（已知坏实现）')
  })

  it('开关 on：固定 AI 回答（有 CAP 无 /api/llm）→ 反退化硬约束失败，verdict=return', () => {
    vi.stubEnv('BLOMA_JUDGE_ANTIDEGRADE', '1')
    const projectId = setupProject('<div>AI 总结区</div><script>render("固定总结文案")</script>')
    const verdict = runJudge({ project_id: projectId, mode: 'quick' })
    const constraint = verdict.hard_constraints.find((c) => c.name === '能力反退化（已知坏实现）')
    expect(constraint).toBeDefined()
    expect(constraint!.passed).toBe(false)
    expect(constraint!.detail).toContain('/api/llm')
    expect(verdict.verdict).toBe('return')
  })

  it('开关 on：模拟失败教学控件 → 反退化硬约束失败', () => {
    vi.stubEnv('BLOMA_JUDGE_ANTIDEGRADE', '1')
    const projectId = setupProject("<div>笔记</div><button>模拟失败</button><script>fetch('/api/llm')</script>")
    const verdict = runJudge({ project_id: projectId, mode: 'quick' })
    const constraint = verdict.hard_constraints.find((c) => c.name === '能力反退化（已知坏实现）')
    expect(constraint!.passed).toBe(false)
    expect(constraint!.detail).toContain('模拟失败')
  })

  it('开关 on：合法 AI 接入 → 反退化约束通过（不误杀）', () => {
    vi.stubEnv('BLOMA_JUDGE_ANTIDEGRADE', '1')
    const projectId = setupProject(
      `<div id="result"></div><script>fetch('/api/llm',{method:'POST',body:JSON.stringify({messages:[{role:'user',content:note}]})}).then(r=>r.json()).then(d=>render(d.content))</script>`,
    )
    const verdict = runJudge({ project_id: projectId, mode: 'quick' })
    const constraint = verdict.hard_constraints.find((c) => c.name === '能力反退化（已知坏实现）')
    expect(constraint).toBeDefined()
    expect(constraint!.passed).toBe(true)
  })
})
