import { restorePromaHome } from '../support/proma-home-guard'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProject, findProject } from '../../main/project/project-service'
import { recordSessionActivity } from '../../main/platform/sessions/session-service'
import { clearSandboxRuntimeForTests, setSandboxRuntimeForTests } from '../../main/delivery/sandbox'
import { createSnapshot, restoreSnapshotFiles } from '../../main/delivery/snapshots'

/**
 * 完整程序阶段 3（2026-09-06）：data/ 运行数据纳入快照/回滚语义锁定。
 * 恢复原语 =「先清空再复制」——回滚后 data/ 必须精确回到快照时点：
 * 快照后新增的数据文件被删除、被改写的数据文件还原（前后端分离产物
 * 的数据随版本走，这是「重启不丢」与「回滚即回滚」的两半保证）。
 */
describe('snapshot/rollback data/ 语义', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    clearSandboxRuntimeForTests()
  })

  function injectFakeSandboxRuntime(): void {
    setSandboxRuntimeForTests({
      processFactory: () =>
        ({
          stdout: { on: () => undefined },
          stderr: { on: () => undefined },
          once: () => undefined,
          kill: () => true,
        }) as unknown as ChildProcess,
      portAllocator: async () => 3211,
      healthCheck: async () => true,
    })
  }

  it('回滚后 data/ 精确回到快照时点：快照后新增的文件被删、被改的文件还原', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-data-rollback-'))
    process.env.PROMA_HOME = home
    injectFakeSandboxRuntime()
    const project = createProject({ request_id: 'req-create', mode: 'quick' })
    recordSessionActivity('session-data', project.project_id)
    const root = findProject(project.project_id).root_path

    // 快照时点：data/notes.json 为 v1
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'notes.json'), JSON.stringify([{ id: '1', text: 'v1' }]), 'utf8')
    const snapshot = await createSnapshot({
      request_id: 'req-snap',
      project_id: project.project_id,
      kind: 'mvp',
      summary: '含 data 的 MVP 快照',
      include_documents: false,
      health_status: 'healthy',
    })

    // 快照之后：改写 v1、新增 extra.json
    writeFileSync(join(root, 'data', 'notes.json'), JSON.stringify([{ id: '1', text: 'v2-已改' }, { id: '2', text: '新增' }]), 'utf8')
    writeFileSync(join(root, 'data', 'extra.json'), JSON.stringify({ later: true }), 'utf8')
    expect(existsSync(join(root, 'data', 'extra.json'))).toBe(true)

    await restoreSnapshotFiles({ request_id: 'req-restore', project_id: project.project_id, snapshot_id: snapshot.snapshot_id })

    // 精确回快照时点：被改的还原、新增的删除
    const restored = JSON.parse(readFileSync(join(root, 'data', 'notes.json'), 'utf8')) as Array<{ id: string; text: string }>
    expect(restored).toEqual([{ id: '1', text: 'v1' }])
    expect(existsSync(join(root, 'data', 'extra.json'))).toBe(false)
  })
})

describe('归档快照回滚可达（全链路审查 P1-14 修复，2026-10-01）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    clearSandboxRuntimeForTests()
    delete process.env.BLOMA_SNAPSHOT_CAP
  })

  const injectFakeSandboxRuntime = (): void => {
    setSandboxRuntimeForTests({
      processFactory: () =>
        ({
          stdout: { on: () => undefined },
          stderr: { on: () => undefined },
          once: () => undefined,
          kill: () => true,
        }) as unknown as ChildProcess,
      portAllocator: async () => 3212,
      healthCheck: async () => true,
    })
  }

  it('容量治理归档后的快照仍可恢复：ensureSnapshotActive 自动搬回活跃集再回滚', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-archive-rollback-'))
    process.env.PROMA_HOME = home
    injectFakeSandboxRuntime()
    const project = createProject({ request_id: 'req-create', mode: 'quick' })
    recordSessionActivity('session-archive', project.project_id)
    const root = findProject(project.project_id).root_path
    writeFileSync(join(root, 'index.html'), '<html><body>v1</body></html>', 'utf8')

    const snapshot = await createSnapshot({
      request_id: 'req-snap',
      project_id: project.project_id,
      kind: 'mvp',
      summary: '待归档的旧快照',
      include_documents: false,
      health_status: 'healthy',
    })

    // 手工把该快照搬进 archive/ 模拟容量治理结果（与 enforceSnapshotCapacity 同构）
    const { getSnapshotsDir } = await import('../../storage/config-paths')
    const proj = findProject(project.project_id)
    const dir = getSnapshotsDir(proj.workspace_slug, proj.project_id)
    const { renameSync, mkdirSync: mkdir, existsSync: exists } = await import('node:fs')
    const { join: joinPath } = await import('node:path')
    mkdir(joinPath(dir, 'archive'), { recursive: true })
    renameSync(joinPath(dir, snapshot.snapshot_id), joinPath(dir, 'archive', snapshot.snapshot_id))
    renameSync(joinPath(dir, `${snapshot.snapshot_id}.json`), joinPath(dir, 'archive', `${snapshot.snapshot_id}.json`))

    // 快照之后写入新内容（回滚应还原 v1）
    writeFileSync(join(root, 'index.html'), '<html><body>v2-new</body></html>', 'utf8')

    // 归档快照直接恢复：不再 SNAPSHOT_NOT_FOUND，而是搬回后正常恢复
    await restoreSnapshotFiles({ request_id: 'req-restore', project_id: project.project_id, snapshot_id: snapshot.snapshot_id })
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('<html><body>v1</body></html>')
    // 搬回后活跃索引恢复存在
    expect(exists(joinPath(dir, `${snapshot.snapshot_id}.json`))).toBe(true)
  })
})
