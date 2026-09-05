import { afterEach, describe, expect, it } from 'vitest'
import type { PrdBackplane } from '../../../main/model/prd-backplane'
import type { SDKMessage } from '../../../shared/types'
import type { SDKQuery, SDKQueryOptions } from '../../../main/orchestrator'
import {
  PLAN_ATTEMPTS,
  PLAN_FILES_LIMIT,
  PLAN_MAX_TOKENS,
  PLAN_TEMPERATURE,
  generateLoopPlan,
  normalizePlanPath,
  parseLoopPlan,
  planLegEnabled,
  renderPlanInjection,
  renderPlanMarkdown,
  validateLoopPlan,
} from '../../../main/coding/loop-planner'

/**
 * P3 任务级三文档契约 · PR-A：plan 腿纯函数地基。
 * 关键锁定（实施稿 §6 PR-A 测试清单）：
 * - 路径安全：`..`、绝对路径、盘符拒绝（硬约束 11）；
 * - 数量上限（quick 12 / longterm 20）与空 filesToTouch 拒绝；
 * - unknown 键忽略 + 去重；
 * - generateLoopPlan 调用参数（attempts 2 / temp 0.2 / maxTokens 4096 / thinking off）；
 * - 开关矩阵：quick 缺省 off / longterm 缺省 on / BLOMA_PLAN_LEG 覆盖。
 */

function planJson(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    filesToTouch: [
      { path: 'index.html', reason: '入口与布局' },
      { path: 'src/app.js', reason: '交互逻辑主体' },
    ],
    reuse: [{ from: 'src/styles.css（骨架）', how: '样式直接扩展不重写' }],
    verification: ['F-001 按右方向键→车辆 x 坐标增加'],
    risks: ['方向键断言依赖焦点管理'],
    involvedRequirementIds: ['F-001', 'F-002'],
    unknownExtra: { junk: true },
    ...overrides,
  })
}

describe('normalizePlanPath — 路径安全（硬约束 11）', () => {
  it('合法相对路径原样通过；反斜杠归一为 /', () => {
    expect(normalizePlanPath('index.html')).toBe('index.html')
    expect(normalizePlanPath(' src\\app.js ')).toBe('src/app.js')
    expect(normalizePlanPath('src/examples/data-module.js')).toBe('src/examples/data-module.js')
  })

  it('拒绝 ..（全形态）、绝对路径、盘符、家目录与 URL', () => {
    for (const bad of ['..', '../x', 'a/../b', 'a/..', '..\\x', '/etc/passwd', '\\\\server\\share', 'C:\\x', 'c:/x', '~/x', 'http://evil']) {
      expect(normalizePlanPath(bad)).toBeNull()
    }
  })

  it('空串/纯空白拒绝', () => {
    expect(normalizePlanPath('')).toBeNull()
    expect(normalizePlanPath('   ')).toBeNull()
  })
})

describe('validateLoopPlan — 守卫校验', () => {
  it('合法对象通过：unknown 键忽略（involvedRequirementIds 保留）', () => {
    const plan = validateLoopPlan(JSON.parse(planJson()))
    expect(plan).toBeDefined()
    expect(plan?.filesToTouch).toHaveLength(2)
    expect(plan?.filesToTouch[0]).toEqual({ path: 'index.html', reason: '入口与布局' })
    expect(plan?.reuse).toHaveLength(1)
    expect(plan?.verification).toEqual(['F-001 按右方向键→车辆 x 坐标增加'])
    expect(plan?.involvedRequirementIds).toEqual(['F-001', 'F-002'])
    expect(plan && 'unknownExtra' in plan).toBe(false)
  })

  it('空/缺失 filesToTouch 拒绝；超数量上限拒绝', () => {
    expect(validateLoopPlan({ filesToTouch: [] })).toBeUndefined()
    expect(validateLoopPlan({ reuse: [] })).toBeUndefined()
    const tooMany = { filesToTouch: Array.from({ length: 13 }, (_, i) => ({ path: `f${i}.js`, reason: 'r' })) }
    expect(validateLoopPlan(tooMany, { maxFiles: 12 })).toBeUndefined()
    expect(validateLoopPlan(tooMany, { maxFiles: 20 })).toBeDefined()
    expect(validateLoopPlan({ filesToTouch: Array.from({ length: PLAN_FILES_LIMIT.longterm + 1 }, (_, i) => ({ path: `f${i}.js`, reason: 'r' })) })).toBeUndefined()
  })

  it('危险路径整体拒绝（不静默剔除，防部分采纳危险合同）', () => {
    for (const bad of [{ path: '../escape.js', reason: 'x' }, { path: 'C:/evil.js', reason: 'x' }, { path: '/abs.js', reason: 'x' }]) {
      expect(validateLoopPlan({ filesToTouch: [{ path: 'index.html', reason: 'ok' }, bad] })).toBeUndefined()
    }
  })

  it('重复路径去重（首见保留）；path 非字符串拒绝', () => {
    const plan = validateLoopPlan({
      filesToTouch: [
        { path: 'src/app.js', reason: 'first' },
        { path: 'src\\app.js', reason: 'dup-normalized' },
      ],
    })
    expect(plan?.filesToTouch).toHaveLength(1)
    expect(plan?.filesToTouch[0].reason).toBe('first')
    expect(validateLoopPlan({ filesToTouch: [{ path: 42, reason: 'x' }] })).toBeUndefined()
  })

  it('reuse/verification/risks 缺失或非数组时兜底为空/过滤，不拒收（只有 filesToTouch 是硬守卫）', () => {
    const plan = validateLoopPlan({ filesToTouch: [{ path: 'index.html', reason: 'r' }] })
    expect(plan).toEqual({ filesToTouch: [{ path: 'index.html', reason: 'r' }], reuse: [], verification: [], risks: [] })
    const filtered = validateLoopPlan({
      filesToTouch: [{ path: 'index.html', reason: 'r' }],
      verification: ['ok', '', 42, null],
      risks: 'not-array',
    })
    expect(filtered?.verification).toEqual(['ok'])
    expect(filtered?.risks).toEqual([])
  })

  it('非对象输入拒绝', () => {
    expect(validateLoopPlan(null)).toBeUndefined()
    expect(validateLoopPlan('x')).toBeUndefined()
    expect(validateLoopPlan([1, 2])).toBeUndefined()
  })
})

