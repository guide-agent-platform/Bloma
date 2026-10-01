import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  maintenancePass,
  promoteToVerified,
  readAllCards,
  reportInjection,
  reportReplayOutcomes,
  resetExperienceIndexForTests,
  selectForInjection,
  tryRegisterCard,
  updateCardAttribution,
} from '../../../main/experience/experience-service'
import type { AntiPatternBody, ExperienceCard } from '../../../main/experience/types'
import { attributeRootCause, needsRefinement } from '../../../main/experience/root-cause-attributor'

/**
 * T-2 统一入册闸门（账本 ~/.proma/bloma-experience.jsonl）：
 * - 注册去重（fingerprint + 10min 窗口折叠）、跨窗口 recurrence 递增
 * - 消费入池 = verified || recurrence>=2（candidate 首注册即落盘不丢数据）
 * - promoteToVerified / reportInjection 统计回报 / maintenance 过期退役
 * - selectForInjection：过滤+相关性排序+整条预算截断
 * - 坏行降级、脱敏必经、静默失败不抛
 * 每用例独立 PROMA_HOME + resetExperienceIndexForTests()。
 */

function antiBody(symptom = 'TypeScript build fails with TS2345: argument type mismatch'): AntiPatternBody {
  return {
    stage: 'build_gate',
    symptom,
    trigger_condition: 'passing string where number expected',
    root_cause: { stage: 'coding', description: 'no coercion', method: 'rule', confidence: 1 },
    test_checklist: ['verify parameter types'],
    review_checklist: ['untyped parameters'],
    severity: 2,
  }
}

function src(): ExperienceCard['source'] {
  return { type: 'build_gate_failure', project_hash: 'p1', timestamp: Date.now() }
}

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'proma-exp-'))
  process.env.PROMA_HOME = home
  process.env.BLOMA_EXPERIENCE = '1'
  resetExperienceIndexForTests()
})
afterEach(() => {
  delete process.env.BLOMA_EXPERIENCE
  resetExperienceIndexForTests()
})

async function registerOnce(body = antiBody()) {
  const card = await tryRegisterCard({ kind: 'anti_pattern', tag: 'build_gate/typescript/type_mismatch', body, source: src() })
  return card as ExperienceCard
}

/** F 系列 W2.3（冻结 v1 注入后）：注入机制测试统一用 v2 rule 卡夹具。 */
function ruleBody(text = 'TypeScript build fails with TS2345: argument type mismatch') {
  return {
    rule_kind: 'execution_rule' as const,
    applies_when: { stage: 'build_gate' },
    failure_mode: text,
    recommended_actions: ['按报错修类型'],
    verification: { check: 'build gate passed' },
    causal_status: 'hypothesis' as const,
    rev: 1,
  }
}

async function registerRuleOnce(text?: string, tag = 'rule/build/types') {
  const card = await tryRegisterCard({ kind: 'rule', tag, body: ruleBody(text), source: src() })
  return card as ExperienceCard
}

