import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncDocuments } from '../../../main/document-engine'
import { writeTestReport, runGwtScenarios } from '../../../main/gwt-service'
import { generateMvp } from '../../../main/mvp-engine'
import { createProject, findProject, recordSketchGenerated } from '../../../main/project-service'
import { getDocumentsDir } from '../../../storage/config-paths'

/**
 * Sprint 2 · S2-JUDGE-009 MVP 生成后自动生成并执行 GWT
 *
 * 文档依据：
 * - generation-workflow.feature @S2-JUDGE-009：每个 P0 功能项至少对应 1 个 GWT 场景；
 *   系统记录测试总数、通过数和失败数；测试结果写入文档目录
 * - api-spec §10.1 document:sync（mvp_before_generation → PRD + GWT 骨架；mvp_tested → 测试报告挂载）
 * - api-spec §12.4 run_gwt_tests（total_count/passed_count/failed_count/failure_summary）
 */
describe('Sprint 2 GWT execution acceptance (S2-JUDGE-009)', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string | undefined

  afterEach(() => {
    if (home) {
      const { rmSync } = require('node:fs')
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
    process.env.PROMA_HOME = originalPromaHome
    home = undefined
  })

  function setup(prefix: string): string {
    home = mkdtempSync(join(tmpdir(), prefix))
    process.env.PROMA_HOME = home
    return home
  }

  it('[S2-JUDGE-009] MVP 生成后应为每个 P0 功能项生成 GWT 场景并写入文档目录', () => {
    const homeDir = setup('bloma-s2-gwt-docs-')
    const project = createProject({ request_id: 's2-project', mode: 'quick' })
    const requirements = [
      { id: 'F-001', description: '记录收入与支出' },
      { id: 'F-002', description: '展示本月结余' },
      { id: 'F-003', description: '按分类查看流水' },
    ]
    recordSketchGenerated(project.project_id, requirements)

    // ① mvp_before_generation：DocumentEngine 生成 PRD 完整功能项 + GWT 骨架
    const result = syncDocuments({
      request_id: 's2-doc',
      session_id: 's2-session',
      project_id: project.project_id,
      checkpoint: 'mvp_before_generation',
    })

    // 每个 P0 功能项至少 1 个 feature 文件
    const docsDir = getDocumentsDir(project.workspace_slug, project.project_id)
    for (const req of requirements) {
      expect(existsSync(join(docsDir, 'features', `${req.id}.feature`))).toBe(true)
    }
    expect(result.documents.some((doc) => doc.type === 'gwt_feature')).toBe(true)
    expect(result.documents.some((doc) => doc.type === 'prd')).toBe(true)
    expect(readFileSync(join(docsDir, 'mvp_before_generation.md'), 'utf8')).toContain('F-003')
  })

  it('[S2-JUDGE-009b] GWT 执行结果记录 total/passed/failed 并写入 test-report 文档', async () => {
    const homeDir = setup('bloma-s2-gwt-run-')
    const project = createProject({ request_id: 's2-project', mode: 'quick' })
    const requirements = [
      { id: 'F-001', description: '记录收入与支出' },
      { id: 'F-002', description: '展示本月结余' },
    ]
    recordSketchGenerated(project.project_id, requirements)
    syncDocuments({
      request_id: 's2-doc',
      session_id: 's2-session',
      project_id: project.project_id,
      checkpoint: 'mvp_before_generation',
    })
    // MVP 产物：index.html 包含全部功能项入口
    generateMvp({ project_id: project.project_id, requirements, template_type: 'web_fullstack' })
    // 用本地 http 服务模拟沙箱预览，返回包含功能入口的 HTML
    const { url: previewUrl, close } = await startPreviewServer('<p>记录收入与支出</p><p>展示本月结余</p>')
    try {

      // ② 执行 GWT 场景
      const result = await runGwtScenarios({
        project_id: project.project_id,
        session_id: 's2-session',
        preview_url: previewUrl,
      })

      // 记录测试总数、通过数和失败数
      expect(result.total_count).toBe(2)
      expect(result.passed_count).toBe(2)
      expect(result.failed_count).toBe(0)
      expect(result.failure_summary).toEqual([])

      // ③ 测试结果写入文档目录（test-report.json + test-report.md）
      const docsDir = getDocumentsDir(project.workspace_slug, project.project_id)
      const reportRef = writeTestReport({
        request_id: 's2-report',
        session_id: 's2-session',
        project_id: project.project_id,
        result,
      })
      expect(reportRef.type).toBe('test_report')
      expect(reportRef.status).toBe('synced')
      expect(existsSync(join(docsDir, 'test-report.json'))).toBe(true)
      expect(existsSync(join(docsDir, 'test-report.md'))).toBe(true)
      expect(readFileSync(join(docsDir, 'test-report.json'), 'utf8')).toContain('"passed_count": 2')
      expect(findProject(project.project_id).current_stage).toBe('clarifying')
    } finally {
      close()
    }
  })
})

async function startPreviewServer(html: string): Promise<{ url: string; close: () => void }> {
  // 避免顶部引入 http，动态加载以保持测试边界清晰
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createServer } = require('node:http') as typeof import('node:http')
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() }
}
