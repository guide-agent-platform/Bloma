import { restorePromaHome } from '../../support/proma-home-guard'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncDocuments } from '../../../main/document-engine'
import { runJudge } from '../../../main/review/judge-engine'
import { createProject, recordSketchGenerated } from '../../../main/project-service'
import { getDocumentsDir } from '../../../storage/config-paths'

/**
 * Sprint 2 · S2-JUDGE-003 / S2-JUDGE-004 裁判硬约束
 *
 * 文档依据：
 * - self-healing-judge.feature @S2-JUDGE-003：裁判硬约束失败时输出 "return" 判定，
 *   报告列出不通过项，且裁判不执行修复
 * - self-healing-judge.feature @S2-JUDGE-004：每个 PRD 功能项必须有 GWT 场景，
 *   缺失时裁判标记缺失项并输出 "return"
 * - component-design §10 JudgeEngine：任一硬约束失败 → 退回（return）
 * - PRD §10.1：裁判是流程门禁，不参与修复
 */
describe('Sprint 2 judge hard constraints acceptance (S2-JUDGE-003 / S2-JUDGE-004)', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string | undefined

  afterEach(() => {
    if (home) {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
    restorePromaHome(originalPromaHome)
    home = undefined
  })

  function setup(prefix: string): void {
    home = mkdtempSync(join(tmpdir(), prefix))
    process.env.PROMA_HOME = home
  }

  it('[S2-JUDGE-003] PRD 缺少核心功能描述时裁判返回 return 且不执行修复', () => {
    setup('bloma-s2-judge-hard-')
    const project = createProject({ request_id: 's2-project', mode: 'quick' })

    // ① 无任何已确认需求 → 硬约束"PRD 核心功能项"失败
    const verdict = runJudge({ project_id: project.project_id, mode: 'quick' })

    expect(verdict.verdict).toBe('return')
    // 报告列出不通过项
    expect(verdict.hard_constraints.length).toBeGreaterThan(0)
    expect(verdict.hard_constraints.every((constraint) => constraint.passed)).toBe(false)
    expect(verdict.hard_constraints.find((constraint) => constraint.name === 'PRD 核心功能项')?.passed).toBe(false)
    // 用户可见摘要可读，不含技术堆栈
    expect(verdict.user_visible_summary).toBeTruthy()
    expect(verdict.user_visible_summary).not.toMatch(/node_modules|Error: |at |TypeError/)

    // ② 裁判只判定不修复：文档目录不产生任何同步产物，项目根不写文件
    const docsDir = getDocumentsDir(project.workspace_slug, project.project_id)
    expect(existsSync(join(docsDir, 'sketch_confirmed.md'))).toBe(false)
    expect(existsSync(join(project.root_path, 'index.html'))).toBe(false)
  })

  it('[S2-JUDGE-004] PRD 功能项缺少 GWT 场景时裁判标记缺失项并返回 return', () => {
    setup('bloma-s2-judge-coverage-')
    const project = createProject({ request_id: 's2-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [
      { id: 'F-001', description: '记录收入与支出' },
      { id: 'F-002', description: '展示本月结余' },
      { id: 'F-003', description: '按分类查看流水' },
    ])
    // 只生成 F-001 / F-002 的 feature，F-003 缺失
    syncDocuments({
      request_id: 's2-doc',
      session_id: 's2-session',
      project_id: project.project_id,
      checkpoint: 'mvp_before_generation',
    })
    const docsDir = getDocumentsDir(project.workspace_slug, project.project_id)
    rmSync(join(docsDir, 'features', 'F-003.feature'))

    const verdict = runJudge({ project_id: project.project_id, mode: 'quick' })

    expect(verdict.verdict).toBe('return')
    const coverage = verdict.hard_constraints.find((constraint) => constraint.name === 'GWT 场景覆盖')
    expect(coverage?.passed).toBe(false)
    expect(coverage?.detail).toContain('F-003')
    // 有 GWT 场景的两个功能项仍被标记为已覆盖
    expect(coverage?.detail).not.toContain('F-001')
    expect(coverage?.detail).not.toContain('F-002')
  })

  it('[S2-JUDGE-004b] 全部功能项均有 GWT 场景且页面有入口时裁判判定通过', () => {
    setup('bloma-s2-judge-pass-')
    const project = createProject({ request_id: 's2-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({
      request_id: 's2-doc',
      session_id: 's2-session',
      project_id: project.project_id,
      checkpoint: 'mvp_before_generation',
    })
    writeFileSync(join(project.root_path, 'index.html'), '<p>记录收入与支出</p>', 'utf8')

    const verdict = runJudge({ project_id: project.project_id, mode: 'quick' })

    expect(verdict.verdict).toBe('pass')
    expect(verdict.hard_constraints.every((constraint) => constraint.passed)).toBe(true)
  })
})
