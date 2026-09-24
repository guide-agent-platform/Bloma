import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel } from '../../shared/types'
import { getChannelByIdRaw } from '../../main/platform/llm/channel-manager'
import type { PrdBackplane, SketchRequirement } from '../../main/coding/sketch-engine'
import type { DelegatedReviewOutcome } from '../../main/review/review-delegation'
import {
  parseAdversarialVerdicts,
  resolveAdversarialChannelsChecked,
  runAdversarialSemanticReview,
  type ReviewRoundRunner,
} from '../../main/review/adversarial-review'

vi.mock('../../main/platform/llm/channel-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/platform/llm/channel-manager')>()
  return {
    ...actual,
    getChannelByIdRaw: vi.fn(),
  }
})

// 集成腿专用：judge-semantic → adversarial-review → runDelegatedReview 全链（脚本化委派）
vi.mock('../../main/review/review-delegation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/review/review-delegation')>()
  return {
    ...actual,
    delegatedReviewEnabled: () => true,
    runDelegatedReview: vi.fn(),
  }
})

/**
 * C3 异构攻防审查单测（协作机制改造批次 3，2026-09-24）。
 *
 * 锁定：
 * - 渠道就绪校验：未配置/渠道禁用/同族 → blocked（降级由 judge-semantic 承接）
 * - 状态机：攻 → 防 →（blocking 争议）复核 ≤2 轮收敛，禁第 3 轮
 * - 防御者反驳：非 blocking 项降级 unverified 留痕（evidence 前缀）；复核失败按防御者版收敛
 * - verdicts 解析：白名单/无证据 refute 丢弃/围栏剥离（幻觉防御）
 * - 集成腿：judge-semantic 分支路由（on=攻防三委派带异渠道；off=现状单委派字节不变）
 */

const ATTACKER_JSON = (findings: unknown): string => JSON.stringify({ findings })
const DEFENDER_JSON = (verdicts: unknown): string => JSON.stringify({ verdicts })

function makeChannel(id: string, providerType: string): Channel {
  return {
    id,
    name: id,
    provider_type: providerType as Channel['provider_type'],
    base_url: `https://${id}.example/api`,
    api_key: 'enc',
    enabled: true,
    models: [{ id: 'm1', name: 'Model-1', enabled: true }],
  }
}

const REQUIREMENTS: SketchRequirement[] = [
  { id: 'F-001', description: '记账列表展示' },
  { id: 'F-002', description: '数据留存' },
  { id: 'F-003', description: '统计图表' },
]

function baseOpts(runReview: ReviewRoundRunner) {
  return {
    goal: '审查产物 vs PRD',
    baseTask: '基础审查任务（含 PRD 功能项清单）',
    system: '裁判 system',
    requirements: REQUIREMENTS,
    query: async function* () {
      yield { type: 'result', subtype: 'success' } as never
    } as never,
    env: {},
    sessionId: 'session-adv',
    projectId: 'project-adv',
    requestId: 'req-adv',
    publish: () => undefined,
    runReview,
  }
}

function okRound(text: string): DelegatedReviewOutcome {
  return { ok: true, delegationId: 'd', finalText: text }
}

describe('C3 渠道就绪校验', () => {
  const origAttacker = process.env.BLOMA_ADVERSARIAL_ATTACKER
  const origDefender = process.env.BLOMA_ADVERSARIAL_DEFENDER

  afterEach(() => {
    if (origAttacker === undefined) delete process.env.BLOMA_ADVERSARIAL_ATTACKER
    else process.env.BLOMA_ADVERSARIAL_ATTACKER = origAttacker
    if (origDefender === undefined) delete process.env.BLOMA_ADVERSARIAL_DEFENDER
    else process.env.BLOMA_ADVERSARIAL_DEFENDER = origDefender
  })

  it('未配置 → not_configured；渠道禁用 → invalid_channel；同族 → same_family', () => {
    expect(resolveAdversarialChannelsChecked()).toEqual({ ok: false, reason: 'not_configured' })

    process.env.BLOMA_ADVERSARIAL_ATTACKER = 'ch-a'
    process.env.BLOMA_ADVERSARIAL_DEFENDER = 'ch-b'
    vi.mocked(getChannelByIdRaw).mockReturnValue(undefined)
    expect(resolveAdversarialChannelsChecked()).toEqual({ ok: false, reason: 'invalid_channel' })

    vi.mocked(getChannelByIdRaw).mockImplementation(((id: string) =>
      makeChannel(id, id === 'ch-a' ? 'deepseek' : 'zhipu')) as never)
    const ok = resolveAdversarialChannelsChecked()
    expect(ok).toEqual({ ok: true, attacker: 'ch-a', defender: 'ch-b' })

    vi.mocked(getChannelByIdRaw).mockImplementation(((id: string) => makeChannel(id, 'deepseek')) as never)
    expect(resolveAdversarialChannelsChecked()).toEqual({ ok: false, reason: 'same_family' })
  })
})

