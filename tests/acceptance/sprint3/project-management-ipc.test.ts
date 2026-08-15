import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createIpcHarness } from '../support/ipc-harness'
import { createProject } from '../../../main/project-service'
import { IPC_CHANNELS } from '../../../shared/types'
import type { ApiResult, Project } from '../../../shared/types'

/** 在独立临时 PROMA_HOME 中执行测试体（await 完整个 async 体后才恢复环境变量）。 */
async function withTmpHome<T>(fn: () => Promise<T>): Promise<T> {
  const originalHome = process.env.PROMA_HOME
  process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-ipc-mgmt-'))
  try {
    return await fn()
  } finally {
    process.env.PROMA_HOME = originalHome
  }
}

describe('Sprint 3 项目管理 IPC 契约（迁移自 Proma 归档/删除）', () => {
  it('[S3-PROJECT-009] project:delete channel 已注册且不存在的项目返回 PROJECT_NOT_FOUND', async () => {
    await withTmpHome(async () => {
      const harness = createIpcHarness()
      expect(harness.channels).toContain(IPC_CHANNELS.PROJECT_DELETE)

      const result = (await harness.invoke(IPC_CHANNELS.PROJECT_DELETE, {
        request_id: 'req-del',
        project_id: 'no-such-project',
      })) as ApiResult<{ deleted: true }>

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('PROJECT_NOT_FOUND')
    })
  })

  it('[S3-PROJECT-010] project:unarchive channel 已注册且不存在的项目返回 PROJECT_NOT_FOUND', async () => {
    await withTmpHome(async () => {
      const harness = createIpcHarness()
      expect(harness.channels).toContain(IPC_CHANNELS.PROJECT_UNARCHIVE)

      const result = (await harness.invoke(IPC_CHANNELS.PROJECT_UNARCHIVE, {
        request_id: 'req-unarch',
        project_id: 'no-such-project',
      })) as ApiResult<Project>

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('PROJECT_NOT_FOUND')
    })
  })

  it('[S3-PROJECT-011] project:list 接受 scope 参数并按视角返回', async () => {
    await withTmpHome(async () => {
      const harness = createIpcHarness()
      const project = createProject({ request_id: 'req-create', mode: 'quick', initial_message: 'scope 测试' })
      await harness.invoke(IPC_CHANNELS.PROJECT_ARCHIVE, { request_id: 'req-arch', project_id: project.project_id })

      const archived = (await harness.invoke(IPC_CHANNELS.PROJECT_LIST, {
        request_id: 'req-list-archived',
        scope: 'archived',
      })) as ApiResult<Project[]>
      const active = (await harness.invoke(IPC_CHANNELS.PROJECT_LIST, {
        request_id: 'req-list-active',
      })) as ApiResult<Project[]>

      expect(archived.ok).toBe(true)
      if (archived.ok) {
        expect(archived.data.some((p) => p.project_id === project.project_id)).toBe(true)
      }
      expect(active.ok).toBe(true)
      if (active.ok) {
        expect(active.data.some((p) => p.project_id === project.project_id)).toBe(false)
      }
    })
  })
})
