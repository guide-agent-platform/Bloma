import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attributeRootCause,
  needsRefinement,
} from '../../../main/experience/root-cause-attributor'
import {
  resetExperienceIndexForTests,
  tryRegisterCard,
  updateCardAttribution,
  readAllCards,
} from '../../../main/experience/experience-service'
import { recordFailureCards } from '../../../main/experience/error-card'
import type { AntiPatternBody, ExperienceCard } from '../../../main/experience/types'

/**
 * T-4 归因腿（规则先行，LLM 兜底）：
 * - 判定穷举矩阵：五规则各正反例；规则命中**零 LLM 调用**（spy）
 * - LLM 降级链：坏 JSON / 抛错 / 超时 → 保持 unknown 不猜
 * - 置信 clamp：LLM 自报 0.9 → 压到 LLM_ATTRIBUTION_MAX_CONFIDENCE
 * - updateCardAttribution 幂等：已存在卡走 update 不重复 insert；同值再更新不加行
 * - 集成：recordFailureCards 落卡后 build_gate 卡被规则层自动精化为 coding
 */

function body(over: Partial<AntiPatternBody> = {}): AntiPatternBody {
  return {
    stage: 'unknown',
    symptom: 'some generic failure happened',
    trigger_condition: 'when doing things',
    root_cause: { stage: 'unknown', description: 'some generic failure happened', method: 'rule', confidence: 0 },
    test_checklist: [],
    review_checklist: [],
    severity: 2,
    ...over,
  }
}

function cardWith(kind: ExperienceCard['source']['type'], bodyOverride: Partial<AntiPatternBody> = {}): ExperienceCard {
  const b = body(bodyOverride)
  return {
    id: 'c1', schema_version: 1, kind: 'anti_pattern', tag: 'x/y/z', status: 'candidate',
    created_at: Date.now(), updated_at: Date.now(), recurrence: 1,
    source: { type: kind, project_hash: 'p1', timestamp: Date.now() },
    fingerprint: 'f'.repeat(16), body: b,
  } as ExperienceCard
}

describe('T-4 归因：规则表判定矩阵', () => {
  const llm = vi.fn(async () => '{"stage":"coding","confidence":0.4,"reasoning":"r"}')

  beforeEach(() => llm.mockClear())

  it('R1 build_gate_failure → coding 置信 1（症状文本不参与）', async () => {
    const r = await attributeRootCause(cardWith('build_gate_failure'), { llmCall: llm })
    expect(r).toMatchObject({ stage: 'coding', method: 'rule', confidence: 1 })
    expect(llm).not.toHaveBeenCalled()
  })

  it('R2 tools_unsupported 源或文案（EN+CJK）→ channel', async () => {
    for (const c of [
      cardWith('tools_unsupported'),
      cardWith('abnormal_outcome', { symptom: '该渠道不支持 tool use，agent loop 无法运行' }),
      cardWith('abnormal_outcome', { symptom: 'tool not supported by provider' }),
    ]) {
      const r = await attributeRootCause(c, { llmCall: llm })
      expect(r.stage).toBe('channel')
    }
    expect(llm).not.toHaveBeenCalled()
  })

  it('R3 验收标准缺失（EN+CJK）→ prd', async () => {
    for (const symptom of ['no acceptance criteria for F-003', 'missing acceptance in item', '功能项缺少验收标准']) {
      const r = await attributeRootCause(cardWith('semantic_findings', { symptom }), { llmCall: llm })
      expect(r.stage).toBe('prd')
    }
    expect(llm).not.toHaveBeenCalled()
  })

  it('R4 需求歧义（ambiguous/unclear/needs clarification/歧义）→ clarify', async () => {
    for (const symptom of ['ambiguous requirement wording', '表述有歧义导致做偏']) {
      const r = await attributeRootCause(cardWith('semantic_findings', { symptom }), { llmCall: llm })
      expect(r.stage).toBe('clarify')
    }
    expect(llm).not.toHaveBeenCalled()
  })

  it('R5 contract + out-of-scope 双关键词 → plan_leg；单独 contract 不触发', async () => {
    const hit = await attributeRootCause(cardWith('gwt_failure', { symptom: 'contract check: scenario out of scope' }), { llmCall: llm })
    expect(hit.stage).toBe('plan_leg')
    const miss = await attributeRootCause(cardWith('gwt_failure', { symptom: 'contract hash mismatch' }), { llmCall: llm })
    expect(miss.stage).toBe('coding') // 落到 R6
    expect(llm).not.toHaveBeenCalled()
  })

  it('R6 gwt_failure 默认 → coding；judge/backfill 归 coding', async () => {
    expect((await attributeRootCause(cardWith('gwt_failure'), { llmCall: llm })).stage).toBe('coding')
    expect((await attributeRootCause(cardWith('semantic_findings'), { llmCall: llm })).stage).toBe('coding')
    expect(llm).not.toHaveBeenCalled()
  })

  it('needsRefinement：初值 rule+unknown+0 需要精化；已有归因结论不重复', () => {
    expect(needsRefinement(cardWith('abnormal_outcome') as ExperienceCard)).toBe(true)
    const refined = cardWith('abnormal_outcome')
    ;(refined.body as AntiPatternBody).root_cause = { stage: 'channel', description: 'x', method: 'rule', confidence: 1 }
    expect(needsRefinement(refined as ExperienceCard)).toBe(false)
  })
})

