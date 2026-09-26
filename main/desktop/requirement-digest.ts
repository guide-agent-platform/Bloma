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
import { requirementPriority } from '../model/prd-backplane'

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

/**
 * 读取项目 PRD 背板并渲染需求摘要（桌面线上下文装配便捷函数）。
 * fail-open：背板缺失/读取失败返回 undefined——不阻断主链（如实无注入）。
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
    return digest.trim() ? digest : undefined
  } catch {
    return undefined
  }
}
