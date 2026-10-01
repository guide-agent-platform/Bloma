import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ExperienceCard } from './types'
import { readAllCards } from './experience-service'
import type { SketchRequirement } from '../model/prd-backplane'

/**
 * T-5 错误重放编译（「为测试做指导」的落点）：
 * - verified / 达阈 anti_pattern → R-{fp8} **建议性（advisory）场景**：进真实执行器
 *   （浏览器行为探针同款），但结果从 gated 三计数剔除——指导测试而不碰交付门禁；
 * - 断言编译优先级：body.gwt（显式场景）→ 从 GWT 症状原文提取原断言（重验同一断言
 *   最高保真）→ 不可编译（结局/审查卡）返回 null；
 * - feature 文件双目录：verified → features/replay-{fp8}.feature（进文档清单），
 *   达阈 candidate → features-candidates/（**不进 features/，gwtCoverage 裁判与
 *   执行清单都不受候选污染**）；
 * - 全链路开关门控：off → 空列表 = 现状字节级。
 */

/** 场景锚 id：fingerprint 前 8 hex（账本回流用，不可反推内容）。 */
export function fp8(fingerprint: string): string {
  return fingerprint.slice(0, 8)
}

/** 重放断言文本（behavior_assertions 单条）；不可编译返回 null。 */
export function replayAssertionText(card: ExperienceCard): string | null {
  if (card.kind !== 'anti_pattern') return null
  const gwt = card.body.gwt
  if (gwt?.when && gwt.then) return `${gwt.given ? `${gwt.given}，` : ''}${gwt.when}时应${gwt.then}`
  const m = /GWT 场景「(.+?)」/.exec(card.body.symptom)
  if (m) {
    const idx = m[1].indexOf(' ')
    const claim = (idx >= 0 ? m[1].slice(idx + 1) : m[1]).trim()
    if (claim) return claim
  }
  return null
}

/**
 * 可重放的卡：非 retired anti_pattern + 可编译断言即可进 **advisory** 执行
 * （用户计划本意：candidate 靠重放转绿拿晋升证据；advisory 不碰业务门禁，
 * 严格 isConsumable 只约束「注入业务面/裁判面」）。verified 优先、复发多优先，上限 3。
 */
function replayableCards(projectId: string): ExperienceCard[] {
  void projectId // v1：账本全局（跨项目复用经验是特性）；保留参数为未来按项目过滤留缝
  try {
    return readAllCards()
      .filter((c) => c.kind === 'anti_pattern' && c.status !== 'retired')
      .sort(
        (a, b) =>
          (b.status !== 'candidate' && b.status !== 'retired' ? 1 : 0) - (a.status !== 'candidate' && a.status !== 'retired' ? 1 : 0) ||
          b.recurrence - a.recurrence,
      )
      .slice(0, 3)
      .filter((c) => replayAssertionText(c) !== null)
  } catch {
    return []
  }
}

/** 合成重放需求项（priority=P2：不触发 P0 门禁；不进背板，第二真相源红线）。 */
export function replayRequirements(projectId: string): SketchRequirement[] {
  return replayableCards(projectId).map((card) => ({
    id: `R-${fp8(card.fingerprint)}`,
    description: `错误重放：${card.tag}（经验库 ${card.status}）`,
    behavior_assertions: [replayAssertionText(card) ?? ''],
    priority: 'P2' as const,
    source: 'experience_replay',
  }))
}

export interface AdvisoryOutcome {
  id: string
  passed: boolean
}

/**
 * 从执行结果剥离 advisory 场景：gated 三计数只含业务场景；outcomes 供账本回流。
 * 计数口径与 gwt-service 一致：total = passed + failed，unverified 不计入。
 */
export function splitAdvisoryResults(
  raw: import('../verification/gwt-service').GwtTestResult,
  replayNames: Set<string>,
): { gated: import('../verification/gwt-service').GwtTestResult; outcomes: AdvisoryOutcome[] } {
  if (replayNames.size === 0) return { gated: raw, outcomes: [] }
  const failedR = raw.failure_summary.filter((f) => replayNames.has(f.scenario))
  const unverifiedR = (raw.unverified ?? []).filter((u) => replayNames.has(u))
  const failedRNames = new Set(failedR.map((f) => f.scenario))
  const unverifiedRNames = new Set(unverifiedR)
  const outcomes: AdvisoryOutcome[] = []
  let executedFailed = 0
  let executedPassed = 0
  for (const name of replayNames) {
    const id = /^R-([0-9a-f]{8})\b/.exec(name)?.[1]
    if (!id) continue
    const failed = failedRNames.has(name)
    const unverified = unverifiedRNames.has(name)
    if (failed) executedFailed++
    else if (!unverified) executedPassed++
    if (!unverified) outcomes.push({ id, passed: !failed })
  }
  const gated = {
    ...raw,
    total_count: Math.max(0, raw.total_count - executedPassed - executedFailed),
    failed_count: Math.max(0, raw.failed_count - executedFailed),
    failure_summary: raw.failure_summary.filter((f) => !replayNames.has(f.scenario)),
    ...(raw.unverified ? { unverified: (raw.unverified ?? []).filter((u) => !replayNames.has(u)) } : {}),
  }
  // 审计 P0-02：待评估不计入通过（互斥态）——passed = total - failed - unverified
  gated.passed_count = Math.max(0, gated.total_count - gated.failed_count - (gated.unverified?.length ?? 0))
  return { gated, outcomes }
}

/** Gherkin 重放文件（文档化；执行走 replayRequirements 合成项，不读本文件）。 */
export function renderReplayFeature(card: ExperienceCard, assertion: string): string {
  const b = card.kind === 'anti_pattern' ? card.body : null
  return [
    `Feature: 错误重放（经验库卡 ${fp8(card.fingerprint)}）`,
    `  标签：${card.tag}`,
    b ? `  症状：${b.symptom}` : '',
    b ? `  归因：${b.root_cause.stage}（${b.root_cause.method}）` : '',
    '',
    `  Scenario: ${assertion}`,
    '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * feature 文件双目录分写（syncDocuments 的 mvp_before_generation 检查位调用）：
 * verified → {docsDir}/features/；达阈 candidate → {docsDir}/features-candidates/。
 * 静默失败：文档化是附属产物，绝不影响生成主链。
 */
export function syncReplayFeatureFiles(projectId: string, docsDir: string): void {
  try {
    for (const card of replayableCards(projectId)) {
      const assertion = replayAssertionText(card)
      if (!assertion) continue
      const fileName = `replay-${fp8(card.fingerprint)}.feature`
      const dir = card.status !== 'candidate' && card.status !== 'retired' ? join(docsDir, 'features') : join(docsDir, 'features-candidates')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, fileName), renderReplayFeature(card, assertion), 'utf8')
    }
  } catch {
    // 静默
  }
}
