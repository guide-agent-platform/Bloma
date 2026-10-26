import type { Project, WorkflowStage } from '../../shared/types'

export type ProgressState = 'pending' | 'active' | 'done' | 'attention'
export type ProgressKey = 'requirements' | 'design' | 'build' | 'verify' | 'deliver'
export interface WorkspaceProgressStep {
  key: ProgressKey
  label: string
  state: ProgressState
  detail: string
  moving: boolean
}

const definitions = [
  { key: 'requirements', label: '需求', detail: '整理使用目标、功能和本次范围。' },
  { key: 'design', label: '界面', detail: '准备界面草图，确认后继续。' },
  { key: 'build', label: '制作', detail: '按本次需求制作程序。' },
  { key: 'verify', label: '验证', detail: '检查程序运行和关键功能。' },
  { key: 'deliver', label: '交付', detail: '查看验证结果，试用并确认交付。' },
] as const

/** Display projection only. Colours never grant a confirmation or a verification result. */
export function deriveWorkspaceProgress(input: {
  project: Project | null
  stage: WorkflowStage
  phase: string | null
  busy: boolean
  decision?: 'requirements' | 'design'
  hasSketch?: boolean
  error?: string
}): WorkspaceProgressStep[] {
  const { project, stage, phase, busy, decision } = input
  let current = 0
  let unknown = false
  if (decision === 'requirements') current = 0
  else if (decision === 'design') current = 1
  else if (phase) {
    if (phase === 'delivered') current = 4
    else if (phase === 'desktop-verify') current = 3
    else if (['desktop-arch', 'desktop-scaffold', 'desktop-implement'].includes(phase)) current = 2
    else unknown = true
  } else if (['generating_sketch', 'sketch_ready'].includes(stage)) current = 1
  else if (['testing', 'judge_review'].includes(stage)) current = 3
  else if (['ready', 'completed'].includes(stage)) current = 4
  else if (['generating_mvp', 'repairing', 'iterating'].includes(stage)) current = 2

  const blocked = !busy && !decision ? project?.desktop_blocked : undefined
  const error = !busy && !decision ? input.error : undefined
  const complete = project?.status === 'completed' && stage === 'completed' && !busy && !blocked && !error
  return definitions.map((definition, index) => {
    let state: ProgressState = unknown ? 'pending' : complete || index < current ? 'done' : index === current ? 'active' : 'pending'
    let detail: string = definition.detail
    if (unknown) detail = `阶段 ${phase} 尚未识别，请在工作记录中核对。`
    else if (index < current) detail = '已进入后续阶段，可在项目资料中回看。'
    else if (index === current) {
      if (blocked || error) {
        state = 'attention'
        detail = blocked?.reason === 'user-stop' ? '本轮已按你的操作停止，当前修改尚需验证。'
          : blocked?.note || error || '制作需要处理，请查看原因后继续。'
      } else if (decision || stage === 'sketch_ready') detail = '等待你确认，可查看内容或提出调整。'
      else if (!busy) detail = '当前停在这一步，可查看已有内容。'
    }
    // Imported/skip-sketch paths must not turn an absent design into a green approval.
    if (index === 1 && current > 1 && !input.hasSketch && !project?.ux_confirmation && !project?.sketch_generated_at) {
      state = 'pending'
      detail = '本次没有已确认的界面草图。'
    }
    return { ...definition, state, detail, moving: state === 'active' && busy }
  })
}