describe('C3 攻防轮次状态机（runReview 注入）', () => {
  const origPromaHome = process.env.PROMA_HOME
  const origAttacker = process.env.BLOMA_ADVERSARIAL_ATTACKER
  const origDefender = process.env.BLOMA_ADVERSARIAL_DEFENDER

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-adv-'))
    process.env.BLOMA_ADVERSARIAL_ATTACKER = 'ch-a'
    process.env.BLOMA_ADVERSARIAL_DEFENDER = 'ch-b'
    vi.mocked(getChannelByIdRaw).mockImplementation(((id: string) =>
      makeChannel(id, id === 'ch-a' ? 'deepseek' : 'zhipu')) as never)
  })
  afterEach(() => {
    if (origPromaHome === undefined) delete process.env.PROMA_HOME
    else process.env.PROMA_HOME = origPromaHome
    if (origAttacker === undefined) delete process.env.BLOMA_ADVERSARIAL_ATTACKER
    else process.env.BLOMA_ADVERSARIAL_ATTACKER = origAttacker
    if (origDefender === undefined) delete process.env.BLOMA_ADVERSARIAL_DEFENDER
    else process.env.BLOMA_ADVERSARIAL_DEFENDER = origDefender
  })

  it('单攻单防全确认（无 blocking 争议）→ rounds 1，findings 原样，无复核', async () => {
    const calls: string[] = []
    const outcome = await runAdversarialSemanticReview(
      baseOpts(async (round) => {
        calls.push(round.channelId)
        if (round.channelId === 'ch-a') {
          return okRound(ATTACKER_JSON([
            { requirement_id: 'F-001', status: 'implemented', evidence: 'src/app.js L10' },
            { requirement_id: 'F-002', status: 'partial', evidence: '仅内存未落盘' },
          ]))
        }
        return okRound(DEFENDER_JSON([
          { requirement_id: 'F-001', verdict: 'confirmed', evidence: '确认' },
          { requirement_id: 'F-002', verdict: 'confirmed', evidence: '确认' },
        ]))
      }),
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.rounds).toBe(1)
    expect(calls).toEqual(['ch-a', 'ch-b'])
    expect(outcome.findings).toHaveLength(2)
    expect(outcome.findings![0]).toMatchObject({ requirement_id: 'F-001', status: 'implemented' })
    expect(outcome.refuted).toEqual([])
  })

  it('防御者反驳非 blocking 项 → 降级 unverified 留痕（evidence 前缀），rounds 1', async () => {
    const outcome = await runAdversarialSemanticReview(
      baseOpts(async (round) => {
        if (round.channelId === 'ch-a') {
          return okRound(ATTACKER_JSON([
            { requirement_id: 'F-003', status: 'partial', evidence: '攻击者称图表缺图例' },
          ]))
        }
        return okRound(DEFENDER_JSON([
          { requirement_id: 'F-003', verdict: 'refuted', evidence: 'src/chart.js L22 已含图例' },
        ]))
      }),
    )
    // partial 非 blocking：不触发复核，直接按防御者调整版收敛
    expect(outcome.rounds).toBe(1)
    expect(outcome.refuted).toEqual(['F-003'])
    expect(outcome.findings![0]).toMatchObject({ requirement_id: 'F-003', status: 'unverified' })
    expect(outcome.findings![0]!.evidence).toContain('[防御者反驳] src/chart.js')
  })

  it('防御者反驳 blocking 项 → 触发复核轮（攻击者改判则采纳），rounds 2', async () => {
    const attackerCalls: string[] = []
    const outcome = await runAdversarialSemanticReview(
      baseOpts(async (round) => {
        if (round.channelId === 'ch-a') {
          attackerCalls.push(round.task.slice(0, 12))
          if (attackerCalls.length === 1) {
            return okRound(ATTACKER_JSON([
              { requirement_id: 'F-002', status: 'missing', evidence: '未找到留存实现' },
            ]))
          }
          expect(round.task).toContain('争议复核')
          expect(round.task).toContain('防御者证据不成立')
          return okRound(ATTACKER_JSON([
            { requirement_id: 'F-002', status: 'implemented', evidence: 'data/ 原子写确认' },
          ]))
        }
        return okRound(DEFENDER_JSON([
          { requirement_id: 'F-002', verdict: 'refuted', evidence: 'db.js writeData 已实现' },
        ]))
      }),
    )
    expect(outcome.rounds).toBe(2)
    expect(outcome.findings![0]).toMatchObject({ requirement_id: 'F-002', status: 'implemented' })
    expect(outcome.refuted).toEqual(['F-002'])
  })

  it('复核仍 blocking → 保留判定，禁第 3 轮（攻击者恰好两轮）', async () => {
    let attackerRounds = 0
    const outcome = await runAdversarialSemanticReview(
      baseOpts(async (round) => {
        if (round.channelId === 'ch-a') {
          attackerRounds += 1
          return okRound(ATTACKER_JSON([
            { requirement_id: 'F-001', status: 'missing', evidence: `第 ${attackerRounds} 轮仍未找到` },
          ]))
        }
        return okRound(DEFENDER_JSON([
          { requirement_id: 'F-001', verdict: 'refuted', evidence: 'app.js 已实现' },
        ]))
      }),
    )
    expect(attackerRounds).toBe(2)
    expect(outcome.rounds).toBe(2)
    // 复审维持 blocking → 最终判定保留 missing（防御者反驳被复核推翻）
    expect(outcome.findings![0]).toMatchObject({ requirement_id: 'F-001', status: 'missing' })
  })

  it('复核轮失败 → 按防御者调整版收敛（rounds 1，refuted 项 unverified）', async () => {
    let attackerRounds = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const outcome = await runAdversarialSemanticReview(
      baseOpts(async (round) => {
        if (round.channelId === 'ch-a') {
          attackerRounds += 1
          if (attackerRounds === 1) {
            return okRound(ATTACKER_JSON([
              { requirement_id: 'F-001', status: 'missing', evidence: '未找到' },
            ]))
          }
          return { ok: false, failure: 'timeout' }
        }
        return okRound(DEFENDER_JSON([
          { requirement_id: 'F-001', verdict: 'refuted', evidence: '确实实现了' },
        ]))
      }),
    )
    warnSpy.mockRestore()
    expect(attackerRounds).toBe(2)
    expect(outcome.ok).toBe(true)
    expect(outcome.rounds).toBe(1) // 复核失败不计轮次，按防御者版收敛
    expect(outcome.findings![0]).toMatchObject({ requirement_id: 'F-001', status: 'unverified' })
  })

  it('攻击者输出不可解析 → failure failed（调用方降级单委派）', async () => {
    const outcome = await runAdversarialSemanticReview(
      baseOpts(async (round) => {
        if (round.channelId === 'ch-a') return okRound('这不是 JSON')
        return okRound(DEFENDER_JSON([]))
      }),
    )
    expect(outcome).toMatchObject({ ok: false, failure: 'failed' })
  })

  it('防御者失败 → failure 透传（调用方降级）', async () => {
    const outcome = await runAdversarialSemanticReview(
      baseOpts(async (round) => {
        if (round.channelId === 'ch-a') {
          return okRound(ATTACKER_JSON([
            { requirement_id: 'F-001', status: 'implemented', evidence: 'ok' },
          ]))
        }
        return { ok: false, failure: 'timeout' }
      }),
    )
    expect(outcome).toMatchObject({ ok: false, failure: 'timeout' })
  })
})

