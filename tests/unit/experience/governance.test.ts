/**
 * Phase 4 C1/C4/C5（2026-09-09，P2 稿 §3）：
 * - C1 治理扩展：新卡注册统一携带 governance 默认值；旧卡读侧 cardGovernance() 归一化
 * - C4 自证防护：教唆绕过受保护面的卡被拦出注入面（不删卡）；诊断性提及不误杀
 * - C5 曝光日志：每次注入面调用落 analytics experience_exposure（可检索/命中/注入三档）
 */
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cardGovernance,
  type AntiPatternBody,
  type ExperienceCard,
} from '../../../main/experience/types'
import { cardThreatensProtectedSurface, PROTECTED_SURFACES } from '../../../main/experience/self-cert-guard'
import { readAllCards, resetExperienceIndexForTests, selectForInjection, tryRegisterCard, promoteToVerified } from '../../../main/experience/experience-service'

function antiBody(symptom = 'TypeScript build fails with TS2345', checklist: string[] = ['verify parameter types']): AntiPatternBody {
  return {
    stage: 'build_gate',
    symptom,
    trigger_condition: 'passing string where number expected',
    root_cause: { stage: 'coding', description: 'no coercion', method: 'rule', confidence: 1 },
    test_checklist: checklist,
    review_checklist: ['untyped parameters'],
    severity: 2,
  }
}

function src(hash = 'p1'): ExperienceCard['source'] {
  return { type: 'build_gate_failure', project_hash: hash, timestamp: Date.now() }
}

/** 单卡注册+验证晋升（存量测试同口径：verified 可消费，免 recurrence 门槛）。 */
async function registerVerified(input: Parameters<typeof tryRegisterCard>[0]): Promise<ExperienceCard | null> {
  const card = await tryRegisterCard(input)
  if (!card) return null
  return promoteToVerified(card.id, 'replay_green')
}

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'proma-gov-'))
  process.env.PROMA_HOME = home
  process.env.BLOMA_EXPERIENCE = '1'
  resetExperienceIndexForTests()
})
afterEach(() => {
  delete process.env.BLOMA_EXPERIENCE
  resetExperienceIndexForTests()
})

/** 读 default 工作区 analytics.jsonl（trackAnalytics 无 project_id 时落这里）。 */
function readExposureEvents(): Array<{ event_type: string; payload?: Record<string, unknown> }> {
  const f = join(home, 'agent-workspaces', 'default-software-builder', 'analytics.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l) } catch { return { event_type: '?' } }
  })
}

describe('C1：治理扩展（governance）', () => {
  it('新卡注册统一携带默认 governance（registerCore 单点）', async () => {
    const card = (await tryRegisterCard({ kind: 'anti_pattern', tag: 'build_gate/ts/mismatch', body: antiBody(), source: src() }))!
    expect(card.governance).toBeDefined()
    expect(card.governance!.hypothesis).toBe('no coercion') // root_cause.description 派生
    expect(card.governance!.scope.taskTypes).toEqual(['*'])
    expect(card.governance!.exclusions).toEqual([])
    expect(card.governance!.validationReportIds).toEqual([]) // 无迁移证据，C2 fail-closed 前提
    expect(card.governance!.rollbackConditions).toEqual([])
  })

  it('旧卡（无 governance）读侧 cardGovernance() 归一化：anti 派生 root_cause、pattern 派生 capability', () => {
    const oldAnti = {
      id: 'x', schema_version: 1, kind: 'anti_pattern', tag: 't', status: 'candidate',
      created_at: 1, updated_at: 1, recurrence: 1, source: src(), fingerprint: 'f',
      body: antiBody(),
    } as unknown as ExperienceCard
    expect(cardGovernance(oldAnti).hypothesis).toBe('no coercion')
    const oldPattern = {
      ...oldAnti, kind: 'pattern', fingerprint: 'g',
      body: { capability: 'Debounce a function call', language_family: 'universal', api_signature: '', implementation_summary: '', files: [], license: 'unknown', license_tier: 'unknown', sandbox_result: { build_pass: true, executed_at: 1 }, reuse_hint: '' },
    } as unknown as ExperienceCard
    expect(cardGovernance(oldPattern).hypothesis).toBe('Debounce a function call')
  })
})

describe('C4：自证防护（注入面代码锁）', () => {
  it('受保护面清单成文；教唆绕过指令命中', () => {
    expect(PROTECTED_SURFACES.length).toBeGreaterThanOrEqual(5)
    const bypass = { kind: 'anti_pattern', status: 'candidate', body: antiBody('build fails', ['关闭 typecheck 让构建通过']) } as unknown as ExperienceCard
    expect(cardThreatensProtectedSurface(bypass)).toBe(true)
    const sneaky = { kind: 'anti_pattern', status: 'candidate', body: antiBody('gate fails', ['跳过 judge 门禁直接交付']) } as unknown as ExperienceCard
    expect(cardThreatensProtectedSurface(sneaky)).toBe(true)
  })

  it('诊断性提及不误杀（描述门禁失败 ≠ 教唆绕过）', () => {
    const normal = { body: antiBody('build fails', ['构建门禁失败时先读 stderr 定位类型错误']) } as unknown as ExperienceCard
    expect(cardThreatensProtectedSurface(normal)).toBe(false)
  })

  it('集成：带绕过指令的卡被拦出注入面（账本保留不删）', async () => {
    await registerVerified({ kind: 'anti_pattern', tag: 'build_gate/ts/normal', body: antiBody('Normal TS error'), source: src() })
    const bypassCard = await registerVerified({
      kind: 'anti_pattern', tag: 'build_gate/ts/bypass', source: src(),
      body: antiBody('Build red again', ['绕过 typecheck 让构建门禁先过']),
    })
    expect(bypassCard?.status).toBe('verified')
    const injected = await selectForInjection({ kind: 'anti_pattern', surface: 'test' })
    expect(injected.map((c) => c.tag)).toEqual(['build_gate/ts/normal'])
    expect(readAllCards()).toHaveLength(2) // 卡未删，只是拦注入
  })
})

describe('C5：曝光日志（experience_exposure）', () => {
  it('注入面调用落一条 exposure：可检索/命中/注入三档（surface 标签随查询）', async () => {
    await registerVerified({ kind: 'anti_pattern', tag: 'build_gate/ts/a', body: antiBody('Error A'), source: src() })
    await selectForInjection({ kind: 'anti_pattern', surface: 'judge_checklist', budget_chars: 10000 })
    const events = readExposureEvents().filter((e) => e.event_type === 'experience_exposure')
    expect(events).toHaveLength(1)
    const payload = events[0].payload as { surface: string; retrievable: unknown[]; matched: string[]; injected: Array<{ id: string; status: string }> }
    expect(payload.surface).toBe('judge_checklist')
    expect(payload.retrievable.length).toBe(1)
    expect(payload.matched.length).toBe(1)
    expect(payload.injected[0].status).toBe('verified')
    expect(payload.injected[0].id).toBeTruthy()
  })

  it('开关 off 零注入零日志（字节级现状）', async () => {
    process.env.BLOMA_EXPERIENCE = '0'
    expect(await selectForInjection({ kind: 'anti_pattern' })).toEqual([])
    expect(readExposureEvents().filter((e) => e.event_type === 'experience_exposure')).toHaveLength(0)
  })
})
