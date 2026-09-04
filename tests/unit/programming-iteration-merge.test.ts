import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeIterationRequirements } from '../../main/programming-orchestrator'
import { getAgentSessionPath } from '../../storage/config-paths'
import type { SDKMessage } from '../../shared/types'

vi.mock('../../main/channel-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/channel-manager')>()
  return {
    ...actual,
    getChannelByIdRaw: () => ({
      id: 'test-channel',
      name: 'Test',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'encrypted-test-key',
      models: [{ id: 'claude-sonnet-4-6', name: 'Claude', enabled: true }],
      enabled: true,
    }),
    decryptApiKey: () => 'test-key-from-channel',
    getFirstEnabledChannel: () => undefined,
  }
})

/**
 * runIterationTask 的修改诉求归一化入库（2026-08-16 复测 43b47a47：口语碎片原样
 * 追加污染 PRD——「重新生成」长成产品按钮、「车的运行方向不对」只能生成最小满足版）。
 * 归一化失败/无渠道回退改动前现状（原样追加），绝不阻断迭代。
 */

const EXISTING = [
  { id: 'F-001', description: '做一个赛车模拟器' },
  { id: 'F-003', description: '我要的是那种我自己能控制的那种' },
]

// channel_id 不设默认值：显式传 undefined 会触发默认参数，「无渠道」用例进不了 fallback 分支
function makeInput(query: unknown, channel_id?: string) {
  return {
    request_id: 'req-merge',
    session_id: 'session-merge',
    project_id: 'project-merge',
    mode: 'quick' as const,
    prompt: '车的运行方向不对',
    channel_id,
    query: query as never,
  }
}

function makeQuery(text: string) {
  return async function* (): AsyncGenerator<SDKMessage> {
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
    yield { type: 'result', subtype: 'success' }
  }
}

describe('mergeIterationRequirements（迭代修改诉求归一化入库）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  it('修正类诉求 revise 已有功能项，决策落 requirement_normalized；focus=目标项 id（P3 分级锚定）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-iter-merge-'))
    process.env.PROMA_HOME = home
    const merged = await mergeIterationRequirements(
      makeInput(makeQuery('{"action":"revise","revise_id":"F-003","description":"行进方向与按键语义一致：左转左行、右转右行"}'), 'test-channel'),
      EXISTING,
    )
    expect(merged.requirements).toHaveLength(2)
    expect(merged.requirements.find((item) => item.id === 'F-003')?.description).toBe('行进方向与按键语义一致：左转左行、右转右行')
    expect(merged.requirements.find((item) => item.id === 'F-001')?.description).toBe('做一个赛车模拟器')
    // P3 分级锚定：revise 焦点=reviseId（目标项存在）
    expect(merged.focusRequirementIds).toEqual(['F-003'])
    // JSONL 行是 JSON-in-JSON（decision 文本经转义），先解析行再断言解码后文本
    const decisionText = readDecisionText(getAgentSessionPath('session-merge'))
    expect(decisionText).toContain('"type":"requirement_normalized"')
  })

  it('P3：append 焦点=新项 id；raw 回退焦点=原样追加的新项 id；skip/out_of_scope 无焦点（全量锚定）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-iter-focus-'))
    process.env.PROMA_HOME = home
    const appended = await mergeIterationRequirements(
      makeInput(makeQuery('{"action":"append","description":"查看历史记录","story":"作为用户我想查看历史"}'), 'test-channel'),
      EXISTING,
    )
    expect(appended.action).toBe('append')
    expect(appended.focusRequirementIds).toEqual(['F-004'])

    const skipped = await mergeIterationRequirements(
      makeInput(makeQuery('{"action":"skip","reason":"操作指令"}'), 'test-channel'),
      EXISTING,
    )
    expect(skipped.action).toBe('skip')
    expect(skipped.focusRequirementIds).toBeUndefined()

    // out_of_scope 会真实写 project.scope_exclusions：需要真项目（字面 id 会让
    // addScopeExclusion 抛错回退 raw——那是既有回退语义，非本用例目标）
    const { createProject } = await import('../../main/project-service')
    const realProject = createProject({ request_id: 'req-focus-scope', mode: 'quick' })
    const outOfScope = await mergeIterationRequirements(
      {
        ...makeInput(makeQuery('{"action":"out_of_scope","description":"不做排行榜"}'), 'test-channel'),
        project_id: realProject.project_id,
      },
      EXISTING,
    )
    expect(outOfScope.action).toBe('out_of_scope')
    expect(outOfScope.focusRequirementIds).toBeUndefined()

    // raw 回退（无渠道）：原样追加，焦点=新项 id（append 必入 focus，硬约束 D3 连锁）
    const raw = await mergeIterationRequirements(makeInput(undefined), EXISTING)
    expect(raw.action).toBe('raw')
    expect(raw.focusRequirementIds).toEqual(['F-004'])
  })

  it('操作指令（「重新生成」）skip：清单原样，按原需求重生成', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-iter-skip-'))
    process.env.PROMA_HOME = home
    const merged = await mergeIterationRequirements(
      makeInput(makeQuery('{"action":"skip","reason":"操作指令"}'), 'test-channel'),
      EXISTING,
    )
    expect(merged.requirements).toEqual(EXISTING)
    expect(merged.action).toBe('skip')
  })

  it('无渠道（无 channel_id 且无可用渠道）→ 回退原样追加', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-iter-fallback-'))
    process.env.PROMA_HOME = home
    const merged = await mergeIterationRequirements(makeInput(makeQuery('{"action":"skip"}'), undefined), EXISTING)
    expect(merged.requirements).toHaveLength(3)
    expect(merged.requirements[2]).toEqual({ id: 'F-004', description: '车的运行方向不对' })
  })

  it('归一化输出非 JSON → 回退原样追加（改动前现状）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-iter-garbage-'))
    process.env.PROMA_HOME = home
    const merged = await mergeIterationRequirements(makeInput(makeQuery('好的，我来帮您整理'), 'test-channel'), EXISTING)
    // 回退原样追加（description=清洗原文），读取侧 helper 兜底默认断言/P2；source 标注入库点
    expect(merged.requirements[2]).toEqual({ id: 'F-004', description: '车的运行方向不对', source: 'iteration' })
  })

  it('query 缺失（无模型句柄）→ 回退原样追加', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-iter-noquery-'))
    process.env.PROMA_HOME = home
    const merged = await mergeIterationRequirements(makeInput(undefined, 'test-channel'), EXISTING)
    expect(merged.requirements[2]).toEqual({ id: 'F-004', description: '车的运行方向不对' })
  })
})

/** 读取会话 JSONL 中第一条 [decision] 行的解码文本（决策内容以 JSON 转义嵌入 text 字段）。 */
function readDecisionText(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as { content?: Array<{ text?: string }> }
      } catch {
        return null
      }
    })
    .filter((message): message is { content: Array<{ text?: string }> } => message !== null)
    .map((message) => message.content?.[0]?.text ?? '')
    .find((text) => text.startsWith('[decision]')) ?? ''
}
