import { restorePromaHome } from '../support/proma-home-guard'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProject, findProject } from '../../main/project/project-service'
import { clearSandboxRuntimeForTests, setSandboxRuntimeForTests } from '../../main/delivery/sandbox'
import { createSnapshot, listSnapshotDocuments, readSnapshotDocument, rollbackSnapshot } from '../../main/delivery/snapshots'
import { getDocumentsDir } from '../../storage/config-paths'

const FROZEN_CONTENT = `# Decisions 版本一\n- [decision] 禁止联网\n`

describe('T7 snapshot document versioning', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    clearSandboxRuntimeForTests()
  })

  function writeDecisions(projectId: string, workspaceSlug: string, content: string): void {
    const dir = getDocumentsDir(workspaceSlug, projectId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'decisions.md'), content)
  }

  it('freezes the current decisions.md at snapshot time and lists/reads the frozen copy', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-t7-freeze-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-t7-freeze', mode: 'quick' })
    writeDecisions(project.project_id, project.workspace_slug, FROZEN_CONTENT)

    const snapshot = await createSnapshot({
      request_id: 'req-t7-freeze-snap',
      project_id: project.project_id,
      kind: 'mvp',
      summary: 'freeze',
      include_documents: true,
      health_status: 'healthy',
    })

    // 快照元数据如实记录文档归档（T7：有才记，不谎报）
    expect(snapshot.documents_archive_path).toBeTruthy()
    expect(existsSync(snapshot.documents_archive_path!)).toBe(true)

    // 回看：frozen=true 且能列出冻结的 decisions（manifest 缺失时按已知文件探测兜底）
    const listed = listSnapshotDocuments(project.project_id, snapshot.snapshot_id)
    expect(listed.frozen).toBe(true)
    expect(listed.documents).toHaveLength(1)
    expect(listed.documents[0]).toMatchObject({
      document_id: 'decisions-log',
      type: 'decisions',
      file: 'decisions.md',
    })

    // 快照之后当前 decisions.md 继续演进 —— 回看的仍是冻结时的内容（版本化）
    const laterContent = `${FROZEN_CONTENT}- [decision] 新增第二条\n`
    writeDecisions(project.project_id, project.workspace_slug, laterContent)

    const frozenRead = readSnapshotDocument(project.project_id, snapshot.snapshot_id, 'decisions-log')
    expect(frozenRead.document.file).toBe('decisions.md')
    expect(frozenRead.content).toBe(FROZEN_CONTENT)

    const currentDir = getDocumentsDir(project.workspace_slug, project.project_id)
    expect(readFileSync(join(currentDir, 'decisions.md'), 'utf8')).toBe(laterContent)
  })

  it('reports frozen=false honestly for legacy snapshots without frozen documents', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-t7-legacy-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-t7-legacy', mode: 'quick' })
    writeDecisions(project.project_id, project.workspace_slug, FROZEN_CONTENT)

    // T7 前存量快照：include_documents=false
    const legacy = await createSnapshot({
      request_id: 'req-t7-legacy-snap',
      project_id: project.project_id,
      kind: 'mvp',
      summary: 'legacy',
      include_documents: false,
      health_status: 'healthy',
    })

    expect(legacy.documents_archive_path).toBeUndefined()
    expect(listSnapshotDocuments(project.project_id, legacy.snapshot_id)).toEqual({
      snapshot_id: legacy.snapshot_id,
      frozen: false,
      documents: [],
    })
    expect(() => readSnapshotDocument(project.project_id, legacy.snapshot_id, 'decisions-log')).toThrow(
      /SNAPSHOT_DOCUMENTS_NOT_FROZEN/,
    )
  })

  it('lists and reads manifest entries in subdirectories (features/) without basename flattening', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-t7-subdir-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-t7-subdir', mode: 'quick' })

    // 模拟 syncDocuments(mvp_before_generation) 的真实产物：子目录文件 + manifest 登记绝对路径
    const docsDir = getDocumentsDir(project.workspace_slug, project.project_id)
    mkdirSync(join(docsDir, 'features'), { recursive: true })
    const featurePath = join(docsDir, 'features', 'F-001.feature')
    writeFileSync(featurePath, '# GWT Feature F-001 frozen\n')
    writeFileSync(
      join(docsDir, '.document-manifest.json'),
      `${JSON.stringify({
        version: 1,
        documents: [
          {
            document_id: 'gwt-f001',
            path: featurePath,
            type: 'gwt_feature',
            checkpoint: 'mvp_before_generation',
            status: 'synced',
          },
        ],
      }, null, 2)}\n`,
      'utf8',
    )

    const snapshot = await createSnapshot({
      request_id: 'req-t7-subdir-snap',
      project_id: project.project_id,
      kind: 'mvp',
      summary: 'subdir',
      include_documents: true,
      health_status: 'healthy',
    })

    // 列表保留子目录相对路径（旧逻辑 basename 压平 → F-001.feature）
    const listed = listSnapshotDocuments(project.project_id, snapshot.snapshot_id)
    expect(listed.frozen).toBe(true)
    expect(listed.documents[0]).toMatchObject({
      document_id: 'gwt-f001',
      type: 'gwt_feature',
      file: 'features/F-001.feature',
    })

    // 回看读取成功（旧逻辑在此抛 DOCUMENT_NOT_FOUND，即 2026-08-29 线上主进程噪音）
    const read = readSnapshotDocument(project.project_id, snapshot.snapshot_id, 'gwt-f001')
    expect(read.content).toBe('# GWT Feature F-001 frozen\n')
    expect(read.document.file).toBe('features/F-001.feature')
  })

  it('rollback restores documents only when the target snapshot froze them', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-t7-rollback-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-t7-rollback', mode: 'quick' })

    // 冻结版（有文档）→ 演进 → 旧快照（无文档）
    writeDecisions(project.project_id, project.workspace_slug, FROZEN_CONTENT)
    const frozenSnap = await createSnapshot({
      request_id: 'req-t7-r1',
      project_id: project.project_id,
      kind: 'mvp',
      summary: 'with docs',
      include_documents: true,
      health_status: 'healthy',
    })
    writeDecisions(project.project_id, project.workspace_slug, `${FROZEN_CONTENT}- [decision] 演进\n`)
    const legacySnap = await createSnapshot({
      request_id: 'req-t7-r2',
      project_id: project.project_id,
      kind: 'mvp',
      summary: 'no docs',
      include_documents: false,
      health_status: 'healthy',
    })

    // rollbackSnapshot 会重启沙箱，注入假沙箱运行时
    setSandboxRuntimeForTests({
      portAllocator: async () => 3200,
      healthCheck: async () => true,
      processFactory: () => makeChildProcess().process,
    })

    // 回滚到冻结版：文档随回滚恢复
    const r1 = await rollbackSnapshot({
      request_id: 'req-t7-rb1',
      project_id: project.project_id,
      snapshot_id: frozenSnap.snapshot_id,
      reason: 'user_undo',
    })
    expect(r1.documents_restored).toBe(true)
    const currentDir = getDocumentsDir(project.workspace_slug, project.project_id)
    expect(readFileSync(join(currentDir, 'decisions.md'), 'utf8')).toBe(FROZEN_CONTENT)

    // 回滚到无冻结文档的存量快照：如实报告 false（不补造）
    const r2 = await rollbackSnapshot({
      request_id: 'req-t7-rb2',
      project_id: project.project_id,
      snapshot_id: legacySnap.snapshot_id,
      reason: 'user_undo',
    })
    expect(r2.documents_restored).toBe(false)
  }, 15_000)

  function makeChildProcess(): { process: ChildProcess; kill: ReturnType<typeof vi.fn> } {
    const emitter = new EventEmitter() as ChildProcess
    const kill = vi.fn(() => {
      emitter.emit('exit')
      return true
    })
    Object.assign(emitter, { kill, pid: 1000 })
    return { process: emitter, kill }
  }
})

