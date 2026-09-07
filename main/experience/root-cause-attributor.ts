import { EXPERIENCE_GOVERNANCE, type AntiPatternBody, type ExperienceCard } from './types'

/**
 * T-4 归因腿：判定「哪个阶段的失误导致了下游错误」——经验库的 tag/stage 精化器。
 *
 * 姿态（与账本治理一致）：
 * - **规则先行**：确定信号（source 类型 + 症状关键词，EN+CJK）映射根因，命中即返回，
 *   **绝不触网**（LLM spy 断言零调用）；
 * - LLM 仅兜底 unknown：走调用方注入的 `llmCall` seam（产品内接线由裁判渠道承担，
 *   离线/测试注入 fake）；置信**强制 clamp ≤ LLM_ATTRIBUTION_MAX_CONFIDENCE**——
 *   模型自述永远不如规则可信；坏 JSON / 越权 stage / 抛错 / 超时一律保持 unknown 不猜；
 * - 输入预算钉死：loop-log ≤300 行（取尾）、背板 ≤2000 字符（超出截断并标记），
 *   防归因请求自己变成上下文炸弹。
 *
 * 写回不 re-insert：由调用方拿 `updateCardAttribution(card.id, result)` 幂等更新
 * （见 experience-service 同函数注释），本模块纯查询语义、零 I/O。
 */

export type RootCause = AntiPatternBody['root_cause']

export interface AttributionContext {
  loopLogLines?: string[]
  backplateSnippet?: string
  llmCall?: (prompt: string) => Promise<string>
  /** 测试 seam：覆盖 LLM 超时（缺省 EXPERIENCE_GOVERNANCE 内 10s） */
  llmTimeoutMs?: number
}

const STAGE_SET = new Set<AntiPatternBody['stage']>(['prd', 'clarify', 'plan_leg', 'build_gate', 'coding', 'channel', 'unknown'])

function rc(stage: AntiPatternBody['stage'], description: string, method: 'rule' | 'llm', confidence: number, extra?: { reasoning?: string; possible_stages?: RootCause['possible_stages'] }): RootCause {
  return { stage, description: description.slice(0, 300), method, confidence, ...extra }
}

type AntiCard = ExperienceCard & { kind: 'anti_pattern' }

interface Rule {
  name: string
  test: (card: AntiCard) => boolean
  decide: (card: AntiCard) => RootCause
}

const RULES: Rule[] = [
  {
    // R1：构建门禁失败——产物代码自身不编译，根因在编码而非门禁
    name: 'build_gate_failure_implies_coding',
    test: (card) => {
      if (card.source.type === 'build_gate_failure') return true
      return /\b(build|tsc|compile|esbuild)\b/i.test(card.body.symptom)
    },
    decide: (card) => rc('coding', card.body.symptom, 'rule', 1, { possible_stages: [{ stage: 'coding', confidence: 1, rule: 'build_gate_failure' }] }),
  },
  {
    // R2：渠道不支持工具/超时中断——运行环境能力问题
    name: 'tools_unsupported_implies_channel',
    test: (card) => {
      if (card.source.type === 'tools_unsupported') return true
      const s = card.body.symptom
      return /不支持\s*(tool|工具)|渠道不支持|tool\s*not\s*supported|unsupported\s*tool/i.test(s)
    },
    decide: (card) => rc('channel', card.body.symptom, 'rule', 1, { possible_stages: [{ stage: 'channel', confidence: 1, rule: 'tools_unsupported' }] }),
  },
  {
    // R3：功能项缺验收标准——需求文档层欠账，下游做偏是必然
    name: 'missing_acceptance_criteria_implies_prd',
    test: (card) => /acceptance criteria|missing acceptance|no acceptance|缺少验收标准|验收标准(缺失|不明确)/i.test(card.body.symptom),
    decide: (card) => rc('prd', card.body.symptom, 'rule', 0.95, { possible_stages: [{ stage: 'prd', confidence: 0.95, rule: 'missing_acceptance_criteria' }] }),
  },
  {
    // R4：需求表述歧义——澄清层没闭合的口子
    name: 'missing_clarification_implies_clarify',
    test: (card) => /ambiguous|unclear|needs clarification|歧义|表述不清/i.test(card.body.symptom),
    decide: (card) => rc('clarify', card.body.symptom, 'rule', 0.9, { possible_stages: [{ stage: 'clarify', confidence: 0.9, rule: 'missing_clarification' }] }),
  },
  {
    // R5：断言指向超出技术合同范围——plan 腿合同欠账（双关键词防单误触）
    name: 'contract_out_of_scope_implies_plan_leg',
    test: (card) => {
      const s = card.body.symptom.toLowerCase()
      return s.includes('contract') && /(out of scope|out-of-scope|超出范围)/.test(s)
    },
    decide: (card) => rc('plan_leg', card.body.symptom, 'rule', 0.9, { possible_stages: [{ stage: 'plan_leg', confidence: 0.9, rule: 'contract_out_of_scope' }] }),
  },
  {
    // R6：GWT 行为失败/语义审查发现——产物行为不符，默认归编码（与采集层初值同权，
    // 不产生多余 update 行）
    name: 'product_behavior_failure_implies_coding',
    test: (card) => card.source.type === 'gwt_failure' || card.source.type === 'semantic_findings',
    decide: (card) => rc('coding', card.body.symptom, 'rule', 1, { possible_stages: [{ stage: 'coding', confidence: 1, rule: 'behavior_failure' }] }),
  },
]

