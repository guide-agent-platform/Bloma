import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { archiveProject, createProject, isWorkflowStage, listProjects } from '../../main/project-service'

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