describe('C3 parseAdversarialVerdicts（幻觉防御）', () => {
  it('白名单 id 过滤、无证据 refute 丢弃、围栏剥离', () => {
    const text = '```json\n{"verdicts":['
      + '{"requirement_id":"F-001","verdict":"confirmed","evidence":"支持"},'
      + '{"requirement_id":"F-999","verdict":"refuted","evidence":"幻觉项"},'
      + '{"requirement_id":"F-002","verdict":"refuted","evidence":""},'
      + '{"requirement_id":"F-003","verdict":"unknown","evidence":"未知枚举"}'
      + ']}\n```'
    const verdicts = parseAdversarialVerdicts(text, REQUIREMENTS)
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toMatchObject({ requirement_id: 'F-001', verdict: 'confirmed' })
  })

  it('无 JSON 对象 → 抛错', () => {
    expect(() => parseAdversarialVerdicts('纯文本', REQUIREMENTS)).toThrow(/ADVERSARIAL_VERDICT_PARSE_FAILED/)
  })
})

describe('C3 judge-semantic 分支路由（集成腿）', () => {
  const origPromaHome = process.env.PROMA_HOME
  const origSwitch = process.env.BLOMA_ADVERSARIAL_REVIEW
  const origAttacker = process.env.BLOMA_ADVERSARIAL_ATTACKER
  const origDefender = process.env.BLOMA_ADVERSARIAL_DEFENDER
  // eslint 风格的顶部导入已在文件头；此处按需取 mock 后模块
  let runSemanticJudgeReviewFn: typeof import('../../main/review/judge-semantic').runSemanticJudgeReview
  let runDelegatedReviewMock: ReturnType<typeof vi.fn>

  beforeAll(async () => {
    const judgeSemantic = await import('../../main/review/judge-semantic')
    runSemanticJudgeReviewFn = judgeSemantic.runSemanticJudgeReview
    const reviewDelegation = await import('../../main/review/review-delegation')
    runDelegatedReviewMock = reviewDelegation.runDelegatedReview as unknown as ReturnType<typeof vi.fn>
  })

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-adv-int-'))
    process.env.BLOMA_ADVERSARIAL_ATTACKER = 'ch-a'
    process.env.BLOMA_ADVERSARIAL_DEFENDER = 'ch-b'
    vi.mocked(getChannelByIdRaw).mockImplementation(((id: string) =>
      makeChannel(id, id === 'ch-a' ? 'deepseek' : 'zhipu')) as never)
    runDelegatedReviewMock?.mockReset()
  })
  afterEach(() => {
    if (origPromaHome === undefined) delete process.env.PROMA_HOME
    else process.env.PROMA_HOME = origPromaHome
    if (origSwitch === undefined) delete process.env.BLOMA_ADVERSARIAL_REVIEW
    else process.env.BLOMA_ADVERSARIAL_REVIEW = origSwitch
    if (origAttacker === undefined) delete process.env.BLOMA_ADVERSARIAL_ATTACKER
    else process.env.BLOMA_ADVERSARIAL_ATTACKER = origAttacker
    if (origDefender === undefined) delete process.env.BLOMA_ADVERSARIAL_DEFENDER
    else process.env.BLOMA_ADVERSARIAL_DEFENDER = origDefender
  })

  const fakeQuery = (async function* () {
    yield { type: 'result', subtype: 'success' }
  }) as never

  it('on：攻防三委派带异渠道，via=adversarial，元信息在场', async () => {
    process.env.BLOMA_ADVERSARIAL_REVIEW = '1'
    runDelegatedReviewMock.mockImplementation(async (opts: { channelId?: string }) => {
      if (opts.channelId === 'ch-a') {
        return okRound(ATTACKER_JSON([
          { requirement_id: 'F-001', status: 'implemented', evidence: 'ok' },
        ]))
      }
      return okRound(DEFENDER_JSON([
        { requirement_id: 'F-001', verdict: 'confirmed', evidence: '确认' },
      ]))
    })

    const result = await runSemanticJudgeReviewFn({
      backplane: { name: '攻防项目', requirements: REQUIREMENTS } as unknown as PrdBackplane,
      artifact: '<html><body>x</body></html>',
      query: fakeQuery,
      env: {},
      sessionId: 's-adv-int',
      projectId: 'p-adv-int',
      requestId: 'r-adv-int',
      publish: () => undefined,
    })

    expect(result.via).toBe('adversarial')
    expect(result.adversarial).toEqual({ rounds: 1, refuted: [] })
    expect(result.findings).toHaveLength(1)
    expect(runDelegatedReviewMock).toHaveBeenCalledTimes(2)
    const channels = runDelegatedReviewMock.mock.calls.map((call: unknown[]) => (call[0] as { channelId?: string }).channelId)
    expect(channels).toEqual(['ch-a', 'ch-b'])
  })

  it('off：现状单委派走真实委派链（端到端），via=delegation 且攻防零进入', async () => {
    delete process.env.BLOMA_ADVERSARIAL_REVIEW
    // 真实单委派链：oneShot query 两行输出（首行被 result_summary 剥离，次行为 JSON）
    const oneShotQuery = (async function* () {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '审查完成' }] } }
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ findings: [{ requirement_id: 'F-001', status: 'implemented', evidence: 'ok' }] }) }] } }
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }) as never

    const result = await runSemanticJudgeReviewFn({
      backplane: { name: '现状项目', requirements: REQUIREMENTS } as unknown as PrdBackplane,
      artifact: '<html><body>x</body></html>',
      query: oneShotQuery,
      env: {},
      sessionId: 's-adv-int2',
      projectId: 'p-adv-int2',
      requestId: 'r-adv-int2',
      publish: () => undefined,
    })

    expect(result.via).toBe('delegation')
    expect(result.adversarial).toBeUndefined()
    expect(result.findings).toHaveLength(1)
    expect(runDelegatedReviewMock).toHaveBeenCalledTimes(0) // 攻防路径零进入（真实链不经 mock）
  })
})
