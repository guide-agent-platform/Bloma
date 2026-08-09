import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyRepairPatch,
  getRepairCount,
  runRepairCycle,
} from '../../main/repair-engine'
import { createProject, findProject, recordSketchGenerated } from '../../main/project-service'
import { getDocumentsDir } from '../../storage/config-paths'

describe('Repair engine (A2-08)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  it('blocks after the test repair limit (3) and keeps counts correct', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-repair-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    let verifyCalls = 0
    const base = {
      request_id: 'req-repair',
      session_id: 'session-1',
      project_id: project.project_id,
      category: 'test_error' as const,
      publish: () => undefined,
      verify: async () => {
        verifyCalls += 1
        return { ok: false }
      },
    }

    const first = await runRepairCycle(base)
    expect(first.repaired).toBe(false)
    expect(first.attempt).toBe(1)
    expect(getRepairCount(project.project_id, 'test')).toBe(1)

    await runRepairCycle(base)
    expect(getRepairCount(project.project_id, 'test')).toBe(2)

    await runRepairCycle(base)
    expect(getRepairCount(project.project_id, 'test')).toBe(3)

    const blocked = await runRepairCycle(base)
    expect(blocked.blocked).toBe(true)
    expect(blocked.stage).toBe('blocked_for_user_decision')
    expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')
    // 熔断后不再尝试补丁/校验，用户文案不含堆栈
    expect(verifyCalls).toBe(3)
  })

  it('resets the count to zero and returns to testing when a repair succeeds', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-repair-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const base = {
      request_id: 'req-repair',
      session_id: 'session-1',
      project_id: project.project_id,
      category: 'runtime_error' as const,
      publish: () => undefined,
    }

    await runRepairCycle({ ...base, verify: async () => ({ ok: false }) })
    expect(getRepairCount(project.project_id, 'runtime')).toBe(1)

    const success = await runRepairCycle({ ...base, verify: async () => ({ ok: true }) })
    expect(success.repaired).toBe(true)
    expect(success.stage).toBe('testing')
    expect(findProject(project.project_id).runtime_repair_count).toBe(0)
    expect(findProject(project.project_id).current_stage).toBe('testing')
  })

  it('regenerates PRD/GWT skeleton docs on constraint_error without touching project code', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-repair-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    writeFileSync(join(project.root_path, 'index.html'), '<h1>用户手动改过的文件</h1>', 'utf8')

    const patch = applyRepairPatch({ request_id: 'req', session_id: 's', project_id: project.project_id }, 'constraint_error')

    expect(patch.summary).toContain('PRD 与 GWT 骨架')
    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    expect(existsSync(join(dir, 'features', 'F-001.feature'))).toBe(true)
    // 文档修复不改代码
    expect(readFileSync(join(project.root_path, 'index.html'), 'utf8')).toContain('用户手动改过')
  })
})
