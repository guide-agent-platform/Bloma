/**
 * 分发支撑件（PR4b 拆出）：编程系统轮构建、会话历史装载、停滞检测、向导路由判定、重建确认卡。
 * 纯机械搬移（零行为变化）；对外契约经 orchestrator re-export 保持不变。
 */
/**
 * 分发支撑件（PR4b 拆出）：编程系统轮构建、会话历史装载、停滞检测、向导路由判定、重建确认卡。
 * 纯机械搬移（零行为变化）；对外契约经 orchestrator re-export 保持不变。
 */



import type { AgentEvent, AgentSendMessageInput, WorkflowStage } from '../../../shared/types';









export { buildSdkEnv } from '../../platform/llm/channel-manager'











import { updateProject } from '../../project/project-service';




import { ConversationTurn } from './orchestration-contracts';


import { makeEvent } from './persistence';

/**
 * 编程路径模型系统提示（问题 A / P1 纵深防御）。
 *
 * 模型在本路径没有任何写文件 / 跑沙箱的工具：给它的上下文必须是「如实汇报 + 引导确认」，
 * 而不是让它自由发挥——否则它既不知道项目真实阶段（编出「还没好」），
 * 又会把整段 HTML 贴进聊天冒充交付（用户看了却落不了盘）。
 */
export function buildProgrammingSystemTurn(stage: WorkflowStage): ConversationTurn {
  return {
    role: 'system',
    content:
      '你在「Bloma 项目生成平台」的编程阶段协助用户。' +
      '本次对话里你没有写文件、运行代码或启动沙箱的工具——项目的生成、测试与预览都' +
      '由平台在后台自动完成，你无法改变或加速它们。' +
      `当前项目阶段：${stage}。` +
      '规则：用户询问进度时，如实基于阶段回答；不知道就说不知道，绝不假装在后台干活。' +
      `阶段为 ${stage} 时按阶段如实说明：若阶段已是 ready 或 completed，应直接告知用户「项目已经生成好了，请看右侧预览区」，不要用「还没好」「还在生成」之类措辞。` +
      '不要在回复里贴出完整 HTML/JS/CSS 代码块冒充交付物（无工具路径下这些代码不会保存' +
      '到项目文件）。要交付/生成，引导用户点预览区上方的「生成完整功能」确认；要看效果，' +
      '引导用户看右侧预览区。',
  }
}



/**
 * 多轮历史窗口（T4-L2）：近 N 轮原文。显式配置常量（默认 10，不静默写死）——
 * 窗口内原文承载「最近在聊什么」；长期不变量（用户约束）不靠窗口，由
 * scanSessionConstraints 全量扫描 + project.constraints 背板注入承载。
 */
// 2026-09-25 自由度批：loadConversationHistory/isStallReply/HISTORY_WINDOW_TURNS 真身
// 上提 platform/sessions/session-service（修复轮续接消费，R1：coding 不得向上 import
// orchestration）；此处 re-export 保旧消费者零改动。
export { loadConversationHistory, isStallReply, HISTORY_WINDOW_TURNS } from '../../platform/sessions/session-service'

export function shouldUseGuideAgent(stage: AgentSendMessageInput['current_stage']): boolean {
  return stage === 'clarifying' || stage === 'blocked_for_user_decision'
}

/** 用户可见文案截断（超长加省略号）。 */
export function truncateForCopy(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/**
 * 发「确认整版重做」二次确认卡（防误触，2026-09-11 卡位改版）。
 * rebuild_direction 收集到方向后与 rebuild_confirm 态更新方向后共用，保证两处
 * 卡文案/选项/阶段流转一致；阶段随卡进入 blocked_for_user_decision。
 */
export function publishRebuildConfirmCard(
  input: AgentSendMessageInput,
  streamPublisher: (event: AgentEvent) => void,
  direction: string,
  persistAssistant: (text: string) => void,
  persistSystem: (text: string) => void,
): void {
  updateProject(input.project_id, { current_stage: 'blocked_for_user_decision' })
  streamPublisher(makeEvent(input, 'stage_changed', { stage: 'blocked_for_user_decision' }))
  const confirmCopy = `你要按「${truncateForCopy(direction, 40)}」整版重做——确认吗？重做会保留已确认的需求与草图，当前版本也会存为快照。`
  persistAssistant(confirmCopy)
  persistSystem('[decision-card] 确定整版重做｜再想想')
  streamPublisher(makeEvent(input, 'message_delta', { text: confirmCopy }))
  streamPublisher(makeEvent(input, 'user_decision_required', {
    kind: 'rebuild_confirm',
    title: '确认整版重做',
    questions: [
      { id: 'rebuild_confirm', label: '确定整版重做', description: '换一种方式重做（保留需求与草图）' },
      { id: 'rebuild_cancel', label: '再想想', description: '先不重做，保持当前版本' },
    ],
  }))
}

