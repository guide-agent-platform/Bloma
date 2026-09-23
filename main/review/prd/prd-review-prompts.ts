/**
 * 审查提示词（PR4d 拆出）：Attacker 系统提示词、复查提示词、审查任务/复查任务/审计注入构建。
 * 纯机械搬移；对外契约经 prd-review re-export 保持不变。
 */
/**
 * PRD 内审门（prd-review）——AC-Lite 攻击→修订→复核闭环，2026-09-01。
 *
 * 方法论来源：用户指定 skill「ac-audit」（对抗-收敛文档审计）；2026-08-26 首落地
 * 为单轮简化版（simplified_ac）；2026-08-30 组会决议 1/4 升级为内审闭环：
 *
 * - Attacker（攻击者）：六维攻击面 I-F-Z-U-L-G，task 携带用户对话原文摘录
 *   （F 维对照源，2026-09-01 补齐）+ read_conversation_history 工具；
 * - Defender（修订者，新增）：按铁律修订背板草稿（prd-defender，代码级校验）；
 * - 复核轮（Attacker 变体）：只验旧 issue 是否消除 + 有无新伤，不全量重扫；
 * - 裁决（代码，不信任模型自报）：deriveVerdict 口径不变，收敛判定只认复核轮输出。
 *
 * 轮次预算：quick 1 轮修复 / longterm 2 轮；超预算 → 用户知情决策卡（残留
 * blocking/major + Defender 已改什么）。降级链：委派内审（默认）→ 直连 →
 * 规则门；aborted（用户停止）永不降级、立即终止管线。
 * 修订稿重走用户过目门：user_confirmed_at 不继承（陷阱 19/42 口径）。
 */

import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentSendMessageInput } from '../../../shared/types'
import { recordDecision } from '../../project/decision-log'
import { publishPrdConfirmCard } from '../../guide/prd-confirm'
import type { PrdBackplane } from '../../coding/sketch-engine'
import { defaultConstraintLevel } from '../../coding/sketch-engine'
import { isInjectionEnabled } from '../../agent/prompting/template-injection'
import { checkSectionCompleteness } from '../../guide/prd-sections'
import { parseEarsAssertion, renderForbiddenTermsForPrompt } from '../../guide/ears-vocabulary'
import type { SDKQuery } from '../../orchestration/orchestrator'
import { delegatedReviewEnabled, runDelegatedReview } from '../review-delegation'
import { buildConversationExcerpt, buildReadConversationHistoryTool } from '../../agent/loop/conversation-excerpt'
import {
  DEFENDER_SYSTEM_PROMPT,
  buildDefenderTask,
  buildWritePrdDraftTool,
  validateDefenderDraft,
  validateDispositionCoverage,
  type DefenderDisposition,
  type DefenderFailure,
} from '../prd-defender'

// =========================================================================
// 类型
// =========================================================================

import { PrdReviewIssue } from './prd-review-contracts'
import { runPrdReviewGate } from './prd-review-gate'

