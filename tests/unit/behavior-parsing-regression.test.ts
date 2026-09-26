import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { restorePromaHome } from '../support/proma-home-guard'
import { createProject, recordSketchGenerated } from '../../main/project/project-service'
import { parseBehaviorAssertion } from '../../main/verification/behavior-assertions'
import { checkEffect, runBrowserGwt, type ScenarioPlan } from '../../main/verification/gwt-runner'
import { compileResetSteps } from '../../main/verification/gwt-steps'
import type { PageState } from '../../main/verification/gwt-steps'
import type { SketchRequirement } from '../../main/coding/sketch-engine'

/**
 * 行为断言解析误译回归（2026-09-26 运行审计 P1-01）：审计在 ef 案实录中抓到的
 * 三类假测试——「按下键盘数字键」被译成 ArrowDown、「显示区文本变化」被译成
 * show（新元素出现）、任意文本/元素变化让断言通过（计时器假绿）。本文件锁定
 * 修复语义 + 审计指定回归五项（按下/显示区/精确 0.5/无关计时器/场景换序）。
 */

const scenarioOf = (assertion: string, description = '功能项'): ScenarioPlan => ({
  item: { id: 'F-001', description, behavior_assertions: [assertion] } as SketchRequirement,
  assertion,
  plan: parseBehaviorAssertion(assertion),
})

const stateOf = (partial: Partial<PageState>): PageState => ({
  elements: [],
  visibleCount: 0,
  text: '',
  inputValues: '',
  ...partial,
})

describe('解析误译（审计 P1-01：ef 实录三例）', () => {
  it('「按下键盘数字键」不再译成 ArrowDown——键族泛指无具体键值 → 待评估回退', () => {
    const plan = parseBehaviorAssertion('按下键盘数字键→显示区追加该数字')
    // 旧口径：trigger={kind:'key',key:'ArrowDown'}（「下」+「键」散匹配）；现不可映射
    expect(plan.trigger?.kind === 'key' && plan.trigger.key === 'ArrowDown').toBe(false)
    expect(plan.presenceFallback).toBe(true)
  })

  it('「按数字键 7」→ 具体按键 key=7（泛指不猜，具体值可映射）', () => {
    const plan = parseBehaviorAssertion('按数字键 7→显示区追加 7')
    expect(plan.trigger).toEqual({ kind: 'key', key: '7' })
  })

  it('「显示区文本变化」→ text-change（非 show 新元素出现）', () => {
    const plan = parseBehaviorAssertion('WHEN 点击数字键 → 显示区文本变化')
    expect(plan.effect?.kind).toBe('text-change')
  })

  it('「按角度制得到 0.5」→ text-change + 期望值 0.5（精确谓词，非任意变化）', () => {
    const plan = parseBehaviorAssertion('输入 sin(30) 并计算→按角度制得到 0.5')
    expect(plan.presenceFallback).toBe(false)
    expect(plan.trigger?.kind).toBe('fill')
    expect(plan.trigger?.value).toBe('sin(30)')
    expect(plan.effect?.kind).toBe('text-change')
    expect(plan.effect?.expectedValue).toBe('0.5')
  })

  it('完整词形方向键不回归：右方向键/左箭头/↓/ArrowUp 均命中；裸简写「按左键」保留', () => {
    expect(parseBehaviorAssertion('按右方向键→车辆 x 坐标增加').trigger).toEqual({ kind: 'key', key: 'ArrowRight' })
    expect(parseBehaviorAssertion('按左箭头→光标左移').trigger).toEqual({ kind: 'key', key: 'ArrowLeft' })
    expect(parseBehaviorAssertion('按 ↓→方块下落').trigger).toEqual({ kind: 'key', key: 'ArrowDown' })
    expect(parseBehaviorAssertion('按ArrowUp→平台上移').trigger).toEqual({ kind: 'key', key: 'ArrowUp' })
    expect(parseBehaviorAssertion('按左键→车辆 x 坐标减小').trigger).toEqual({ kind: 'key', key: 'ArrowLeft' })
  })
})