describe('T-4 归因：LLM 兜底与降级', () => {
  it('无规则命中（纯异常结局）走 LLM：合法 JSON 采用且置信 clamp ≤0.5', async () => {
    const llm = vi.fn(async () => '前缀噪声 {"stage":"coding","confidence":0.9,"reasoning":"loop 在写文件前未 read"} 后缀')
    const r = await attributeRootCause(cardWith('abnormal_outcome', { symptom: 'Loop 结束（turn_limit，24 轮 / 55 次工具调用）', stage: 'unknown' }), {
      llmCall: llm,
      loopLogLines: ['turn 1 write_file a', 'turn 24 still editing'],
      backplateSnippet: 'F-001 记录收支',
    })
    expect(llm).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ stage: 'coding', method: 'llm' })
    expect(r.confidence).toBeLessThanOrEqual(0.5)
    expect(r.reasoning).toContain('read')
  })

  it('降级链全保持 unknown：坏 JSON / 越权 stage / 抛错 / 超时', async () => {
    const card = cardWith('abnormal_outcome', { symptom: 'Loop 结束（turn_limit，24 轮 / 55 次工具调用）', stage: 'unknown' })
    for (const bad of [
      vi.fn(async () => 'not json at all'),
      vi.fn(async () => '{"stage":"magic","confidence":0.4}'),
      vi.fn(async () => { throw new Error('LLM 500') }),
      vi.fn(() => new Promise<string>((r) => setTimeout(() => r('{"stage":"coding","confidence":0.4}'), 5000))),
    ]) {
      const r = await attributeRootCause(card, { llmCall: bad, llmTimeoutMs: 40 })
      expect(r.stage).toBe('unknown')
      expect(r.method).toBe('llm')
    }
  })

  it('LLM 输入预算：loop-log 超 300 行截断、背板超 2000 字符截断', async () => {
    const llm = vi.fn(async (_prompt: string) => 'garbage')
    await attributeRootCause(cardWith('abnormal_outcome', { symptom: 'Loop 结束（turn_limit，24 轮 / 55 次工具调用）', stage: 'unknown' }), {
      llmCall: llm,
      loopLogLines: Array.from({ length: 900 }, (_, i) => `line ${i}`),
      backplateSnippet: '背'.repeat(3000),
    })
    const prompt = llm.mock.calls[0][0] as string
    expect(prompt).toContain('line 899') // 取尾：最近过程最重要
    expect(prompt).not.toContain('line 0\n')
    expect((prompt.match(/背/g) ?? []).length).toBeLessThanOrEqual(2000)
  })
})

describe('T-4 updateCardAttribution 幂等写回', () => {
  const originalHome = process.env.PROMA_HOME
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'proma-attr-'))
    process.env.PROMA_HOME = home
    resetExperienceIndexForTests()
  })
  afterEach(() => {
    resetExperienceIndexForTests()
    process.env.PROMA_HOME = originalHome
  })

  it('已存在 candidate 卡：归因走 update——账本仍单卡、root_cause 精化、同值重复调用不加行', async () => {
    const card = await tryRegisterCard({
      kind: 'anti_pattern',
      tag: 'build_gate/typescript/type_mismatch',
      body: body({ stage: 'build_gate', symptom: 'tsc failed: TS2345', root_cause: { stage: 'build_gate', description: 'tsc failed: TS2345', method: 'rule', confidence: 1 } }),
      source: { type: 'build_gate_failure', project_hash: 'p1', timestamp: Date.now() },
    })
    expect(card).not.toBeNull()
    const linesBefore = readFileSync(join(home, 'bloma-experience.jsonl'), 'utf8').trim().split('\n').length
    const rc = { stage: 'coding', description: 'tsc failed: TS2345', method: 'rule' as const, confidence: 1 }
    const updated = await updateCardAttribution(card!.id, rc)
    expect(updated?.kind === 'anti_pattern' && updated.body.root_cause.stage).toBe('coding')
    // 同值再更新 → 幂等不加行（返回值等价、行数不变）
    const again = await updateCardAttribution(card!.id, rc)
    expect(again?.updated_at).toBe(updated?.updated_at)
    const linesAfter = readFileSync(join(home, 'bloma-experience.jsonl'), 'utf8').trim().split('\n').length
    expect(linesAfter).toBe(linesBefore + 1) // 只多了第一次真 update 一行
    expect(readAllCards()).toHaveLength(1) // 压缩视图单卡，绝无重复 insert
  })

  it('未知 id → null', async () => {
    expect(await updateCardAttribution('nope', { stage: 'coding', description: 'd', method: 'rule', confidence: 1 })).toBeNull()
  })

  it('集成（W2.1 语义）：recordFailureCards 只落事件行不产卡（归因腿无新卡可精化）', async () => {
    recordFailureCards(
      { projectId: 'proj-attr', sessionId: 's' },
      { testResult: { total_count: 3, passed_count: 2, failed_count: 1, failure_summary: [{ scenario: 'F-001 存按钮', reason: '未命中' }] } },
    )
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(readAllCards()).toHaveLength(0)
    const { readExperienceEvents } = await import('../../../main/experience/event-log')
    const events = readExperienceEvents()
    expect(events.some((e) => e.event_type === 'gwt_failure')).toBe(true)
  })
})
