import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProject } from '../../main/project-service'
import { getAnalyticsPath, getProjectEventsPath } from '../../storage/config-paths'
import { appendJsonLine } from '../../storage/json-store'

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

  it('文件路径 getter 只拼路径不建目录，写入时才落盘', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-home-pure-'))
    process.env.PROMA_HOME = home

    const events = getProjectEventsPath('default-software-builder', 'project-pure')
    const analytics = getAnalyticsPath('default-software-builder')

    // 读路径若带 mkdir 副作用，PROMA_HOME 被污染时会在 cwd 下建出 ./undefined/agent-workspaces/...
    expect(existsSync(join(home, 'agent-workspaces'))).toBe(false)
    expect(existsSync(dirname(events))).toBe(false)
    expect(existsSync(analytics)).toBe(false)

    appendJsonLine(events, { type: 'test' })
    expect(existsSync(events)).toBe(true)
  })

  it('裸 teardown 会把 PROMA_HOME 写成字符串 "undefined"（缺陷起点）', () => {
    process.env.PROMA_HOME = undefined as unknown as string
    expect(process.env.PROMA_HOME).toBe('undefined')
  })

  it('裸 teardown 若写成字符串 "null" 同样会被 guard 归位', () => {
    process.env.PROMA_HOME = null as unknown as string
    expect(process.env.PROMA_HOME).toBe('null')
  })

  it('全局 guard 在下个用例开始前归位，污染不跨用例传播', () => {
    expect(process.env.PROMA_HOME).not.toBe('undefined')
    expect(process.env.PROMA_HOME).not.toBe('null')
  })
})
