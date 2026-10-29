import type { AgentRoutingRole } from './types'

/** Display copy only. Only the two active flow defaults are exposed. */
export const FLOW_ROUTING_COPY: Record<AgentRoutingRole, {label: string; description: string}> = {
  guide: {label: '需求沟通', description: '用于理解需求、澄清目标；各次调用按实际流程选路。'},
  programming: {label: '界面与制作', description: '用于界面草图与软件制作；不指定子任务数量。'},
}
