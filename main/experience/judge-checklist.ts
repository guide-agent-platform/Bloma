import { selectForInjection } from './experience-service'
import { experienceEnabled, EXPERIENCE_GOVERNANCE, type ExperienceCard } from './types'
import { sanitizeForInjection } from '../memory-sanitize'

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

function renderRuleLine(card: ExperienceCard & { kind: 'rule' }): string | null {
  // v2 规则卡（W2.3 冻结 v1 后唯一可进裁判面的卡）：失败形态 + 审查关注（动作/验证择要）
  const tag = sanitizeForInjection(card.tag, { limit: 40 })
  const failure = sanitizeForInjection(card.body.failure_mode, { limit: 140 })
  if (tag.blocked || failure.blocked || !failure.text) return null
  const focusRaw = [...card.body.recommended_actions.slice(0, 2), card.body.verification.check].join('；')
  const focus = sanitizeForInjection(focusRaw, { limit: 120 })
  if (focus.blocked) return null
  return `- [${tag.text}] ${failure.text}${focus.text ? ` → 审查关注：${focus.text}` : ''}`
}

function renderLine(card: ExperienceCard & { kind: 'anti_pattern' }): string | null {
  // 注入面统一净化（2026-09-12 记忆栈审计裁定 ②）：与 learnings/跨会话语录共用同一出口；
  // 命中绕过指令那么卡不入段（self-cert-guard 已在入库侧拦一道，这里防御性再拦）。
  const tag = sanitizeForInjection(card.tag, { limit: 40 })
  const symptom = sanitizeForInjection(card.body.symptom, { limit: 140 })
  if (tag.blocked || symptom.blocked || !symptom.text) return null
  const focusRaw = card.body.review_checklist.slice(0, 2).join('；')
  const focus = sanitizeForInjection(focusRaw, { limit: 120 })
  if (focus.blocked) return null
  return `- [${tag.text}] ${symptom.text}${focus.text ? ` → 审查关注：${focus.text}` : ''}`
}

export async function buildJudgeErrorPatternsSection(
  projectId: string,
  opts: JudgeSectionOptions = {},
): Promise<string> {
  void projectId // v1 账本全局（经验跨项目共享是特性）；参数为按项目过滤留缝
  if (!experienceEnabled()) return ''
  try {
    const cards = await selectForInjection({
      kind: 'rule',
      surface: 'judge_checklist',
      limit: opts.limit ?? EXPERIENCE_GOVERNANCE.DEFAULT_INJECT_LIMIT,
      budget_chars: opts.budget_chars ?? 1200, // 审查段预算小于编程段（裁判 prompt 已有产物全文）
      context_hint: opts.context_hint,
    })
    const lines = cards
      .filter((c): c is ExperienceCard & { kind: 'rule' } => c.kind === 'rule' && (c.status === 'verified' || c.status === 'active'))
      .map(renderRuleLine)
      .filter((line): line is string => line !== null)
    if (lines.length === 0) return ''
    return ['【常见错法】（经验库中已验证的错法，逐项对照，防漏判）', ...lines].join('\n')
  } catch {
    return ''
  }
}