describe('parseLoopPlan — 模型输出解析', () => {
  it('裸 JSON 与 markdown 围栏均解析；垃圾文本返回 undefined', () => {
    expect(parseLoopPlan(planJson())?.filesToTouch).toHaveLength(2)
    expect(parseLoopPlan('```json\n' + planJson() + '\n```')?.filesToTouch).toHaveLength(2)
    expect(parseLoopPlan('我觉得应该……')).toBeUndefined()
    expect(parseLoopPlan('{"filesToTouch": []}')).toBeUndefined()
  })
})

describe('renderPlanMarkdown / renderPlanInjection — 双格式渲染', () => {
  const plan = parseLoopPlan(planJson())!

  it('plan.md：标题/参考合同声明/目标文件/复用/验证/风险/涉及功能项齐全', () => {
    const md = renderPlanMarkdown(plan)
    expect(md).toContain('# 技术合同（plan 腿）')
    expect(md).toContain('参考合同')
    expect(md).toContain('## 目标文件（filesToTouch）')
    expect(md).toContain('- `index.html`：入口与布局')
    expect(md).toContain('src/styles.css（骨架）')
    expect(md).toContain('## 验证口径（verification，对齐 P0 断言）')
    expect(md).toContain('F-001 按右方向键→车辆 x 坐标增加')
    expect(md).toContain('## 风险（risks）')
    expect(md).toContain('F-001、F-002')
  })

  it('注入段：参考合同声明 + 目标文件 + 验证口径 + 自测收口行；risks 不进注入', () => {
    const injection = renderPlanInjection(plan)
    expect(injection).toContain('【技术合同')
    expect(injection).toContain('默认架构')
    expect(injection).toContain('目标文件：')
    expect(injection).toContain('- index.html：入口与布局')
    expect(injection).toContain('复用点：')
    expect(injection).toContain('验证口径（对齐 P0 断言）：')
    expect(injection).toContain('改完按验证口径自测（run_gwt_tests 对照行为断言）后再声明完成。')
    expect(injection).not.toContain('焦点管理')
  })

  it('文件多时降级为存在性行（路径锚不丢，D3 哲学）', () => {
    const many = validateLoopPlan({
      filesToTouch: Array.from({ length: 20 }, (_, i) => ({ path: `src/module-${i}.js`, reason: '这一条理由特别长'.repeat(12) })),
      verification: Array.from({ length: 8 }, (_, i) => `F-00${i} 断言原文`),
    })!
    const injection = renderPlanInjection(many)
    // 全部 20 个路径都在（锚不丢）
    for (let i = 0; i < 20; i += 1) expect(injection).toContain(`src/module-${i}.js`)
    // 验证口径截断为 5 行 + 存在性提示
    expect(injection).toContain('另有 3 条验证口径')
  })

  it('verification 为空时兜底自测指令行', () => {
    const planNoVerify = validateLoopPlan({ filesToTouch: [{ path: 'index.html', reason: 'r' }] })!
    expect(renderPlanInjection(planNoVerify)).toContain('按 system 锚定段全部 P0 断言自测')
  })
})

