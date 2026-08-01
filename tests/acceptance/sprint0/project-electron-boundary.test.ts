import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createProject } from '../../../main/project-service'
import { useTemporaryPromaHome, type TemporaryPromaHome } from '../support/test-environment'

const root = fileURLToPath(new URL('../../..', import.meta.url))

describe('Sprint 0 project and Electron boundary acceptance', () => {
  let environment: TemporaryPromaHome | undefined

  afterEach(() => {
    environment?.cleanup()
    environment = undefined
  })

  it('[S0-PROJECT-001] 创建项目应初始化索引、工作区、文档和快照目录', () => {
    environment = useTemporaryPromaHome('bloma-role-c-project-')
    const project = createProject({
      request_id: 'role-c-project-create',
      mode: 'longterm',
      initial_message: '长期项目阶段验收',
    })
    const workspace = join(environment.home, 'agent-workspaces', project.workspace_slug)

    expect(project.current_stage).toBe('clarifying')
    expect(project.mode).toBe('longterm')
    expect(existsSync(join(environment.home, 'projects.json'))).toBe(true)
    expect(existsSync(project.root_path)).toBe(true)
    expect(existsSync(join(workspace, 'documents', project.project_id))).toBe(true)
    expect(existsSync(join(workspace, 'snapshots', project.project_id))).toBe(true)
  })

  it('[S0-UI-006] BrowserWindow 应启用隔离、沙箱并关闭 Node 集成', () => {
    const source = readFileSync(join(root, 'main', 'index.ts'), 'utf8')
    expect(source).toMatch(/contextIsolation:\s*true/)
    expect(source).toMatch(/nodeIntegration:\s*false/)
    expect(source).toMatch(/sandbox:\s*true/)
    expect(source).toMatch(/setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'/)
  })
})
