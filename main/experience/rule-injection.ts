/**
 * Phase 10 W2-2/W3（2026-09-16，承接 F 系列 Wave 3 单点消费闭环）：
 * v2 规则卡→loop 注入的规则侧——匹配（受控词表硬过滤）、渲染（条件—动作—证据）、
 * 种子常量（EXP-API-001 人工成文）、动作观测（action_observed 六档曝光之一）。
 *
 * 注入位：mergeAssetMap 第三参（plan 生成后 loop 启动前，与 W5 任务清单同位）——
 * 由 buildRuleInjectionMap 一调用产出，编排器接线 ≤15 行。
 * 纪律：①开关 off=注入段字节级缺失；②限 1~3 张、同 run 同 revision 去重；
 * ③种子只经人工成文通道登记（candidate→human_review verified），不走 LLM 生成；
 * ④负例（W5）：纯本地无后端任务必须排除 EXP-API-001（capabilities/template_types
 * 硬过滤验证）。
 * 开关 BLOMA_EXP_RULE_INJECT：'1'/'on'/'true'=开；未设/'0'/'off'/'false'=关（缺省 off）。
 */
import { trackAnalytics } from '../delivery/track-analytics'
import { selectForInjection, tryRegisterCard, promoteToVerified, readAllCards } from './experience-service'
import { type ExperienceCard, type RuleCardBody } from './types'

