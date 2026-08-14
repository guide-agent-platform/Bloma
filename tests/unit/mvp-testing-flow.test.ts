import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  runPostMvpTestingFlow,
  setProgrammingEventPublisher,
} from '../../main/programming-orchestrator'
import { syncDocuments } from '../../main/document-engine'
import { createProject, findProject, recordSketchGenerated } from '../../main/project-service'

describe('Post-MVP testing flow (A2-09 state machine)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    setProgrammingEventPublisher(() => undefined)
  })

  it('reaches judge_review when all GWT scenarios pass on the first run', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-flow-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({ request_id: 'req-sync', session_id: 'session-1', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
    // 裁判（改造 E）读项目产物校验「代码交互入口」，须先落盘 index.html
    writeFileSync(join(project.root_path, 'index.html'), '<html><body><p>记录收入与支出</p></body></html>', 'utf8')
    const events: string[] = []
    setProgrammingEventPublisher((event) => events.push(event.type))

    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body><p>记录收入与支出</p></body></html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const result = await runPostMvpTestingFlow({
        request_id: 'req-flow',
        session_id: 'session-1',
        project_id: project.project_id,
        mode: 'quick',
        preview_url: `http://127.0.0.1:${port}`,
      })

      expect(result.verdict).toBe('ready')
      expect(result.test_result.failed_count).toBe(0)
      expect(events).toContain('stage_changed')
      expect(events).toContain('judge_result')
      expect(findProject(project.project_id).current_stage).toBe('ready')
    } finally {
      server.close()
    }
  })

  it('auto-repairs test failures (max 3), then reaches judge_review once the preview recovers', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-flow-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({ request_id: 'req-sync', session_id: 'session-1', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
    const events: string[] = []
    setProgrammingEventPublisher((event) => events.push(event.type))

    let requestCount = 0
    const server = createServer((req, res) => {
      // A2-14b：runGwtScenarios 现会额外同源拉取 /src/app.js（功能断言），
      // 这里仅对根 HTML 请求计数，避免 app.js 请求干扰「预览逐步恢复」的请求时序。
      if (req.url === '/src/app.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' })
        res.end('// no calculate here')
        return
      }
      requestCount += 1
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(requestCount >= 3 ? '<html><p>记录收入与支出</p></html>' : '<html><h1>加载中</h1></html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const result = await runPostMvpTestingFlow({
        request_id: 'req-flow',
        session_id: 'session-1',
        project_id: project.project_id,
        mode: 'quick',
        preview_url: `http://127.0.0.1:${port}`,
      })

      expect(result.verdict).toBe('ready')
      expect(events.filter((type) => type === 'repairing')).toHaveLength(2)
      expect(findProject(project.project_id).current_stage).toBe('ready')
      expect(findProject(project.project_id).test_repair_count).toBe(0)
    } finally {
      server.close()
    }
  })

  it('lets go to the user after 3 failed test repairs (blocked_for_user_decision)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-flow-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    setProgrammingEventPublisher((event) => events.push({ type: event.type, payload: event.payload as Record<string, unknown> }))

    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><h1>持续失败</h1></html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const result = await runPostMvpTestingFlow({
        request_id: 'req-flow',
        session_id: 'session-1',
        project_id: project.project_id,
        mode: 'quick',
        preview_url: `http://127.0.0.1:${port}`,
      })

      expect(result.verdict).toBe('blocked')
      expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')
      expect(findProject(project.project_id).test_repair_count).toBe(3)
      const decision = events.find((event) => event.type === 'user_decision_required')
      expect(decision).toBeTruthy()
      const questions = decision?.payload.questions as Array<{ label: string }> | undefined
      expect(questions?.map((q) => q.label)).toContain('继续尝试')
      expect(JSON.stringify(events)).not.toMatch(/node_modules|Error:|at /)
    } finally {
      server.close()
    }
  })
})
