import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readTestReport, runGwtScenarios, writeTestReport } from '../../main/gwt-service'
import { createProject, recordSketchGenerated } from '../../main/project-service'
import { getDocumentsDir } from '../../storage/config-paths'

describe('GWT service (A2-07)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  it('marks scenarios passed when the preview serves every P0 feature entry', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-gwt-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body><p>记录收入与支出</p></body></html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const result = await runGwtScenarios({
        project_id: project.project_id,
        session_id: 'session-1',
        preview_url: `http://127.0.0.1:${port}`,
      })
      expect(result.total_count).toBe(1)
      expect(result.passed_count).toBe(1)
      expect(result.failed_count).toBe(0)
      expect(result.failure_summary).toEqual([])
    } finally {
      server.close()
    }
  })

  it('reports failures with P0-readable reasons when the page lacks a feature entry', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-gwt-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body><h1>空白页</h1></body></html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const result = await runGwtScenarios({
        project_id: project.project_id,
        session_id: 'session-1',
        preview_url: `http://127.0.0.1:${port}`,
      })
      expect(result.passed_count).toBe(0)
      expect(result.failed_count).toBe(1)
      expect(result.failure_summary[0].scenario).toContain('F-001')
      expect(result.failure_summary[0].reason).toContain('缺少功能入口')
      expect(JSON.stringify(result)).not.toMatch(/node_modules|Error:|at /)
    } finally {
      server.close()
    }
  })

  it('writes the test report as the authoritative document and reads it back', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-gwt-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const result = {
      total_count: 2,
      passed_count: 1,
      failed_count: 1,
      failure_summary: [{ scenario: 'F-001 核心路径可运行', reason: '页面缺少功能入口' }],
    }

    const ref = writeTestReport({ request_id: 'req-report', session_id: 'session-1', project_id: project.project_id, result })
    expect(ref.type).toBe('test_report')
    expect(ref.status).toBe('synced')

    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    expect(readFileSync(join(dir, 'test-report.json'), 'utf8')).toContain('passed_count')
    expect(readFileSync(join(dir, 'test-report.md'), 'utf8')).toContain('测试报告')
    expect(readTestReport(project.project_id)).toEqual(result)
  })
})
