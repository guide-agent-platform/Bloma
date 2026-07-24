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
      { id: 'goal', label: '主要目标', description: '这个软件最重要的是帮你完成什么？' },
      { id: 'audience', label: '使用对象', description: '主要是谁来用？自己、团队，还是客户？' },
      { id: 'workflow', label: '核心流程', description: '用户打开后第一件事和最后一步分别是什么？' },
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
