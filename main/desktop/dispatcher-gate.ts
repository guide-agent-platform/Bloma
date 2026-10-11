/**
 * 桌面调度员裁决围栏（批次 A 地基，2026-09-24）——推进标记三关校验 + 工具白名单。
 *
 * 依据实施稿第二节「控制权分界」：阶段序列/推进授权/写权限/验收=代码裁决；
 * 阶段内微决策=模型自主。执行者有了自主性才需要意图守卫，本模块就是守卫的纯函数核心：
 *
 *   关1 锚定收集 collectAdvanceMarks——只认注释/行首两种锚定形态，句中引用丢弃并记观测；
 *   关2 目标唯一性 validateAdvanceTarget——唯一合法目标=当前节点 next，跳级/回退拒绝；
 *   关3 产物验证 verifyPhaseArtifacts——artifact 门禁声明的产物存在性检查。
 *
 * canUseTool 白名单 checkDispatcherToolGate：调度员不写文件——写文件族硬拦
 * （写操作一律经委派子会话完成），白名单外工具拒绝并教育。
 *
 * 本模块零 I/O（产物存在性经谓词注入）、零 agent 运行时依赖；批次 D 接线时由
 * 调度员 loop 的工具门禁与 run 收口检测块消费。web 线不消费本模块。
 *
 * AGPL 边界：锚定收集/目标校验的守卫设计模式为结构思想借鉴；正则、判定矩阵、
 * 文案全部自写（对方判据：欠收集比误收集致命→行首裸标记仍收集；防御性放行
 * （数据异常宁放行不卡死）——两条设计原则经评估后采纳，实现零复制）。
 */

import type { MessageContentBlock } from '../../shared/types'
import { getDesktopPhase, type PhaseNode } from './dispatcher-phases'

// =========================================================================
// 关1：推进标记锚定收集
// =========================================================================

/** 推进标记协议字面量（与 dispatcher-prompt 的协议说明段同源维护）。 */
export const PHASE_ADVANCE_KEYWORD = 'PHASE_ADVANCE'

/** 锚定收集结果：按序收集的标记目标 + 被丢弃的句中引用观测（教育/遥测用）。 */
export interface AdvanceMarkCollection {
  /** 按出现序收集的推进目标（同一文本多处标记全部保留，去重由消费方决定）。 */
  marks: string[]
  /** 句中引用形态的丢弃观测（上下文样本截 60 字符）。 */
  discarded: Array<{ target: string; context: string }>
}

/**
 * 从一轮 assistant 消息的文本块中按序收集 PHASE_ADVANCE 标记（纯函数）。
 *
 * 锚定形态仅两种（欠收集比误收集致命，反之句中引用是模型复述协议字面串的噪声）：
 *   ① 注释形态：<!-- PHASE_ADVANCE: desktop-scaffold -->
 *   ② 行首形态：串首或换行后可选空白直接跟标记（容忍缩进，代码块内行首标记仍收集
 *      ——独立行声明的标记视为真实意图，与竞品同判）。
 *
 * 扫描面：assistant 轮次的内容块数组，只取 text 块拼接（tool_use/tool_result 不扫）。
 */
