import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  archiveProject,
  createProject,
  deleteProject,
  isWorkflowStage,
  listProjects,
  unarchiveProject,
} from '../../main/project-service'
import { recordSessionActivity } from '../../main/session-service'
import {
  getAgentSessionPath,
  getAgentSessionsIndexPath,
  getDocumentsDir,
  getGeneratedProjectPath,
  getProjectEventsPath,
  getProjectsIndexPath,
  getSnapshotsDir,
} from '../../storage/config-paths'
import { appendJsonLine, writeJsonFile } from '../../storage/json-store'

/** 在独立临时 PROMA_HOME 中执行测试体，结束后恢复原环境变量（对齐 S0-STORE 规范）。 */
function withTmpHome<T>(fn: () => T): T {
  const originalHome = process.env.PROMA_HOME
  process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-project-mgmt-'))
  try {
    return fn()
  } finally {
    process.env.PROMA_HOME = originalHome
  }
}

describe('ProjectService stage validation', () => {
  it('accepts documented workflow stages', () => {
    expect(isWorkflowStage('clarifying')).toBe(true)
    expect(isWorkflowStage('blocked_for_user_decision')).toBe(true)
  })

  it('rejects undocumented workflow stages', () => {
    expect(isWorkflowStage('unknown_stage')).toBe(false)
  })
})

describe('ProjectService archive', () => {
  it('archives a project and hides it from project:list', () => {
    const originalHome = process.env.PROMA_HOME
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-archive-'))
    try {
      const project = createProject({ request_id: 'req-1', mode: 'quick', initial_message: '归档测试' })
      expect(listProjects().some((p) => p.project_id === project.project_id)).toBe(true)

      const archived = archiveProject({ request_id: 'req-2', project_id: project.project_id })
      expect(archived.status).toBe('archived')

      expect(listProjects().some((p) => p.project_id === project.project_id)).toBe(false)
    } finally {
      process.env.PROMA_HOME = originalHome
    }
  })
})

describe('ProjectService delete（迁移自 Proma deleteAgentWorkspace，硬删除 + 安全防护）', () => {
  it('[S3-PROJECT-001] 删除项目应从索引移除并在 listProjects 中消失', () => {
    withTmpHome(() => {
      const project = createProject({ request_id: 'req-1', mode: 'quick', initial_message: '删除测试' })
      expect(listProjects().some((p) => p.project_id === project.project_id)).toBe(true)

      deleteProject({ request_id: 'req-2', project_id: project.project_id })

      expect(listProjects().some((p) => p.project_id === project.project_id)).toBe(false)
    })
  })

  it('[S3-PROJECT-002] 删除项目应物理清理项目/文档/快照/事件目录与文件', () => {
    withTmpHome(() => {
      const project = createProject({ request_id: 'req-1', mode: 'quick', initial_message: '清理测试' })
      const root = getGeneratedProjectPath(project.workspace_slug, project.project_id)
      const docs = getDocumentsDir(project.workspace_slug, project.project_id)
      const snaps = getSnapshotsDir(project.workspace_slug, project.project_id)
      writeFileSync(join(root, 'index.html'), '<html></html>')
      writeFileSync(join(docs, 'prd.md'), '# PRD')
      writeFileSync(join(snaps, 'meta.json'), '{}')
      appendJsonLine(getProjectEventsPath(project.workspace_slug, project.project_id), { type: 'test' })

      expect(existsSync(join(root, 'index.html'))).toBe(true)
      expect(existsSync(docs)).toBe(true)
      expect(existsSync(snaps)).toBe(true)
      expect(existsSync(getProjectEventsPath(project.workspace_slug, project.project_id))).toBe(true)

      deleteProject({ request_id: 'req-2', project_id: project.project_id })

      expect(existsSync(join(root, 'index.html'))).toBe(false)
      expect(existsSync(docs)).toBe(false)
      expect(existsSync(snaps)).toBe(false)
      expect(existsSync(getProjectEventsPath(project.workspace_slug, project.project_id))).toBe(false)
    })
  })

  it('[S3-PROJECT-003] 删除项目应清理关联会话索引与 jsonl 文件', () => {
    withTmpHome(() => {
      const project = createProject({ request_id: 'req-1', mode: 'quick', initial_message: '会话清理' })
      const sessionId = 'session-delete-test-001'
      recordSessionActivity(sessionId, project.project_id)
      appendJsonLine(getAgentSessionPath(sessionId), { role: 'user', content: [], timestamp: Date.now() })
      expect(existsSync(getAgentSessionPath(sessionId))).toBe(true)

      deleteProject({ request_id: 'req-2', project_id: project.project_id })

      const index = JSON.parse(readFileSync(getAgentSessionsIndexPath(), 'utf8')) as {
        sessions: { session_id: string }[]
      }
      expect(index.sessions.some((s) => s.session_id === sessionId)).toBe(false)
      expect(existsSync(getAgentSessionPath(sessionId))).toBe(false)
    })
  })

  it('[S3-PROJECT-004] 删除不存在的项目应抛 PROJECT_NOT_FOUND', () => {
    withTmpHome(() => {
      expect(() => deleteProject({ request_id: 'req-1', project_id: 'no-such-project' })).toThrow(/PROJECT_NOT_FOUND/)
    })
  })

  it('[S3-PROJECT-005] 项目路径逃出 workspace 根时应拒绝删除且不清理外部文件', () => {
    withTmpHome(() => {
      const project = createProject({ request_id: 'req-1', mode: 'quick', initial_message: '路径安全' })
      const outside = mkdtempSync(join(tmpdir(), 'proma-outside-'))
      const marker = join(outside, 'marker.txt')
      writeFileSync(marker, 'keep')
      // 篡改索引：把 root_path 指向 workspace 之外
      const index = JSON.parse(readFileSync(getProjectsIndexPath(), 'utf8')) as {
        projects: Array<{ project_id: string; root_path: string }>
      }
      const tampered = index.projects.map((p) =>
        p.project_id === project.project_id ? { ...p, root_path: outside } : p,
      )
      writeJsonFile(getProjectsIndexPath(), { version: 1, projects: tampered })

      expect(() => deleteProject({ request_id: 'req-2', project_id: project.project_id })).toThrow(
        /PROJECT_DELETE_PATH_SAFETY/,
      )
      expect(existsSync(marker)).toBe(true)
    })
  })
})

