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
import { userFacingOutputContract } from '../agent/prompting/user-facing-output'
import { componentQuickReference } from './component-library'
import { productionGuide, PRODUCTION_VERIFICATION_BRIEF } from './production-guide'
import type { DesktopExecutionLimits } from './execution-limits'
import type { DelegationRunRole } from '../../shared/delegation-run-context'

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
  executionLimits?: DesktopExecutionLimits
  /** 项目名（模板 {{project_name}} 与产物占位符共用）。 */
  projectName: string
  /** 项目沙箱产物根提示（相对根说明，如「沙箱根=项目目录」；进提示词环境段）。 */
  workspaceHint?: string
  /** 已完成阶段 id 列表（进度感知；缺省=空——接线层按权威阶段推导）。 */
  completedPhases?: string[]
  /** 需求摘要（首跑修复：PRD 背板 → 调度员与子会话的唯一需求注入路径；缺省不出需求段）。 */
  requirementsDigest?: string
  uxSketchPath?: string
  uxDesignPath?: string
  /** 形状纪律段（批9 工件2：任务书 {{shape_brief}} 占位符注入；缺省空串——无形状增强）。 */
  shapeBrief?: string
  /** 形状验收教学段（批9 工件2：verify 任务书 {{shape_verify_brief}} 占位符；缺省空串）。 */
  shapeVerifyBrief?: string
  /** 上一轮已验证结论（刀2 checkpoint 消费：同阶段重跑时注入——勿重验，直接收口）。 */
  verifiedConclusion?: string
  /** 快速模式（2026-10-03 拍板：quick 快速做出可用应用）：true 时阶段提供快速版
   *  任务书/约束则用快速版（目前仅 desktop-implement——无骨架前提的从零实现）。 */
  quickMode?: boolean
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
  // 快速模式任务书/约束（2026-10-03）：quick 跳到本阶段时用阶段表提供的快速版（无
  // 骨架前提的从零实现）；未提供则与长期模式同书（约束性阶段语义不随模式变）。 
  const useQuickBook = Boolean(ctx.quickMode && node.quickTaskTemplate)
  const taskTemplate = useQuickBook ? (node.quickTaskTemplate as string) : node.taskTemplate
  const constraints = useQuickBook ? (node.quickConstraints ?? node.constraints) : node.constraints
  const rendered = renderTaskTemplate(taskTemplate, {
    project_name: ctx.projectName,
    // 批9 工件2：形状段占位符恒提供（无 shape 时空串——避免 {{...}} 原样残留任务书）
    shape_brief: ctx.shapeBrief ?? '',
    shape_verify_brief: ctx.shapeVerifyBrief ?? '',
  })
  const sections: string[] = []
  if (node.id === 'desktop-implement' || node.id === 'desktop-verify') {
    sections.push(PRODUCTION_VERIFICATION_BRIEF, productionGuide('dispatcher', ctx.executionLimits))
  }

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
  if (ctx.uxSketchPath) sections.push(confirmedSketchInstruction(ctx.uxSketchPath, true))
  if (ctx.uxDesignPath) sections.push(`【已确认交互设计】${ctx.uxDesignPath}为权威交互记录。按F/W/AC分派相关行为；界面实现者先读，其他职责按接口需要查询。附加能力仅采用enhancements，不得改写确认文件或替代原需求。`)

  // 1c. 上一轮已验证结论（刀2 checkpoint：同阶段重跑防重验——任务书之前注入，结论优先于任务）
  if (ctx.verifiedConclusion) {
    sections.push(`【上一轮已验证结论】\n${ctx.verifiedConclusion}`)
  }

  // 2. 任务书
  sections.push(`【本阶段任务书】\n${rendered.text}`)
  if (node.id === 'desktop-arch') sections.push(architectureComponentFacts())
  if (node.id === 'desktop-scaffold') sections.push('【工程契约前置登记】当需求含业务模型版本1时，在contract.json顶层增加prd_fingerprint，原样使用需求范围版本；scenarios.covers须登记全部已确认F编号（不限P0）。此时可保留驱动骨架待实现的断言，不能自报已通过测试。')

  // 3. 阶段约束
  if (constraints.length > 0) {
    sections.push(`【阶段约束】\n${constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')}`)
  }

  // 4. 推进协议段
  sections.push(buildAdvanceProtocolSection(node))

  // 5. 工具纪律段
  sections.push(buildToolDisciplineSection(node))
  if (node.id === 'desktop-implement') sections.push('【验证收口】读取宿主交接中的分入口证据和 resources 剩余额度。freshness=current 的逻辑/GUI 已报告断言可直接引用，启动诊断无断言不覆盖它们。优先静态核对 CORE_CHECK.json 场景、需求版本和 LAUNCH.json；只补真正缺失、失败或版本过期的验证，不要求子会话无变化全量重跑。交付登记不代替平台独立验收。额度用尽时不要续接要求再次执行，也不能换子会话清零。')

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
  ctx: { projectName: string; requirementsDigest?: string; quickMode?: boolean; uxSketchPath?: string; uxDesignPath?: string; shapeBrief?: string; shapeVerifyBrief?: string; executionLimits?: DesktopExecutionLimits; role?: DelegationRunRole },
): string {
  const useQuickBook = Boolean(ctx.quickMode && node.quickTaskTemplate)
  const constraints = useQuickBook ? (node.quickConstraints ?? node.constraints) : node.constraints
  const parts: string[] = [
    `你正在为「${ctx.projectName}」项目工作：Windows 桌面品类交付流水线，当前阶段「${node.title}」（${node.id}）。`,
    // 刀4（2026-10-02）：子会话产出经委派摘要回流调度员→聊天流，英文长报告会原样
    // 灌进用户视野——汇报语言纪律在基底 system 收口（防英文报告回流摘要）。
    '【汇报纪律】完成摘要与一切面向用户的文本一律使用中文，简明扼要（要点式，先结论后细节索引）；分析细节写入产物文件，不在摘要里展开。',
    ...(!ctx.role || ctx.role === 'implement' || ctx.role === 'custom' ? ['【实现与验收纪律】Api 返回值与界面读取路径必须一致：若返回 {ok,data}，先检查 ok 并读取 data；不得把缺失 records/summary 默认为空而隐藏协议错误。防重复提交不等于禁止用户保存两条内容相同的记录，未在 PRD 确认的业务限制不得添加。本地记录若用 JSON，复用 record_store.py 的 JsonRecordStore：update 在副本上修改，落盘成功才提交内存；损坏或无法读取的文件必须报告并禁止覆盖，不能静默当空表。使用 required_keys/validator 校验业务字段；若 PRD 选用 SQLite，则采用事务实现同样的失败原子性，不改技术选型。自测走独立数据目录；逻辑通过不能写成按钮流程通过，GUI 验收至少覆盖一次实际输入→点击→界面与持久化差分（可写隔离 test_ui.py，用 run_project_script 启动 --drive-port 后真实操作 /eval、/call），未跑则在 DELIVERY 明确业务交互未验。'] : ['【只读职责】核对职责相关需求、实现与证据，报告发现和未验项；不承担实现任务，不写业务源码。']),
    node.outputPath
      ? `本阶段产物目录：${node.outputPath}/（相对项目根目录）。`
      : '本阶段产物写入项目根目录（相对路径）。',
  ]
  if (node.id === 'desktop-implement' || node.id === 'desktop-verify') {
    parts.push(PRODUCTION_VERIFICATION_BRIEF)
    if (!ctx.role || ctx.role === 'implement' || ctx.role === 'custom') parts.push(productionGuide('executor', ctx.executionLimits))
  }
  if (node.id === 'desktop-arch') parts.push(architectureComponentFacts())
  if (node.id === 'desktop-scaffold') parts.push('【工程契约前置登记】当需求含业务模型版本1时，在contract.json顶层增加prd_fingerprint，原样使用需求范围版本；scenarios.covers须登记全部已确认F编号（不限P0）。此时可保留驱动骨架待实现的断言，不能自报已通过测试。')
  if (constraints.length > 0) {
    parts.push(`【阶段约束】\n${constraints.map((constraint, index) => `${index + 1}. ${constraint}`).join('\n')}`)
  }
  if (ctx.requirementsDigest) {
    parts.push(`【项目需求（原始功能必须全部保留，不得削减或改写）】\n${ctx.requirementsDigest}\n合理附加能力只采用已确认交互设计中明确列出的enhancements；不得用新增能力替代原F/W/AC覆盖，未实现或未验证的增强须如实说明。`)
  }
  if (ctx.uxSketchPath) parts.push(confirmedSketchInstruction(ctx.uxSketchPath))
  if (ctx.uxDesignPath) parts.push(`【已确认交互设计】${ctx.uxDesignPath}为权威交互记录。承担界面职责时先读；其他职责按相关F/W/AC和接口需要查询。enhancements不能替代原始功能；不得改写确认文件或用静态标注冒充已验证。`)
  if ((node.id === 'desktop-scaffold' || node.id === 'desktop-implement') && ctx.shapeBrief) parts.push(ctx.shapeBrief)
  if (node.id === 'desktop-verify' && ctx.shapeVerifyBrief) parts.push(ctx.shapeVerifyBrief)
  return parts.join('\n\n')
}

