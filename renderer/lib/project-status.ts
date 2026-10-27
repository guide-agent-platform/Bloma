import type { Project } from '../../shared/types'
/** Display only; verification and confirmation remain host-owned. */
export function longtermStatusLabel(project:Project):string|undefined{
  if(project.workflow_version!=='software-v1'||project.mode!=='longterm')return
  if(project.status==='archived')return'长期项目已归档'
  if(project.status==='abandoned')return'已放弃，记录保留'
  if(project.current_stage==='blocked_for_user_decision'&&!project.desktop_phase)return'下一阶段待确认'
  const summary=project.longterm_summary
  return summary?.status==='awaiting_confirmation'?'本阶段待核对':summary?.status==='backlog_pending'?`阶段已交付 · 待办 ${summary.pending_items}`:summary?.status==='milestone_delivered'?'本阶段已交付':summary?.status==='building'?'里程碑制作中':summary?.status==='planning'?'长期维护待规划':undefined
}