export function collectAdvanceMarks(turns: ReadonlyArray<readonly MessageContentBlock[]>): AdvanceMarkCollection {
  const marks: string[] = []
  const discarded: Array<{ target: string; context: string }> = []
  for (const blocks of turns) {
    const text = blocks
      .filter((block): block is { type: 'text'; text?: string } => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
    if (!text) continue
    // 锚定形态：注释 ∪ 行首（捕获组 1=注释内、2=行首）
    const anchored = [...text.matchAll(
      /(?:<!--\s*PHASE_ADVANCE:\s*([a-z0-9-]+)\s*-->)|(?:^|\n)[ \t]*PHASE_ADVANCE:\s*([a-z0-9-]+)/gi,
    )]
    for (const match of anchored) {
      const target = (match[1] ?? match[2] ?? '').toLowerCase()
      if (target) marks.push(target)
    }
    // 丢弃观测：宽松命中 − 锚定命中 = 句中引用数
    const loose = [...text.matchAll(/PHASE_ADVANCE:\s*([a-z0-9-]+)/gi)]
    for (const match of loose) {
      const idx = match.index ?? 0
      const covered = anchored.some((am) => {
        const amIdx = am.index ?? 0
        return idx >= amIdx && idx < amIdx + am[0].length
      })
      if (covered) continue
      const target = (match[1] ?? '').toLowerCase()
      if (!target) continue
      discarded.push({
        target,
        context: text.slice(Math.max(0, idx - 20), idx + 40).replace(/\n/g, ' '),
      })
    }
  }
  return { marks, discarded }
}

// =========================================================================
// 关2：推进目标唯一性校验
// =========================================================================

/** 关2 判定结果（expected 为唯一合法目标，开放 string——阶段表可插阶段）。 */
export type AdvanceTargetValidation =
  | { ok: true }
  | { ok: false; expected: string | null; reason: 'unknown-current' | 'unknown-target' | 'not-next' | 'terminal' }

/**
 * 推进目标唯一性校验（纯函数）：target === 当前节点 next 才放行。
 *
 * 判定矩阵：
 * - current 不在阶段表（数据异常/上游未初始化）→ 防御性放行（宁放行不卡死，
 *   与既有故障处理哲学一致；接线层可自行记观测）；
 * - current 为终态（next=null）→ 一律拒绝（terminal）；
 * - target 不是合法阶段 id → 拒绝（unknown-target，防伪造枚举外目标）；
 * - target ≠ next → 拒绝（not-next，覆盖跳级与回退两种形态），expected 携带唯一合法目标。
 */
export function validateAdvanceTarget(current: string, target: string): AdvanceTargetValidation {
  const currentNode = getDesktopPhase(current)
  if (!currentNode) return { ok: true }
  if (currentNode.next === null) {
    return { ok: false, expected: null, reason: 'terminal' }
  }
  if (!getDesktopPhase(target)) {
    return { ok: false, expected: currentNode.next, reason: 'unknown-target' }
  }
  if (target !== currentNode.next) {
    return { ok: false, expected: currentNode.next, reason: 'not-next' }
  }
  return { ok: true }
}

// =========================================================================
// 关3：产物存在性验证
// =========================================================================

/** 关3 判定结果：passed=false 时 missing 列出未通过门禁及其缺失产物。 */
export interface ArtifactVerification {
  passed: boolean
  /** 已核验的产物路径（渲染后的绝对判定输入，供事件流/报告）。 */
  checked: string[]
  /** 未通过项：gateId → 缺失产物路径列表。 */
  missing: Array<{ gateId: string; artifacts: string[] }>
}

/**
 * 产物存在性验证（纯函数；存在性谓词注入）。
 *
 * 只核验 kind='artifact' 的门禁（driver 门禁的执行器批次 C 落地，manual 门禁属
 * 决策卡边界）；artifacts 支持 {{project_name}} 占位符渲染。无 artifact 门禁的
 * 阶段恒通过（空产核验不是失败）。
 *
 * @param node 当前阶段节点
 * @param exists 产物存在性谓词（入参=渲染后的相对路径；生产侧接沙箱根 resolve，
 *               测试侧注入桩表）
 * @param vars 占位符变量（{{project_name}} 等）
 */
export function verifyPhaseArtifacts(
  node: PhaseNode,
  exists: (relativePath: string) => boolean,
  vars: Record<string, string> = {},
): ArtifactVerification {
  const checked: string[] = []
  const missing: Array<{ gateId: string; artifacts: string[] }> = []
  for (const gate of node.gates) {
    if (gate.kind !== 'artifact') continue
    const missingArtifacts: string[] = []
    for (const pattern of gate.artifacts ?? []) {
      const resolved = renderPattern(pattern, vars)
      checked.push(resolved)
      if (!exists(resolved)) missingArtifacts.push(resolved)
    }
    if (missingArtifacts.length > 0) missing.push({ gateId: gate.id, artifacts: missingArtifacts })
  }
  return { passed: missing.length === 0, checked, missing }
}

/** 占位符渲染（{{var}} 全量替换；未知变量保留原样——与 dispatcher-prompt.renderTaskTemplate 同语义）。 */
function renderPattern(pattern: string, vars: Record<string, string>): string {
  return pattern.replace(/\{\{([a-z_][a-z0-9_]*)\}\}/gi, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole)
}

// =========================================================================
// 三关总入口（批次 D 接线层消费；批次 A 提供判定骨架）
// =========================================================================

/** 一次推进决策的完整判定（关1 产物 + 关2 + 关3）。 */
export type AdvanceDecision =
  | { decision: 'advance'; target: string; discardedObservations: AdvanceMarkCollection['discarded'] }
  | {
      decision: 'reject'
      reason: 'no-marks' | 'multiple-divergent' | 'unknown-current' | 'unknown-target' | 'not-next' | 'terminal' | 'artifacts-missing' | 'contract-invalid' | 'security-fail' | 'test-invalid' | 'fault-survived' | 'driver-blocked' | 'driver-fail'
      expected?: string | null
      actual?: string
      missingArtifacts?: ArtifactVerification['missing']
      discardedObservations: AdvanceMarkCollection['discarded']
      /** 拒收教育文案（三段式；批次 E 接 systemInitiated 续接时复用）。 */
      education: string
    }

/**
 * 三关串行判定：锚定收集 → 目标唯一性 → 产物存在性。
 *
 * 多标记语义：同轮多个标记全部同目标=幂等（按一次处理）；出现分歧目标=拒绝
 * （multiple-divergent，防「广撒网赌一个过」）。拒收时给出结构化原因与教育文案；
 * 文案生成委托 buildGateRejectionEdu（本模块内联实现，避免对 prompt 模块的运行时
 * 依赖——prompt 面向系统提示词组装，文案职责留在裁决侧单点维护）。
 */
export function evaluateAdvance(
  turns: ReadonlyArray<readonly MessageContentBlock[]>,
  current: string,
  exists: (relativePath: string) => boolean,
  vars: Record<string, string> = {},
): AdvanceDecision {
  const collection = collectAdvanceMarks(turns)
  const uniqueTargets = [...new Set(collection.marks)]
  if (uniqueTargets.length === 0) {
    return {
      decision: 'reject',
      reason: 'no-marks',
      discardedObservations: collection.discarded,
      education: buildGateRejectionEdu('no-marks', { current }),
    }
  }
  if (uniqueTargets.length > 1) {
    return {
      decision: 'reject',
      reason: 'multiple-divergent',
      actual: uniqueTargets.join(' | '),
      discardedObservations: collection.discarded,
      education: buildGateRejectionEdu('multiple-divergent', { current, actual: uniqueTargets.join('、') }),
    }
  }
  const target = uniqueTargets[0]
  const validation = validateAdvanceTarget(current, target)
  if (!validation.ok) {
    return {
      decision: 'reject',
      reason: validation.reason,
      expected: validation.expected,
      actual: target,
      discardedObservations: collection.discarded,
      education: buildGateRejectionEdu(validation.reason, {
        current,
        actual: target,
        expected: validation.expected ?? undefined,
      }),
    }
  }
  const currentNode = getDesktopPhase(current)
  if (!currentNode) {
    // 关2 防御性放行的同一分支：无节点即无门禁可验
    return { decision: 'advance', target, discardedObservations: collection.discarded }
  }
  const artifacts = verifyPhaseArtifacts(currentNode, exists, vars)
  if (!artifacts.passed) {
    return {
      decision: 'reject',
      reason: 'artifacts-missing',
      missingArtifacts: artifacts.missing,
      discardedObservations: collection.discarded,
      education: buildGateRejectionEdu('artifacts-missing', {
        current,
        actual: target,
        missing: artifacts.missing.flatMap((entry) => entry.artifacts).join('、'),
      }),
    }
  }
  return { decision: 'advance', target, discardedObservations: collection.discarded }
}

/** 拒收原因枚举（AdvanceDecision 的 reject 分支提取）。 */
export type AdvanceRejectReason = Extract<AdvanceDecision, { decision: 'reject' }>['reason']

/**
 * 拒收教育文案（三段式：发生了什么 / 为什么拒 / 正确做法）。
 * 批次 E 拒收教育闭环（systemInitiated 续接 + 防环 ≤2 + 降级）消费同一文案源。
 */
export function buildGateRejectionEdu(
  reason: AdvanceRejectReason,
  detail: { current: string; actual?: string; expected?: string; missing?: string },
): string {
  const header = '推进标记被裁决边界拒绝'
  const what = `本次声明：阶段「${detail.current}」→ 目标「${detail.actual ?? '（无）'}」`
  switch (reason) {
    case 'no-marks':
      return `${header}\n发生了什么：本轮未收集到任何锚定形态的推进标记（注释 <!-- PHASE_ADVANCE: xxx --> 或行首 PHASE_ADVANCE: xxx）。\n为什么拒：推进必须显式声明意图，静默完成不构成推进。\n正确做法：确认本阶段门禁全部通过后，在回复末尾单独一行输出推进标记。`
    case 'multiple-divergent':
      return `${header}\n发生了什么：${what}，且同轮出现多个不同目标。\n为什么拒：分歧目标意味着阶段结论未收敛。\n正确做法：先收敛到唯一结论（必要时向用户澄清），再输出单一目标的推进标记。`
    case 'unknown-target':
      return `${header}\n发生了什么：${what}，该目标不在阶段表枚举内。\n为什么拒：阶段序列由代码裁决，伪造枚举外目标无效。\n正确做法：只能推进到当前阶段的唯一合法目标「${detail.expected ?? ''}」。`
    case 'not-next':
      return `${header}\n发生了什么：${what}。\n为什么拒：跳级与回退都被拒绝——当前阶段唯一合法目标是「${detail.expected ?? ''}」。\n正确做法：先完成当前阶段门禁，输出 PHASE_ADVANCE: ${detail.expected ?? ''}；如确需变更序列请向用户说明并由人工介入。`
    case 'terminal':
      return `${header}\n发生了什么：当前已处于终态（delivered），仍声明了推进目标「${detail.actual ?? ''}」。\n为什么拒：终态无合法推进。\n正确做法：输出交付总结；后续迭代走既有迭代管线。`
    case 'artifacts-missing':
      return `${header}\n发生了什么：${what}，但产物验证未通过——缺失：${detail.missing ?? ''}。\n为什么拒：推进以真实产物为凭，不以自述为凭。\n正确做法：先委派补齐缺失产物（核验存在且内容有效），再重新声明推进。`
    case 'unknown-current':
      return `${header}\n发生了什么：当前阶段「${detail.current}」不在阶段表内（数据异常）。\n为什么拒：异常状态下不做推进。\n正确做法：向用户报告状态异常，等待人工确认阶段。`
    default:
      return `${header}\n发生了什么：${what}。`
  }
}

// =========================================================================
// canUseTool 工具白名单（调度员不写文件）
// =========================================================================

/** 写文件族——调度员硬拦清单（工具面形态对齐 agent-tools/write_file|edit_file 与上游 Write|Edit 双名）。 */
export const DISPATCHER_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'Write', 'Edit'])