describe('checkEffect 收紧（审计 P1-01：任意变化假绿）', () => {
  it('期望值断言：页面出现 0.5 才通过；未出现（哪怕文本有变化）失败', () => {
    const scenario = scenarioOf('输入 sin(30) 并计算→按角度制得到 0.5')
    const before = stateOf({ text: '计算器 0' })
    const pass = checkEffect(scenario, before, stateOf({ text: '计算器 0.5' }))
    expect(pass).toBeUndefined()
    const fail = checkEffect(scenario, before, stateOf({ text: '计算器 等待输入' }))
    expect(fail).toContain('0.5')
  })

  it('无关计时器变化不再假绿：非计时断言仅时钟文本跳动 → 失败', () => {
    const scenario = scenarioOf('点击保存按钮→状态文本更新为已保存')
    const before = stateOf({ text: '时钟 12:00:01 保存' })
    const onlyClock = checkEffect(scenario, before, stateOf({ text: '时钟 12:00:05 保存' }))
    expect(onlyClock).toBeDefined()
    expect(onlyClock).toContain('时钟类文本跳动')
    const realChange = checkEffect(scenario, before, stateOf({ text: '时钟 12:00:05 已保存' }))
    expect(realChange).toBeUndefined()
  })

  it('计时/时钟类断言（timeBound）：时钟文本变化即合法通过', () => {
    const scenario = scenarioOf('点击开始按钮→计时时间开始变化')
    const before = stateOf({ text: '计时 00:00:00' })
    const pass = checkEffect(scenario, before, stateOf({ text: '计时 00:00:03' }))
    expect(pass).toBeUndefined()
  })

  it('show 断言不被时钟元素假绿：sig 已剥离时间文本，时钟跳动不算新元素', () => {
    const scenario = scenarioOf('点击详情按钮→弹出详情面板')
    const clockSig = 'div.clock#时间@80x20'
    const before = stateOf({ elements: [{ sig: clockSig, x: 0, y: 0 }], visibleCount: 1 })
    const after = stateOf({ elements: [{ sig: clockSig, x: 0, y: 0 }], visibleCount: 1, text: '12:00:05' })
    // 只有时钟文本跳动（sig 不变）：无新元素出现 → 失败（旧口径 sig 含时间会判“新元素”假绿）
    expect(checkEffect(scenario, before, after)).toContain('没有新元素出现')
    const realShow = stateOf({ elements: [{ sig: clockSig, x: 0, y: 0 }, { sig: 'div.panel#详情@200x100', x: 0, y: 30 }], visibleCount: 2 })
    expect(checkEffect(scenario, before, realShow)).toBeUndefined()
  })
})

describe('compileResetSteps 目标提取（审计 P1-01：解析失败先走 steps）', () => {
  it('无 trigger.target 时从断言提取「重置」名词短语', () => {
    const compiled = compileResetSteps('当前输入与结果被重置', undefined)
    expect(compiled.status).toBe('compiled')
    if (compiled.status === 'compiled') {
      expect(compiled.steps[1].op).toMatchObject({ type: 'click', target: '重置' })
    }
  })

  it('trigger 提供的目标优先于文本提取', () => {
    const compiled = compileResetSteps('点击清空键→当前输入与结果归零', '清空键')
    expect(compiled.status).toBe('compiled')
    if (compiled.status === 'compiled') {
      expect(compiled.steps[1].op).toMatchObject({ type: 'click', target: '清空键' })
    }
  })
})

describe('场景换序（审计 P1-01：每场景独立导航隔离状态，真浏览器）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  async function playwrightAvailable(): Promise<boolean> {
    try {
      const { chromium } = await import('playwright')
      const browser = await chromium.launch({ headless: true })
      await browser.close()
      return true
    } catch {
      return false
    }
  }

  it('场景 A 的输入残留不影响场景 B：两个顺序结果一致', async () => {
    if (!(await playwrightAvailable())) {
      console.warn('[p1-01] playwright chromium 不可用，跳过场景换序验证')
      return
    }
    // 页面：输入框 + 回显；断言 A=输入触发回显（text-change）；B=加载初始态显示欢迎（show 语义静态部分弱——
    // 用 text-change 的输入值比对：B 在 A 之后跑，若状态残留则 inputValues 非空导致 A 类断言假绿/假红）
    const html = `<!doctype html><html><body>
<input id="q" placeholder="搜索框">
<div id="out">欢迎使用</div>
<script>
document.getElementById('q').addEventListener('input', function (e) {
  document.getElementById('out').textContent = '草稿：' + e.target.value
})
</script></body></html>`
    const server = createServer((_req, res) => {
      // charset=utf-8 对齐真实 static-server：缺 charset 时 Chromium 按 Latin-1 解码，
      // 中文 placeholder 全乱码 → 探针 fill 匹配 MISS（gwt-probe-browser 同坑注释）
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-order-'))
      const project = createProject({ request_id: 'req-order', mode: 'quick' })
      writeFileSync(join(project.root_path, 'index.html'), html, 'utf8')
      recordSketchGenerated(project.project_id, [
        {
          id: 'F-001',
          description: '搜索',
          behavior_assertions: ['在搜索框输入内容→草稿文本变化', '在搜索框输入内容→草稿文本变化'],
        },
      ])
      const run = async () =>
        runBrowserGwt({
          project_id: project.project_id,
          session_id: 's-order',
          preview_url: `http://127.0.0.1:${port}`,
        })
      // 同一断言跑两轮：轮内两个场景独立导航后都应通过（第二轮场景不再吃到第一轮残留；
      // 旧口径共用 Page 时第一个场景的输入残留会让第二个场景的 before 已含草稿文本）
      const first = await run()
      const second = await run()
      expect(first?.failed_count).toBe(0)
      expect(second?.failed_count).toBe(0)
    } finally {
      server.close()
    }
  })
})
