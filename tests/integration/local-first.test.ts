import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProject } from '../../main/project-service'

describe('Local-First storage', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  it('uses temporary PROMA_HOME and creates JSON/file directories only', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-home-'))
    process.env.PROMA_HOME = home

    const project = createProject({
      request_id: 'req-1',
      mode: 'quick',
      initial_message: '库存管理',
    })

    expect(project.root_path.startsWith(home)).toBe(true)
    expect(existsSync(join(home, 'projects.json'))).toBe(true)
    expect(existsSync(project.root_path)).toBe(true)
  })
})
