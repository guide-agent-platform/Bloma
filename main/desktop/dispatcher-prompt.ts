/**
 * 桌面调度员系统提示词构建器（批次 A 地基，2026-09-24）。
 *
 * 依据实施稿第二节：调度员系统提示词按阶段动态重建——任务书来自阶段表数据
 * （dispatcher-phases），协议段（推进标记/工具纪律/确认纪律）来自裁决边界约定。
 * 本模块纯函数零 I/O；批次 D 接线时由调度员 loop 的系统提示词装配点消费。
 *
 * 文案全部自写（AGPL 边界：仅借鉴「提示词按阶段数据渲染」的结构思想）。
 */

import type { PhaseNode } from './dispatcher-phases'
import { PHASE_ADVANCE_KEYWORD } from './dispatcher-gate'

/** 任务书模板渲染结果：unresolved 收集未匹配占位符（诊断/测试断言用）。 */
export interface RenderedTemplate {
  text: string
  /** 模板中存在但 vars 未提供的占位符名（去重；渲染后保留原 {{name}} 形态）。 */
  unresolved: string[]
}

/**
 * 渲染任务书模板：{{var}} 全量替换。
 * 未知占位符保留原样并记入 unresolved（不抛错——任务书是数据，缺变量属装配
 * 缺陷，由接线层观测/测试锁定，不让运行时崩）。
 */
export function renderTaskTemplate(template: string, vars: Record<string, string>): RenderedTemplate {
  const unresolved = new Set<string>()
  const text = template.replace(/\{\{([a-z_][a-z0-9_]*)\}\}/gi, (whole, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name]
    unresolved.add(name)
    return whole
  })
  return { text, unresolved: [...unresolved] }
}

/** 构建器上下文：模板变量 + 阶段表整体信息（进度条/序列感知）。 */
export interface DispatcherPromptContext {
  /** 项目名（模板 {{project_name}} 与产物占位符共用）。 */
  projectName: string
  /** 项目沙箱产物根提示（相对根说明，如「沙箱根=项目目录」；进提示词环境段）。 */
  workspaceHint?: string
  /** 已完成阶段 id 列表（进度感知；缺省=空——接线层按权威阶段推导）。 */
  completedPhases?: string[]
  /** 需求摘要（首跑修复：PRD 背板 → 调度员与子会话的唯一需求注入路径；缺省不出需求段）。 */
  requirementsDigest?: string
  /** 上一轮已验证结论（刀2 checkpoint 消费：同阶段重跑时注入——勿重验，直接收口）。 */
  verifiedConclusion?: string
}

/**
 * 构建调度员系统提示词（每阶段动态重建）。
 *
 * 组装序（固定，段落锚可被测试锁定）：
 *   1. 角色与使命头；
 *   2. 阶段任务书（模板渲染）；
 *   3. 阶段约束（constraints 逐条）；
 *   4. 推进协议段（标记形态+唯一合法目标+门禁清单）；
 *   5. 工具纪律段（不写文件+委派路径+本阶段扩展工具）；
 *   6. 输出纪律段（中文/要点化/结尾形态——d34d189f 狗粮案 40 轮英文叙述直灌聊天流的根治）；
 *   7. 确认纪律段（requiresUserConfirmation 时：先决策卡后标记）。
 */
