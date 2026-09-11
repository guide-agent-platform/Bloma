import { afterEach, describe, expect, it } from 'vitest'
import { generateAgentIdeas, researchModeResolver } from '../../main/guide/guide-agent-service'
import type { SDKMessage } from '../../shared/types'
import type { SDKQuery } from '../../main/orchestrator'

/**
 * R2（2026-09-12 用户拍板「cut 掉网络搜索环节，只由 agent 提创造性建议」）：
 * - 模式矩阵：BLOMA_RESEARCH_MODE 缺省 agent（纯模型灵感，零网络请求）；
 *   'scrape'/'search'/'1'/'on' 回到现状市调链路（逃生口）；
 * - generateAgentIdeas：LLM 输出 JSON → 清洗 + source='AI 建议'；垃圾/失败/空需求 → []；
 * - 需求确认/PRD 确认两卡的 ideas_mode 随卡透出（渲染端头标「AI 灵感建议」如实标注）。
 */

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const original = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    fn()
  } finally {
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
}

describe('researchModeResolver — 模式矩阵（缺省 agent）', () => {
  it('未设=agent；agent/off/false=agent；scrape/search/1/on=scrape', () => {
    withEnv('BLOMA_RESEARCH_MODE', undefined, () => expect(researchModeResolver()).toBe('agent'))
    withEnv('BLOMA_RESEARCH_MODE', 'agent', () => expect(researchModeResolver()).toBe('agent'))
    withEnv('BLOMA_RESEARCH_MODE', 'scrape', () => expect(researchModeResolver()).toBe('scrape'))
    withEnv('BLOMA_RESEARCH_MODE', 'search', () => expect(researchModeResolver()).toBe('scrape'))
    withEnv('BLOMA_RESEARCH_MODE', '1', () => expect(researchModeResolver()).toBe('scrape'))
    withEnv('BLOMA_RESEARCH_MODE', 'on', () => expect(researchModeResolver()).toBe('scrape'))
  })
})

function fakeMsg(text: string): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } } as unknown as SDKMessage
}

function scriptedQuery(responses: string[]): SDKQuery {
  let call = 0
  return async function* () {
    const text = responses[Math.min(call, responses.length - 1)] ?? ''
    call += 1
    yield fakeMsg(text)
  }
}

describe('generateAgentIdeas — agent 灵感建议', () => {
  afterEach(() => {
    delete process.env.BLOMA_RESEARCH_MODE
  })

  it('LLM 输出 JSON：清洗（label≤20/note≤40）+ source 固定 AI 建议', async () => {
    const ideas = await generateAgentIdeas('做一个纵版打飞机', {
      query: scriptedQuery([JSON.stringify({
        ideas: [
          { label: 'Boss 血量阶段化弹幕', note: '血量低于阈值弹幕更密，制造终局张力（参考怒首领蜂）' },
          { label: '擦弹得分机制', note: '贴弹幕边缘存活奖励分数，鼓励冒险走位'.repeat(3) },
        ],
      })]),
    })
    expect(ideas).toHaveLength(2)
    expect(ideas[0].label).toBe('Boss 血量阶段化弹幕')
    expect(ideas[0].source).toBe('AI 建议')
    expect(ideas[1].note.length).toBeLessThanOrEqual(40)
  })

  it('垃圾文本/非 JSON/空 ideas 数组 → []（想法区隐藏，弹窗照常）', async () => {
    for (const junk of ['随便聊聊', '{"ideas": []}', '前置说明 {"ideas": [{"label": ""}]} 后缀']) {
      const ideas = await generateAgentIdeas('做一个纵版打飞机', { query: scriptedQuery([junk]) })
      expect(ideas).toEqual([])
    }
  })

  it('空需求 → 直接 []（不发 LLM）；LLM 抛错 → []（不阻断）', async () => {
    expect(await generateAgentIdeas('   ', { query: scriptedQuery(['{}']) })).toEqual([])
    const boom: SDKQuery = () => {
      throw new Error('LLM_FAILED')
    }
    expect(await generateAgentIdeas('做一个纵版打飞机', { query: boom })).toEqual([])
  })

  it('超量截断至 5 条（与市调提炼同口径）', async () => {
    const ideas = await generateAgentIdeas('做一个纵版打飞机', {
      query: scriptedQuery([JSON.stringify({
        ideas: Array.from({ length: 8 }, (_, i) => ({ label: `灵感${i + 1}号设计点`, note: '说明' })),
      })]),
    })
    expect(ideas).toHaveLength(5)
  })
})
