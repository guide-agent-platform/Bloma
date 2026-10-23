import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { buildDelegationTools } from '../agent/delegation/delegation-tools'
import type { PhaseNode } from './dispatcher-phases'
import { buildAdvanceProtocolSection, buildDesktopChildBaseSystem, renderTaskTemplate, type DispatcherPromptContext } from './dispatcher-prompt'

/** Proma bf3e98c: the primary agent owns the edit/execute loop; collaboration is
 * optional. Keep Bloma's independent verification and phase authorization outside
 * that loop. Frozen dispatch experiments retain their original supervisor. */
export function usesProductionAgent(node: PhaseNode, experiment: boolean): boolean {
  return !experiment && ['desktop-arch', 'desktop-scaffold', 'desktop-implement'].includes(node.id)
}

export function productionTurns(phase: string): number {
  return phase === 'desktop-implement' ? 96 : phase === 'desktop-scaffold' ? 24 : 32
}

export function productionAgentTools(executorTools: AgentLoopTool[], extraTools: AgentLoopTool[]): AgentLoopTool[] {
  const tools = [...executorTools.filter(tool => tool.name !== 'ask_delegation_question'), ...buildDelegationTools('parent'), ...extraTools]
  return [...new Map(tools.map(tool => [tool.name, tool])).values()]
}

export function buildProductionAgentPrompt(node: PhaseNode, ctx: DispatcherPromptContext): string {
  const adapt = (constraints: readonly string[]) => constraints.map(text => text
    .replace('实现与骨架同一委派线续接（上下文不换人）', '沿用主执行会话和已有骨架上下文，直接实现与验证')
    .replace('自测走子会话 run_project_script', '自测使用 run_project_script')
    .replace('Spike 子会话', '专项验证'))
  const primaryNode: PhaseNode = { ...node, constraints: adapt(node.constraints),
    ...(node.quickConstraints ? { quickConstraints: adapt(node.quickConstraints) } : {}) }
  const task = node.id === 'desktop-arch'
    ? '直接完成最小架构决策并写入00_ARCH/architecture.md与env-checklist.json：先查询平台组件与实际环境；沿用已验证骨架与现有驱动，不重新研究pywebview起窗、线程和桥。只对PRD新增且现有组件无法覆盖的风险做最小专项实测；同一故障先定位原因再重试，不反复运行同一失败探针。按实际结果标注文证/实证/未验证，未验证不得冒充通过。架构以模块、持久化、接口及验收入口为主，随后进入实现。'
    : renderTaskTemplate(ctx.quickMode && node.quickTaskTemplate ? node.quickTaskTemplate : node.taskTemplate, {
      project_name: ctx.projectName, shape_brief: ctx.shapeBrief ?? '', shape_verify_brief: ctx.shapeVerifyBrief ?? '',
    }).text
      .replace(/按职责委派 implement 子会话完成实现/g, '由你直接完成实现与验证，独立任务才选择委派')
      .replace(/委派[^\n：:]*完成/g, '直接完成')
  return [
    buildDesktopChildBaseSystem(primaryNode, { ...ctx, role: 'implement' }),
    '【主执行Agent】你持有本阶段上下文，可直接读取、编辑、安装依赖并运行验证。对已有失败先做最小修复，不把同一任务反复交给新执行者重新通读。委派仅用于可独立完成、边界明确的工作；UI与业务跨边界变更由你集成后真实验证。',
    '先读相关入口与生产者/消费者，尽早运行一个最小业务闭环。接口字段以实际返回为准；修改接口时同轮更新消费者与契约测试。验证失败不能通过降低断言或更改预期来掩盖。测试与交付证据保留独立数据目录及真实命令。',
    ctx.verifiedConclusion ? `【上一轮已验证结论】\n${ctx.verifiedConclusion}` : '',
    `【本阶段任务书】\n${task}`,
    buildAdvanceProtocolSection(node),
    '阶段推进仍由宿主核对产物与验证；执行结束不等于交付成功。未完成时给出已改文件、最新验证和可直接继续的缺口，不能输出成功推进标记。向用户用简短中文报告结果与下一步。',
  ].filter(Boolean).join('\n\n')
}