export function buildDispatcherSystemPrompt(node: PhaseNode, ctx: DispatcherPromptContext): string {
  const rendered = renderTaskTemplate(node.taskTemplate, {
    project_name: ctx.projectName,
  })
  const sections: string[] = []

  // 1. 角色与使命头
  sections.push(
    `你是桌面品类交付调度员，当前角色：${node.role}（阶段「${node.id}」· ${node.title}）。` +
      (ctx.completedPhases && ctx.completedPhases.length > 0
        ? `已完成阶段：${ctx.completedPhases.join(' → ')}。`
        : '') +
      '你的职责是编排本阶段工作：委派、等待、核验、与用户交互；阶段内的时机与参数由你自主决策。',
  )

  // 1b. 项目需求（首跑修复：此前调度员与子会话均无需求注入路径——PRD 背板摘要由此进入上下文）
  if (ctx.requirementsDigest) {
    sections.push(`【项目需求（唯一真相源，不得改写）】\n${ctx.requirementsDigest}`)
  }

  // 1c. 上一轮已验证结论（刀2 checkpoint：同阶段重跑防重验——任务书之前注入，结论优先于任务）
  if (ctx.verifiedConclusion) {
    sections.push(`【上一轮已验证结论】\n${ctx.verifiedConclusion}`)
  }

  // 2. 任务书
  sections.push(`【本阶段任务书】\n${rendered.text}`)

  // 3. 阶段约束
  if (node.constraints.length > 0) {
    sections.push(`【阶段约束】\n${node.constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')}`)
  }

  // 4. 推进协议段
  sections.push(buildAdvanceProtocolSection(node))

  // 5. 工具纪律段
  sections.push(buildToolDisciplineSection(node))

  // 6. 输出纪律段（刀4，2026-10-02 d34d189f 狗粮案：调度员英文过程叙述 40 轮/段
  // 原样直灌聊天流——纪律段进基座，所有阶段固定生效）
  sections.push(buildOutputDisciplineSection())

  // 7. 确认纪律段
  if (node.requiresUserConfirmation) {
    sections.push(
      '【确认纪律】\n' +
        '本阶段收口需要用户确认：门禁全部通过后，直接在回复末尾输出推进标记即可——' +
        '平台裁决边界会自动向用户发起确认卡并等待确认（你不需要、也无法自己发卡，不要让子会话代办）。' +
        '用户确认前阶段不会推进；用户被拒时按意见返工。',
    )
  }

  if (ctx.workspaceHint) {
    sections.push(`【环境】\n${ctx.workspaceHint}`)
  }

  return sections.join('\n\n')
}

/**
 * 子会话基底 system（桌面线 worker 视角，2026-09-26 首跑修复）：项目/阶段/产物目录/
 * 阶段约束/需求摘要——不含调度员纪律段（「不写文件/靠委派」是调度员专属规则，
 * 子会话恰恰负责落盘）。委派机制会在其上再叠 role 说明与任务（buildChildSystemPrompt）。
 */
export function buildDesktopChildBaseSystem(
  node: PhaseNode,
  ctx: { projectName: string; requirementsDigest?: string },
): string {
  const parts: string[] = [
    `你正在为「${ctx.projectName}」项目工作：Windows 桌面品类交付流水线，当前阶段「${node.title}」（${node.id}）。`,
    // 刀4（2026-10-02）：子会话产出经委派摘要回流调度员→聊天流，英文长报告会原样
    // 灌进用户视野——汇报语言纪律在基底 system 收口（防英文报告回流摘要）。
    '【汇报纪律】完成摘要与一切面向用户的文本一律使用中文，简明扼要（要点式，先结论后细节索引）；分析细节写入产物文件，不在摘要里展开。',
    node.outputPath
      ? `本阶段产物目录：${node.outputPath}/（相对项目根目录）。`
      : '本阶段产物写入项目根目录（相对路径）。',
  ]
  if (node.constraints.length > 0) {
    parts.push(`【阶段约束】\n${node.constraints.map((constraint, index) => `${index + 1}. ${constraint}`).join('\n')}`)
  }
  if (ctx.requirementsDigest) {
    parts.push(`【项目需求（唯一真相源，不得改写；清单外新功能一律不做）】\n${ctx.requirementsDigest}`)
  }
  return parts.join('\n\n')
}

/**
 * 推进协议段（提示词中的裁决契约说明——与 dispatcher-gate 的收集正则同源维护）：
 * - 标记形态两种（注释/行首），句中复述不生效；
 * - 唯一合法目标=next（终态说明收尾语义）；
 * - 门禁清单（gates 数据渲染）。
 */
