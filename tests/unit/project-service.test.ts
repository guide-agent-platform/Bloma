import { restorePromaHome } from '../support/proma-home-guard'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  abandonProject,
  archiveProject,
  createProject,
  deleteProject,
  exportProject,
  getProjectProgressSummary,
  isWorkflowStage,
  listProjects,
  recordSketchGenerated,
  renameProject,
  reopenProject,
  unarchiveProject,
} from '../../main/project/project-service'
import { recordSessionActivity } from '../../main/platform/sessions/session-service'
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
    restorePromaHome(originalHome)
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
      restorePromaHome(originalHome)
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

describe('ProjectService export（PRD §14.2 手动导出）', () => {
  it('[S3-PROJECT-009] 导出项目应把生成代码复制到目标目录下的同名子文件夹并计数', () => {
    withTmpHome(() => {
      const project = createProject({ request_id: 'req-1', mode: 'quick', initial_message: '导出测试' })
      const root = getGeneratedProjectPath(project.workspace_slug, project.project_id)
      writeFileSync(join(root, 'index.html'), '<html></html>')
      writeFileSync(join(root, 'app.js'), 'console.log(1)')

      const destRoot = mkdtempSync(join(tmpdir(), 'proma-export-'))
      const result = exportProject({ request_id: 'req-2', project_id: project.project_id }, destRoot)

      expect(result.canceled).toBe(false)
      expect(result.destination).toBe(join(destRoot, project.name))
      expect(existsSync(join(destRoot, project.name, 'index.html'))).toBe(true)
      expect(existsSync(join(destRoot, project.name, 'app.js'))).toBe(true)
      expect(result.file_count).toBe(2)
    })
  })

  it('[S3-PROJECT-010] 导出不存在的项目应抛 PROJECT_NOT_FOUND', () => {
    withTmpHome(() => {
      expect(() => exportProject({ request_id: 'req-1', project_id: 'no-such-project' }, tmpdir())).toThrow(
        /PROJECT_NOT_FOUND/,
      )
    })
  })
})

describe('ProjectService rename（U13 项目重命名）', () => {
  it('[S3-PROJECT-011] 重命名应更新项目名并写入 project_renamed 事件', () => {
    withTmpHome(() => {
      const project = createProject({ request_id: 'req-1', mode: 'quick', initial_message: '帮我做个东西' })
      const renamed = renameProject({ request_id: 'req-2', project_id: project.project_id, name: '  记账本 App  ' })

      expect(renamed.name).toBe('记账本 App')
      expect(listProjects('all').find((p) => p.project_id === project.project_id)?.name).toBe('记账本 App')

      const events = readFileSync(getProjectEventsPath(project.workspace_slug, project.project_id), 'utf8')
      expect(events).toContain('project_renamed')
    })
  })

  it('[S3-PROJECT-012] 重命名应剔除非法字符并截断到 32 字', () => {
    withTmpHome(() => {
      const project = createProject({ request_id: 'req-1', mode: 'quick', initial_message: '原名' })
      const renamed = renameProject({
        request_id: 'req-2',
        project_id: project.project_id,
        name: '记<账>:本"/\x00尾?' + 'x'.repeat(40),
      })
      expect(renamed.name.length).toBeLessThanOrEqual(32)
      expect(renamed.name).not.toContain('<')
      expect(renamed.name).not.toContain(':')
    })
  })

  it('[S3-PROJECT-013] 重命名为空名应抛 VALIDATION_ERROR', () => {
    withTmpHome(() => {
      const project = createProject({ request_id: 'req-1', mode: 'quick', initial_message: '原名' })
      expect(() => renameProject({ request_id: 'req-2', project_id: project.project_id, name: '   ' })).toThrow(
        /VALIDATION_ERROR/,
      )
    })
  })

  it('[S3-PROJECT-014] 重命名不存在的项目应抛 PROJECT_NOT_FOUND', () => {
    withTmpHome(() => {
      expect(() => renameProject({ request_id: 'req-1', project_id: 'no-such-project', name: '新名' })).toThrow(
        /PROJECT_NOT_FOUND/,
      )
    })
  })
})

describe('ProjectService abandon/reopen（U15 状态流转）', () => {
  it('[S3-PROJECT-015] 标记为已放弃应把 active 置为 abandoned 并写入 project_abandoned 事件', () => {
    withTmpHome(() => {
      const project = createProject({ request_id: 'req-1', mode: 'quick', initial_message: '放弃测试' })
      const abandoned = abandonProject({ request_id: 'req-2', project_id: project.project_id })

      expect(abandoned.status).toBe('abandoned')
      expect(listProjects('all').find((p) => p.project_id === project.project_id)?.status).toBe('abandoned')

      const events = readFileSync(getProjectEventsPath(project.workspace_slug, project.project_id), 'utf8')
      expect(events).toContain('project_abandoned')
    })
  })

  it('[S3-PROJECT-016] 恢复进行应把 abandoned 置回 active', () => {
    withTmpHome(() => {
      const project = createProject({ request_id: 'req-1', mode: 'quick', initial_message: '恢复进行测试' })
      abandonProject({ request_id: 'req-2', project_id: project.project_id })

      const reopened = reopenProject({ request_id: 'req-3', project_id: project.project_id })

      expect(reopened.status).toBe('active')
      expect(listProjects('all').find((p) => p.project_id === project.project_id)?.status).toBe('active')
    })
  })

  it('[S3-PROJECT-017] 标记已放弃不存在的项目应抛 PROJECT_NOT_FOUND', () => {
    withTmpHome(() => {
      expect(() => abandonProject({ request_id: 'req-1', project_id: 'no-such-project' })).toThrow(
        /PROJECT_NOT_FOUND/,
      )
    })
  })
})

describe('ProjectService progress summary（U16 卡片信息量）', () => {
  it('[S3-PROJECT-018] 无草图记录时返回 undefined', () => {
    withTmpHome(() => {
      const project = createProject({ request_id: 'req-1', mode: 'quick', initial_message: '无草图' })
      expect(getProjectProgressSummary(project.project_id)).toBeUndefined()
    })
  })

  it('[S3-PROJECT-019] 取最近一次 sketch_generated 最后一条需求作为摘要', () => {
    withTmpHome(() => {
      const project = createProject({ request_id: 'req-1', mode: 'quick', initial_message: '有草图' })
      recordSketchGenerated(project.project_id, [
        { id: 'F-001', description: '记录收入与支出' },
        { id: 'F-002', description: '展示本月结余' },
      ])
      expect(getProjectProgressSummary(project.project_id)).toBe('展示本月结余')
    })
  })

  it('[S3-PROJECT-020] 超长摘要截断到 40 字并加省略号', () => {
    withTmpHome(() => {
      const project = createProject({ request_id: 'req-1', mode: 'quick', initial_message: '长摘要' })
      recordSketchGenerated(project.project_id, [
        { id: 'F-001', description: '一'.repeat(60) },
      ])
      const summary = getProjectProgressSummary(project.project_id)
      expect(summary).toBeDefined()
      expect(summary!.length).toBeLessThanOrEqual(41) // 40 字 + 省略号
      expect(summary!.endsWith('…')).toBe(true)
    })
  })
})
