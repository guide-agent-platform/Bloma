import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildGapReport, normalizeCap } from '../../../scripts/gap-report.mjs'

/**
 * G1 缺口报告：面 A（官方模块域无 verified pattern）+ 面 B（达阈错误 tag 无正向参考）
 * + 已被 pattern 覆盖的模块不报缺口（含 candidate pattern 不算覆盖）。
 */

function ledgerLine(card: Record<string, unknown>) {
  return JSON.stringify(card)
}
function patternCard(tag: string, status: string, capability: string) {
  return {
    id: `pid-${tag}-${status}`, schema_version: 1, kind: 'pattern', tag, status, recurrence: 1,
    created_at: Date.now(), updated_at: Date.now(), fingerprint: `fp${tag}`,
    source: { type: 'web_reference', project_hash: 'seed', timestamp: Date.now() },
    body: { capability, language_family: 'js', api_signature: 'x()', implementation_summary: 's', files: [], license: 'MIT', license_tier: 'permissive', sandbox_result: { build_pass: status === 'verified', executed_at: 1 }, reuse_hint: 'h' },
  }
}
function antiCard(tag: string, status: string, recurrence: number) {
  return {
    id: `aid-${tag}`, schema_version: 1, kind: 'anti_pattern', tag, status, recurrence,
    created_at: Date.now(), updated_at: Date.now(), fingerprint: `af${tag}`,
    source: { type: 'gwt_failure', project_hash: 'p', timestamp: Date.now() },
    body: { stage: 'coding', symptom: 's', trigger_condition: 't', root_cause: { stage: 'coding', description: 'd', method: 'rule', confidence: 1 }, test_checklist: [], review_checklist: [], severity: 2 },
  }
}

const modulesDir = join(process.cwd(), 'main', 'templates', 'official-modules')

describe('gap-report.mjs', () => {
  it('空账本：全部官方模块域报缺口；无错误面缺口', () => {
    const root = mkdtempSync(join(tmpdir(), 'gap-empty-'))
    const report = buildGapReport({ root, modulesDir })
    expect(report.verified_patterns).toBe(0)
    const slugs = report.gaps.filter((g) => g.kind === 'official_capability_without_pattern').map((g) => g.capability)
    expect(slugs).toContain('game-loop')
    expect(slugs).toContain('filter-list')
    expect(report.gaps.every((g) => g.suggested_queries.length === 2)).toBe(true)
  })

  it('verified pattern 覆盖模块域后不再报；candidate pattern 不算覆盖', () => {
    const root = mkdtempSync(join(tmpdir(), 'gap-cov-'))
    writeFileSync(
      join(root, 'bloma-experience.jsonl'),
      [ledgerLine(patternCard('pattern/js/filter_list', 'candidate', 'search filter list')), ledgerLine(patternCard('pattern/js/game_loop', 'verified', 'game loop'))].join('\n') + '\n',
      'utf8',
    )
    const slugs = buildGapReport({ root, modulesDir }).gaps.map((g: { capability: string }) => g.capability)
    expect(slugs).toContain('filter-list') // candidate 不算覆盖
    expect(slugs).not.toContain('game-loop') // verified 覆盖
  })

  it('面 B：达阈错误 tag 无正向参考报 error_tag_without_pattern；同 key 去重；misc 忽略', () => {
    const root = mkdtempSync(join(tmpdir(), 'gap-err-'))
    writeFileSync(
      join(root, 'bloma-experience.jsonl'),
      [
        ledgerLine(antiCard('coding/gwt/debounce_missing', 'candidate', 3)),
        ledgerLine(antiCard('coding/gwt/debounce_missing_b', 'verified', 1)),
        ledgerLine(antiCard('unknown/outcome/misc', 'verified', 1)),
      ].join('\n') + '\n',
      'utf8',
    )
    const errGaps = buildGapReport({ root, modulesDir }).gaps.filter((g) => g.kind === 'error_tag_without_pattern')
    expect(errGaps.map((g) => g.capability)).toContain('debounce_missing')
    expect(errGaps.find((g) => g.capability === 'misc')).toBeUndefined()
    expect(normalizeCap('Filter-List 中文')).toBe('filter_list_中文')
  })
})
