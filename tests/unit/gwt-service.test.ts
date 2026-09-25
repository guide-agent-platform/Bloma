import { restorePromaHome } from '../support/proma-home-guard'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { readTestReport, runGwtScenarios, writeTestReport } from '../../main/verification/gwt-service'
import { setBrowserGwtDisabledForTests } from '../../main/verification/gwt-runner'
import { createProject, recordSketchGenerated } from '../../main/project/project-service'
import { getAnalyticsPath, getDocumentsDir } from '../../storage/config-paths'

describe('GWT service (A2-07)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    setBrowserGwtDisabledForTests(false)
  })

  it('marks scenarios passed when the preview serves every P0 feature entry', async () => {
    // mock 产物只喂静态词表（无真实交互元素），固定走静态兜底（模拟 chromium 不可用）
    setBrowserGwtDisabledForTests(true)
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

  it('LLM 产物功能断言：预览含交互控件 + src/app.js 含脚本逻辑 → 全部通过（A2-14b）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-gwt-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    // 模型产物的 index.html 不含需求描述原文，靠领域无关的交互断言而非原文匹配判定通过
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    const server = createServer((req, res) => {
      if (req.url === '/src/app.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' })
        res.end("document.querySelector('button').addEventListener('click', function () {})")
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><button>开始使用</button></body></html>')
      }
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

  it('W5：test-report.json 被熔断回滚清除 → 回退 analytics test_completed 事件还原失败清单（append-only 不受回滚影响）', () => {
    const project = createProject({ request_id: 'req-fallback', mode: 'quick' })
    // 不写 test-report.json（模拟回滚清除）；只落 analytics 事件
    const analyticsLine = JSON.stringify({
      event_type: 'test_completed',
      project_id: project.project_id,
      payload: {
        total_count: 10,
        passed_count: 9,
        failed_count: 1,
        failures: [{ scenario: 'API 契约端点：GET /api/records', reason: '契约端点失活（HTTP 404）' }],
      },
    })
    const analyticsPath = getAnalyticsPath(project.workspace_slug)
    mkdirSync(dirname(analyticsPath), { recursive: true })
    writeFileSync(analyticsPath, `${analyticsLine}${String.fromCharCode(10)}`, 'utf8')

    const report = readTestReport(project.project_id)
    expect(report).not.toBeNull()
    expect(report!.failed_count).toBe(1)
    expect(report!.failure_summary[0].scenario).toContain('GET /api/records')
    // 无文件且无事件的取不到（如实 null）
    const bare = createProject({ request_id: 'req-bare', mode: 'quick' })
    expect(readTestReport(bare.project_id)).toBeNull()
  })
})

describe('产物入口指纹（挂账②：报告带指纹+新鲜度校验）', () => {
  it('computeEntryFingerprint：多文件聚合稳定（同内容同序同哈希；改一字节即变；index 缺失为 null）', async () => {
    const { computeEntryFingerprint } = await import('../../main/verification/gwt-service')
    const fs = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = fs.mkdtempSync(join(tmpdir(), 'fp-'))
    fs.mkdirSync(join(root, 'src'), { recursive: true })
    fs.writeFileSync(join(root, 'index.html'), '<html>入口</html>')
    fs.writeFileSync(join(root, 'src', 'app.js'), 'console.log(1)')
    const a = computeEntryFingerprint(root)
    const b = computeEntryFingerprint(root)
    expect(a).not.toBeNull()
    expect(b).toEqual(a) // 确定性
    expect(a!.files).toBe(2)
    fs.writeFileSync(join(root, 'src', 'app.js'), 'console.log(2)') // 改一字节
    expect(computeEntryFingerprint(root)!.sha256).not.toBe(a!.sha256)
    fs.rmSync(join(root, 'index.html'))
    expect(computeEntryFingerprint(root)).toBeNull() // 无入口
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('同名文件挪位改变指纹（路径参与哈希）', async () => {
    const { computeEntryFingerprint } = await import('../../main/verification/gwt-service')
    const fs = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = fs.mkdtempSync(join(tmpdir(), 'fp2-'))
    fs.mkdirSync(join(root, 'src', 'sub'), { recursive: true })
    fs.writeFileSync(join(root, 'index.html'), '<html></html>')
    fs.writeFileSync(join(root, 'src', 'a.js'), 'X')
    const a = computeEntryFingerprint(root)
    fs.renameSync(join(root, 'src', 'a.js'), join(root, 'src', 'sub', 'a.js')) // 挪位
    expect(computeEntryFingerprint(root)!.sha256).not.toBe(a!.sha256)
    fs.rmSync(root, { recursive: true, force: true })
  })
})