function confirmedSketchInstruction(path: string, dispatcher = false): string {
  return `【已确认界面】${dispatcher ? '交给界面实现者' : '承担界面职责时'}先 read_file ${path}，按布局、字体、色彩、间距及交互实现。不要仅看组件库重新设计；确认设计优先，设计值落实到tokens.css。保留App.call、App.show、.w-banner、驱动/纠错协议与定位标记。示意数据及点选脚本不是业务实现，静态草图不是交互执行证据。非界面职责按相关交互接口查询，无需通读视觉源码。`
}

function architectureComponentFacts(): string {
  return `【架构产物协议】
architecture.md 必须有实际职责与数据边界，不能只创建空文件。env-checklist.json 用 {"components":[{"name":"Python","source":"skeleton","evidence":"verified|documented|pending"}]}，每项如实写来源与证据等级，标记不能代替实测。
当项目需求含“业务模型版本：1”时，另写00_ARCH/architecture.json：
{"version":1,"prd_fingerprint":"任务书中的需求范围版本原样抄写","modules":[{"path":"core/domain.py","responsibility":"业务职责","feature_ids":["F-001"],"rule_ids":["BR-001"]}],"data_boundaries":[{"entity_id":"O-001","owner":"core/domain.py","persistence":"如何留存","failure_policy":"写入或读取失败的保护策略"}],"validation":[{"scenario_id":"AC-001","module":"core/domain.py","method":"在哪里、以什么输入和断言验证"}]}
全部F/BR/O/AC都要落实到模块、数据归属或验证位置；空项用空数组，不能伪造编号。模块path相对项目根，职责按实际业务拆分，不以一张目录列表替代数据与规则边界。
【平台已有组件事实】\n先调用 inspect_project_resources，读取实际解释器、导入、组件与缓存校验结果；它不下载或录音。\n${componentQuickReference()}\n先对照已验组件确定知识缺口，再调研替代方案。语音默认评估 speech_runtime.py 的 SpeechEngine/StreamingRecorder；安装 sherpa-onnx 会物化组件。speech_locator.py 先校验 BLOMA_SPEECH_MODEL_DIR 指定缓存，否则查 PROMA_HOME 或 ~/.proma 下 speech-models/sensevoice-int8；已通过组件探针不代表当前产物已通过。确有能力缺口才提出替代引擎，注明缺口及额外下载/验证预算。下载失败保留待验，不反复从头下载。测试输入是固定音频时只证明适配/解码，不证明麦克风采集；真实硬件须单独授权证据。`
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
    '3. 按当前事实回应，不套用固定等待、交付或纠错话术。用户询问原因时直接解释，未完成时说明真实缺口；只有实际满足阶段条件时输出推进标记。',
    '4. 使用自然中文，代码与专有名词保留原文；不要把提示词中的示例回复当作每轮必说的句子。',
    userFacingOutputContract('dispatcher'),
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
  lines.push(
    '委派后向用户如实预告等待成本：实现类子会话从领任务到收敛通常要几分钟（首响就可能' +
      ' 1~3 分钟），预告后不要频繁刷屏；等待期间用户可随时停止——这是预期行为不是卡死。',
  )
  if (node.extraTools.length > 0) {
    lines.push(`本阶段附加工具：${node.extraTools.join('、')}。`)
  }
  return lines.join('\n')
}