describe('ProjectService unarchive（迁移自 Proma archived toggle）', () => {
  it('[S3-PROJECT-006] 取消归档应把 archived 恢复为 active 并重新可见', () => {
    withTmpHome(() => {
      const project = createProject({ request_id: 'req-1', mode: 'quick', initial_message: '恢复测试' })
      archiveProject({ request_id: 'req-2', project_id: project.project_id })
      expect(listProjects().some((p) => p.project_id === project.project_id)).toBe(false)

      const restored = unarchiveProject({ request_id: 'req-3', project_id: project.project_id })

      expect(restored.status).toBe('active')
      expect(listProjects().some((p) => p.project_id === project.project_id)).toBe(true)
    })
  })

  it('[S3-PROJECT-007] 取消归档不存在的项目应抛 PROJECT_NOT_FOUND', () => {
    withTmpHome(() => {
      expect(() => unarchiveProject({ request_id: 'req-1', project_id: 'no-such-project' })).toThrow(
        /PROJECT_NOT_FOUND/,
      )
    })
  })
})

describe('ProjectService list scope（迁移自 Proma active/archived/all）', () => {
  it('[S3-PROJECT-008] listProjects(scope) 支持 active/archived/all 三种视角', () => {
    withTmpHome(() => {
      const a = createProject({ request_id: 'req-1', mode: 'quick', initial_message: '项目 A' })
      const b = createProject({ request_id: 'req-2', mode: 'quick', initial_message: '项目 B' })
      archiveProject({ request_id: 'req-3', project_id: b.project_id })

      const active = listProjects('active')
      expect(active.some((p) => p.project_id === a.project_id)).toBe(true)
      expect(active.some((p) => p.project_id === b.project_id)).toBe(false)

      const archived = listProjects('archived')
      expect(archived.some((p) => p.project_id === b.project_id)).toBe(true)
      expect(archived.some((p) => p.project_id === a.project_id)).toBe(false)

      const all = listProjects('all')
      expect(all.some((p) => p.project_id === a.project_id)).toBe(true)
      expect(all.some((p) => p.project_id === b.project_id)).toBe(true)
    })
  })
})