/** 开关解析（与 BLOMA_EXPERIENCE 家族同风格）。 */
export function ruleInjectEnabled(): boolean {
  const raw = (process.env.BLOMA_EXP_RULE_INJECT ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

/** 第一条规则种子（咨询 F Q1.4 EXP-API-001；人工成文，causal_status=hypothesis）。 */
export const EXP_API_001_BODY: RuleCardBody = {
  rule_kind: 'execution_rule',
  applies_when: {
    stage: 'implement',
    template_types: ['web_fullstack', 'game'],
    capabilities: ['external_service', 'api_proxy', 'media_proxy', 'ai_proxy', 'backend_data'],
  },
  failure_mode: '前端调用 /api/<前缀> 但 server/routes/ 无对应实现——只交付前端外壳（B 站 214397c3 + shmup 476847e5 双案实锤，终验曾假绿）',
  recommended_actions: [
    '实现 server/routes/<前缀>.js（CJS：module.exports={\'METHOD /path\':fn}，文件名即 /api/ 前缀）',
    '用 run_api_contract_tests 自测契约存活（全端点非 404/5xx）',
    '交付前核对 api-reconcile 对账零失败（前端引用⇄路由⇄契约三方一致）',
  ],
  verification: {
    check: 'run_api_contract_tests 全过 + 终验 API 契约检查绿',
    false_positive_hint: '纯本地无后端任务不适用本规则（见 exceptions）',
  },
  exceptions: ['纯本地工具（无 /api/ 调用、无数据留存、无外部服务）'],
  causal_status: 'hypothesis',
  evidence_refs: ['case-214397c3-bili', 'case-476847e5-shmup-0911'],
  applicability: { platform: 'bloma' },
  rev: 1,
}

export const EXP_API_001_TAG = 'rule/api/frontend-backend-parity'

/** 幂等登记种子（人工成文=human_review verified；账本存在性即幂等，跨 PROMA_HOME 安全）。 */
export async function registerSeedRules(): Promise<void> {
  try {
    const exists = readAllCards().some((c) => c.tag === EXP_API_001_TAG)
    if (exists) return
    const card = await tryRegisterCard({
      kind: 'rule',
      tag: EXP_API_001_TAG,
      body: EXP_API_001_BODY,
      source: { type: 'backfill', project_hash: 'seed', timestamp: Date.now() },
    })
    if (card) await promoteToVerified(card.id, 'human_review')
  } catch {
    // 种子登记失败不阻断（下次启动重试）
  }
}

export interface RuleMatchInput {
  /** 注入归属项目（action_observed 观测用；缺省不追踪） */
  projectId?: string
  stage?: string
  templateType?: string
  /** 任务能力面（外部服务/后端数据/AI 代理等信号；来自背板 interface_spec/CAP/前端调用扫描） */
  capabilities?: string[]
}

/** 从背板确定性派生能力面（interface_spec→backend_data；ai_capabilities→ai_proxy）。 */
export function deriveCapabilitiesFromBackplane(backplane: {
  interface_spec?: Array<{ endpoint?: string }>
  ai_capabilities?: Array<{ task?: string }>
}): string[] {
  const caps: string[] = []
  if ((backplane.interface_spec ?? []).some((ep) => (ep.endpoint ?? '').trim())) caps.push('backend_data')
  if ((backplane.ai_capabilities ?? []).some((cap) => (cap.task ?? '').trim())) caps.push('ai_proxy')
  return caps
}

function ruleMatches(card: ExperienceCard, input: RuleMatchInput): boolean {
  if (card.kind !== 'rule') return false
  const when = card.body.applies_when
  if (when.stage && input.stage && when.stage !== input.stage) return false
  if (when.template_types && when.template_types.length > 0) {
    if (!input.templateType || !when.template_types.includes(input.templateType)) return false
  }
  if (when.capabilities && when.capabilities.length > 0) {
    const caps = new Set((input.capabilities ?? []).map((c) => c.toLowerCase()))
    if (![...when.capabilities].some((c) => caps.has(c.toLowerCase()))) return false
  }
  return true
}

/** 受控词表匹配（确定性硬过滤，无向量）：注入面候选里挑 ≤3 张适用规则。 */
export async function matchRules(input: RuleMatchInput): Promise<ExperienceCard[]> {
  try {
    const pool = await selectForInjection({ kind: 'rule', surface: 'loop_rule_injection', limit: 10, budget_chars: 8000 })
    const seen = new Set<string>()
    const out: ExperienceCard[] = []
    for (const card of pool) {
      if (!ruleMatches(card, input)) continue
      const rev = card.kind === 'rule' ? card.body.rev ?? 1 : 1
      const dedupeKey = `${card.tag}@${rev}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      out.push(card)
      if (out.length >= 3) break
    }
    return out
  } catch {
    return []
  }
}

/** 渲染规则注入段（条件—动作—证据；空数组返回 null）。 */
export function renderRuleInjection(rules: ExperienceCard[]): string | null {
  if (rules.length === 0) return null
  const blocks = rules.map((card) => {
    if (card.kind !== 'rule') return null
    const body = card.body
    const applies = [
      body.applies_when.stage ? `阶段=${body.applies_when.stage}` : null,
      body.applies_when.template_types?.length ? `类型=${body.applies_when.template_types.join('/')}` : null,
      body.applies_when.capabilities?.length ? `能力=${body.applies_when.capabilities.join('/')}` : null,
    ]
      .filter(Boolean)
      .join('，')
    const lines = [
      `◆ ${card.tag}（rev ${body.rev ?? 1}，${body.causal_status}）${applies ? ` [${applies}]` : ''}`,
      `  风险：${body.failure_mode}`,
      ...body.recommended_actions.slice(0, 4).map((a, i) => `  现在执行 ${i + 1}. ${a}`),
      `  完成证据：${body.verification.check}${body.verification.false_positive_hint ? `（假阳性提示：${body.verification.false_positive_hint}）` : ''}`,
      ...(body.exceptions?.length ? [`  不适用：${body.exceptions.join('；')}`] : []),
    ]
    return lines.join('\n')
  })
  const rendered = blocks.filter((b): b is string => b !== null)
  if (rendered.length === 0) return null
  return [
    '【行动规则（经验库 v2，条件—动作—证据）】以下规则来自已验证经验，适用时现在执行并在完成总结里给出证据；不适用（见各自「不适用」行）不要照做：',
    ...rendered,
  ].join('\n')
}

/** 编排器一调用入口：开关 off/无匹配 → null（注入段字节级缺失）；命中登记 action 观测。 */
export async function buildRuleInjectionMap(input: RuleMatchInput): Promise<string | null> {
  if (!ruleInjectEnabled()) return null
  void registerSeedRules()
  const rules = await matchRules(input)
  const rendered = renderRuleInjection(rules)
  if (rendered && input.projectId) noteInjected(input.projectId, rules.map((r) => r.tag))
  return rendered
}

// ---------------------------------------------------------------------------
// 曝光六档（W3.5）：eligible/retrieved/injected 由 exposure 事件承载（experience-service），
// action_observed 在此记录——证据源=loop 工具调用序列；check_passed/delivery_observed
// 消费终验/交付事件（W3 后续接线登记）。
// ---------------------------------------------------------------------------

const injectedProjects = new Map<string, Set<string>>()

/** 注入发生时登记（buildRuleInjectionMap 命中后内部调用）。 */
function noteInjected(projectId: string, tags: string[]): void {
  const set = injectedProjects.get(projectId) ?? new Set<string>()
  for (const t of tags) set.add(t)
  injectedProjects.set(projectId, set)
}

/**
 * loop 结束后回看工具调用序列：被注入项目实际执行了规则推荐的工具 → action_observed
 * 曝光行（fire-and-forget；终验/交付侧的 check_passed/delivery_observed 由 W3 后续接）。
 */
export function recordRuleActionObserved(projectId: string, toolNames: string[]): void {
  try {
    const tags = injectedProjects.get(projectId)
    if (!tags || tags.size === 0) return
    const called = new Set(toolNames.map((t) => t.toLowerCase()))
    if (!called.has('run_api_contract_tests')) return
    trackAnalytics({
      request_id: `exp-action-${Date.now()}`,
      event: {
        event_type: 'experience_exposure',
        payload: { surface: 'loop_rule_injection', level: 'action_observed', rules: [...tags], tool: 'run_api_contract_tests' },
        privacy_level: 'research_safe',
      },
    })
    injectedProjects.delete(projectId)
  } catch {
    // 静默
  }
}

export { noteInjected }