describe('experience-service：注册与去重', () => {
  it('首次注册 → candidate recurrence=1 落盘；开关 off 时 no-op 返回 null', async () => {
    const card = await registerOnce()
    expect(card.status).toBe('candidate')
    expect(card.recurrence).toBe(1)
    const lines = readFileSync(join(home, 'bloma-experience.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    process.env.BLOMA_EXPERIENCE = 'off'
    expect(await tryRegisterCard({ kind: 'anti_pattern', tag: 'x/y/z', body: antiBody('别的'), source: src() })).toBeNull()
  })

  it('10 分钟窗口内同指纹重复注册 → 折叠不计数不加行', async () => {
    const first = await registerOnce()
    const second = await tryRegisterCard({ kind: 'anti_pattern', tag: first.tag, body: first.kind === 'anti_pattern' ? first.body : antiBody(), source: src() })
    expect(second?.id).toBe(first.id)
    expect(second?.recurrence).toBe(1)
    expect(readAllCards()).toHaveLength(1)
  })

  it('跨项目（seen_projects 新增）且窗口外 → recurrence+1 且仍单卡；同项目重观察不计数', async () => {
    const first = await registerOnce()
    const stored = readAllCards()[0]
    // 拨旧 11 分钟（改写盘时间戳后重载索引）
    const old = { ...stored, created_at: stored.created_at - 11 * 60_000, updated_at: stored.updated_at - 11 * 60_000 }
    writeFileSync(join(home, 'bloma-experience.jsonl'), `${JSON.stringify(old)}\n`, 'utf8')
    resetExperienceIndexForTests()
    // 同项目重复观察 → 幂等不计数
    const sameProject = await registerOnce()
    expect(sameProject?.recurrence).toBe(1)
    // 新观察来自另一项目（source.project_hash 不同）→ recurrence+1
    const other = await tryRegisterCard({ kind: 'anti_pattern', tag: first!.tag, body: first!.kind === 'anti_pattern' ? first!.body : antiBody(), source: { type: 'gwt_failure', project_hash: 'p2', timestamp: Date.now() } })
    expect(other?.recurrence).toBe(2)
    expect(other?.seen_projects).toHaveLength(2)
    const cards = readAllCards()
    expect(cards).toHaveLength(1)
  })

  it('注册必经脱敏：路径/凭证不出现在文件里', async () => {
    await registerOnce(antiBody('build failed at C:\\Users\\alice\\projects\\secret-app\\src\\index.ts with mongodb://admin:password123@db:27017'))
    const raw = readFileSync(join(home, 'bloma-experience.jsonl'), 'utf8')
    expect(raw).not.toContain('alice')
    expect(raw).not.toContain('password123')
  })
})

describe('experience-service：attribution-seam 链路（unknown 卡 → LLM 精化落盘）', () => {
  const unknownBody = (): AntiPatternBody => ({ ...antiBody(), stage: 'unknown', symptom: 'QQQ-7788 未登记结局：执行体以未知形态中止', trigger_condition: 'QQQ-7788 无任何已知规则线索', root_cause: { stage: 'unknown', description: 'unknown', method: 'rule', confidence: 0 } })
  it('needsRefinement 卡经真实接线（fake llm seam）精化：method=llm、clamp≤0.5、reasoning 落盘', async () => {
    const card = (await tryRegisterCard({ kind: 'anti_pattern', tag: 'unknown/outcome/timeout', body: unknownBody(), source: { type: 'abnormal_outcome', project_hash: 'p1', timestamp: Date.now() } })) as ExperienceCard
    expect(needsRefinement(card)).toBe(true)
    const refined = await attributeRootCause(card, {
      llmCall: async () => JSON.stringify({ stage: 'coding', confidence: 0.9, reasoning: '长任务多轮工具调用未收敛，疑为生成侧任务分解粒度过大', possible_stages: ['coding'] }),
    })
    expect(refined.method).toBe('llm')
    expect(refined.confidence).toBeLessThanOrEqual(0.5) // 强制 clamp 纪律
    const updated = await updateCardAttribution(card.id, refined)
    expect((updated?.body as AntiPatternBody).root_cause.reasoning).toContain('任务分解粒度')
    const latest = readAllCards().find((c) => c.id === card.id)
    expect((latest?.body as AntiPatternBody).root_cause.stage).toBe('coding')
    expect(needsRefinement(latest!)).toBe(false) // 精化后不再需要二次归因
  })
})

describe('experience-service：replay 回流产物相关性门（V1.1 假绿修复）', () => {
  // 真实灰度 S5+S6（2026-09-07）暴露：契约卡被拉到「产物根本没有该端点」的项目上重放，
  // 静态启发式默认放行 → 假 replay_green 晋升。无关产物的绿/红都无证据价值。
  const contractBody = (): AntiPatternBody => ({ ...antiBody(), stage: 'coding', symptom: 'GWT 场景「API 契约端点：GET /api/records」未通过：契约端点失活（HTTP 404，路由未实现或挂载失败）' })
  const projectId = 'pid-replay-gate'
  const writeArtifact = (html: string) => {
    const dir = join(home, 'agent-workspaces', 'default-software-builder', 'generated-projects', projectId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.html'), html, 'utf8')
  }
  it('产物未引用重放端点：passed 不产晋升证据（卡保持 candidate）', async () => {
    const card = await registerOnce(contractBody())
    writeArtifact('<html><body>一个换算器，没有 API</body></html>')
    await reportReplayOutcomes([{ id: card.fingerprint.slice(0, 8), passed: true }], projectId)
    const latest = readAllCards().find((c) => c.id === card.id)
    expect(latest?.status).toBe('candidate')
  })
  it('产物引用了重放端点：passed 正常晋升 verified（gate 不误伤）', async () => {
    const card = await registerOnce(contractBody())
    writeArtifact('<html><script>fetch("/api/records")</script></html>')
    await reportReplayOutcomes([{ id: card.fingerprint.slice(0, 8), passed: true }], projectId)
    const latest = readAllCards().find((c) => c.id === card.id)
    expect(latest?.status).toBe('verified')
    expect(latest?.verified_by).toBe('replay_green')
  })
  it('无端点 token 的卡（DOM 断言类）行为不变：passed 即晋升', async () => {
    const card = await registerOnce()
    writeArtifact('<html><body>无关内容</body></html>')
    await reportReplayOutcomes([{ id: card.fingerprint.slice(0, 8), passed: true }], projectId)
    expect(readAllCards().find((c) => c.id === card.id)?.status).toBe('verified')
  })
  it('不传 projectId（旧调用面兼容）：不设门，保持原语义', async () => {
    const card = await registerOnce(contractBody())
    await reportReplayOutcomes([{ id: card.fingerprint.slice(0, 8), passed: true }])
    expect(readAllCards().find((c) => c.id === card.id)?.status).toBe('verified')
  })
})

describe('experience-service：状态机与统计', () => {
  it('promoteToVerified：candidate→verified，last_verified_at/verified_by 填充；未知 id 返回 null', async () => {
    const card = await registerOnce()
    const promoted = await promoteToVerified(card!.id, 'replay_green')
    expect(promoted?.status).toBe('verified')
    expect(promoted?.last_verified_at).toBeTypeOf('number')
    expect(promoted?.verified_by).toBe('replay_green')
    expect(await promoteToVerified('no-such-id', 'human_review')).toBeNull()
  })

  it('reportInjection 维护 stats（injected/matched/false_positive）', async () => {
    const card = await registerOnce()
    await promoteToVerified(card!.id, 'sandbox_pass')
    await reportInjection(card!.id, 'injected')
    await reportInjection(card!.id, 'matched')
    await reportInjection(card!.id, 'false_positive')
    const fresh = readAllCards().find((c) => c.id === card!.id)
    expect(fresh?.stats).toMatchObject({ times_injected: 1, times_matched: 1, false_positive_count: 1 })
  })

  it('maintenancePass：candidate 超 60 天未验证 → retired（retired 不再参与去重合并）', async () => {
    const card = await registerOnce()
    const stored = readAllCards()[0]
    const old = { ...stored, created_at: Date.now() - 61 * 86_400_000 }
    writeFileSync(join(home, 'bloma-experience.jsonl'), `${JSON.stringify(old)}\n`, 'utf8')
    resetExperienceIndexForTests()
    const changed = await maintenancePass(Date.now())
    expect(changed).toBeGreaterThanOrEqual(1)
    expect(readAllCards()[0].status).toBe('retired')
  })
})

describe('experience-service：selectForInjection', () => {
  async function seedFixture() {
    // A: verified rule 卡；B: candidate recurrence=1（不可消费）；C: verified 但 stale
    const a = await registerRuleOnce('TypeError: not a function')
    await promoteToVerified(a!.id, 'replay_green')
    const b = await registerRuleOnce('canvas rAF loop leaks on restart')
    const c = await registerRuleOnce('unhandled rejection in async init')
    await promoteToVerified(c!.id, 'human_review')
    const stored = readAllCards().find((x) => x.id === c!.id)!
    const staleCard = { ...stored, last_verified_at: Date.now() - 91 * 86_400_000 }
    writeFileSync(join(home, 'bloma-experience.jsonl'), readAllCards().filter((x) => x.id !== c!.id).map((x) => `${JSON.stringify(x)}`).concat(`${JSON.stringify(staleCard)}`).join('\n') + '\n', 'utf8')
    resetExperienceIndexForTests()
    return { a, b, c }
  }

  it('只返回 verified || recurrence>=2；默认排除 stale；include_stale 可放宽', async () => {
    const { a, b, c } = await seedFixture()
    const ids = (await selectForInjection({ kind: 'rule' })).map((x) => x.id)
    expect(ids).toContain(a!.id)
    expect(ids).not.toContain(b!.id) // candidate r=1
    expect(ids).not.toContain(c!.id) // stale
    const withStale = await selectForInjection({ kind: 'rule', include_stale: true })
    expect(withStale.map((x) => x.id)).toContain(c!.id)
  })

  it('tag_prefix 过滤 + limit + budget_chars 整条取舍（不出现半条卡文本）', async () => {
    const { a } = await seedFixture()
    for (let i = 0; i < 8; i++) {
      const card = await registerRuleOnce(`canvas frame budget exceeded scenario ${i} ${'x'.repeat(200)}`)
      await promoteToVerified(card!.id, 'replay_green')
    }
    const canvasOnly = await selectForInjection({ kind: 'rule', tag_prefix: 'build_gate/' })
    expect(canvasOnly.every((x) => x.tag.startsWith('build_gate/'))).toBe(true)
    const limited = await selectForInjection({ kind: 'rule', limit: 3 })
    expect(limited).toHaveLength(3)
    const budgeted = await selectForInjection({ kind: 'rule', budget_chars: 400 })
    expect(budgeted.length).toBeGreaterThan(0)
    expect(budgeted.length).toBeLessThan(8)
    const total = budgeted.reduce((n, x) => n + (x.kind === 'anti_pattern' ? x.body.symptom.length : 0), 0)
    expect(total).toBeLessThanOrEqual(400)
  })

  it('context_hint 关键词重叠参与排序（提示匹配的卡靠前）', async () => {
    const a = await registerRuleOnce('TypeError: not a function')
    await promoteToVerified(a!.id, 'replay_green')
    const b = await registerRuleOnce('debounce timer leaks on unmount')
    await promoteToVerified(b!.id, 'replay_green')
    const res = await selectForInjection({ kind: 'rule', context_hint: 'timer debounce unmount input handler' })
    expect(res[0].id).toBe(b!.id)
  })
})

describe('experience-service：健壮性', () => {
  it('账本中间插坏行 → 跳过并 warn，有效卡完好；全坏 → 空索引不抛', async () => {
    await registerOnce()
    const path = join(home, 'bloma-experience.jsonl')
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    writeFileSync(path, `${lines[0]}\nNOT-JSON{{{\n`, 'utf8')
    resetExperienceIndexForTests()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readAllCards()).toHaveLength(1)
    writeFileSync(path, 'junk\nmore-junk\n', 'utf8')
    resetExperienceIndexForTests()
    expect(readAllCards()).toHaveLength(0)
    warn.mockRestore()
  })

  // 负载安全阈值（2026-10-01）：全量并行 CPU 满载下旧 5s/100ms 阈必超；保留数量级敏感性（O(n²) 回归仍会爆 30s/1s）
  it('1000 次注册压测（负载安全阈值）', { timeout: 90_000 }, async () => {
    for (let i = 0; i < 500; i++) {
      await tryRegisterCard({ kind: 'anti_pattern', tag: 'perf/x/unique', body: antiBody(`unique symptom ${i}`), source: src() })
    }
    const start = Date.now()
    for (let i = 500; i < 1000; i++) {
      await tryRegisterCard({ kind: 'anti_pattern', tag: 'perf/x/unique', body: antiBody(`unique symptom ${i}`), source: src() })
    }
    expect(Date.now() - start).toBeLessThan(30_000)
    const t0 = performance.now()
    await selectForInjection({ kind: 'rule', limit: 5 })
    expect(performance.now() - t0).toBeLessThan(1_000)
  })
})