/** 初值占位（confidence=0 且 unknown）才需要外部精化；已出结论的卡不重复归因。 */
export function needsRefinement(card: ExperienceCard): boolean {
  if (card.kind !== 'anti_pattern') return false
  const r = card.body.root_cause
  return r.confidence === 0 && r.stage === 'unknown'
}

function buildLlmPrompt(card: ExperienceCard & { kind: 'anti_pattern' }, context: AttributionContext): string {
  const maxLines = EXPERIENCE_GOVERNANCE.MAX_LOOP_LOG_LINES_FOR_ATTRIBUTION
  const lines = (context.loopLogLines ?? []).slice(-maxLines)
  const truncatedMark = (context.loopLogLines?.length ?? 0) > maxLines ? `\n[...共 ${context.loopLogLines!.length} 行，仅保留最近 ${maxLines} 行]` : ''
  const maxBack = EXPERIENCE_GOVERNANCE.MAX_BACKPLATE_CHARS_FOR_ATTRIBUTION
  const back = (context.backplateSnippet ?? '').slice(0, maxBack)
  return [
    'You are analyzing an error that occurred during an AI coding agent\'s execution.',
    '',
    'Error card:',
    `- Stage: ${card.body.stage}`,
    `- Symptom: ${card.body.symptom}`,
    `- Trigger: ${card.body.trigger_condition}`,
    '',
    `Recent execution log (last ${lines.length} lines):`,
    lines.join('\n') + truncatedMark,
    '',
    `Context snippet:\n${back}`,
    '',
    'Determine the ROOT CAUSE stage. Choose ONE from:',
    'prd, clarify, plan_leg, build_gate, coding, channel, unknown',
    '',
    'Return JSON only:',
    '{"stage":"...","confidence":0.0-0.5,"reasoning":"..."}',
  ].join('\n')
}

function unknownLlm(card: ExperienceCard & { kind: 'anti_pattern' }, why: string): RootCause {
  return rc('unknown', card.body.symptom, 'llm', 0, { reasoning: why })
}

/**
 * 归因主入口：规则表顺序匹配，第一条命中生效；全不匹配且有 llmCall 才走 LLM。
 * 绝不抛（归因是增强不是依赖）。
 */
export async function attributeRootCause(
  card: ExperienceCard,
  context: AttributionContext = {},
): Promise<RootCause> {
  if (card.kind !== 'anti_pattern') return { stage: 'unknown', description: '', method: 'rule', confidence: 0 }
  const anti: AntiCard = card
  for (const rule of RULES) {
    try {
      if (rule.test(anti)) return rule.decide(anti)
    } catch {
      // 单条规则脏输入不阻断后续规则
    }
  }
  if (!context.llmCall) return { ...card.body.root_cause } // 无 LLM 面 = 保持现状（调用方等值幂等）
  try {
    const timeoutMs = context.llmTimeoutMs ?? 10_000
    const raw = await Promise.race<string>([
      context.llmCall(buildLlmPrompt(card, context)),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error(`LLM_ATTRIBUTION_TIMEOUT_${timeoutMs}ms`)), timeoutMs)),
    ])
    const jsonMatch = /(\{[\s\S]*\})/.exec(raw ?? '')
    if (!jsonMatch) return unknownLlm(card, 'LLM returned invalid JSON')
    const parsed = JSON.parse(jsonMatch[1]) as { stage?: unknown; confidence?: unknown; reasoning?: unknown }
    if (typeof parsed.stage !== 'string' || !STAGE_SET.has(parsed.stage as AntiPatternBody['stage'])) {
      return unknownLlm(card, 'LLM returned out-of-authority stage')
    }
    const reported = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence) ? parsed.confidence : 0
    return rc(
      parsed.stage as AntiPatternBody['stage'],
      card.body.symptom,
      'llm',
      Math.min(EXPERIENCE_GOVERNANCE.LLM_ATTRIBUTION_MAX_CONFIDENCE, Math.max(0, reported)),
      { reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 300) : undefined },
    )
  } catch (error) {
    return unknownLlm(card, `LLM attribution failed: ${(error as Error)?.message ?? 'unknown'}`)
  }
}
