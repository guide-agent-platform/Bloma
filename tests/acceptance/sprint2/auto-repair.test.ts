import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncDocuments } from '../../../main/document-engine'
import { runPostMvpTestingFlow, setProgrammingEventPublisher } from '../../../main/programming-orchestrator'
import { CircuitBreakSettledError } from '../../../main/recovery-service'
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
 * - 长期型改造 T5（guide-agent-长期型Agent改造任务清单-2026-08-15）：熔断从「回滚后仍让渡」
 *   升级为「回滚事务 + 阶段收敛」——回滚成功即按磁盘证据收敛阶段并清零修复计数（哨兵错误
 *   终结流程，上层不当失败处理）；让渡卡片仅在回滚失败/无健康快照时兜底。
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
    // 落一份完整产物（带交互入口）再拍健康快照：熔断回滚后按磁盘证据收敛为 ready（T5「阶段与磁盘一致」）
    mkdirSync(join(project.root_path, 'src'), { recursive: true })
    writeFileSync(
      join(project.root_path, 'index.html'),
      '<html><head><style>body{margin:0}</style></head><body><button id="add">记一笔</button><script src="src/app.js"></script></body></html>',
      'utf8',
    )
    writeFileSync(
      join(project.root_path, 'src', 'app.js'),
      "document.getElementById('add').addEventListener('click', () => {})",
      'utf8',
    )
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

  it('[S2-JUDGE-002] 连续 3 次修复失败后熔断回滚，项目回到健康快照且阶段与磁盘一致', async () => {
    const { projectId, snapshotId } = await setup('bloma-s2-repair-fuse-')
    const events: AgentEvent[] = []
    setProgrammingEventPublisher((event) => events.push(event))

    // 预览始终失败，3 次修复全部失败
    const previewUrl = await previewServer(() => '<html><body><h1>持续失败</h1></body></html>')

    // 熔断回滚成功即终结本流程（哨兵错误，上层不当普通失败处理）
    await expect(
      runPostMvpTestingFlow({
        request_id: 's2-flow',
        session_id: 's2-session',
        project_id: projectId,
        mode: 'quick',
        preview_url: previewUrl,
      }),
    ).rejects.toThrow(CircuitBreakSettledError)

    // ① 回滚 + 阶段收敛（T5：阶段与磁盘一致，而非只让渡）：恢复的是完整健康产物
    //    → ready；修复计数清零；不再弹 blocked 让渡卡（用户后续直接对话即可继续）
    expect(findProject(projectId).current_stage).toBe('ready')
    expect(findProject(projectId).test_repair_count ?? 0).toBe(0)
    expect(events.some((event) => event.type === 'user_decision_required')).toBe(false)

    // ② 每次修复尝试发布一次 repairing 事件；第 4 次是"已达上限"通知（不新增修复尝试）
    expect(events.filter((event) => event.type === 'repairing').length).toBeLessThanOrEqual(4)

    // ③ 向导告知内容没有丢失（用户可见文案不含失败堆栈）
    const serialized = JSON.stringify(events)
    expect(serialized).not.toMatch(/node_modules|Error: |at |TypeError|ReferenceError/)

    // ④ 熔断回滚到最近健康快照：下发 rollback_done + 落「内容未丢失」文案，
    //    并产出 rollback_guard 保护快照，且项目指针仍指向健康快照（PRD §13.4 / @S2-JUDGE-002）
    expect(events.some((event) => event.type === 'rollback_done')).toBe(true)
    expect(events.some((event) => event.type === 'message_delta' && String(event.payload.text).includes('回到之前的版本'))).toBe(true)
    expect(events.some((event) => event.type === 'message_delta' && String(event.payload.text).includes('内容都还在，没有丢失'))).toBe(true)
    expect(listSnapshots(projectId).some((snap) => snap.kind === 'rollback_guard')).toBe(true)
    expect(findProject(projectId).current_snapshot_id).toBe(snapshotId)
  })
})

function makeChildProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess
  Object.assign(emitter, { kill: vi.fn(() => true), pid: 1000 })
  return emitter
}
