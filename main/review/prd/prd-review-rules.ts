/**
 * 规则门与解析（PR4d 拆出）：审查结果解析、选项消毒、ruleGateReview 六维规则审查。
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

/**
 * 规则门与解析（PR4d 拆出）：审查结果解析、选项消毒、ruleGateReview 六维规则审查。
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




import type { PrdBackplane } from "../../model/prd-backplane";
import { defaultConstraintLevel } from "../../model/prd-backplane";
import { checkSectionCompleteness } from '../../guide/prd-sections'
import { parseEarsAssertion } from '../../guide/ears-vocabulary';





// =========================================================================
// 类型
// =========================================================================

import { PrdReviewDimension, PrdReviewIssue, PrdReviewOption, PrdReviewOutcome } from './prd-review-contracts'
import { deriveVerdict } from './prd-review-gate'

/** 稳健解析：剥围栏 → 截取首尾大括号 → JSON；维度/严重度白名单校验；
 *  plain_question/options 一并解析（2026-08-30 选择题化）。 */
export function parseReviewIssues(text: string): PrdReviewIssue[] {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('PRD_REVIEW_PARSE_FAILED: 输出中无 JSON 对象')
  let parsed: { issues?: unknown }
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as { issues?: unknown }
  } catch {
    throw new Error('PRD_REVIEW_PARSE_FAILED: JSON 解析失败')
  }
  const dimensions = new Set(['I', 'F', 'Z', 'U', 'L', 'G'])
  const severities = new Set(['blocking', 'major', 'minor', 'suggestion'])
  const issues: PrdReviewIssue[] = []
  for (const raw of Array.isArray(parsed.issues) ? parsed.issues : []) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const dimension = String(item.dimension ?? '')
    const severity = String(item.severity ?? '')
    const claim = typeof item.claim === 'string' ? item.claim.trim() : ''
    if (!dimensions.has(dimension) || !severities.has(severity) || !claim) continue
    const plainQuestion = typeof item.plain_question === 'string' ? item.plain_question.trim() : ''
    const options = sanitizeReviewOptions(item.options)
    issues.push({
      dimension: dimension as PrdReviewDimension,
      severity: severity as PrdReviewIssue['severity'],
      location: typeof item.location === 'string' ? item.location.trim().slice(0, 80) : '',
      claim: claim.slice(0, 200),
      evidence: Array.isArray(item.evidence)
        ? item.evidence.filter((entry): entry is string => typeof entry === 'string').slice(0, 3)
        : [],
      ...(plainQuestion ? { plain_question: plainQuestion.slice(0, 80) } : {}),
      ...(options.length > 0 ? { options } : {}),
    })
  }
  return issues
}

/**
 * 审查选项纠偏（与向导澄清卡同款思路）：模型输出的 options 一律不信任——
 * 占位/问句式 label 丢弃、去重、超长截断；最多保留 4 条。id 缺省时用 label 兑底。
 * 只处理展示层，不触碰「代码型 JSON 不可修补」红线（选项全灭时由调用方补兑底）。
 */
export function sanitizeReviewOptions(raw: unknown): PrdReviewOption[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const options: PrdReviewOption[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const label = typeof item.label === 'string' ? item.label.replace(/\s+/g, ' ').trim().slice(0, 12) : ''
    if (label.length < 2 || /[?？]$/.test(label) || seen.has(label)) continue
    if (/^(范围)?选项\s*[一二三四五六七八九十0-9a-c]?$|^option\s*[a-c]?$/i.test(label)) continue
    seen.add(label)
    const description = typeof item.description === 'string'
      ? item.description.replace(/\s+/g, ' ').trim().slice(0, 30)
      : ''
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim().slice(0, 40) : label
    options.push(description ? { id, label, description } : { id, label })
    if (options.length >= 4) break
  }
  return options
}

