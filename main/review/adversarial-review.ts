/**
 * C3 异构攻防审查轮次（协作机制改造清单批次 3，2026-09-24）。
 *
 * 把语义裁判的单委派审查升级为「攻击者 → 防御者 →（争议复核）→ 收敛」的对抗轮次：
 * - 攻击者（异渠道 A，只读 research）：审产物 vs PRD，出语义判定（沿用 judge-semantic
 *   五态枚举与证据纪律）——同源模型互审有同款幻觉互证盲区，攻击者必须与裁判渠道异族；
 * - 防御者（异渠道 B，只读 research）：逐条核验攻击者判定——confirmed（引用产物证据
 *   支持）或 refuted（引用产物证据证明攻击者误判）。refuted 的 blocking 项进争议复核；
 * - 争议复核（≤1 轮，攻击者合计 ≤2 轮）：防御者反驳的 blocking 项交回攻击者带证据
 *   重判；复核后仍 blocking 则收敛保留（禁第 3 轮，熔断口径对齐修复轮 ≤2）。
 *
 * 边界与纪律：
 * - 裁判铁律不变：攻/防都是 role=research 只读委派，只判定不修复；结论仍走
 *   judge-semantic 的 deriveConstraint 合成（无新增输出通道）。
 * - 渠道由代码解析（env 配置渠道 ID），不进模型可写参数——权威单点写入。
 *   BLOMA_ADVERSARIAL_ATTACKER / BLOMA_ADVERSARIAL_DEFENDER（bloma-channels 渠道 id）。
 * - 攻防互异族是硬断言（C2）；作者渠道在语义腿上下文不可靠可得，author 断言留待
 *   编排器接线（已知限制，v1 文档化）。
 * - 诚实降级：开关 off / 渠道未配置 / 同族 / 任一轮失败 → 返回 failure，调用方
 *   （judge-semantic）降级现状单委派——不阻断交付。
 */

import type { PrdBackplane, SketchRequirement } from '../coding/sketch-engine'
import type { SDKQuery } from '../orchestration/orchestrator'
import type { AgentEvent } from '../../shared/types'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { getChannelByIdRaw } from '../platform/llm/channel-manager'
import { channelFamilyOf } from '../platform/llm/channel-family'
import { runDelegatedReview, type DelegatedReviewOutcome } from './review-delegation'
import { parseSemanticFindings, type SemanticFinding } from './judge-semantic'