describe('generateLoopPlan — callLlmForJson 包装（D6 参数锁定）', () => {
  const originalOverride = process.env.BLOMA_PLAN_LEG

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.BLOMA_PLAN_LEG
    else process.env.BLOMA_PLAN_LEG = originalOverride
  })

  function fakeMsg(text: string): SDKMessage {
    return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } } as unknown as SDKMessage
  }

  function scriptedQuery(responses: string[]): { query: SDKQuery; calls: Array<{ prompt: string; options: SDKQueryOptions }> } {
    const calls: Array<{ prompt: string; options: SDKQueryOptions }> = []
    const query: SDKQuery = (prompt, options) => {
      calls.push({ prompt, options })
      const text = responses.shift() ?? ''
      return (async function* (): AsyncGenerator<SDKMessage> {
        yield fakeMsg(text)
      })()
    }
    return { query, calls }
  }

  const backplane: PrdBackplane = {
    project_id: 'p1',
    name: '赛车游戏',
    positioning: '做一个键盘控制的小赛车游戏',
    requirements: [
      { id: 'F-001', description: '键盘控制赛车移动', behavior_assertions: ['按右方向键→车辆 x 坐标增加'], priority: 'P0' },
    ],
    acceptance: {},
    out_of_scope: ['排行榜'],
    assumptions: [],
  }

  it('成功路径：返回解析后的 plan；调用参数 temperature 0.2 / maxTokens 4096 / thinking off / attempts 2', async () => {
    const { query, calls } = scriptedQuery([planJson()])
    const plan = await generateLoopPlan({ mode: 'longterm', backplane, skeletonMap: null, query, env: { K: 'v' }, sessionId: 's1', providerType: 'anthropic' })
    expect(plan?.filesToTouch).toHaveLength(2)
    expect(calls).toHaveLength(1)
    expect(calls[0].options.temperature).toBe(PLAN_TEMPERATURE)
    expect(calls[0].options.temperature).toBe(0.2)
    expect(calls[0].options.maxTokens).toBe(PLAN_MAX_TOKENS)
    expect(calls[0].options.maxTokens).toBe(640000)
    expect(calls[0].options.thinkingLevel).toBe('off')
    expect(calls[0].options.providerType).toBe('anthropic')
    expect(calls[0].options.env).toEqual({ K: 'v' })
    // prompt 携带背板摘要 + 无骨架提示 + 上限提醒（quick=12）
    expect(calls[0].prompt).toContain('按右方向键→车辆 x 坐标增加')
    expect(calls[0].prompt).toContain('无工程骨架')
    expect(calls[0].prompt).toContain(`数量上限 ${PLAN_FILES_LIMIT.longterm}`)
    // system prompt 角色与输出契约
    expect(calls[0].options.history?.[0].content).toContain('技术规划腿')
    expect(calls[0].options.history?.[0].content).toContain('只规划不实现')
  })

  it('骨架地图注入 prompt；迭代/quick 上限 12 透传', async () => {
    const { query, calls } = scriptedQuery([planJson()])
    await generateLoopPlan({ mode: 'quick', backplane, skeletonMap: '工程骨架已就位：\n- src/app.js：主逻辑', query, env: {}, sessionId: 's1' })
    expect(calls[0].prompt).toContain('工程骨架已就位')
    expect(calls[0].prompt).toContain(`数量上限 ${PLAN_FILES_LIMIT.quick}`)
    expect(calls[0].prompt).not.toContain('无工程骨架')
  })

  it('quick 模式下 13 个文件超上限 → 校验拒绝 → 重试一轮后仍失败 → null（fail-closed）', async () => {
    const tooMany = planJson({ filesToTouch: Array.from({ length: 13 }, (_, i) => ({ path: `f${i}.js`, reason: 'r' })) })
    const { query, calls } = scriptedQuery([tooMany, tooMany])
    const plan = await generateLoopPlan({ mode: 'quick', backplane, skeletonMap: null, query, env: {}, sessionId: 's1' })
    expect(plan).toBeNull()
    expect(calls).toHaveLength(PLAN_ATTEMPTS)
  })

  it('渠道/LLM 异常 → null 不抛错（fail-closed）', async () => {
    const query: SDKQuery = () => {
      throw new Error('LLM_FAILED')
    }
    const plan = await generateLoopPlan({ mode: 'longterm', backplane, skeletonMap: null, query, env: {}, sessionId: 's1' })
    expect(plan).toBeNull()
  })
})

describe('planLegEnabled — 开关矩阵（D7）', () => {
  const original = process.env.BLOMA_PLAN_LEG
  afterEach(() => {
    if (original === undefined) delete process.env.BLOMA_PLAN_LEG
    else process.env.BLOMA_PLAN_LEG = original
  })

  it('未设：quick=off / longterm=on', () => {
    delete process.env.BLOMA_PLAN_LEG
    expect(planLegEnabled('quick')).toBe(false)
    expect(planLegEnabled('longterm')).toBe(true)
  })

  it("'0'/off/false 全关；'1'/on/true 全开", () => {
    for (const off of ['0', 'off', 'false', 'OFF']) {
      process.env.BLOMA_PLAN_LEG = off
      expect(planLegEnabled('quick')).toBe(false)
      expect(planLegEnabled('longterm')).toBe(false)
    }
    for (const on of ['1', 'on', 'true', 'ON']) {
      process.env.BLOMA_PLAN_LEG = on
      expect(planLegEnabled('quick')).toBe(true)
      expect(planLegEnabled('longterm')).toBe(true)
    }
  })
})
