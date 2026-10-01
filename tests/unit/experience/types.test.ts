import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EXPERIENCE_GOVERNANCE,
  computeFingerprint,
  hashProjectRef,
  isStale,
  licenseTierOf,
  normalizeForFingerprint,
  sanitizeText,
  type AntiPatternBody,
  type CardEnvelope,
  type PatternBody,
} from '../../../main/experience/types'
import { getExperienceIndexPath } from '../../../storage/config-paths'

/**
 * T-0 经验库 schema 基础（统一账本方案，用户 2026-09-06 拍板）：
 * - sanitizeText：家目录路径/URL 凭证/query token/键值 secret/超长截断
 * - normalizeForFingerprint：大小写/标点/多空格归一
 * - computeFingerprint：anti_pattern 用 stage|symptom，pattern 用 capability|api_signature
 * - isStale：仅 verified 且有 last_verified_at 且超 TTL 才 stale
 * - hashProjectRef：脱敏项目标识（12 hex）
 * - getExperienceIndexPath：PROMA_HOME/bloma-experience.jsonl（纯路径不建目录）
 * - experienceEnabled：BLOMA_EXPERIENCE 缺省 off（P3 开关口径）
 */

function baseEnvelope(overrides: Partial<CardEnvelope> = {}): CardEnvelope {
  const now = Date.now()
  return {
    id: 'test-id',
    schema_version: 1,
    kind: 'anti_pattern',
    tag: 'build_gate/typescript/type_mismatch',
    status: 'candidate',
    created_at: now,
    updated_at: now,
    recurrence: 1,
    source: { type: 'build_gate_failure', project_hash: 'a1b2c3d4e5f6', timestamp: now },
    fingerprint: 'f'.repeat(16),
    ...overrides,
  }
}

describe('experience/types：脱敏', () => {
  it('Windows 家目录路径 → {path}/basename，不含用户名', () => {
    const out = sanitizeText('build failed at C:\\Users\\alice\\projects\\secret-app\\src\\index.ts line 42')
    expect(out).not.toContain('alice')
    expect(out).not.toContain('secret-app')
    expect(out).toContain('{path}/index.ts')
  })

  it('POSIX /home 路径同样脱敏', () => {
    const out = sanitizeText('error in /home/bob/work/demo/main.ts: bad import')
    expect(out).not.toContain('bob')
    expect(out).toContain('{path}/main.ts')
  })

  it('URL 内嵌凭证与 token 查询参数脱敏', () => {
    const out = sanitizeText('conn mongodb://admin:password123@localhost:27017 and https://api.x.com/v1?token=secretxyz&x=1')
    expect(out).not.toContain('password123')
    expect(out).not.toContain('secretxyz')
    expect(out).toContain('{user}')
    expect(out).toContain('token={redacted}')
  })

  it('键值形态 secret/api_key/password 的值脱敏，但普通含 token 字样的词不误伤', () => {
    const out = sanitizeText('api_key=abc123 and token type_mismatch appears')
    expect(out).not.toContain('abc123')
    expect(out).toContain('token type_mismatch appears')
  })

  it('超长文本截断 500 + 省略号', () => {
    const out = sanitizeText('x'.repeat(5000))
    expect(out.length).toBeLessThanOrEqual(510)
    expect(out.endsWith('...')).toBe(true)
  })
})

