import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ITERATION_MODE_SECTION,
  buildIterationTask,
  iterationBriefEnabled,
  resolveAgentLoopMaxTurnsLocal,
} from '../../../main/coding/iteration-brief'
import { iterationBriefActive, resolveLoopMaxTurnsForInput } from '../../../main/coding/programming-orchestrator'
import { generateLoopPlan } from '../../../main/agent/loop/loop-planner'
import type { PrdBackplane } from '../../../main/model/prd-backplane'
import type { SDKMessage } from '../../../shared/types'
import type { SDKQuery, SDKQueryOptions } from '../../../main/orchestration/orchestrator'

/**
 * Phase 8 W1/W2（2026-09-11 狗粮 94f449c6 复盘「照搬正常 agent 工作模式」）：
 * 局部修改轮聚焦任务书。关键锁定：
 * - 开关矩阵：BLOMA_ITER_BRIEF 缺省 on / '0' 强制关 / '1' 强制开；
 * - maxTurns local 档：缺省 12 / BLOMA_LOOP_MAX_TURNS_LOCAL 覆盖 / 非法值回退；
 * - 任务书五要素：诉求原话 / grep-first / 先复现 / 最小变更 / 聚焦完成判据；
 * - 路由：localOnly+开 → local 档；开关关或 rebuild 或非 localOnly → 字节级=现状档；
 * - plan 腿定位合同：localOnly prompt 换定位口径 + 既有文件硬过滤（不存在即剔除，
 *   全不存在 → null fail-open）。
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

describe('iterationBriefEnabled — 开关矩阵（缺省 on，0 逃生口）', () => {
  it('未设=on；1/on/true=on；0/off/false=off', () => {
    withEnv('BLOMA_ITER_BRIEF', undefined, () => expect(iterationBriefEnabled()).toBe(true))
    withEnv('BLOMA_ITER_BRIEF', '1', () => expect(iterationBriefEnabled()).toBe(true))
    withEnv('BLOMA_ITER_BRIEF', 'on', () => expect(iterationBriefEnabled()).toBe(true))
    withEnv('BLOMA_ITER_BRIEF', 'true', () => expect(iterationBriefEnabled()).toBe(true))
    withEnv('BLOMA_ITER_BRIEF', '0', () => expect(iterationBriefEnabled()).toBe(false))
    withEnv('BLOMA_ITER_BRIEF', 'off', () => expect(iterationBriefEnabled()).toBe(false))
    withEnv('BLOMA_ITER_BRIEF', 'false', () => expect(iterationBriefEnabled()).toBe(false))
  })
})

describe('resolveAgentLoopMaxTurnsLocal — local 档轮次预算', () => {
  it('未设=12；合法 env 覆盖；非法值回退缺省（对齐 resolveAgentLoopMaxTurns 口径）', () => {
    withEnv('BLOMA_LOOP_MAX_TURNS_LOCAL', undefined, () => expect(resolveAgentLoopMaxTurnsLocal()).toBe(12))
    withEnv('BLOMA_LOOP_MAX_TURNS_LOCAL', '8', () => expect(resolveAgentLoopMaxTurnsLocal()).toBe(8))
    withEnv('BLOMA_LOOP_MAX_TURNS_LOCAL', '0', () => expect(resolveAgentLoopMaxTurnsLocal()).toBe(12))
    withEnv('BLOMA_LOOP_MAX_TURNS_LOCAL', 'abc', () => expect(resolveAgentLoopMaxTurnsLocal()).toBe(12))
    withEnv('BLOMA_LOOP_MAX_TURNS_LOCAL', '0.5', () => expect(resolveAgentLoopMaxTurnsLocal()).toBe(12))
  })
})

describe('buildIterationTask — 聚焦任务书五要素', () => {
  const task = buildIterationTask('开始页面在开始游戏后不会消失')

  it('用户诉求原话即任务主体（不再还原成全量 MVP 任务书）', () => {
    expect(task).toContain('【本轮任务】开始页面在开始游戏后不会消失')
    expect(task).toContain('只改这一处，其余保持现状')
    expect(task).not.toContain('可运行 MVP')
    expect(task).not.toContain('逐功能项实现')
  })

  it('工作方式：grep-first 定位 + 禁止全项目通读', () => {
    expect(task).toContain('grep')
    expect(task).toContain('禁止全项目通读')
  })

  it('工作方式：先复现后修（无法复现如实停止不盲改）', () => {
    expect(task).toContain('先复现')
    expect(task).toContain('无法复现时如实说明并停止')
  })

  it('最小变更：只改与诉求直接相关的文件', () => {
    expect(task).toContain('最小变更')
    expect(task).toContain('其余文件保持现状勿重写')
  })

  it('聚焦完成判据：断言通过 + 无高危 + 总结说明改动', () => {
    expect(task).toContain('run_gwt_tests 通过')
    expect(task).toContain('run_security_scan 无高危')
    expect(task).toContain('改了哪些文件')
  })
})

describe('ITERATION_MODE_SECTION — 【修改模式】段（对齐修复轮语义）', () => {
  it('任务书即全部工作 + 不要重新生成整个项目 + 不改无关文件', () => {
    expect(ITERATION_MODE_SECTION).toContain('【修改模式】')
    expect(ITERATION_MODE_SECTION).toContain('本轮全部工作')
    expect(ITERATION_MODE_SECTION).toContain('不要重新生成整个项目')
    expect(ITERATION_MODE_SECTION).toContain('与诉求无关')
  })
})

describe('resolveLoopMaxTurnsForInput / iterationBriefActive — 路由（off=字节级现状）', () => {
  it('localOnly + 开关开 → local 档；rebuild 优先级更高（全量锚定语义）', () => {
    withEnv('BLOMA_ITER_BRIEF', undefined, () => {
      expect(resolveLoopMaxTurnsForInput({ mode: 'longterm', localOnly: true })).toBe(resolveAgentLoopMaxTurnsLocal())
      expect(resolveLoopMaxTurnsForInput({ mode: 'longterm', localOnly: true, rebuild: true })).toBe(40)
      expect(resolveLoopMaxTurnsForInput({ mode: 'quick', localOnly: true })).toBe(resolveAgentLoopMaxTurnsLocal())
    })
  })

  it('开关关 → 一律现状档（localOnly 也回全量，字节级=现状）', () => {
    withEnv('BLOMA_ITER_BRIEF', '0', () => {
      expect(resolveLoopMaxTurnsForInput({ mode: 'longterm', localOnly: true })).toBe(40)
      expect(iterationBriefActive({ localOnly: true })).toBe(false)
    })
  })

  it('非 localOnly / 未传 → 现状档与 inactive', () => {
    withEnv('BLOMA_ITER_BRIEF', undefined, () => {
      expect(resolveLoopMaxTurnsForInput({ mode: 'longterm' })).toBe(40)
      expect(resolveLoopMaxTurnsForInput({ mode: 'quick' })).toBe(24)
      expect(iterationBriefActive({})).toBe(false)
      expect(iterationBriefActive({ localOnly: true })).toBe(true)
      expect(iterationBriefActive({ localOnly: true, rebuild: true })).toBe(false)
    })
  })
})

describe('generateLoopPlan localOnly — 定位合同（W2-3）', () => {
  const backplane: PrdBackplane = {
    project_id: 'p1',
    name: '纵版雷霆战机',
    positioning: '纵版无尽刷分射击',
    requirements: [
      { id: 'F-001', description: '核心玩法', behavior_assertions: ['点击开始游戏按钮→开始页面消失'], priority: 'P0' },
    ],
    acceptance: {},
    out_of_scope: [],
    assumptions: [],
  }

  function fakeMsg(text: string): SDKMessage {
    return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } } as unknown as SDKMessage
  }

  function scriptedQuery(responses: string[]): { query: SDKQuery; prompts: string[]; systems: string[] } {
    const prompts: string[] = []
    const systems: string[] = []
    const query: SDKQuery = (prompt, options: SDKQueryOptions) => {
      prompts.push(prompt)
      const sys = options.history?.[0]?.content
      systems.push(typeof sys === 'string' ? sys : Array.isArray(sys) ? sys.map((c) => ('text' in c ? c.text : '')).join('\n') : '')
      const text = responses.shift() ?? ''
      return (async function* (): AsyncGenerator<SDKMessage> {
        yield fakeMsg(text)
      })()
    }
    return { query, prompts, systems }
  }

  const planJson = (files: Array<{ path: string; reason: string }>) =>
    JSON.stringify({ filesToTouch: files, reuse: [], verification: ['F-001 点击开始游戏按钮→开始页面消失'], risks: [], involvedRequirementIds: ['F-001'] })

  it('prompt 换定位口径：诉求原话 + 只改既有文件 + 禁止新建；system 段同步', async () => {
    const { query, prompts, systems } = scriptedQuery([planJson([{ path: 'src/app.js', reason: 'overlay 隐藏逻辑' }])])
    const plan = await generateLoopPlan({
      mode: 'longterm', backplane, skeletonMap: null, query, env: {}, sessionId: 's1',
      localOnly: true, localPrompt: '开始页面在开始游戏后不会消失',
    })
    expect(plan?.filesToTouch).toHaveLength(1)
    expect(prompts[0]).toContain('开始页面在开始游戏后不会消失')
    expect(prompts[0]).toContain('局部优化')
    expect(prompts[0]).toContain('禁止新建文件')
    expect(prompts[0]).not.toContain('功能项清单（id/优先级/描述/行为断言）')
    expect(systems[0]).toContain('禁止规划新建文件')
  })

  it('既有文件硬过滤：模型给出不存在的文件剔除；全不存在 → null（fail-open）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bloma-plan-local-'))
    try {
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'app.js'), '// stub', 'utf8')
      // 只有 src/app.js 存在（相对路径含子目录，mkdir 不存在 → existsSync false）
      const { query } = scriptedQuery([planJson([
        { path: 'src/app.js', reason: '存在' },
        { path: 'src/game-core.js', reason: '不存在（昨晚误导合同的翻版）' },
      ])])
      const plan = await generateLoopPlan({
        mode: 'longterm', backplane, skeletonMap: null, query, env: {}, sessionId: 's1',
        localOnly: true, localPrompt: 'x', projectRootPath: dir,
      })
      expect(plan?.filesToTouch).toHaveLength(1)
      expect(plan?.filesToTouch[0].path).toBe('src/app.js')

      const { query: q2 } = scriptedQuery([planJson([{ path: 'src/ghost.js', reason: '不存在' }])])
      const none = await generateLoopPlan({
        mode: 'longterm', backplane, skeletonMap: null, query: q2, env: {}, sessionId: 's1',
        localOnly: true, localPrompt: 'x', projectRootPath: dir,
      })
      expect(none).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非 localOnly：prompt 与过滤均现状（不携带定位口径）', async () => {
    const { query, prompts } = scriptedQuery([planJson([{ path: 'src/new-file.js', reason: '新建合法' }])])
    const plan = await generateLoopPlan({ mode: 'longterm', backplane, skeletonMap: null, query, env: {}, sessionId: 's1' })
    expect(plan?.filesToTouch).toHaveLength(1)
    expect(prompts[0]).not.toContain('禁止新建文件')
    expect(prompts[0]).toContain('功能项清单')
  })
})

describe('局部修改轮聚焦任务书 — 开关缺省 on 声明（Phase 8 拍板）', () => {
  it('与修复轮/骨架渲染开关（缺省 off）不同：本开关是纯任务书表达层，缺省 on，逃生口 BLOMA_ITER_BRIEF=0', () => {
    withEnv('BLOMA_ITER_BRIEF', undefined, () => {
      expect(iterationBriefEnabled()).toBe(true)
    })
  })
})

afterEach(() => {
  // 环境变量恢复由 withEnv 就地保证；此处兜底清理防泄漏
  delete process.env.BLOMA_ITER_BRIEF
  delete process.env.BLOMA_LOOP_MAX_TURNS_LOCAL
})