/** 确定性规则门（LLM 不可用降级）：只拦硬伤，宁松勿严。附带零基础话术 + 通用选项（无 LLM 生成贴合的选项，给通用出口）。 */
export function ruleGateReview(backplane: PrdBackplane, mode?: 'quick' | 'longterm'): PrdReviewOutcome {
  const issues: PrdReviewIssue[] = []
  // 注入点④规则门确定性检查（LLM 不可用降级同享模板体系；开关关闭=现状）：
  // 必填章节缺失 → major；longterm 断言禁词直查 → major（禁词表三处同源）
  if (backplane.template_meta) {
    try {
      // 模板体系检查只在模板已接入的背板上运行：template_meta 存在 = P2 之后管线
      // 产物（buildPrdBackplane/resolvePrdBackplane 均写入）；裸对象/旧背板 = 模板
      // 前产物，不追责（行为=现状）。
      const type = backplane.template_meta.type
      const level = backplane.template_meta.level ?? defaultConstraintLevel(type)
      // 规则门宁松勿严口径：只拦「结构性缺失」（定位空/章节字段缺失），不拦
      // 「增强链未产出」——assertions/gwt 依赖 enricher/EARS 化（可选增强，失败回退
      // 薄清单属现状合法流）；断言薄弱交给 LLM 攻击轮质疑，不由规则门硬拦。
      const structuralMissing = checkSectionCompleteness(backplane, mode ?? 'quick', level).missing.filter(
        (entry) => entry.section.id !== 'assertions' && entry.section.id !== 'gwt',
      )
      for (const missing of structuralMissing) {
        issues.push({
          dimension: 'G',
          severity: 'major',
          location: missing.section.id,
          claim: `必填章节「${missing.section.label}」缺失：${missing.reason}`,
          evidence: [`章节 ${missing.section.id} 未达必填口径（mode=${mode ?? 'quick'}, level=${level}）`],
          plain_question: `${missing.section.label}这块还没有内容，要补一下吗？`,
          options: ruleOptions([
            { id: 'guide', label: '按常见做法补', description: '向导按行业惯例补齐' },
            { id: 'tell', label: '我来补充', description: '我说具体内容' },
          ]),
        })
      }
      if (mode === 'longterm') {
        for (const item of backplane.requirements ?? []) {
          for (const assertion of item.behavior_assertions ?? []) {
            if (parseEarsAssertion(assertion).forbiddenResponse) {
              issues.push({
                dimension: 'G',
                severity: 'major',
                location: item.id,
                claim: `行为断言含不可测措辞：「${assertion}」`,
                evidence: [assertion],
                plain_question: '这条验收说法太模糊，没法客观检查，能说得更具体吗？',
                options: ruleOptions([
                  { id: 'earsify', label: '改成可检验的说法', description: '自动改写成「点击 X 后出现 Y」式' },
                  { id: 'tell', label: '我来改', description: '我自己说清楚' },
                ]),
              })
            }
          }
        }
      }
    } catch {
      // 模板检查失败不阻断规则门
    }
  }
  const positioning = String(backplane.positioning ?? '').trim()
  if (!positioning) {
    issues.push({
      dimension: 'F',
      severity: 'blocking',
      location: 'positioning',
      claim: 'PRD 缺少产品定位',
      evidence: ['positioning 为空'],
      plain_question: '这个产品主要是给谁用、帮他们解决什么问题？',
      options: ruleOptions([
        { id: 'tell', label: '我来说明', description: '补充用途和人群' },
        { id: 'guide', label: '你来定', description: '按常见做法补上' },
      ]),
    })
  }
  const requirements = backplane.requirements ?? []
  if (requirements.length === 0) {
    issues.push({
      dimension: 'F',
      severity: 'blocking',
      location: 'requirements',
      claim: 'PRD 没有任何功能项',
      evidence: ['requirements 为空数组'],
      plain_question: '这个产品具体要能做什么，还不太清楚。',
      options: ruleOptions([
        { id: 'tell', label: '我来说明', description: '补充具体功能' },
        { id: 'guide', label: '你来定', description: '按常见做法补上' },
      ]),
    })
  }
  const seen = new Map<string, string>()
  for (const item of requirements) {
    const description = String(item.description ?? '').trim()
    if (description.length < 4) {
      issues.push({
        dimension: 'U',
        severity: 'major',
        location: item.id,
        claim: `功能项「${item.id}」描述过短，无法理解要做什么`,
        evidence: [description || '（空）'],
        plain_question: `「${description || item.id}」这个功能说得太简单，能不能再说具体一点？`,
        options: ruleOptions([
          { id: 'tell', label: '我来说明', description: '补充具体怎么做' },
          { id: 'guide', label: '你来定', description: '按常见做法补上' },
        ]),
      })
    }
    const duplicated = seen.get(description)
    if (duplicated && description.length >= 4) {
      issues.push({
        dimension: 'I',
        severity: 'major',
        location: item.id,
        claim: `与 ${duplicated} 描述完全相同，疑似重复项`,
        evidence: [description],
        plain_question: '有两个功能看起来一样，是不是重复了？',
        options: ruleOptions([
          { id: 'dedupe', label: '就保留一个', description: '去掉重复的' },
          { id: 'tell', label: '其实是两个', description: '我来说明区别' },
        ]),
      })
    } else {
      seen.set(description, item.id)
    }
  }
  return { verdict: deriveVerdict(issues), issues, mode: 'rules' }
}

/** 规则门选项兑底：每条保证有非空选项（通用出口）。 */
export function ruleOptions(options: PrdReviewOption[]): PrdReviewOption[] {
  return sanitizeReviewOptions(options)
}

// =========================================================================
// 审查未过 → 决策卡与回传
// =========================================================================

