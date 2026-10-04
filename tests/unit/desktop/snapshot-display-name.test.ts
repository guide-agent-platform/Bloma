/**
 * 时间轴快照显示名回归锁（2026-10-05）：桌面线 checkpoint 快照不再暴露
 * web 时代 `mvp-<短id>` 机器码——用中文阶段标题（display_name 链路）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { restorePromaHome } from '../../support/proma-home-guard'
import { recordPhaseCheckpoint } from '../../../main/desktop/phase-checkpoint'
import { createProject } from '../../../main/project/project-service'

describe('阶段 checkpoint 快照显示名（时间轴人话命名）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bloma-snapshot-name-'))
    process.env.PROMA_HOME = home
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    rmSync(home, { recursive: true, force: true })
  })

  it('implement 阶段快照 name＝中文标题·短id，不再 mvp-xxx；summary 保留语义', async () => {
    const project = createProject({ request_id: 'req-name-1', mode: 'quick' })
    const checkpoint = await recordPhaseCheckpoint({
      requestId: 'req-name-1',
      projectId: project.project_id,
      stage: 'desktop-implement',
      gates: ['delivery-doc: 产物核验通过'],
      summary: 'desktop 阶段「desktop-implement」门禁全绿待推进',
      verification: 'recoverable',
    })
    expect(checkpoint?.snapshot_id).toBeTruthy()
    const meta = JSON.parse(
      readFileSync(
        join(process.env.PROMA_HOME ?? '', 'agent-workspaces', project.workspace_slug, 'snapshots', project.project_id, checkpoint!.snapshot_id!, 'metadata.json'),
        'utf8',
      ),
    ) as { name: string; summary: string }
    expect(meta.name).toMatch(/^实现与交付说明·[0-9a-f]{4}$/)
    expect(meta.name).not.toContain('mvp-')
    expect(meta.summary).toContain('门禁全绿')
  })

  it('未知阶段 id 回退原始 id（不炸、仍无 mvp- 前缀）', async () => {
    const project = createProject({ request_id: 'req-name-2', mode: 'quick' })
    const checkpoint = await recordPhaseCheckpoint({
      requestId: 'req-name-2',
      projectId: project.project_id,
      stage: 'desktop-mystery',
      gates: [],
      summary: 's',
      verification: 'recoverable',
    })
    expect(checkpoint).not.toBeNull()
    expect(checkpoint?.snapshot_id).toBeTruthy()
  })
})
