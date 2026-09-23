import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyNormalization, normalizeRequirementUpdate, recordRequirementNormalization } from '../../main/guide/requirement-normalizer'
import { getAgentSessionPath } from '../../storage/config-paths'
import type { SDKMessage } from '../../shared/types'
import type { SDKQuery, SDKQueryOptions } from '../../main/orchestration/orchestrator'

/**
 * 修改诉求归一化（2026-08-16 复测 43b47a47：口语碎片原样入库污染 PRD 背板）。
 * - revise：修正/细化已有功能项 → 改写原项描述（F-001 主题锚点不可 revise，退化为 append）；
 * - append：全新能力 → 改写后追加；
 * - skip：操作指令（「重新生成」）不入清单；
 * - 一切失败（无 env/LLM/非 JSON/超长/异常）回退改动前现状：原样追加清洗原文。
 */

const ENV = { ANTHROPIC_API_KEY: 'test' } as Record<string, string>

const EXISTING = [
  { id: 'F-001', description: '做一个赛车模拟器' },
  { id: 'F-002', description: '真实模拟' },
  { id: 'F-003', description: '我要的是那种我自己能控制的那种' },
]

function makeQuery(text: string) {
  return async function* (): AsyncGenerator<SDKMessage> {
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
    yield { type: 'result', subtype: 'success' }
  }
}

/** 捕获 query 收到的 options（透传断言用） */
function captureQuery(text: string): { query: SDKQuery; captured: Array<Record<string, unknown>> } {
  const captured: Array<Record<string, unknown>> = []
  const query: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
    captured.push(options as unknown as Record<string, unknown>)
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
    yield { type: 'result', subtype: 'success' }
  }
  return { query, captured }
}

const originalPromaHome = process.env.PROMA_HOME

afterEach(() => {
  restorePromaHome(originalPromaHome)
})