export function buildAdvanceProtocolSection(node: PhaseNode): string {
  const lines: string[] = []
  lines.push('【推进协议】')
  if (node.next === null) {
    lines.push(
      '本阶段为终态。完成工作后输出交付总结即可，不要输出任何推进标记。',
    )
  } else {
    lines.push(
      `本阶段完成且门禁全部通过后，在回复末尾单独一行输出（二选一，句中复述无效）：`,
      `  <!-- ${PHASE_ADVANCE_KEYWORD}: ${node.next} -->`,
      `  ${PHASE_ADVANCE_KEYWORD}: ${node.next}`,
      `这是唯一的合法推进目标；跳级、回退、伪造目标都会被裁决边界拒绝并退回重做。`,
    )
  }
  const effectiveGates = node.gates.filter((g) => g.kind !== 'manual')
  if (effectiveGates.length > 0) {
    lines.push('本阶段门禁（推进前必须全部满足）：')
    for (const gate of effectiveGates) {
      lines.push(`  - [${gate.kind}] ${gate.description}`)
    }
  }
  const manualGates = node.gates.filter((g) => g.kind === 'manual')
  if (manualGates.length > 0) {
    lines.push('用户确认门（裁决边界决策卡收口）：')
    for (const gate of manualGates) {
      lines.push(`  - ${gate.description}`)
    }
  }
  return lines.join('\n')
}

/**
 * 输出纪律段（刀4，2026-10-02 确认协议与呈现层战役）：面向用户的呈现质量契约——
 * 调度员是用户唯一可见的过程人格，聊天流不是工程日志。三条纪律对应三类事故：
 * 英文长段（渠道默认英文输出）→ ①一律中文；过程叙述淹没结论 → ②要点化≤2 句，
 * 长分析落产物文件；结尾形态漂移（开放式提问/冗长总结） → ③结尾只允许下一步一句话
 * 或推进标记。子会话侧的对应纪律在 buildDesktopChildBaseSystem（防英文报告回流摘要）。
 */
export function buildOutputDisciplineSection(): string {
  return [
    '【输出纪律】',
    '1. 面向用户的一切文本（阶段叙述、汇报、拒收教育、交付通知）一律使用中文；专有名词与代码标识符可保留英文原词，不写英文句段。',
    '2. 过程叙述收敛为不超过 2 句的要点；更长的分析与方案对比写入委派任务书或产物文件（报告/清单），不进聊天流。',
    '3. 每轮回复的结尾只允许两种形态：一句话说明下一步，或输出推进标记——不写开放式提问、不写冗长总结。',
  ].join('\n')
}

/**
 * 工具纪律段：调度员不写文件（裁决边界硬拦清单）+ 委派是写操作唯一路径 +
 * 本阶段扩展工具（extraTools 数据渲染；基础面在接线层工具装配时已体现）。
 */
export function buildToolDisciplineSection(node: PhaseNode): string {
  const lines: string[] = []
  lines.push('【工具纪律】')
  lines.push(
    '你不直接写文件：write_file/edit_file 被裁决边界硬拦。一切落盘工作（建骨架、写实现、' +
      '写报告）都通过 delegate_agent 委派子会话完成；你负责拆解任务书、指定渠道与验收标准、' +
      '用只读工具核验产物。',
  )
  lines.push(
    '落盘类子任务一律用 role=implement 委派（research/explore 子会话只读、没有写文件工具）；' +
      '子会话挂起提问（摘要里的 pending_question）时尽快用 answer_delegation_question 代答，' +
      '否则它会一直挂起、且 wait_for_delegations 会反复提前返回。',
  )
  if (node.extraTools.length > 0) {
    lines.push(`本阶段附加工具：${node.extraTools.join('、')}。`)
  }
  return lines.join('\n')
}
