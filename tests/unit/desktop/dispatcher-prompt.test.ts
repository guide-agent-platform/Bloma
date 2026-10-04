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

  it('确认纪律段仅 requiresUserConfirmation 节点渲染（刀1 后内置表无此节点；构造节点验证渲染路径保留）', () => {
    // 刀1（2026-10-02）：撤 manual 门后内置接管阶段均 false；渲染路径保留供
    // Intent 层/未来不可逆动作类节点复用——用构造节点锁定渲染形态不回退。
    const withConfirm = buildDispatcherSystemPrompt(
      { ...DESKTOP_PHASES['desktop-implement'], requiresUserConfirmation: true },
      ctx,
    )
    expect(withConfirm).toContain('【确认纪律】')
    expect(withConfirm).toContain('推进标记')
    expect(withConfirm).toContain('平台裁决边界会自动向用户发起确认卡')
    expect(withConfirm).not.toContain('guide_decide')
    // 内置表零确认段的防回归已由 dispatcher-phases.test 的刀 1 数据锁承担（2026-10-03
    // 删留执行：此处删去重复的全表 for 断言，保留构造节点渲染路径验证）
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
  it('非终态：两种锚定形态示例 + 唯一合法目标 + 门禁清单（刀1 后内置阶段无「用户确认门」）', () => {
    const section = buildAdvanceProtocolSection(DESKTOP_PHASES['desktop-arch'])
    expect(section).toContain('<!-- PHASE_ADVANCE: desktop-scaffold -->')
    expect(section).toContain('PHASE_ADVANCE: desktop-scaffold')
    expect(section).toContain('句中复述无效')
    expect(section).toContain('[artifact] 选型结论文档存在且可读')
    // 刀1：撤 manual 门——内置阶段不再渲染用户确认门行（全表防回归由
    // dispatcher-phases.test 数据锁承担，2026-10-03 删留执行去重）
    expect(section).not.toContain('用户确认门')
  })

  it('终态：收尾语义、不出现在标记示例', () => {
    const section = buildAdvanceProtocolSection(DESKTOP_PHASES.delivered)
    expect(section).toContain('终态')
    expect(section).toContain('不要输出任何推进标记')
    expect(section).not.toContain('PHASE_ADVANCE: null')
  })
})

describe('buildToolDisciplineSection', () => {
  it('写文件硬拦 + 委派路径说明（含 role 选择与代答纪律）', () => {
    const section = buildToolDisciplineSection(DESKTOP_PHASES['desktop-arch'])
    expect(section).toContain('不直接写文件')
    expect(section).toContain('delegate_agent')
    expect(section).toContain('role=implement')
    expect(section).toContain('answer_delegation_question')
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

describe('输出纪律段（刀4，2026-10-02 确认协议与呈现层战役）', () => {
  it('系统提示词固定含【输出纪律】段：中文/≤2 句要点/结尾两形态 + 英文漂移自检（刀4 强化）', () => {
    const prompt = buildDispatcherSystemPrompt(DESKTOP_PHASES['desktop-scaffold'], { projectName: 'p' })
    expect(prompt).toContain('【输出纪律】')
    expect(prompt).toContain('一律使用中文')
    expect(prompt).toContain('不超过 2 句')
    expect(prompt).toContain('一句话说明下一步，或输出推进标记')
    expect(prompt).toContain('立即停止并改用中文重述')
    // 组装序：输出纪律在工具纪律之后
    expect(prompt.indexOf('【工具纪律】')).toBeLessThan(prompt.indexOf('【输出纪律】'))
  })

  it('verifiedConclusion 渲染【上一轮已验证结论】段（刀2 checkpoint 消费面）；缺省不出；任务书之前', () => {
    const withConclusion = buildDispatcherSystemPrompt(DESKTOP_PHASES['desktop-scaffold'], {
      projectName: 'p',
      verifiedConclusion: '上一轮（2026-10-02T15:00:00.000Z）本阶段门禁已全部验证通过，结论如下（勿重验）：\n- scaffold-contract: 产物核验通过\n直接续接收口：输出推进标记。',
    })
    expect(withConclusion).toContain('【上一轮已验证结论】')
    expect(withConclusion).toContain('勿重验')
    expect(withConclusion.indexOf('【上一轮已验证结论】')).toBeLessThan(withConclusion.indexOf('【本阶段任务书】'))
    const without = buildDispatcherSystemPrompt(DESKTOP_PHASES['desktop-scaffold'], { projectName: 'p' })
    expect(without).not.toContain('【上一轮已验证结论】')
  })

  it('子会话基底含汇报纪律（防英文报告回流摘要）', () => {
    const base = buildDesktopChildBaseSystem(DESKTOP_PHASES['desktop-implement'], { projectName: 'p' })
    expect(base).toContain('【汇报纪律】')
    expect(base).toContain('中文')
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

describe('快速模式任务书（2026-10-03 拍板：quick 快速做出可用应用）', () => {
  const ctx = { projectName: 'clip-tool' }

  it('quickMode 时 implement 用快速版任务书与约束：从零实现可用应用，不教续接骨架/契约先行', () => {
    const prompt = buildDispatcherSystemPrompt(DESKTOP_PHASES['desktop-implement'], { ...ctx, quickMode: true })
    expect(prompt).toContain('快速做一个能用的应用')
    expect(prompt).toContain('从零实现一个完整可用的 Windows 桌面程序')
    expect(prompt).toContain('不要求 contract.json 与驱动断言')
    expect(prompt).toContain('LAUNCH.json')
    expect(prompt).toContain('快速模式不做工程契约与驱动断言')
    // 长期模式任务书的关键前提不得混入（防双任务书叠加混淆调度员）
    expect(prompt).not.toContain('续接骨架委派实现真实桌面程序')
    expect(prompt).not.toContain('每实现一个功能必须先有对应驱动断言')
  })

  it('非 quickMode 的 implement 保持长期模式任务书（字节不变，既有用例语义）', () => {
    const prompt = buildDispatcherSystemPrompt(DESKTOP_PHASES['desktop-implement'], ctx)
    expect(prompt).toContain('续接骨架委派实现真实桌面程序')
    expect(prompt).not.toContain('快速做一个能用的应用')
  })

  it('无快速版任务书的阶段（arch/scaffold/verify）：quickMode 也用原任务书与约束', () => {
    const prompt = buildDispatcherSystemPrompt(DESKTOP_PHASES['desktop-scaffold'], { ...ctx, quickMode: true })
    expect(prompt).toContain('按选型结论搭建最小骨架')
  })

  it('buildDesktopChildBaseSystem quickMode：子会话基底同步用快速版约束（不注入断言先行纪律）', () => {
    const base = buildDesktopChildBaseSystem(DESKTOP_PHASES['desktop-implement'], { ...ctx, quickMode: true })
    expect(base).toContain('快速模式不做工程契约与驱动断言')
    expect(base).not.toContain('每实现一个功能必须先有对应驱动断言')
    const baseLong = buildDesktopChildBaseSystem(DESKTOP_PHASES['desktop-implement'], ctx)
    expect(baseLong).toContain('每实现一个功能必须先有对应驱动断言')
  })
})
