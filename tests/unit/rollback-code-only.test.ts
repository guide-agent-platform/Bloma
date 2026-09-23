import { restorePromaHome } from '../support/proma-home-guard'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProject, findProject } from '../../main/project/project-service'
import { recordSessionActivity } from '../../main/platform/sessions/session-service'
import { clearSandboxRuntimeForTests, setSandboxRuntimeForTests } from '../../main/delivery/sandbox'
import { createSnapshot, restoreSnapshotFiles, rollbackCodeOnlyEnabled } from '../../main/delivery/snapshots'

/**
 * Phase 10 W1-2（2026-09-16，咨询 G 收口）：回滚语义修复——代码与数据分离。
 * BLOMA_ROLLBACK_CODE_ONLY 缺省 off=字节级现状（data/ 随快照精确回滚，
 * snapshot-data-rollback.test.ts 的既有锁继续钉 off 路径）；on=data/ 先备份到
 * data-backups/<快照短id>-<时间戳>/ 再保护性保留——回滚只回代码与文档。
 * 背景：真实使用语义下「data/ 精确回滚」会把用户数周积累的真实数据随熔断回滚
 * 静默还原（3b6f987 的能力在沙箱是卖点、在真实使用是事故）。
 */
describe('rollback code/data 分离（BLOMA_ROLLBACK_CODE_ONLY）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalSwitch = process.env.BLOMA_ROLLBACK_CODE_ONLY

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    clearSandboxRuntimeForTests()
    if (originalSwitch === undefined) delete process.env.BLOMA_ROLLBACK_CODE_ONLY
    else process.env.BLOMA_ROLLBACK_CODE_ONLY = originalSwitch
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
      portAllocator: async () => 3213,
      healthCheck: async () => true,
    })
  }

  it('开关缺省 off；1/on/true 开；0/off/false 关', () => {
    delete process.env.BLOMA_ROLLBACK_CODE_ONLY
    expect(rollbackCodeOnlyEnabled()).toBe(false)
    process.env.BLOMA_ROLLBACK_CODE_ONLY = '1'
    expect(rollbackCodeOnlyEnabled()).toBe(true)
    process.env.BLOMA_ROLLBACK_CODE_ONLY = 'false'
    expect(rollbackCodeOnlyEnabled()).toBe(false)
    process.env.BLOMA_ROLLBACK_CODE_ONLY = 'true'
    expect(rollbackCodeOnlyEnabled()).toBe(true)
    process.env.BLOMA_ROLLBACK_CODE_ONLY = '0'
    expect(rollbackCodeOnlyEnabled()).toBe(false)
  })

  it('off=字节级现状：data/ 随快照精确回滚（新增被删、改写还原）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-rco-off-'))
    process.env.PROMA_HOME = home
    delete process.env.BLOMA_ROLLBACK_CODE_ONLY
    injectFakeSandboxRuntime()
    const project = createProject({ request_id: 'req-create', mode: 'quick' })
    recordSessionActivity('session-rco', project.project_id)
    const root = findProject(project.project_id).root_path
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'notes.json'), 'v1', 'utf8')
    writeFileSync(join(root, 'index.html'), '<html>v1</html>', 'utf8')
    const snapshot = await createSnapshot({
      request_id: 'req-snap', project_id: project.project_id, kind: 'mvp',
      summary: 'off 路径快照', include_documents: false, health_status: 'healthy',
    })
    writeFileSync(join(root, 'data', 'notes.json'), 'v2-用户新增数据', 'utf8')
    writeFileSync(join(root, 'data', 'extra.json'), '快照后新增', 'utf8')
    writeFileSync(join(root, 'index.html'), '<html>v2</html>', 'utf8')
    await restoreSnapshotFiles({ request_id: 'req-r', project_id: project.project_id, snapshot_id: snapshot.snapshot_id })
    expect(readFileSync(join(root, 'data', 'notes.json'), 'utf8')).toBe('v1')
    expect(existsSync(join(root, 'data', 'extra.json'))).toBe(false)
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('<html>v1</html>')
  })

  it('on=data/ 保留回滚前状态+备份生成（内容=回滚前 data）+代码仍精确回滚', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-rco-on-'))
    process.env.PROMA_HOME = home
    process.env.BLOMA_ROLLBACK_CODE_ONLY = '1'
    injectFakeSandboxRuntime()
    const project = createProject({ request_id: 'req-create', mode: 'quick' })
    recordSessionActivity('session-rco', project.project_id)
    const root = findProject(project.project_id).root_path
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'notes.json'), 'v1', 'utf8')
    writeFileSync(join(root, 'index.html'), '<html>v1</html>', 'utf8')
    const snapshot = await createSnapshot({
      request_id: 'req-snap', project_id: project.project_id, kind: 'mvp',
      summary: 'on 路径快照', include_documents: false, health_status: 'healthy',
    })
    // 用户在快照后积累真实数据 + 代码被改坏
    writeFileSync(join(root, 'data', 'notes.json'), 'v1+用户积累', 'utf8')
    writeFileSync(join(root, 'data', 'new-record.json'), '回滚前新数据', 'utf8')
    writeFileSync(join(root, 'index.html'), '<html>broken</html>', 'utf8')

    await restoreSnapshotFiles({ request_id: 'req-r', project_id: project.project_id, snapshot_id: snapshot.snapshot_id })

    // 代码精确回滚；data/ 保留回滚前状态（用户数据不丢）
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('<html>v1</html>')
    expect(readFileSync(join(root, 'data', 'notes.json'), 'utf8')).toBe('v1+用户积累')
    expect(readFileSync(join(root, 'data', 'new-record.json'), 'utf8')).toBe('回滚前新数据')
    // 备份目录生成且内容=回滚前 data（双保险：恢复后 data 不可读时人工取回）
    const backupsRoot = join(root, 'data-backups')
    expect(existsSync(backupsRoot)).toBe(true)
    const backups = readdirSync(backupsRoot)
    expect(backups.length).toBe(1)
    expect(backups[0].startsWith(snapshot.snapshot_id.slice(0, 8))).toBe(true)
    expect(readFileSync(join(backupsRoot, backups[0], 'notes.json'), 'utf8')).toBe('v1+用户积累')
    expect(readFileSync(join(backupsRoot, backups[0], 'new-record.json'), 'utf8')).toBe('回滚前新数据')
  })

  it('on：二次回滚备份不覆盖（时间戳目录各自独立）+ data/ 始终保留最新', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-rco-twice-'))
    process.env.PROMA_HOME = home
    process.env.BLOMA_ROLLBACK_CODE_ONLY = '1'
    injectFakeSandboxRuntime()
    const project = createProject({ request_id: 'req-create', mode: 'quick' })
    recordSessionActivity('session-rco', project.project_id)
    const root = findProject(project.project_id).root_path
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'notes.json'), 'v0', 'utf8')
    const s1 = await createSnapshot({
      request_id: 'r', project_id: project.project_id, kind: 'mvp',
      summary: '一号快照', include_documents: false, health_status: 'healthy',
    })
    writeFileSync(join(root, 'data', 'notes.json'), 'v1', 'utf8')
    await restoreSnapshotFiles({ request_id: 'r1', project_id: project.project_id, snapshot_id: s1.snapshot_id })
    expect(readdirSync(join(root, 'data-backups')).length).toBe(1)
    writeFileSync(join(root, 'data', 'notes.json'), 'v2', 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 5)) // 时间戳防撞
    await restoreSnapshotFiles({ request_id: 'r2', project_id: project.project_id, snapshot_id: s1.snapshot_id })
    const backups = readdirSync(join(root, 'data-backups'))
    expect(backups.length).toBe(2)
    expect(readFileSync(join(root, 'data', 'notes.json'), 'utf8')).toBe('v2')
  })

  it('on：无 data/ 目录时不生成备份不报错（纯代码项目豁免）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-rco-nodata-'))
    process.env.PROMA_HOME = home
    process.env.BLOMA_ROLLBACK_CODE_ONLY = '1'
    injectFakeSandboxRuntime()
    const project = createProject({ request_id: 'req-create', mode: 'quick' })
    recordSessionActivity('session-rco', project.project_id)
    const root = findProject(project.project_id).root_path
    writeFileSync(join(root, 'index.html'), '<html>v1</html>', 'utf8')
    const snapshot = await createSnapshot({
      request_id: 'r', project_id: project.project_id, kind: 'mvp',
      summary: '无数据快照', include_documents: false, health_status: 'healthy',
    })
    writeFileSync(join(root, 'index.html'), '<html>v2</html>', 'utf8')
    await restoreSnapshotFiles({ request_id: 'r', project_id: project.project_id, snapshot_id: snapshot.snapshot_id })
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('<html>v1</html>')
    expect(existsSync(join(root, 'data-backups'))).toBe(false)
  })
})