/** 六维攻击 system prompt（攻击轮）：六维攻击面 + PRD 权重 + 证据/严重度/禁编造铁律。 */
export const PRD_REVIEW_SYSTEM_PROMPT = [
  '你是文档攻击者（Attacker）——简化版 AC 对抗审计。目标：对给出的 PRD 执行六维攻击式审查，找出真实缺陷。',
  '',
  '【方法声明】对抗-收敛（AC）审计的简化运行。报告将标注 simplified_ac=true，不冒充完整方法论。',
  '判定边界速记：换名不矛盾（归 U）；「很难但有可能」只标 suggestion；需求文档不要求给实现方案。',
  '',
  '【六维攻击面】（括号为 PRD 权重，火力分配参考）',
  '- F 保真（30%）：PRD 是否忠实于【用户确认的需求清单】与【用户对话原文】——缺项、改偏、擅自加戏',
  '- U 可懂（20%）：歧义、一义多解、未定义术语',
  '- L 闭环（25%）：以产品定位为锚，沿「用户打开产品 → 输入/发起 → 拿到核心结果 → 查看 → 管理/留存」把主流程走一遍：缺必需环节且无豁免理由 = blocking；清单里只有孤立单点功能、拼不出一次完整使用的，按 blocking 报（2026-09-06 随记灵案：单功能项 PRD 拼不出产品）。留存/管理环节可按产品形态豁免，但 PRD 或豁免理由必须明说',
  '- G 护栏（10%）：无可客观度量的验收（「要快」「要好用」）、缺失边界情形',
  '- I 自洽（8%）：条目间相互矛盾',
  '- Z 可造（7%）：违反工程常识（「零延迟」「无限容量」）',
  '',
  '【规则】',
  '- 每个缺陷必须引用 PRD 原文证据（功能项 id 或原句）；F 维缺陷应引用用户原话对照',
  '- 严重度：blocking（无法开工/核心缺失）> major（会做错方向）> minor > suggestion',
  '- 不许提修复方案（只指出问题，修复是 Defender 的事）',
  '- 某维找不到缺陷 → 记入 clean_dimensions；不确定 → 同样记 clean，禁止编造',
  '- blocking/major 合计通常 0~3 个；把整份需求说得一无是处通常是过度攻击，不是严格',
  '',
  '【输出】严格 JSON，不要 markdown 围栏，不要任何多余文字：',
  '{"issues":[{"dimension":"F","severity":"blocking","location":"F-001","claim":"专业问题描述","evidence":["PRD 原句或用户原话"],"plain_question":"零基础大白话问题","options":[{"id":"opt-1","label":"具体答案（≤10 字）","description":"选它后会做成什么样（≤20 字）"}]}],',
  ' "clean_dimensions":["I","Z"]}',
  '',
  '【人话化要求（选择题化，2026-08-30）】',
  '- blocking/major 的 issue 必须带 plain_question 和 options；minor/suggestion 可不带。',
  '- plain_question：零基础大白话，像跟不懂技术的人说话（例：「有一个功能，你还没说清楚它到底要做什么」）；禁止出现 blocking/major/F保真/可懂/闭环/护栏/自洽/可造/验收/度量等术语。',
  '- options：用户点选后需求会改成什么样，具体、互斥、零基础可懂（例：「只在电脑上用」「手机也能用」）；label ≤10 字、description ≤20 字，2~4 条。',
  '- options 里不需要放「忽略/不改」——平台会固定追加；不要放「你帮我决定」类让渡（平台另有全局出口）。',
].join('\n')

/** 复核轮 system prompt（2026-09-01）：只验旧 issue 是否消除 + 有无新伤，不全量重扫（控 token）。 */
export const PRD_REVIEW_RECHECK_SYSTEM_PROMPT = [
  '你是文档攻击者（Attacker）的复核轮——上一轮审查发现的 blocking/major 问题已经由修订者（Defender）处置，你只做两件事：',
  '1. 逐条验证旧 issue 是否真的消除（对照修订后 PRD 原文，不许凭处置说明自报消除了事）；',
  '2. 检查修订本身是否引入新缺陷（新伤：改坏了原本没问题的部分、新增项与已有项矛盾等）。',
  '',
  '【边界】',
  '- 只报「未消除的旧 issue」与「新引入的缺陷」；旧 issue 已消除且无新伤 → issues 为空数组',
  '- 修订说明里声称改了但 PRD 原文对不上的，按未消除报（不信任自报）',
  '- 不重扫六维全量（首攻轮已扫过；只盯增量）',
  '- 严重度口径与首攻轮一致；新伤用 severity 标注，claim 里注明「（修订引入）」',
  '',
  '【输出】严格 JSON，不要 markdown 围栏：',
  '{"issues":[{"dimension":"L","severity":"major","location":"F-003","claim":"（修订引入）专业问题描述","evidence":["修订后 PRD 原句"],"plain_question":"零基础大白话问题","options":[{"id":"opt-1","label":"具体答案（≤10 字）","description":"选它后会做成什么样（≤20 字）"}]}],',
  ' "clean_dimensions":[]}',
  '',
  '【人话化要求】与首攻轮一致：blocking/major 必须带 plain_question 与 options（零基础大白话、选项具体互斥）。',
].join('\n')

/** 内审执行选项（runPrdReviewGate 主入口）。 */
export interface InternalAuditOptions {
  backplane: PrdBackplane
  confirmedRequirements: Array<{ id: string; description: string }>
  query: SDKQuery
  env: Record<string, string> | undefined
  sessionId: string
  signal?: AbortSignal
  maxTokens?: number
  /** 委派可视化：三者齐备时优先走委派子 agent，否则直连 */
  projectId?: string
  requestId?: string
  publish?: (event: AgentEvent) => void
  /** 2026-09 内审闭环：轮次预算（quick 1 / longterm 2）与 D1 开关联动 */
  mode?: AgentSendMessageInput['mode']
  /** 厂商隔离事实（调用方解析后传入；如实展示，不冒充） */
  vendorIsolated?: boolean
}

