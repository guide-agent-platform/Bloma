import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { restorePromaHome } from '../support/proma-home-guard'
import { createIpcHarness } from '../acceptance/support/ipc-harness'
import { createProject, exportProject, updateProject } from '../../main/project/project-service'
import { exportProjectHandoff } from '../../main/delivery/project-export'
import { getDocumentsDir } from '../../storage/config-paths'
import { readPrdBackplane } from '../../main/project/document-engine'
import { IPC_CHANNELS, type ApiResult } from '../../shared/types'

describe('收口细节：导出路径、命名同步和设置错误', () => {
  const originalHome = process.env.PROMA_HOME
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bloma-details-'))
    process.env.PROMA_HOME = home
  })
  afterEach(() => {
    restorePromaHome(originalHome)
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it.each(['..', '.', '***', 'CON', 'NUL.txt', 'LPT1', '账本.  '])('名称 %s 导出仍在所选目录的正常子目录内，两条导出路径一致', (name) => {
    const project = createProject({ request_id: 'export', mode: 'quick' })
    updateProject(project.project_id, { name })
    writeFileSync(join(project.root_path, 'payload.txt'), '项目产物', 'utf8')
    const destination = join(home, 'exports')
    mkdirSync(destination)
    const exports = [exportProject, exportProjectHandoff].map((exporter) => exporter({ request_id: 'export', project_id: project.project_id }, destination))
    expect(exports[0].destination).toBe(exports[1].destination)
    for (const result of exports) {
      expect(dirname(result.destination!)).toBe(destination)
      expect(readFileSync(join(result.destination!, 'payload.txt'), 'utf8')).toBe('项目产物')
    }
    expect(existsSync(join(home, 'payload.txt'))).toBe(false)
    expect(existsSync(join(destination, 'payload.txt'))).toBe(false)
  })

  it('导出包内已有目录 junction 时拒绝写穿，包外哨兵保持原样', () => {
    const project = createProject({ request_id: 'export', mode: 'quick', initial_message: '目录测试' })
    mkdirSync(join(project.root_path, 'data'))
    writeFileSync(join(project.root_path, 'data', 'sentinel.txt'), '项目新文件', 'utf8')
    const destination = join(home, 'exports'), outside = join(home, 'outside')
    const target = join(destination, project.name)
    mkdirSync(target, { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, 'sentinel.txt'), '原有哨兵', 'utf8')
    symlinkSync(outside, join(target, 'data'), 'junction')
    expect(relative(destination, outside)).toContain('..')
    for (const exporter of [exportProject, exportProjectHandoff]) {
      expect(() => exporter({ request_id: 'export', project_id: project.project_id }, destination)).toThrow('symbolic link')
      expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('原有哨兵')
    }
  })

  it('界面重命名同步 PRD 名称与标题，保留冻结信息、需求及已生成入口', async () => {
    const project = createProject({ request_id: 'rename', mode: 'quick', initial_message: '旧名称' })
    const original = {
      project_id: project.project_id, name: '旧名称', positioning: '学习工具',
      requirements: [{ id: 'F-001', description: '计时' }], acceptance: { 'F-001': '计时正确' },
      out_of_scope: ['不做云同步'], assumptions: [], user_confirmed_at: '2026-10-09T12:00:00Z',
      prd_document: '# PRD：旧名称\n## 内容\n旧名称作为用户原话保留',
    }
    const path = join(getDocumentsDir(project.workspace_slug, project.project_id), 'prd.json')
    writeFileSync(path, JSON.stringify(original), 'utf8')
    writeFileSync(join(project.root_path, 'app.py'), 'title = "旧名称"', 'utf8')
    const result = await createIpcHarness().invoke(IPC_CHANNELS.PROJECT_RENAME, { request_id: 'rename', project_id: project.project_id, name: '新的名称' }) as ApiResult<unknown>
    expect(result.ok).toBe(true)
    expect(readPrdBackplane(project.project_id).name).toBe('新的名称')
    const stored = JSON.parse(readFileSync(path, 'utf8'))
    expect(stored.prd_document).toContain('# PRD：新的名称')
    expect(stored.prd_document).toContain('旧名称作为用户原话保留')
    expect(stored.requirements).toEqual(original.requirements)
    expect(stored.user_confirmed_at).toBe(original.user_confirmed_at)
    expect(readFileSync(join(project.root_path, 'app.py'), 'utf8')).toBe('title = "旧名称"')
  })

  it.each([12, {}, ['规则']])('非法文本输入 %j 经 IPC 返回校验错误而不是内部异常', async (value) => {
    const project = createProject({ request_id: 'invalid', mode: 'quick' })
    const harness = createIpcHarness()
    for (const [channel, payload] of [
      [IPC_CHANNELS.PROMPT_SAVE, { request_id: 'invalid', prompt_id: 'prd-system', content: value }],
      [IPC_CHANNELS.PROJECT_RENAME, { request_id: 'invalid', project_id: project.project_id, name: value }],
    ] as const) {
      const result = await harness.invoke(channel, payload) as ApiResult<unknown>
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected validation failure')
      expect(result.error.code).toBe('VALIDATION_ERROR')
    }
  })
})