describe('experience/types：归一化与指纹', () => {
  it('大小写/标点/多空格归一后等价', () => {
    const a = normalizeForFingerprint('TypeScript build fails with TS2345')
    const b = normalizeForFingerprint('typescript  build FAILS with ts2345!!!')
    expect(a).toBe(b)
  })

  it('不同文本归一后不同', () => {
    expect(normalizeForFingerprint('missing await')).not.toBe(normalizeForFingerprint('unhandled rejection'))
  })

  it('anti_pattern 指纹只看 stage|symptom（其余字段变化不改变指纹）', () => {
    const body: AntiPatternBody = {
      stage: 'coding',
      symptom: 'TypeError: not a function',
      trigger_condition: 'calling optional method without guard',
      root_cause: { stage: 'coding', description: 'd1', method: 'rule', confidence: 1 },
      test_checklist: ['t1'],
      review_checklist: ['r1'],
      severity: 2,
    }
    const f1 = computeFingerprint('anti_pattern', body)
    const f2 = computeFingerprint('anti_pattern', { ...body, symptom: 'TypeError: not a function', trigger_condition: '完全不同的描述' })
    const f3 = computeFingerprint('anti_pattern', { ...body, symptom: '别的错误' })
    expect(f1).toBe(f2)
    expect(f1).not.toBe(f3)
    expect(f1).toMatch(/^[0-9a-f]{16}$/)
  })

  it('pattern 指纹用 capability|api_signature', () => {
    const body: PatternBody = {
      capability: 'debounce a function call',
      language_family: 'ts',
      api_signature: 'debounce(fn: Function, ms: number): () => void',
      implementation_summary: 'wrap with timer',
      files: [],
      license: 'MIT',
      license_tier: 'permissive',
      reuse_hint: 'use for search inputs',
      sandbox_result: { build_pass: true, executed_at: 1 },
    }
    expect(computeFingerprint('pattern', body)).toBe(computeFingerprint('pattern', { ...body, reuse_hint: '改天' }))
    expect(computeFingerprint('pattern', body)).not.toBe(computeFingerprint('pattern', { ...body, api_signature: 'other(1): void' }))
  })
})

describe('experience/types：isStale 与项目脱敏', () => {
  const DAY = 86_400_000
  it('verified 且超 VERIFIED_TTL_DAYS → stale；未超 → 非 stale', () => {
    const now = Date.now()
    expect(isStale(baseEnvelope({ status: 'verified', last_verified_at: now - (EXPERIENCE_GOVERNANCE.VERIFIED_TTL_DAYS + 1) * DAY }), now)).toBe(true)
    expect(isStale(baseEnvelope({ status: 'verified', last_verified_at: now - (EXPERIENCE_GOVERNANCE.VERIFIED_TTL_DAYS - 1) * DAY }), now)).toBe(false)
  })

  it('无 last_verified_at → 非 stale；candidate/retired 不判 stale', () => {
    expect(isStale(baseEnvelope({ status: 'verified' }))).toBe(false)
    expect(isStale(baseEnvelope({ status: 'candidate', last_verified_at: Date.now() - 999 * DAY }))).toBe(false)
    expect(isStale(baseEnvelope({ status: 'retired', last_verified_at: Date.now() - 999 * DAY }))).toBe(false)
  })

  it('hashProjectRef：稳定、12 hex、不复现原 id', () => {
    const h = hashProjectRef('proj-12345')
    expect(h).toBe(hashProjectRef('proj-12345'))
    expect(h).toMatch(/^[0-9a-f]{12}$/)
    expect(h).not.toContain('proj-12345')
  })

  it('licenseTierOf 政策分级（与用户 LICENSE_TIER_MAP 对齐）', () => {
    expect(licenseTierOf('MIT')).toBe('permissive')
    expect(licenseTierOf('Apache-2.0')).toBe('permissive')
    expect(licenseTierOf('BSD-3-Clause')).toBe('permissive')
    expect(licenseTierOf('LGPL-3.0')).toBe('weak_copyleft')
    expect(licenseTierOf('MPL-2.0')).toBe('weak_copyleft')
    expect(licenseTierOf('GPL-3.0')).toBe('strong_copyleft')
    expect(licenseTierOf('AGPL-3.0')).toBe('strong_copyleft')
    expect(licenseTierOf(undefined)).toBe('unknown')
    expect(licenseTierOf('Weird-Custom-1.0')).toBe('unknown')
  })
})

describe('storage/config-paths：经验库路径', () => {
  const originalPromaHome = process.env.PROMA_HOME
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  it('返回 PROMA_HOME/bloma-experience.jsonl 且为纯路径（不建目录）', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-exp-'))
    process.env.PROMA_HOME = home
    const p = getExperienceIndexPath()
    expect(p).toBe(join(home, 'bloma-experience.jsonl'))
  })
})
