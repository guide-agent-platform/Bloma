import { selectForInjection } from './experience-service'
import { experienceEnabled, EXPERIENCE_GOVERNANCE, type ExperienceCard } from './types'

/**
 * T-6 裁判清单注入（「错误经验为审查做指导」的落点）：
 * 语义审查（直连与委派两条路）的 prompt 组装位插入【常见错法】段——审查者知道
 * 已验证的错法 = 捕获率提升。
 *
 * 铁律：
 * - **只注入 verified 卡**（replay_green/human_review 出证的才配指导裁判；
 *   达阈 candidate 属「编程提示」层，不进审查面）；
 * - 空账本 / 开关 off / 查询失败 → 一律空串——调用方以 filter(Boolean) 拼接，
 *   与现状**字节级等价**（回归锁用例保证）；
 * - 裁判侧无用户 override 面（SEMANTIC_JUDGE_SYSTEM_PROMPT 为内置段），注入位
 *   紧随 system/任务段之后即与锚定同权。
 */

export interface JudgeSectionOptions {
  limit?: number
  budget_chars?: number
  /** 相关性提示（通常传被审项目名+功能项摘要） */
  context_hint?: string
}

function renderLine(card: ExperienceCard & { kind: 'anti_pattern' }): string {
  const focus = card.body.review_checklist.slice(0, 2).join('；')
  return `- [${card.tag}] ${card.body.symptom}${focus ? ` → 审查关注：${focus}` : ''}`
}

export async function buildJudgeErrorPatternsSection(
  projectId: string,
  opts: JudgeSectionOptions = {},
): Promise<string> {
  void projectId // v1 账本全局（经验跨项目共享是特性）；参数为按项目过滤留缝
  if (!experienceEnabled()) return ''
  try {
    const cards = await selectForInjection({
      kind: 'anti_pattern',
      surface: 'judge_checklist',
      limit: opts.limit ?? EXPERIENCE_GOVERNANCE.DEFAULT_INJECT_LIMIT,
      budget_chars: opts.budget_chars ?? 1200, // 审查段预算小于编程段（裁判 prompt 已有产物全文）
      context_hint: opts.context_hint,
    })
    const lines = cards
      .filter((c): c is ExperienceCard & { kind: 'anti_pattern' } => c.kind === 'anti_pattern' && (c.status === 'verified' || c.status === 'active'))
      .map(renderLine)
    if (lines.length === 0) return ''
    return ['【常见错法】（经验库中已验证的错法，逐项对照，防漏判）', ...lines].join('\n')
  } catch {
    return ''
  }
}
