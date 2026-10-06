/**
 * 桌面线需求摘要渲染（2026-09-26 首跑修复）。
 *
 * 背景：首跑实证——桌面调度员与子会话此前没有任何需求注入路径（调度员系统提示词只含
 * 阶段任务书，子会话基底只有委派规则），架构/实现子会话看不到 PRD。本模块把 PRD 背板
 * 映射为紧凑的「需求清单」文本，由编排层装配进调度员系统提示词与子会话基底 system。
 *
 * 纯函数零依赖（结构类型入参，不引 model 层——R1 合规）；调用方负责取值与容错。
 */

import { readPrdBackplane } from '../project/document-engine'
import { requirementPriority, type UxExperienceSpec } from '../model/prd-backplane'

export interface RequirementDigestItem {
  id: string
  description: string
  /** 优先级（P0/P1/P2；缺省不渲染标签） */
  priority?: string
}

export interface RequirementDigestInput {
  items: RequirementDigestItem[]
  /** 单项描述截断上限（默认 140 字符） */
  maxDescriptionChars?: number
  /** 最多输出条数（默认 24；超出以省略行注明） */
  maxItems?: number
}

/**
 * 渲染需求摘要（逐行 `- F-xxx [P0] 描述`）。
 * 空清单返回空串——调用方以「空串 = 不注入」口径处理（fail-open）。
 */
export function renderRequirementsDigest(input: RequirementDigestInput): string {
  const maxItems = input.maxItems ?? 24
  const maxChars = input.maxDescriptionChars ?? 140
  const shown = input.items.slice(0, maxItems)
  const lines = shown.map((item) => {
    const description =
      item.description.length > maxChars ? `${item.description.slice(0, maxChars)}…` : item.description
    return `- ${item.id}${item.priority ? ` [${item.priority}]` : ''} ${description}`
  })
  if (input.items.length > shown.length) {
    lines.push(`- …其余 ${input.items.length - shown.length} 项（略）`)
  }
  return lines.join('\n')
}

/** 七态中文标签（digest 渲染用；与 prd-backplane UxStateId 同源）。 */
const UX_STATE_LABELS: Record<UxExperienceSpec['states'][number]['id'], string> = {
  empty: '空态',
  ready_input: '待输入',
  validating: '校验中',
  running: '执行中',
  success: '成功',
  partial: '部分成功',
  failed: '失败',
}

/**
 * 渲染体验契约段（UX 契约线，2026-10-06）：背板 ux 存在时渲染紧凑文本注入子会话上下文；
 * 缺省返回 undefined（任务书通用七态兑底纪律兜底，不注入）。纯函数供单测。
 */
export function renderUxDigest(ux: UxExperienceSpec | undefined): string | undefined {
  if (!ux || ux.states.length === 0) return undefined
  const lines = ['【体验契约（PRD 确认时冻结——实现按此交付，不得自行改定义）】']
  lines.push('状态（用户在该状态看到什么）：')
  for (const state of ux.states) {
    lines.push(`- ${UX_STATE_LABELS[state.id]}（${state.id}）：${state.observable}`)
  }
  if (ux.feedback_rules.length > 0) {
    lines.push('反馈规则：')
    for (const rule of ux.feedback_rules) {
      lines.push(`- ${rule}`)
    }
  }
  return lines.join('\n')
}

/**
 * 读取项目 PRD 背板并渲染需求摘要（桌面线上下文装配便捷函数）。
 * fail-open：背板缺失/读取失败返回 undefined——不阻断主链（如实无注入）。
 * UX 契约线（2026-10-06）：背板 ux 存在时在需求清单后追加体验契约段（同一注入点，
 * quick/longterm 子会话同享）。
 */
export function readDesktopRequirementsDigest(projectId: string): string | undefined {
  try {
    const backplane = readPrdBackplane(projectId)
    const digest = renderRequirementsDigest({
      items: backplane.requirements.map((item) => ({
        id: item.id,
        description: item.description,
        priority: requirementPriority(item),
      })),
    })
    const parts = [digest.trim() ? digest : '', renderUxDigest(backplane.ux) ?? ''].filter(Boolean)
    return parts.length > 0 ? parts.join('\n\n') : undefined
  } catch {
    return undefined
  }
}
