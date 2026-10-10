import type { Project, WorkflowStage } from '../../shared/types'

export function workspaceScene(project: Project | null, stage: WorkflowStage, phase: string | null, sketchVisible: boolean) {
  if (project?.status === 'completed' && stage === 'completed') return { chapter: 4, title: '从今天起，它属于你。', description: '启动程序，或者继续打磨下一版。' }
  if (project?.desktop_blocked) return { chapter: 3, title: '停一下，也没关系。', description: '已有工作保留，告诉我怎么继续。' }
  if (phase && phase !== 'delivered') return { chapter: 3, title: '你的想法，正在成为软件。', description: '沿着已确认的需求与界面，继续制作。' }
  if (phase === 'delivered') return { chapter: 4, title: '先亲自试一试。', description: '查看实际交付状态，确认它是否符合你的想法。' }
  if (sketchVisible || stage === 'sketch_ready') return { chapter: 2, title: '先看看，它会是什么样子。', description: '确认这个方向，再制作完整功能。' }
  if (['generating_mvp','testing','judge_review','repairing','iterating'].includes(stage)) return { chapter: 3, title: '你的想法，正在成为软件。', description: '当前进度与需要你确认的事，会显示在这里。' }
  return { chapter: stage === 'blocked_for_user_decision' ? 1 : 0, title: '每一个软件，都从一个想法开始。', description: '先说你想解决什么，细节可以一起补齐。' }
}
