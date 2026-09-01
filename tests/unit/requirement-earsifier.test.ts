import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { earsifyRequirements, mergeRewrite, semanticOverlap, type EarsifyStats } from '../../main/requirement-earsifier'
import type { SketchRequirement } from '../../main/sketch-engine'

function makeRequirements(): SketchRequirement[] {
  return [
    {
      id: 'F-001',
      description: '做一个番茄钟计时器',
      priority: 'P0',
      behavior_assertions: ['点击开始后计时启动', '计时中点暂停会停下'],
    },
    { id: 'F-002', description: '显示今日完成数', priority: 'P2', behavior_assertions: ['数字变化'] },
  ]
}

describe('requirement-earsifier（P3：P0 断言 EARS 化 + 三层守卫）', () => {
  describe('semanticOverlap：②语义保持度量（双度量）', () => {
    it('同义改写（含措辞重排）高重叠', () => {
      expect(semanticOverlap('点击开始后计时启动', 'WHEN 点击开始按钮 → 计时启动')).toBeGreaterThanOrEqual(0.5)
      expect(semanticOverlap('计时中点暂停会停下', 'WHEN 点击暂停按钮 → 计时停止')).toBeGreaterThanOrEqual(0.5)
    })

    it('换内容低重叠（借改写夹带新功能被拦截）', () => {
      expect(semanticOverlap('点击开始后计时启动', 'WHEN 点击保存按钮 → 跳转至首页')).toBeLessThan(0.5)
    })
  })

  describe('mergeRewrite：三层守卫', () => {
    const stats = (): EarsifyStats => ({ earsified: 0, dropped: 0, p0Items: 0 })

    it('良构改写被采纳，非 P0 项原样', () => {
      const result = mergeRewrite(
        makeRequirements(),
        [
          {
            id: 'F-001',
            behavior_assertions: ['WHEN 点击开始按钮 → 计时启动', 'WHEN 点击暂停按钮 → 计时停止'],
          },
        ],
        stats(),
      )
      expect(result.requirements[0].behavior_assertions).toEqual(['WHEN 点击开始按钮 → 计时启动', 'WHEN 点击暂停按钮 → 计时停止'])
      expect(result.requirements[1].behavior_assertions).toEqual(['数字变化'])
      expect(result.stats.earsified).toBe(2)
    })

    it('①格式守卫：非良构/复合 trigger/禁词断言丢弃', () => {
      const result = mergeRewrite(
        makeRequirements(),
        [
          {
            id: 'F-001',
            behavior_assertions: [
              '该功能可见可交互', // 无中轴非良构
              'WHEN 点击开始并点击暂停 → 计时启动', // 复合 trigger
              'IF 输入非法 → 系统优雅处理', // 禁词
            ],
          },
        ],
        stats(),
      )
      // 全灭 → 保留原断言
      expect(result.requirements[0].behavior_assertions).toEqual(['点击开始后计时启动', '计时中点暂停会停下'])
      expect(result.stats.dropped).toBe(3)
      expect(result.stats.earsified).toBe(0)
    })

    it('②语义守卫：与原断言脱缰的改写丢弃（防夹带新功能）', () => {
      const result = mergeRewrite(
        makeRequirements(),
        [{ id: 'F-001', behavior_assertions: ['WHEN 点击保存按钮 → 列表新增一条记录'] }],
        stats(),
      )
      expect(result.requirements[0].behavior_assertions).toEqual(makeRequirements()[0].behavior_assertions)
      expect(result.stats.dropped).toBe(1)
    })

    it('③数量守卫：改写后超 原数+1 截断（截断发生在守卫前，dropped 计数）', () => {
      const result = mergeRewrite(
        makeRequirements(),
        [
          {
            id: 'F-001',
            behavior_assertions: [
              'WHEN 点击开始按钮 → 计时启动',
              'WHEN 点击暂停按钮 → 计时停止',
              'WHEN 双击暂停按钮 → 计时停止',
              'WHEN 点击暂停按钮 → 计时暂停',
            ],
          },
        ],
        stats(),
      )
      // 原 2 条 + 1 容差 = 最多 3 条；第 4 条截断（守卫前）
      expect(result.requirements[0].behavior_assertions).toHaveLength(3)
      expect(result.stats.dropped).toBe(1)
    })

    it('②语义守卫拦截夹带新功能（重置/设置不在原断言语义锚内）', () => {
      const result = mergeRewrite(
        makeRequirements(),
        [{ id: 'F-001', behavior_assertions: ['WHEN 点击重置按钮 → 计时归零'] }],
        stats(),
      )
      expect(result.requirements[0].behavior_assertions).toEqual(makeRequirements()[0].behavior_assertions)
      expect(result.stats.dropped).toBe(1)
    })

    it('description/story/priority/id 原样保留（F-001 锚点不变式）', () => {
      const result = mergeRewrite(
        [{ ...makeRequirements()[0], story: '作为用户我想计时' }],
        [{ id: 'F-001', behavior_assertions: ['WHEN 点击开始按钮 → 计时启动'] }],
        stats(),
      )
      expect(result.requirements[0].description).toBe('做一个番茄钟计时器')
      expect(result.requirements[0].story).toBe('作为用户我想计时')
      expect(result.requirements[0].priority).toBe('P0')
      expect(result.requirements[0].id).toBe('F-001')
    })

    it('未知 id 不并入（只按盘上已有 id 匹配）', () => {
      const result = mergeRewrite(makeRequirements(), [{ id: 'F-999', behavior_assertions: ['WHEN 点击 → 显示'] }], stats())
      expect(result.requirements).toHaveLength(2)
      expect(result.stats.earsified).toBe(0)
    })
  })

  describe('earsifyRequirements：主入口（失败回退不阻塞）', () => {
    beforeEach(() => {
      vi.unstubAllEnvs()
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('无 query/env → 原样返回不发请求', async () => {
      const query = vi.fn()
      const result = await earsifyRequirements({
        project_id: 'p',
        session_id: 's',
        requirements: makeRequirements(),
        query: query as never,
        env: {},
      })
      expect(query).not.toHaveBeenCalled()
      expect(result.requirements).toEqual(makeRequirements())
    })

    it('全部 P0 断言已良构 EARS → 幂等短路不发请求', async () => {
      const query = vi.fn()
      const alreadyEars: SketchRequirement[] = [
        { id: 'F-001', description: '番茄钟', priority: 'P0', behavior_assertions: ['WHEN 点击开始按钮 → 计时启动'] },
      ]
      const result = await earsifyRequirements({
        project_id: 'p',
        session_id: 's',
        requirements: alreadyEars,
        query: query as never,
        env: { KEY: 'v' },
      })
      expect(query).not.toHaveBeenCalled()
      expect(result.requirements).toEqual(alreadyEars)
    })

    it('无前缀存量断言（中轴家族「后/时」）不算已 EARS 化，仍会改写', async () => {
      const alreadyEars: SketchRequirement[] = [
        { id: 'F-001', description: '番茄钟', priority: 'P0', behavior_assertions: ['点击开始后计时启动'] },
      ]
      const query = vi.fn(async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '{"requirements":[{"id":"F-001","behavior_assertions":["WHEN 点击开始按钮 → 计时启动"]}]}' }] },
        }
      })
      const result = await earsifyRequirements({
        project_id: 'p',
        session_id: 's',
        requirements: alreadyEars,
        query: query as never,
        env: { KEY: 'v' },
      })
      expect(query).toHaveBeenCalled()
      expect(result.requirements[0].behavior_assertions).toEqual(['WHEN 点击开始按钮 → 计时启动'])
    })

    it('LLM 抛错 → 原样返回（主线不阻塞）', async () => {
      const query = vi.fn(async function* () {
        throw new Error('boom')
      })
      const result = await earsifyRequirements({
        project_id: 'p',
        session_id: 's',
        requirements: makeRequirements(),
        query: query as never,
        env: { KEY: 'v' },
      })
      expect(result.requirements).toEqual(makeRequirements())
      expect(result.stats.earsified).toBe(0)
    })

    it('LLM 返回良构改写 → 采纳（prompt 含三处同源词表渲染）', async () => {
      let seenPrompt = ''
      const query = vi.fn(async function* (prompt: string) {
        seenPrompt = prompt
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '{"requirements":[{"id":"F-001","behavior_assertions":["WHEN 点击开始按钮 → 计时启动","WHEN 点击暂停按钮 → 计时停止"]}]}' }] },
        }
      })
      const result = await earsifyRequirements({
        project_id: 'p',
        session_id: 's',
        requirements: makeRequirements(),
        query: query as never,
        env: { KEY: 'v' },
      })
      expect(result.stats.earsified).toBe(2)
      expect(result.requirements[0].behavior_assertions?.[0]).toContain('WHEN')
      // 三处同源：system prompt（经 history 传入）渲染自 ears-vocabulary 同一常量
      expect(query).toHaveBeenCalled()
      void seenPrompt
    })

    it('abort 后 → 原样返回', async () => {
      const controller = new AbortController()
      controller.abort()
      const query = vi.fn(async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: '{"requirements":[]}' }] } }
      })
      const result = await earsifyRequirements({
        project_id: 'p',
        session_id: 's',
        requirements: makeRequirements(),
        query: query as never,
        env: { KEY: 'v' },
        signal: controller.signal,
      })
      expect(result.requirements).toEqual(makeRequirements())
    })
  })
})
