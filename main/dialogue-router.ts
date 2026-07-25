import type { Project } from '../shared/types'

export type DialogueRoute =
  | { action: 'ask_clarification'; questions: ClarificationOption[] }
  | { action: 'generate_sketch'; requirements: { id: string; description: string }[] }

export interface ClarificationOption {
  id: string
  label: string
  description?: string
}

export function routeDialogue(message: string, project: Project): DialogueRoute {
  const normalized = message.trim()
  if (project.mode === 'quick' && isClearEnough(normalized)) {
    return {
      action: 'generate_sketch',
      requirements: [{ id: 'F-001', description: normalized }],
    }
  }

  if (project.mode === 'longterm' && isClearEnough(normalized) && hasAudienceHint(normalized)) {
    return {
      action: 'generate_sketch',
      requirements: [{ id: 'F-001', description: normalized }],
    }
  }

  return {
    action: 'ask_clarification',
    questions: [
      { id: 'daily', label: '日常生活工具', description: '记账、提醒、清单这类日常小事' },
      { id: 'work', label: '工作提效工具', description: '流程、协作、记录这类工作场景' },
      { id: 'auto', label: '你帮我决定', description: '交给我，按常见做法先出一版' },
    ],
  }
}

function isClearEnough(message: string): boolean {
  if (message.length >= 18) return true
  return /(做|生成|开发|搭建|应用|工具|系统|页面|看板|管理|记录|分析)/.test(message) && message.length >= 8
}

function hasAudienceHint(message: string): boolean {
  return /(我|自己|用户|客户|团队|员工|学生|老师|管理员|运营|销售)/.test(message)
}
