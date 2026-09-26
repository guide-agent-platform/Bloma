/**
 * 桌面调度员提示词构建器测试（批次 A，2026-09-24）。
 *
 * 覆盖：模板渲染（替换/未知占位符保留）、系统提示词组装序与段落锚、
 * 推进协议段（终态/非终态/门禁渲染）、工具纪律段（extraTools）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildAdvanceProtocolSection,
  buildDesktopChildBaseSystem,
  buildDispatcherSystemPrompt,
  buildToolDisciplineSection,
  renderTaskTemplate,
} from '../../../main/desktop/dispatcher-prompt'
import { DESKTOP_PHASES } from '../../../main/desktop/dispatcher-phases'

describe('renderTaskTemplate', () => {
  it('全量替换已知占位符', () => {
    const { text, unresolved } = renderTaskTemplate('为 {{project_name}} 搭建骨架', { project_name: 'clip-tool' })
    expect(text).toBe('为 clip-tool 搭建骨架')
    expect(unresolved).toEqual([])
  })

  it('未知占位符保留原样并收集（不抛错）', () => {
    const { text, unresolved } = renderTaskTemplate('{{a}} 与 {{b}}', { a: 'x' })
    expect(text).toBe('x 与 {{b}}')
    expect(unresolved).toEqual(['b'])
  })

  it('无占位符模板原样返回', () => {
    const { text, unresolved } = renderTaskTemplate('固定文案', {})
    expect(text).toBe('固定文案')
    expect(unresolved).toEqual([])
  })
})

describe('buildDispatcherSystemPrompt 组装序', () => {
  const ctx = { projectName: 'clip-tool', completedPhases: ['requirements', 'desktop-arch'] }

  it('段落锚按固定序出现（任务书→约束→推进协议→工具纪律→确认纪律）', () => {
    const prompt = buildDispatcherSystemPrompt(DESKTOP_PHASES['desktop-scaffold'], ctx)
    const anchors = ['【本阶段任务书】', '【阶段约束】', '【推进协议】', '【工具纪律】'].map((a) => prompt.indexOf(a))
    expect(anchors.every((i) => i >= 0)).toBe(true)
    expect([...anchors].sort((a, b) => a - b)).toEqual(anchors)
  })

  it('角色头含角色/阶段 id/已完成阶段；任务书占位符已渲染', () => {
    const prompt = buildDispatcherSystemPrompt(DESKTOP_PHASES['desktop-arch'], ctx)
    expect(prompt).toContain('桌面架构师')
    expect(prompt).toContain('desktop-arch')
    expect(prompt).toContain('requirements → desktop-arch')
    expect(prompt).not.toContain('{{')
  })

  it('任务书与约束来自阶段表数据（改数据不改代码的提示词半边）', () => {
    const node = {
      ...DESKTOP_PHASES['desktop-scaffold'],
      taskTemplate: '新任务书：{{project_name}} 的骨架',
      constraints: ['新约束甲', '新约束乙'],
    }
    const prompt = buildDispatcherSystemPrompt(node, { projectName: 'timer' })
    expect(prompt).toContain('新任务书：timer 的骨架')
    expect(prompt).toContain('1. 新约束甲')
    expect(prompt).toContain('2. 新约束乙')
  })

  it('requiresUserConfirmation 阶段渲染确认纪律段；无需确认阶段不渲染', () => {
    const withConfirm = buildDispatcherSystemPrompt(DESKTOP_PHASES['desktop-implement'], ctx)
    expect(withConfirm).toContain('【确认纪律】')
    expect(withConfirm).toContain('guide_decide')
    const withoutConfirm = buildDispatcherSystemPrompt(DESKTOP_PHASES['desktop-scaffold'], ctx)
    expect(withoutConfirm).not.toContain('【确认纪律】')
  })

  it('workspaceHint 渲染进环境段', () => {
    const prompt = buildDispatcherSystemPrompt(DESKTOP_PHASES['desktop-arch'], {
      projectName: 'p',
      workspaceHint: '沙箱根=项目目录',
    })
    expect(prompt).toContain('【环境】')
    expect(prompt).toContain('沙箱根=项目目录')
  })
})

describe('buildAdvanceProtocolSection', () => {
  it('非终态：两种锚定形态示例 + 唯一合法目标 + 门禁清单', () => {
    const section = buildAdvanceProtocolSection(DESKTOP_PHASES['desktop-arch'])
    expect(section).toContain('<!-- PHASE_ADVANCE: desktop-scaffold -->')
    expect(section).toContain('PHASE_ADVANCE: desktop-scaffold')
    expect(section).toContain('句中复述无效')
    expect(section).toContain('[artifact] 选型结论文档存在且可读')
    expect(section).toContain('用户确认门')
  })

  it('终态：收尾语义、不出现在标记示例', () => {
    const section = buildAdvanceProtocolSection(DESKTOP_PHASES.delivered)
    expect(section).toContain('终态')
    expect(section).toContain('不要输出任何推进标记')
    expect(section).not.toContain('PHASE_ADVANCE: null')
  })
})

describe('buildToolDisciplineSection', () => {
  it('写文件硬拦 + 委派路径说明', () => {
    const section = buildToolDisciplineSection(DESKTOP_PHASES['desktop-arch'])
    expect(section).toContain('不直接写文件')
    expect(section).toContain('delegate_agent')
  })

  it('extraTools 渲染附加工具行；空则不出该行', () => {
    const withExtra = buildToolDisciplineSection({
      ...DESKTOP_PHASES['desktop-implement'],
      extraTools: ['run_desktop_preview'],
    })
    expect(withExtra).toContain('本阶段附加工具：run_desktop_preview')
    expect(buildToolDisciplineSection(DESKTOP_PHASES['desktop-arch'])).not.toContain('本阶段附加工具')
  })
})

describe('需求摘要与子会话基底（2026-09-26 首跑修复）', () => {
  it('requirementsDigest 渲染【项目需求】段；缺省不出', () => {
    const withDigest = buildDispatcherSystemPrompt(DESKTOP_PHASES['desktop-arch'], {
      projectName: 'p',
      requirementsDigest: 'F-001 [P0] 托盘倒计时工具',
    })
    expect(withDigest).toContain('【项目需求')
    expect(withDigest).toContain('F-001 [P0]')
    const without = buildDispatcherSystemPrompt(DESKTOP_PHASES['desktop-arch'], { projectName: 'p' })
    expect(without).not.toContain('【项目需求')
  })

  it('子会话基底：项目/阶段/产物目录/约束/需求；不泄漏调度员纪律', () => {
    const base = buildDesktopChildBaseSystem(DESKTOP_PHASES['desktop-arch'], {
      projectName: 'timer',
      requirementsDigest: 'F-001 [P0] 托盘倒计时工具',
    })
    expect(base).toContain('timer')
    expect(base).toContain('desktop-arch')
    expect(base).toContain('00_ARCH/')
    expect(base).toContain('【阶段约束】')
    expect(base).toContain('【项目需求')
    expect(base).not.toContain('你不直接写文件')
  })
})
