import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncDocuments } from '../../../main/document-engine'
import { runPostMvpTestingFlow, setProgrammingEventPublisher } from '../../../main/programming-orchestrator'
import {
  clearSandboxRuntimeForTests,
  createSnapshot,
  listSnapshots,
  setSandboxRuntimeForTests,
  setSnapshotCaptureProviderForTests,
} from '../../../main/platform-services'
import { createProject, findProject, recordSketchGenerated, updateProject } from '../../../main/project-service'
import type { AgentEvent } from '../../../shared/types'

/**
 * Sprint 2 · S2-JUDGE-001 / S2-JUDGE-002 自动修复与熔断
 *
 * 文档依据：
 * - self-healing-judge.feature @S2-JUDGE-001：代码运行失败时自动修复，最多尝试 3 次，不展示堆栈
 * - self-healing-judge.feature @S2-JUDGE-002：第 3 次修复仍失败时熔断回滚最近健康快照，
 *   告知用户内容没有丢失，用户可选继续尝试/接受当前/补充说明
 * - component-design §7 修复计数（runtime/test 各 ≤3）
 * - api-spec §13 错误码 user_visible_message（不暴露堆栈）
 */
describe('Sprint 2 auto repair acceptance (S2-JUDGE-001 / S2-JUDGE-002)', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string | undefined
  let servers: Array<{ close: () => void }> = []

  afterEach(() => {
    for (const server of servers) server.close()
    servers = []
    if (home) {
      const { rmSync } = require('node:fs')
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
    process.env.PROMA_HOME = originalPromaHome
    home = undefined
    setProgrammingEventPublisher(() => undefined)
    clearSandboxRuntimeForTests()
    setSnapshotCaptureProviderForTests()
  })

  async function setup(prefix: string): Promise<{ projectId: string; snapshotId: string }> {
    home = mkdtempSync(join(tmpdir(), prefix))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 's2-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({
      request_id: 's2-doc',
      session_id: 's2-session',
      project_id: project.project_id,
      checkpoint: 'mvp_before_generation',
    })
    // 真实 runSketchTask 会落一份 sketch 快照并推进 current_snapshot_id；熔断回滚以此为健康目标。
    // 注入 mock 沙箱运行时 + 截图 provider，避免回滚里 runSandbox 起真实进程/等待超时。
    setSandboxRuntimeForTests({
      portAllocator: async () => 3201,
      healthCheck: async () => true,
      processFactory: () => makeChildProcess(),
    })
    setSnapshotCaptureProviderForTests(async () => ({ extension: 'png', buffer: Buffer.from('fake-png') }))
    const snapshot = await createSnapshot({
      request_id: 's2-snapshot',
      project_id: project.project_id,
      kind: 'sketch',
      summary: '记录收入与支出的验证草图',
      include_documents: false,
      health_status: 'healthy',
    })
    updateProject(project.project_id, { current_snapshot_id: snapshot.snapshot_id })
    return { projectId: project.project_id, snapshotId: snapshot.snapshot_id }
  }

  async function previewServer(htmlProvider: () => string): Promise<string> {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(htmlProvider())
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const address = server.address() as AddressInfo
    return `http://127.0.0.1:${address.port}`
  }

  it('[S2-JUDGE-001] 运行失败时自动修复并在 3 次内恢复，且用户事件不含堆栈', async () => {
    const { projectId } = await setup('bloma-s2-repair-ok-')
    const events: AgentEvent[] = []
    setProgrammingEventPublisher((event) => events.push(event))

    // 预览先失败 N 次，之后恢复正常（模拟自动修复后运行成功）
    let requestCount = 0
    const previewUrl = await previewServer(() => {
      requestCount += 1
      return requestCount >= 3 ? '<html><body><p>记录收入与支出</p></body></html>' : '<html><body><h1>加载中</h1></body></html>'
    })

    const result = await runPostMvpTestingFlow({
      request_id: 's2-flow',
      session_id: 's2-session',
      project_id: projectId,
      mode: 'quick',
      preview_url: previewUrl,
    })

    // 自动修复后回到测试并最终进入裁判/ready
    expect(result.verdict).toBe('ready')
    // 修复循环触发了 repairing 事件，但最终计数归零
    expect(events.filter((event) => event.type === 'repairing').length).toBeGreaterThan(0)
    expect(findProject(projectId).current_stage).toBe('ready')
    expect(findProject(projectId).test_repair_count ?? 0).toBe(0)

    // 用户可见事件不包含堆栈/内部标识
    const serialized = JSON.stringify(events)
    expect(serialized).not.toMatch(/node_modules|Error: |at |TypeError|ReferenceError/)
  })

  it('[S2-JUDGE-002] 连续 3 次修复失败后熔断，通知用户内容未丢失并提供继续/接受/补充选项', async () => {
    const { projectId, snapshotId } = await setup('bloma-s2-repair-fuse-')
    const events: AgentEvent[] = []
    setProgrammingEventPublisher((event) => events.push(event))

    // 预览始终失败，3 次修复全部失败
    const previewUrl = await previewServer(() => '<html><body><h1>持续失败</h1></body></html>')

    const result = await runPostMvpTestingFlow({
      request_id: 's2-flow',
      session_id: 's2-session',
      project_id: projectId,
      mode: 'quick',
      preview_url: previewUrl,
    })

    // ① 停止继续自动修复：进入 blocked_for_user_decision，修复计数达到上限 3
    expect(result.verdict).toBe('blocked')
    expect(findProject(projectId).current_stage).toBe('blocked_for_user_decision')
    // 真实修复尝试恰好 3 次（test_repair_count 达到上限）
    expect(findProject(projectId).test_repair_count ?? 0).toBe(3)

    // ② 每次修复尝试发布一次 repairing 事件；第 4 次是"已达上限"通知（不新增修复尝试）
    expect(events.filter((event) => event.type === 'repairing').length).toBeLessThanOrEqual(4)

    // ③ user_decision_required：用户可选择继续尝试/接受当前/补充说明
    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision).toBeTruthy()
    const questions = decision?.payload.questions as Array<{ label: string }> | undefined
    expect(questions?.map((q) => q.label)).toEqual(
      expect.arrayContaining(['继续尝试', '接受现状', '补充说明']),
    )

    // ④ 向导告知内容没有丢失（用户可见文案不含失败堆栈）
    const serialized = JSON.stringify(events)
    expect(serialized).not.toMatch(/node_modules|Error: |at |TypeError|ReferenceError/)

    // ⑤ 熔断回滚到最近健康快照：下发 rollback_done + 落「内容未丢失」文案，
    //    并产出 rollback_guard 保护快照，且项目指针仍指向健康快照（PRD §13.4 / @S2-JUDGE-002）
    expect(events.some((event) => event.type === 'rollback_done')).toBe(true)
    expect(events.some((event) => event.type === 'message_delta' && String(event.payload.text).includes('回到之前的版本'))).toBe(true)
    expect(listSnapshots(projectId).some((snap) => snap.kind === 'rollback_guard')).toBe(true)
    expect(findProject(projectId).current_snapshot_id).toBe(snapshotId)
  })
})

function makeChildProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess
  Object.assign(emitter, { kill: vi.fn(() => true), pid: 1000 })
  return emitter
}
