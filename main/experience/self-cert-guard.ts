/**
 * 自证循环防护（Phase 3/4 C4，2026-09-09，P2 稿 §3 C4 / 咨询 C 缺口 4）。
 *
 * 成文规则（代码锁承载，与注释同源）：
 * 1. 独立验收依据、权威需求（PRD 背板/断言）、受保护验收测试**不可被任何未 verified
 *    经验修改**；待验证经验只能以只读 advisory 文本指导候选实现，不能同时决定裁判标准。
 * 2. 注入面（selectForInjection 出口）是纯文本 advisory——不携带工具、不携带写权限；
 *    任何卡内容若教唆关闭/绕过受保护门禁，一律不得进入注入面（不删卡，只拦注入）。
 * 3. 该过滤对 verified 卡同样生效（fail-safe：advisory 丢失的代价远小于门禁被教唆绕过）。
 */

import type { ExperienceCard } from './types'
import { containsBypassInstruction } from '../agent/loop/memory-sanitize'

/** 受保护面（单点定义；他处引用勿散写）。 */
export const PROTECTED_SURFACES = [
  'judge 规则',
  'GWT 断言',
  'PRD 背板',
  '构建门禁（typecheck/build gate）',
  'API 契约探测',
  '安全扫描',
] as const

/**
 * 教唆绕过受保护面的指令检测：**单点定义已迁至 `main/memory-sanitize.ts`**
 * （2026-09-12 记忆栈审计裁定 ②：三类注入面收敛到同一净化出口）。语义不变——
 * 保守窄匹配（动词+受保护面组合）、诊断性提及不命中。
 */

/** 提取卡内可注入文本面（checklist/summary/hint/root_cause 描述）做模式检测。 */
function injectableText(card: ExperienceCard): string {
  if (card.kind === 'anti_pattern') {
    return [
      card.body.symptom,
      card.body.root_cause?.description ?? '',
      ...(card.body.test_checklist ?? []),
      ...(card.body.review_checklist ?? []),
    ].join('\n')
  }
  if (card.kind === 'rule') {
    // v2 规则卡：失败形态+建议动作是注入面（W3 renderRuleInjection 同源字段）
    return [card.body.failure_mode, ...card.body.recommended_actions, card.body.verification.check].join('\n')
  }
  return [card.body.capability, card.body.implementation_summary, card.body.reuse_hint].join('\n')
}

/** 卡内容是否教唆绕过受保护面（true = 不得注入）。 */
export function cardThreatensProtectedSurface(card: ExperienceCard): boolean {
  try {
    return containsBypassInstruction(injectableText(card))
  } catch {
    // 检测自身失败 → fail-safe 视为威胁（拦注入不删卡）
    return true
  }
}