// ===========================================================================
// Phase 7 U3 I6（2026-09-10）：恢复即新版本（BLOMA_RESTORE_AS_VERSION）
// ===========================================================================
describe('I6 restored 快照（恢复即新版本）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    clearSandboxRuntimeForTests()
    delete process.env.BLOMA_RESTORE_AS_VERSION
  })

  function makeChildProcess(): { process: ChildProcess } {
    const emitter = new EventEmitter() as ChildProcess
    Object.assign(emitter, { kill: () => { emitter.emit('exit'); return true }, pid: 1001 })
    return { process: emitter }
  }

  async function seedWithSnapshot(): Promise<{ projectId: string; snapshotId: string }> {
    const home = mkdtempSync(join(tmpdir(), 'proma-i6-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-i6', mode: 'quick' })
    writeFileSync(join(project.root_path, 'index.html'), '<html><body>v1</body></html>', 'utf8')
    const snap = await createSnapshot({
      request_id: 'req-i6-snap', project_id: project.project_id,
      kind: 'mvp', summary: '版本一', include_documents: true, health_status: 'healthy',
    })
    // 模拟版本二：回滚目标之后有新内容（guard 会保留）
    writeFileSync(join(project.root_path, 'index.html'), '<html><body>v2</body></html>', 'utf8')
    setSandboxRuntimeForTests({
      portAllocator: async () => 3201,
      healthCheck: async () => true,
      processFactory: () => makeChildProcess().process,
    })
    return { projectId: project.project_id, snapshotId: snap.snapshot_id }
  }

  it('开关 off（缺省）→ 回滚不拍 restored 快照（字节级现状回归锁）', async () => {
    const { projectId, snapshotId } = await seedWithSnapshot()
    const result = await rollbackSnapshot({ request_id: 'req-i6-off', project_id: projectId, snapshot_id: snapshotId, reason: 'user_undo' })
    expect(result.rolled_back).toBe(true)
    expect(result.current_snapshot_id).toBe(snapshotId)
  }, 15_000)

  it('开关 on → 恢复即新版本：restored 快照带 derived_from 指针、指针前移、guard 保留恢复前状态', async () => {
    process.env.BLOMA_RESTORE_AS_VERSION = '1'
    const { projectId, snapshotId } = await seedWithSnapshot()
    const result = await rollbackSnapshot({ request_id: 'req-i6-on', project_id: projectId, snapshot_id: snapshotId, reason: 'user_undo' })
    expect(result.rolled_back).toBe(true)
    // 指针前移到恢复点（不再指源版本）
    expect(result.current_snapshot_id).not.toBe(snapshotId)
    // restored 快照元数据：kind/derived_from/summary 语义
    const restoredMeta = JSON.parse(
      readFileSync(join(getSnapshotsDirOf(projectId), `${result.current_snapshot_id}.json`), 'utf8'),
    ) as { kind?: string; derived_from?: string; summary?: string }
    expect(restoredMeta.kind).toBe('restored')
    expect(restoredMeta.derived_from).toBe(snapshotId)
    expect(String(restoredMeta.summary)).toContain('恢复的版本')
    // guard 仍在（恢复前 v2 状态保留可找回）
    expect(result.guard_snapshot_id).toBeTruthy()
    // 当前产物内容=源版本（恢复语义不变）
    const project = findProject(projectId)
    expect(readFileSync(join(project.root_path, 'index.html'), 'utf8')).toContain('v1')
    expect(project.current_snapshot_id).toBe(result.current_snapshot_id)
  }, 15_000)

  function getSnapshotsDirOf(projectId: string): string {
    const project = findProject(projectId)
    return join(process.env.PROMA_HOME as string, 'agent-workspaces', project.workspace_slug, 'snapshots', projectId)
  }
})