describe('requirement-normalizer', () => {
  it('[S4-REASON-017] thinkingLevel/providerType 透传到 query options（迭代修改门试点）', async () => {
    const { query, captured } = captureQuery('{"action":"skip"}')
    await normalizeRequirementUpdate({
      session_id: 's',
      existing: EXISTING,
      modification: '重新生成',
      query,
      env: ENV,
      thinkingLevel: 'high',
      providerType: 'deepseek',
    })
    expect(captured).toHaveLength(1)
    expect(captured[0].thinkingLevel).toBe('high')
    expect(captured[0].providerType).toBe('deepseek')
  })

  it('[S4-REASON-018] 缺省不传 thinkingLevel → options 不带该字段（零回归契约）', async () => {
    const { query, captured } = captureQuery('{"action":"skip"}')
    await normalizeRequirementUpdate({
      session_id: 's',
      existing: EXISTING,
      modification: '重新生成',
      query,
      env: ENV,
    })
    expect(captured[0].thinkingLevel).toBeUndefined()
    expect(captured[0].providerType).toBeUndefined()
  })

  it('revise：修正类诉求改写目标功能项，不再追加碎片', async () => {
    const decision = await normalizeRequirementUpdate({
      session_id: 's',
      existing: EXISTING,
      modification: '车的运行方向不对',
      query: makeQuery('{"action":"revise","revise_id":"F-003","description":"用户可通过按键控制赛车方向、加速与刹车，行进方向与按键语义一致"}'),
      env: ENV,
    })
    expect(decision).toEqual({
      action: 'revise',
      description: '用户可通过按键控制赛车方向、加速与刹车，行进方向与按键语义一致',
      reviseId: 'F-003',
      via: 'llm',
    })
    const merged = applyNormalization(EXISTING, decision, 'F-004')
    expect(merged).toHaveLength(3) // 修订不扩容
    expect(merged.find((item) => item.id === 'F-003')?.description).toContain('行进方向与按键语义一致')
    expect(merged.find((item) => item.id === 'F-001')?.description).toBe('做一个赛车模拟器')
  })

  it('revise 指向 F-001 主题锚点 → 主题不动，行为修正以追加断言并入 F-001（§5.3 例外规则）', async () => {
    const decision = await normalizeRequirementUpdate({
      session_id: 's',
      existing: EXISTING,
      modification: '车的运行方向不对，按右应该往右走',
      query: makeQuery(
        '{"action":"revise","revise_id":"F-001","description":"做一个赛车模拟器，方向键控制行进方向",'
          + '"behavior_assertions":["按右方向键→车辆 x 坐标增加"],"priority":"P0"}',
      ),
      env: ENV,
    })
    expect(decision.action).toBe('revise')
    expect(decision.reviseId).toBe('F-001')
    const merged = applyNormalization(EXISTING, decision, 'F-004')
    expect(merged).toHaveLength(3) // F-001 例外不扩容
    const anchor = merged.find((item) => item.id === 'F-001')
    // 主题锚点禁重写：description/story 保持原样，不漂移为「卡丁车」之类的新主题
    expect(anchor?.description).toBe('做一个赛车模拟器')
    expect(anchor?.story).toBeUndefined()
    // 行为修正并入：断言追加到 F-001
    expect(anchor?.behavior_assertions).toContain('按右方向键→车辆 x 坐标增加')
  })

  it('revise 指向不存在的 id → 退化为 append', async () => {
    const decision = await normalizeRequirementUpdate({
      session_id: 's',
      existing: EXISTING,
      modification: '加个后视镜',
      query: makeQuery('{"action":"revise","revise_id":"F-009","description":"显示后视镜视野"}'),
      env: ENV,
    })
    expect(decision.action).toBe('append')
  })

  it('skip：操作指令（「重新生成」）不入清单，清单原样', async () => {
    const decision = await normalizeRequirementUpdate({
      session_id: 's',
      existing: EXISTING,
      modification: '重新生成',
      query: makeQuery('{"action":"skip","reason":"操作指令"}'),
      env: ENV,
    })
    expect(decision).toEqual({ action: 'skip', description: '', via: 'llm' })
    expect(applyNormalization(EXISTING, decision, 'F-004')).toBe(EXISTING)
  })

  it('无 env（渠道不可用）→ 回退原样追加，不发起 LLM 调用', async () => {
    let called = 0
    const query = async function* (): AsyncGenerator<SDKMessage> {
      called += 1
      yield { type: 'result', subtype: 'success' }
    }
    const decision = await normalizeRequirementUpdate({
      session_id: 's',
      existing: EXISTING,
      modification: '车的运行方向不对',
      query,
      env: undefined,
    })
    expect(decision).toEqual({ action: 'append', description: '车的运行方向不对', via: 'fallback' })
    expect(called).toBe(0)
  })

  it('非 JSON 输出（闲聊/HTML）→ 回退原样追加', async () => {
    const decision = await normalizeRequirementUpdate({
      session_id: 's',
      existing: EXISTING,
      modification: '车的运行方向不对',
      query: makeQuery('<!doctype html><html><body>hi</body></html>'),
      env: ENV,
    })
    expect(decision.via).toBe('fallback')
    expect(decision.description).toBe('车的运行方向不对')
  })

  it('带 markdown 围栏的 JSON 正常解析；description 超长（>300）回退', async () => {
    const fenced = await normalizeRequirementUpdate({
      session_id: 's',
      existing: EXISTING,
      modification: '加历史记录',
      query: makeQuery('```json\n{"action":"append","description":"提供历史记录列表"}\n```'),
      env: ENV,
    })
    expect(fenced).toEqual({ action: 'append', description: '提供历史记录列表', via: 'llm' })

    const tooLong = await normalizeRequirementUpdate({
      session_id: 's',
      existing: EXISTING,
      modification: '加历史记录',
      query: makeQuery(`{"action":"append","description":"${'长'.repeat(301)}"}`),
      env: ENV,
    })
    expect(tooLong.via).toBe('fallback')
  })

  it('query 抛错 → 回退原样追加（归一化绝不阻断生成链路）', async () => {
    const decision = await normalizeRequirementUpdate({
      session_id: 's',
      existing: EXISTING,
      modification: '车的运行方向不对',
      query: async function* (): AsyncGenerator<SDKMessage> {
        throw new Error('channel down')
        yield { type: 'result', subtype: 'success' } as SDKMessage
      },
      env: ENV,
    })
    expect(decision).toEqual({ action: 'append', description: '车的运行方向不对', via: 'fallback' })
  })

  it('recordRequirementNormalization 落 [decision] requirement_normalized 行到会话 JSONL', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-reqnorm-'))
    process.env.PROMA_HOME = home
    recordRequirementNormalization(
      { project_id: 'project-x', session_id: 'session-x' },
      'iteration',
      '车的运行方向不对',
      { action: 'revise', description: '行进方向与按键语义一致', reviseId: 'F-003', via: 'llm' },
    )
    const path = getAgentSessionPath('session-x')
    expect(existsSync(path)).toBe(true)
    // JSONL 行是 JSON-in-JSON（decision 文本经转义），先解析行再断言解码后文本
    const decisionText = readDecisionText(path)
    expect(decisionText).toContain('[decision]')
    expect(decisionText).toContain('"type":"requirement_normalized"')
    expect(decisionText).toContain('F-003')
  })

  it('out_of_scope：范围声明（「不要排行榜」）不入功能项，决策携带范围文本', async () => {
    const decision = await normalizeRequirementUpdate({
      session_id: 's',
      existing: EXISTING,
      modification: '不要排行榜',
      query: makeQuery('{"action":"out_of_scope","description":"不做排行榜功能"}'),
      env: ENV,
    })
    expect(decision).toEqual({ action: 'out_of_scope', description: '不做排行榜功能', outOfScope: '不做排行榜功能', via: 'llm' })
    // 清单原样（范围声明由调用方持久化到 scope_exclusions）
    expect(applyNormalization(EXISTING, decision, 'F-004')).toBe(EXISTING)
  })

  it('out_of_scope 缺范围文本 → 保守退化为 skip（宁可不入库，不错误排除）', async () => {
    const decision = await normalizeRequirementUpdate({
      session_id: 's',
      existing: EXISTING,
      modification: '不要',
      query: makeQuery('{"action":"out_of_scope"}'),
      env: ENV,
    })
    expect(decision.action).toBe('skip')
  })

  it('故事化产出 JSON 契约（§5.2）：story + behavior_assertions + priority + assumptions', async () => {
    const decision = await normalizeRequirementUpdate({
      session_id: 's',
      existing: EXISTING,
      modification: '让车能跟随方向键移动，别只变文字',
      query: makeQuery(
        '{"action":"revise","revise_id":"F-003",'
          + '"story":"作为玩家，我想让赛车随方向键左右移动，以便获得驾驶操控感",'
          + '"description":"赛车随方向键左右移动",'
          + '"behavior_assertions":["按右方向键→车辆 x 坐标增加","按左方向键→车辆 x 坐标减小"],'
          + '"priority":"P0",'
          + '"assumptions":["按空格键→车辆速度归零（常识补全默认）"]}',
      ),
      env: ENV,
    })
    expect(decision.action).toBe('revise')
    expect(decision.story).toBe('作为玩家，我想让赛车随方向键左右移动，以便获得驾驶操控感')
    expect(decision.behavior_assertions).toEqual(['按右方向键→车辆 x 坐标增加', '按左方向键→车辆 x 坐标减小'])
    expect(decision.priority).toBe('P0')
    expect(decision.assumptions).toEqual(['按空格键→车辆速度归零（常识补全默认）'])
    // applyNormalization：非 F-001 revise 重写 story + 追加断言（已有断言保序在前）
    const merged = applyNormalization(EXISTING, decision, 'F-004')
    const target = merged.find((item) => item.id === 'F-003')
    expect(target?.story).toContain('作为玩家')
    expect(target?.behavior_assertions?.slice(-2)).toEqual(['按右方向键→车辆 x 坐标增加', '按左方向键→车辆 x 坐标减小'])
    expect(target?.priority).toBe('P0')
  })

  it('append 携带 story/断言/优先级时物化进新功能项（source 标注入库点）', () => {
    const merged = applyNormalization(
      EXISTING,
      {
        action: 'append',
        description: '提供历史记录列表',
        story: '作为用户，我想查看历史记录，以便回顾之前的操作',
        behavior_assertions: ['完成一次操作→历史列表新增一条记录'],
        priority: 'P1',
        via: 'llm',
      },
      'F-004',
      'iteration',
    )
    const appended = merged.find((item) => item.id === 'F-004')
    expect(appended).toEqual({
      id: 'F-004',
      description: '提供历史记录列表',
      story: '作为用户，我想查看历史记录，以便回顾之前的操作',
      behavior_assertions: ['完成一次操作→历史列表新增一条记录'],
      priority: 'P1',
      source: 'iteration',
    })
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
