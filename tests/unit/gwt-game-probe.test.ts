import { afterEach, describe, expect, it } from 'vitest'
import { checkGameMoveEffect, gamePlayerCoordOf, gwtGameProbeEnabled, isMoveEffect } from '../../main/gwt-runner'
import { buildAgentLoopSystemPrompt } from '../../main/coding/programming-orchestrator'
import type { AssertionPlan } from '../../main/behavior-assertions'

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

describe('C4 游戏侧探针（BLOMA_GWT_GAME_PROBE）', () => {
  const previousEnv = process.env.BLOMA_GWT_GAME_PROBE

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.BLOMA_GWT_GAME_PROBE
    else process.env.BLOMA_GWT_GAME_PROBE = previousEnv
  })

  it('开关缺省 off（字节级现状：游戏侧分支不激活）', () => {
    delete process.env.BLOMA_GWT_GAME_PROBE
    expect(gwtGameProbeEnabled()).toBe(false)
    process.env.BLOMA_GWT_GAME_PROBE = '1'
    expect(gwtGameProbeEnabled()).toBe(true)
  })

  it('isMoveEffect：仅 move-* 四类位移效果命中', () => {
    expect(isMoveEffect({ kind: 'move-up', target: 'x' } as unknown as AssertionPlan['effect'])).toBe(true)
    expect(isMoveEffect({ kind: 'show', target: 'x' } as unknown as AssertionPlan['effect'])).toBe(false)
    expect(isMoveEffect(undefined)).toBe(false)
  })

  it('gamePlayerCoordOf：顶层 {x,y} / player 子对象 / 非数字坐标 / 坏 JSON 四态', () => {
    expect(gamePlayerCoordOf('{"x":100,"y":200}')).toEqual({ x: 100, y: 200 })
    expect(gamePlayerCoordOf('{"player":{"x":1.5,"y":2.5},"mode":"playing"}')).toEqual({ x: 1.5, y: 2.5 })
    expect(gamePlayerCoordOf('{"score":0}')).toBeUndefined()
    expect(gamePlayerCoordOf('not-json')).toBeUndefined()
  })

  it('checkGameMoveEffect：按上键 y 减小 → 通过；y 不变 → 失败附坐标前后值', () => {
    const scenario = moveScenario('move-up', 'ArrowUp')
    expect(checkGameMoveEffect(scenario, '{"x":100,"y":200}', '{"x":100,"y":180}')).toBeUndefined()
    const failed = checkGameMoveEffect(scenario, '{"x":100,"y":200}', '{"x":100,"y":200}')
    expect(failed).toContain('玩家坐标 y 200→200（未上移）')
    expect(failed).toContain('__g.state')
  })

  it('checkGameMoveEffect：四方向语义齐全（下=增、右=增、左=减）', () => {
    expect(checkGameMoveEffect(moveScenario('move-down', 'ArrowDown'), '{"x":0,"y":0}', '{"x":0,"y":30}')).toBeUndefined()
    expect(checkGameMoveEffect(moveScenario('move-right', 'ArrowRight'), '{"x":0,"y":0}', '{"x":30,"y":0}')).toBeUndefined()
    expect(checkGameMoveEffect(moveScenario('move-left', 'ArrowLeft'), '{"x":0,"y":0}', '{"x":-30,"y":0}')).toBeUndefined()
  })

  it('checkGameMoveEffect：快照无玩家坐标 → 如实指出契约缺口（不用快照变化兜底防自动 tick 假绿）', () => {
    const failed = checkGameMoveEffect(moveScenario('move-up'), '{"score":10,"frame":1}', '{"score":10,"frame":99}')
    expect(failed).toContain('未暴露玩家坐标')
    expect(failed).toContain('游戏探针通道')
  })
})

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

  it('开关 off：无【游戏探针通道】段（字节级现状）', () => {
    delete process.env.BLOMA_GWT_GAME_PROBE
    expect(buildAgentLoopSystemPrompt(gameBackplane, 'diff')).not.toContain('游戏探针通道')
  })

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
