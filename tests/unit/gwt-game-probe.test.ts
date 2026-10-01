import { afterEach, describe, expect, it } from 'vitest'
import { checkGameMoveEffect, gamePlayerCoordOf, isMoveEffect } from '../../main/verification/gwt-runner'
import { buildAgentLoopSystemPrompt } from '../../main/coding/programming-orchestrator'
import type { AssertionPlan } from '../../main/verification/behavior-assertions'

/**
 * C4（2026-09-11 拍板）：canvas 游戏「按键→位移」断言的游戏侧探针通道——
 * 纯判定函数单测（Playwright 层是薄壳，判定逻辑全在这里）。
 * 审计案 35c1a633：F-002 上下键位移×2 因 canvas 无 DOM 元素结构性不可过。
 */

function moveScenario(kind: string, key = 'ArrowUp'): { plan: AssertionPlan; assertion: string } {
  return {
    plan: {
      trigger: { kind: 'key', key },
      effect: { kind, target: '战机' },
      presenceFallback: false,
    } as unknown as AssertionPlan,
    assertion: '按键后战机位移',
  }
}

describe('C4 prompt 契约注入（game 生成时的【游戏探针通道】段）', () => {
  const previousEnv = process.env.BLOMA_GWT_GAME_PROBE

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.BLOMA_GWT_GAME_PROBE
    else process.env.BLOMA_GWT_GAME_PROBE = previousEnv
  })

  const gameBackplane = {
    project_id: 'p1',
    name: '打飞机',
    positioning: '复古纵版射击',
    requirements: [{ id: 'F-001', description: '操控飞机' }],
    acceptance: {},
    out_of_scope: [],
    assumptions: [],
    gdd: { core_fantasy: '复古街机', pillars: ['爽快'], core_loop: ['躲避', '射击'], numbers: [] },
  } as Parameters<typeof buildAgentLoopSystemPrompt>[0]

  it('开关 on + game 背板（gdd 存在）：注入通道契约（mode/state 义务与自动点开始说明）', () => {
    process.env.BLOMA_GWT_GAME_PROBE = '1'
    const prompt = buildAgentLoopSystemPrompt(gameBackplane, 'diff')
    expect(prompt).toContain('【游戏探针通道】')
    expect(prompt).toContain('__g.mode')
    expect(prompt).toContain('__g.state()')
    expect(prompt).toContain('自动点开始')
  })

  it('开关 on 但非 game 背板（无 gdd）：零注入', () => {
    process.env.BLOMA_GWT_GAME_PROBE = '1'
    const plain = { ...gameBackplane, gdd: undefined } as Parameters<typeof buildAgentLoopSystemPrompt>[0]
    expect(buildAgentLoopSystemPrompt(plain, 'diff')).not.toContain('游戏探针通道')
  })
})