/** 攻击轮任务体（委派与直连共用）：PRD 全文 + 用户确认清单 + 对话原文 + 输出指令。 */
export function buildPrdReviewTask(
  backplane: PrdBackplane,
  confirmedRequirements: Array<{ id: string; description: string }>,
  conversationExcerpt?: string,
  mode?: 'quick' | 'longterm',
): string {
  const lines = [
    '【PRD 全文（背板 JSON）】',
    JSON.stringify(
      {
        name: backplane.name,
        positioning: backplane.positioning,
        requirements: backplane.requirements,
        out_of_scope: backplane.out_of_scope,
        constraints: backplane.constraints,
      },
      null,
      2,
    ),
    '',
    '【用户确认的需求清单（F 保真维度的对照基准）】',
    confirmedRequirements.length
      ? confirmedRequirements.map((item) => `- ${item.id}: ${item.description}`).join('\n')
      : '- （无已确认清单，F 维度以用户对话原文为对照基准）',
  ]
  if (conversationExcerpt) {
    lines.push('', conversationExcerpt, '', '可用 read_conversation_history 工具查阅完整对话原文（F 维度证据可引用用户原话）。')
  }
  const auditInjection = buildAuditInjection(backplane, mode)
  if (auditInjection) lines.push('', auditInjection)
  lines.push('', '现在执行六维攻击审查，按【输出】格式给出 JSON。')
  return lines.join('\n')
}

/** 注入点④切片（周计划 §6）：章节完备性（checkSectionCompleteness 同源判定）+ longterm EARS 可测性。 */
export function buildAuditInjection(backplane: PrdBackplane, mode?: 'quick' | 'longterm'): string | null {
  if (!isInjectionEnabled('audit')) return null
  try {
    const type = backplane.template_meta?.type ?? 'personal_tool'
    const level = backplane.template_meta?.level ?? defaultConstraintLevel(type)
    const completeness = checkSectionCompleteness(backplane, mode ?? 'quick', level)
    const sections: string[] = []
    if (mode === 'longterm') {
      sections.push('【工程模板追加检查（长期模式）】')
      sections.push(
        completeness.missing.length
          ? `- 章节完备性：以下必填章节缺失（level=${level}），逐项攻出：${completeness.missing.map((m) => `${m.section.label}（${m.reason}）`).join('；')}`
          : '- 章节完备性：必填章节齐全（复核确认即可，不强行找茬）。',
      )
      sections.push(
        `- EARS 可测性：行为断言含以下不可测措辞之一即为缺陷（severity=major，维度 G）：${renderForbiddenTermsForPrompt()}。一条断言只许一个触发动作（「A 并 B」复合触发=major）。`,
      )
    } else {
      sections.push('【工程模板追加检查（快消模式）】')
      sections.push(
        completeness.missing.length
          ? `- 章节完备性：五必填章节有缺失（${completeness.missing.map((m) => m.section.label).join('、')}），只攻缺失项，其余不找茬。`
          : '- 章节完备性：五必填章节齐全（复核确认即可，不强行找茬）。',
      )
    }
    return sections.join('\n')
  } catch {
    return null
  }
}

/** 复核任务体：修订后背板 + 旧 issues + Defender 处置说明。 */
export function buildRecheckTask(
  backplane: PrdBackplane,
  previousIssues: PrdReviewIssue[],
  dispositions: DefenderDisposition[],
  conversationExcerpt?: string,
): string {
  const serious = previousIssues.filter((issue) => issue.severity === 'blocking' || issue.severity === 'major')
  const lines = [
    '【修订后 PRD 全文（背板 JSON）】',
    JSON.stringify(
      {
        name: backplane.name,
        positioning: backplane.positioning,
        requirements: backplane.requirements,
        out_of_scope: backplane.out_of_scope,
        constraints: backplane.constraints,
      },
      null,
      2,
    ),
    '',
    '【上轮 blocking/major 问题（逐条验证是否消除，序号即 issue_index）】',
    serious.length
      ? serious
          .map((issue, index) => `${index + 1}. [${issue.dimension}/${issue.severity}] ${issue.claim}（位置：${issue.location || '未标注'}）`)
          .join('\n')
      : '- （无）',
    '',
    '【修订者处置说明（不信任自报，须对照 PRD 原文验证）】',
    dispositions.length
      ? dispositions.map((item) => `${item.issue_index}. ${item.action === 'fixed' ? '已修' : '拒改'}：${item.note}`).join('\n')
      : '- （无）',
  ]
  if (conversationExcerpt) lines.push('', conversationExcerpt)
  lines.push('', '现在执行复核：逐条验证旧 issue 是否消除 + 检查修订是否引入新缺陷，按【输出】格式给出 JSON。')
  return lines.join('\n')
}

