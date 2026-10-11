import type { Project, WorkflowStage } from '../../shared/types'

export function workspaceScene(project: Project | null, stage: WorkflowStage, phase: string | null, sketchVisible: boolean, running = false) {
  if (project?.status === 'completed' && stage === 'completed') return { chapter: 4, title: '你的软件', description: '已交付 · 启动或继续改进' }
  if (project?.desktop_blocked && !running) return { chapter: 3, title: '制作暂时停止', description: '工作已保留 · 继续制作或调整要求' }
  if (phase && phase !== 'delivered') return { chapter: 3, title: '制作', description: '按已确认的需求与界面继续制作' }
  if (phase === 'delivered') return { chapter: 4, title: '先试一试', description: '查看验证结果和限制，再确认交付' }
  if (sketchVisible || stage === 'sketch_ready') return { chapter: 2, title: '界面草图', description: '等待确认 · 可点选修改' }
  if (['generating_mvp','testing','judge_review','repairing','iterating'].includes(stage)) return { chapter: 3, title: '制作', description: '当前进度和确认事项会显示在这里' }
  return { chapter: stage === 'blocked_for_user_decision' ? 1 : 0, title: '想法与需求', description: '先说使用目标，细节一起补齐' }
}