/**
 * 调度员基础工具白名单：
 * - 委派族（C1 跨渠道）：写操作的全部合法路径——调度员只编排不落盘；
 * - 只读族：read_file/list_files/grep/find/web_fetch/web_research；
 * - 决策卡：guide_decide（用户交互收口）；
 * - 会话元工具：compact_context（管理会话自身上下文，非开发工具）。
 * 阶段扩展（PhaseNode.extraTools）叠加在本面之上。
 */
export const DISPATCHER_BASE_TOOLS: ReadonlySet<string> = new Set([
  'delegate_agent',
  'delegate_agents',
  'wait_for_delegations',
  'list_delegations',
  'get_delegation_results',
  'stop_delegation',
  'stop_delegations',
  'ask_delegation_question',
  'answer_delegation_question',
  'continue_delegation',
  'read_file',
  'list_files',
  'grep',
  'find',
  'web_fetch',
  'web_research',
  'inspect_project_resources',
  'guide_decide',
  'compact_context',
])

/** 工具门禁判定：null=放行；{deny,message}=拒绝（message 为教育文案）。 */
export interface ToolGateResult {
  deny: true
  message: string
}

/**
 * 调度员工具门禁（纯函数；批次 D 接线进调度员 loop 的 canUseTool 链）。
 *
 * 判定序：
 * 1. 写文件族 → 硬拦（无论是否在白名单/扩展中——PhaseNode.extraTools 声明写族
 *    属于数据错误，硬拦优先级最高，fail-closed）；
 * 2. 基础白名单 ∪ 阶段 extraTools → 放行；
 * 3. 其余 → 拒绝 + 教育（列出本阶段可用工具面）。
 *
 * 终态（delivered）与非调度员接管阶段（dispatcherManaged=false，如 requirements
 * 复用向导管线）不适用本门禁（接线层不挂），传入时不做特判——接线层负责。
 */
export function checkDispatcherToolGate(phase: PhaseNode, toolName: string): ToolGateResult | null {
  if (DISPATCHER_WRITE_TOOLS.has(toolName)) {
    return {
      deny: true,
      message:
        '调度员角色不直接写文件：write_file/edit_file 已被硬拦。\n' +
        '写操作的正确路径是委派：用 delegate_agent 派给具备完整工具面的子会话完成，' +
        '并用 read_file 核验产物。',
    }
  }
  if (DISPATCHER_BASE_TOOLS.has(toolName) || phase.extraTools.includes(toolName)) return null
  return {
    deny: true,
    message:
      `工具「${toolName}」不在阶段「${phase.id}」的调度员工具面内。\n` +
      `本阶段可用：${[...DISPATCHER_BASE_TOOLS, ...phase.extraTools].join('、')}。\n` +
      '需要其他能力时请通过委派完成（delegate_agent）。',
  }
}