/** 攻防审查总开关（缺省 off=字节级现状：judge-semantic 走单委派语义腿）。 */
export function adversarialReviewEnabled(): boolean {
  const raw = (process.env.BLOMA_ADVERSARIAL_REVIEW ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on'
}

/** 攻/防渠道配置（渠道 ID；缺省 undefined=未配置→降级）。 */
export function resolveAdversarialChannels(): { attacker?: string; defender?: string } {
  const pick = (name: string): string | undefined => {
    const value = (process.env[name] ?? '').trim()
    return value || undefined
  }
  return { attacker: pick('BLOMA_ADVERSARIAL_ATTACKER'), defender: pick('BLOMA_ADVERSARIAL_DEFENDER') }
}

export interface AdversarialChannelsOk {
  ok: true
  attacker: string
  defender: string
}
export interface AdversarialChannelsBlocked {
  ok: false
  reason: 'not_configured' | 'invalid_channel' | 'same_family'
}

/**
 * 攻防渠道就绪校验：两端配置、渠道存在且启用、互异族（C2 断言语境化包装）。
 * 返回 blocked 时调用方降级单委派（warn 日志由调用方统一出）。
 */
export function resolveAdversarialChannelsChecked(): AdversarialChannelsOk | AdversarialChannelsBlocked {
  const { attacker, defender } = resolveAdversarialChannels()
  if (!attacker || !defender) return { ok: false, reason: 'not_configured' }
  const attackerChannel = getChannelByIdRaw(attacker)
  const defenderChannel = getChannelByIdRaw(defender)
  if (!attackerChannel?.enabled || !defenderChannel?.enabled) return { ok: false, reason: 'invalid_channel' }
  if (channelFamilyOf(attackerChannel) === channelFamilyOf(defenderChannel)) return { ok: false, reason: 'same_family' }
  return { ok: true, attacker, defender }
}

// =========================================================================
// 攻防轮次产物
// =========================================================================

/** 防御者对单条攻击者判定的核验结论。 */
export interface AdversarialVerdict {
  requirement_id: string
  verdict: 'confirmed' | 'refuted'
  evidence: string
}

export interface AdversarialReviewOutcome {
  ok: boolean
  /** 防御者调整后的最终判定（refuted 项降级 unverified 留痕）。 */
  findings?: SemanticFinding[]
  /** 攻击者轮次（1=单攻单防；2=含争议复核）。 */
  rounds?: number
  /** 被防御者反驳的 requirement_id（可观测：已知问题清单的争议面）。 */
  refuted?: string[]
  failure?: DelegatedReviewOutcome['failure'] | 'same_family' | 'not_configured'
}

/** 单轮审查依赖注入（测试可替换；生产默认 runDelegatedReview）。 */
export type ReviewRoundRunner = (opts: {
  goal: string
  task: string
  system: string
  channelId: string
}) => Promise<DelegatedReviewOutcome>

/** 判定为 blocking 级（进争议复核的条件）——与 deriveConstraint 的口径同源。 */
function isBlockingStatus(status: SemanticFinding['status']): boolean {
  return status === 'missing' || status === 'deviated'
}

/**
 * 攻防轮次主入口。requirements 用于解析白名单（幻觉防御）与攻击者任务构建。
 * 任何一轮失败返回 failure（不抛错）——调用方降级单委派。
 */
export async function runAdversarialSemanticReview(opts: {
  goal: string
  baseTask: string
  system: string
  requirements: SketchRequirement[]
  query: SDKQuery
  env: Record<string, string>
  sessionId: string
  projectId: string
  requestId: string
  publish: (event: AgentEvent) => void
  signal?: AbortSignal
  extraTools?: AgentLoopTool[]
  /** 测试注入位（缺省 runDelegatedReview）。 */
  runReview?: ReviewRoundRunner
}): Promise<AdversarialReviewOutcome> {
  const channels = resolveAdversarialChannelsChecked()
  if (!channels.ok) {
    return { ok: false, failure: channels.reason === 'same_family' ? 'same_family' : 'not_configured' }
  }
  const runReview: ReviewRoundRunner =
    opts.runReview ??
    (async (round) => {
      const outcome = await runDelegatedReview({
        goal: round.goal,
        task: round.task,
        system: round.system,
        channelId: round.channelId,
        query: opts.query,
        env: opts.env,
        sessionId: opts.sessionId,
        projectId: opts.projectId,
        requestId: opts.requestId,
        publish: opts.publish,
        signal: opts.signal,
        extraTools: opts.extraTools,
      })
      return outcome
    })

  // ── 第 1 轮：攻击者 ──
  const attack1 = await runReview({
    goal: `攻击者审查（异族复核）：${opts.goal}`,
    task: `${opts.baseTask}\n\n【攻击者角色强化】你是第一审查者（攻击者），与后续防御者来自不同模型家族。请以严格怀疑态度逐项查证：优先找「做偏了/做漏了/测试报告粉饰」的证据；不确定时宁可如实标注 unverified，不要放过可疑项。输出格式不变。`,
    system: opts.system,
    channelId: channels.attacker,
  })
  if (!attack1.ok || !attack1.finalText) return { ok: false, failure: attack1.failure ?? 'empty' }
  let attackerFindings: SemanticFinding[]
  try {
    attackerFindings = parseSemanticFindings(attack1.finalText, opts.requirements)
  } catch {
    return { ok: false, failure: 'failed' }
  }

  // ── 防御者核验 ──
  const defend = await runReview({
    goal: `防御者核验（异族对抗）：${opts.goal}`,
    task: buildDefenderTask(opts.baseTask, attackerFindings),
    system: opts.system,
    channelId: channels.defender,
  })
  if (!defend.ok || !defend.finalText) return { ok: false, failure: defend.failure ?? 'empty' }
  let verdicts: AdversarialVerdict[]
  try {
    verdicts = parseAdversarialVerdicts(defend.finalText, opts.requirements)
  } catch {
    return { ok: false, failure: 'failed' }
  }
  const refutedIds = verdicts.filter((v) => v.verdict === 'refuted').map((v) => v.requirement_id)
  const refutedSet = new Set(refutedIds)
  // 防御者反驳 → 降级 unverified 留痕（不静默删——审计面可见）
  const adjusted: SemanticFinding[] = attackerFindings.map((f) =>
    refutedSet.has(f.requirement_id) && f.status !== 'unverified'
      ? { ...f, status: 'unverified' as const, evidence: `[防御者反驳] ${verdicts.find((v) => v.requirement_id === f.requirement_id)?.evidence ?? f.evidence}` }
      : f,
  )

  // ── 争议复核（≤1 轮）：防御者反驳了 blocking 级判定时，交回攻击者带证据重判 ──
  const disputed = attackerFindings.filter(
    (f) => refutedSet.has(f.requirement_id) && isBlockingStatus(f.status),
  )
  if (disputed.length === 0) {
    return { ok: true, findings: adjusted, rounds: 1, refuted: refutedIds }
  }
  const attack2 = await runReview({
    goal: `争议复核（第 2 轮攻击者）：${opts.goal}`,
    task: buildDisputedRecheckTask(opts.baseTask, disputed, verdicts),
    system: opts.system,
    channelId: channels.attacker,
  })
  if (!attack2.ok || !attack2.finalText) {
    // 复核失败不废掉第 1 轮成果：按防御者调整版收敛（诚实降级，注明轮次）
    console.warn('[adversarial-review] 争议复核轮失败，按防御者调整版收敛:', attack2.failure)
    return { ok: true, findings: adjusted, rounds: 1, refuted: refutedIds }
  }
  let recheckFindings: SemanticFinding[]
  try {
    recheckFindings = parseSemanticFindings(attack2.finalText, opts.requirements)
  } catch {
    console.warn('[adversarial-review] 复核输出不可解析，按防御者调整版收敛')
    return { ok: true, findings: adjusted, rounds: 1, refuted: refutedIds }
  }
  // 复核结论只覆盖争议项（其余项保持防御者调整版）；复核仍 blocking 则保留（禁第 3 轮）
  const recheckedIds = new Set(recheckFindings.map((f) => f.requirement_id))
  const merged = adjusted.map((f) =>
    recheckedIds.has(f.requirement_id) ? recheckFindings.find((r) => r.requirement_id === f.requirement_id)! : f,
  )
  return { ok: true, findings: merged, rounds: 2, refuted: refutedIds }
}

/** 防御者任务：原任务上下文 + 攻击者判定清单 + 逐条核验输出契约。 */
function buildDefenderTask(baseTask: string, attackerFindings: SemanticFinding[]): string {
  const findingsJson = JSON.stringify(
    { findings: attackerFindings.map((f) => ({ requirement_id: f.requirement_id, status: f.status, evidence: f.evidence })) },
    null,
    2,
  )
  return [
    baseTask,
    '',
    '【防御者角色】你是第二审查者（防御者），与攻击者来自不同模型家族。攻击者已给出下列判定，请逐条独立核验：',
    '- confirmed：你查证产物后认同该判定（evidence 引用支持该判定的产物代码证据）；',
    '- refuted：你查证产物后认定攻击者误判（evidence 引用证明误判的产物代码证据——无证据不得 refute）。',
    '',
    '【攻击者判定】',
    '```json',
    findingsJson,
    '```',
    '',
    '【输出】严格 JSON，不要 markdown 围栏，不要任何多余文字：',
    '{"verdicts":[{"requirement_id":"F-001","verdict":"confirmed","evidence":"产物代码证据"}]}',
    '每条攻击者判定都必须给出一条 verdict；你只能核验，不得新增攻击者未判定的功能项。',
  ].join('\n')
}

/** 争议复核任务：只重判被反驳的 blocking 项（带防御者证据）。 */
function buildDisputedRecheckTask(baseTask: string, disputed: SemanticFinding[], verdicts: AdversarialVerdict[]): string {
  const disputedJson = JSON.stringify(
    {
      disputed: disputed.map((f) => ({
        attacker: { requirement_id: f.requirement_id, status: f.status, evidence: f.evidence },
        defender_rebuttal: verdicts.find((v) => v.requirement_id === f.requirement_id) ?? null,
      })),
    },
    null,
    2,
  )
  return [
    baseTask,
    '',
    '【争议复核（第 2 轮·终审）】防御者对以下你此前的 blocking 判定提出了带证据的反驳。请重新查证这些项：',
    '- 防御者证据成立 → 如实改判（implemented/partial/unverified）；',
    '- 防御者证据不成立或你找到新的产物证据 → 维持原判（evidence 给出新证据）。',
    '本轮是终审：只输出下列争议项的判定，输出格式不变；此后不再有复核轮。',
    '',
    '```json',
    disputedJson,
    '```',
  ].join('\n')
}

/** 防御者 verdicts 稳健解析：白名单校验 + 未知 id 丢弃（幻觉防御）。 */
export function parseAdversarialVerdicts(text: string, requirements: SketchRequirement[]): AdversarialVerdict[] {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('ADVERSARIAL_VERDICT_PARSE_FAILED: 输出中无 JSON 对象')
  let parsed: { verdicts?: unknown }
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as { verdicts?: unknown }
  } catch {
    throw new Error('ADVERSARIAL_VERDICT_PARSE_FAILED: JSON 解析失败')
  }
  const knownIds = new Set(requirements.map((item) => item.id))
  const out: AdversarialVerdict[] = []
  for (const raw of Array.isArray(parsed.verdicts) ? parsed.verdicts : []) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const requirementId = String(item.requirement_id ?? '')
    const verdict = String(item.verdict ?? '')
    if (!knownIds.has(requirementId) || (verdict !== 'confirmed' && verdict !== 'refuted')) continue
    // 反驳必须带证据（无证据的 refute 不采信——防御者同样不可无证据翻案）
    const evidence = typeof item.evidence === 'string' ? item.evidence.trim().slice(0, 160) : ''
    if (verdict === 'refuted' && !evidence) continue
    out.push({ requirement_id: requirementId, verdict, evidence })
  }
  return out
}
