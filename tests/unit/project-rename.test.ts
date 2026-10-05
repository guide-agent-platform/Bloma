/**
 * 项目自动命名修复测试（2026-10-05 用户反馈：「模式选择→建项目」路径无
 * initial_message → 全部「未命名项目」）。
 *
 * 覆盖：deriveProjectDisplayName 取名规则（剥引导语/句读截断/长度）；
 * maybeRenameUnnamedProject（未命名→改名、已命名不动、短消息不动、项目不存在）；
 * createProject 的 name 派生新契约。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { restorePromaHome } from '../support/proma-home-guard'
import { createProject, deriveProjectDisplayName, findProject, maybeRenameUnnamedProject } from '../../main/project/project-service'

describe('deriveProjectDisplayName（首条消息取名）', () => {
  it('剥引导语 + 句读截断 + 16 字上限', () => {
    expect(deriveProjectDisplayName('做一个简单的倒计时器，能设置分钟数开始倒计时，结束时弹窗提醒')).toBe('简单的倒计时器')
    expect(deriveProjectDisplayName('帮我做一个番茄钟')).toBe('番茄钟')
    expect(deriveProjectDisplayName('请写一个文件批量重命名工具。支持预览')).toBe('文件批量重命名工具')
    expect(deriveProjectDisplayName('我想要一款悬浮球')).toBe('悬浮球')
    expect(deriveProjectDisplayName('做一个纵版打飞机')).toBe('纵版打飞机')
  })

  it('无效输入返回 undefined（不改名）', () => {
    expect(deriveProjectDisplayName(undefined)).toBeUndefined()
    expect(deriveProjectDisplayName('')).toBeUndefined()
    expect(deriveProjectDisplayName('好')).toBeUndefined()
    expect(deriveProjectDisplayName('嗯嗯')).toBeUndefined()
    expect(deriveProjectDisplayName('帮我做')).toBeUndefined()
  })
})

describe('maybeRenameUnnamedProject（未命名项目补名）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-rename-'))
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  it('未命名项目 + 有效首条消息 → 改名生效', () => {
    const project = createProject({ request_id: 'req-rename-1', mode: 'quick' })
    expect(project.name).toBe('未命名项目')
    expect(maybeRenameUnnamedProject(project.project_id, '做一个简单的倒计时器，结束时提醒我')).toBe(true)
    expect(findProject(project.project_id)?.name).toBe('简单的倒计时器')
  })

  it('已命名项目不动；短消息不动；项目不存在返回 false', () => {
    const project = createProject({ request_id: 'req-rename-2', mode: 'quick' })
    maybeRenameUnnamedProject(project.project_id, '做一个番茄钟')
    const named = project.project_id
    expect(maybeRenameUnnamedProject(named, '做一个计算器')).toBe(false)
    expect(findProject(named)?.name).toBe('番茄钟')
    expect(maybeRenameUnnamedProject(named, '好')).toBe(false)
    expect(maybeRenameUnnamedProject('nonexistent-project', '做一个计算器')).toBe(false)
  })

  it('createProject 带 initial_message 时用派生名（新契约）', () => {
    const project = createProject({ request_id: 'req-rename-3', mode: 'quick', initial_message: '帮我做一个单位换算器，很简单的' })
    expect(project.name).toBe('单位换算器')
  })
})
