import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { describeEffect, describeTrigger, parseBehaviorAssertion } from '../../main/behavior-assertions'
import { planScenarios, scenarioName, setBrowserGwtDisabledForTests } from '../../main/gwt-runner'
import { runGwtScenarios } from '../../main/gwt-service'
import { runJudge } from '../../main/judge-engine'
import { syncDocuments } from '../../main/document-engine'
import type { PrdBackplane } from '../../main/sketch-engine'
import { createProject, recordSketchGenerated } from '../../main/project-service'
import { getDocumentsDir } from '../../storage/config-paths'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * M3 行为门禁（2026-08-17 设计 §7.4/§8.1）：
 * - 断言解析：领域无关动作词表（触发器 + 效果），解析不出 → 存在性兜底；
 * - GWT 场景从 behavior_assertions 派生（per-assertion）；
 * - 裁判硬约束③：运行证据（行为脚本失败）→ 退回（P3「车不位移必退回」关门）；
 *   静态词表未命中 → 待评估不退回（防 SVG/canvas 误杀）；
 * - 精致度软约束：UX 契约存在时 MVP 不低于草图粗粒度下界（防体验倒挂 P4）。
 */
describe('行为断言解析（parseBehaviorAssertion）', () => {
  it('位移类断言：按右方向键→x 坐标增加 = key 触发 + move-right 效果 + 词表关键词', () => {
    const plan = parseBehaviorAssertion('按右方向键→车辆 x 坐标增加')
    expect(plan.presenceFallback).toBe(false)
    expect(plan.trigger).toEqual({ kind: 'key', key: 'ArrowRight' })
    expect(plan.effect?.kind).toBe('move-right')
    expect(plan.effect?.keywords).toContain('translate')
  })

  it('左右上下/空格/回车按键触发映射 + 移动方向效果', () => {
    expect(parseBehaviorAssertion('按左键→车辆 x 坐标减小').trigger).toEqual({ kind: 'key', key: 'ArrowLeft' })
    expect(parseBehaviorAssertion('按上方向键→火箭 y 坐标减小').effect?.kind).toBe('move-up')
    expect(parseBehaviorAssertion('按下方向键→角色 y 坐标增加').effect?.kind).toBe('move-down')
    expect(parseBehaviorAssertion('按空格→角色隐藏').trigger).toEqual({ kind: 'key', key: ' ' })
    expect(parseBehaviorAssertion('按回车→表单提交').effect?.kind).toBeUndefined() // 提交未入词表 → 存在性兜底
  })

  it('点击触发：点击保存按钮→列表新增一条记录', () => {
    const plan = parseBehaviorAssertion('点击保存按钮→列表新增一条记录')
    expect(plan.trigger).toEqual({ kind: 'click', target: '保存' })
    expect(plan.effect?.kind).toBe('add-item')
  })

  it('显隐/文本变化效果', () => {
    expect(parseBehaviorAssertion('点击关闭→面板隐藏').effect?.kind).toBe('hide')
    expect(parseBehaviorAssertion('点击详情→弹层显示').effect?.kind).toBe('show')
    expect(parseBehaviorAssertion('点击计算→结果文字变化').effect?.kind).toBe('text-change')
  })

  it('默认断言与无法解析的断言 → 存在性兜底（绝不因看不懂退回）', () => {
    expect(parseBehaviorAssertion('该功能项在产物中可见且可交互').presenceFallback).toBe(true)
    expect(parseBehaviorAssertion('赛车要很真实').presenceFallback).toBe(true)
    expect(parseBehaviorAssertion('按右方向键→拥有驾驶操控感').presenceFallback).toBe(true) // 效果不可断言
  })

  it('触发/效果的用户可读描述（GWT 骨架与失败原因共用）', () => {
    expect(describeTrigger({ kind: 'key', key: 'ArrowRight' })).toBe('按下右方向键')
    expect(describeTrigger({ kind: 'click', target: '保存' })).toBe('点击「保存」控件')
    expect(describeEffect({ kind: 'move-right', keywords: [] })).toBe('目标元素向右位移')
  })
})

describe('GWT 场景按断言派生（planScenarios）', () => {
  it('每条 behavior_assertion 一个场景；默认断言走存在性兜底', () => {
    const scenarios = planScenarios([
      {
        id: 'F-001',
        description: '赛车模拟器',
        behavior_assertions: ['按右方向键→车辆 x 坐标增加', '点击保存→成绩列表新增一条记录'],
        priority: 'P0',
      },
      { id: 'F-002', description: '历史记录' },
    ])
    // F-001 两条行为断言 + F-002 默认断言（可见且可交互）
    expect(scenarios).toHaveLength(3)
    expect(scenarios[0].plan.presenceFallback).toBe(false)
    expect(scenarios[0].plan.effect?.kind).toBe('move-right')
    expect(scenarios[2].plan.presenceFallback).toBe(true)
    // 场景名 `${itemId} ${assertion}`：裁判按此前缀对账运行证据
    expect(scenarioName('F-001', '按右方向键→车辆 x 坐标增加')).toBe('F-001 按右方向键→车辆 x 坐标增加')
  })
})

describe('裁判行为门禁（P3：车不位移必退回）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  /** 构造「车只旋转不位移」的产物（2026-08-16 复测 43b47a47 实锤形态）。 */
  function setupRacingProject() {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-p3-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [
      {
        id: 'F-001',
        description: '赛车模拟器',
        story: '作为玩家，我想用方向键驾驶赛车，以便获得竞速体验',
        behavior_assertions: ['按右方向键→车辆 x 坐标增加'],
        priority: 'P0',
      },
    ])
    syncDocuments({ request_id: 'req-sync', session_id: 's', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
    // 产物：有交互控件 + 脚本逻辑（存在性过），但 JS 只 rotate 不位移
    writeFileSync(join(project.root_path, 'index.html'), '<button id="right">右</button><div class="car">🏎️</div>', 'utf8')
    mkdirSync(join(project.root_path, 'src'), { recursive: true })
    writeFileSync(join(project.root_path, 'src', 'app.js'), "document.addEventListener('keydown', function(e){ if(e.key==='ArrowRight'){ document.querySelector('.car').style.transform='rotate(8deg)'; } })", 'utf8')
    return project
  }

  it('运行证据：行为脚本断言失败 → 硬约束③退回（P3 关门）', () => {
    const project = setupRacingProject()
    const verdict = runJudge({
      project_id: project.project_id,
      mode: 'quick',
      test_result: {
        total_count: 1,
        passed_count: 0,
        failed_count: 1,
        failure_summary: [
          { scenario: 'F-001 按右方向键→车辆 x 坐标增加', reason: '断言未满足：按右方向键→车辆 x 坐标增加（预期目标元素向右位移，实际触发后没有任何元素发生水平位移）' },
        ],
      },
    })

    expect(verdict.verdict).toBe('return')
    expect(verdict.repairable).toBe(true)
    const constraint = verdict.hard_constraints.find((item) => item.name === 'P0 行为断言可满足性')
    expect(constraint?.passed).toBe(false)
    expect(constraint?.detail).toContain('按右方向键→车辆 x 坐标增加')
  })

  it('静态兜底：词表命中且产物含关键词 → 确认通过；无运行证据不退回', () => {
    const project = setupRacingProject()
    // 产物含 transform（rotate）→ 静态关键词命中（无法区分位移/旋转，这正是静态的精度边界）
    const verdict = runJudge({ project_id: project.project_id, mode: 'quick' })
    expect(verdict.verdict).toBe('pass')
    const constraint = verdict.hard_constraints.find((item) => item.name === 'P0 行为断言可满足性')
    expect(constraint?.passed).toBe(true)
    expect(constraint?.detail).toContain('静态确认')
  })

  it('静态兜底：词表命中但产物未现关键词 → 待评估不退回（防 SVG/canvas 误杀）', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-canvas-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [
      {
        id: 'F-001',
        description: '画板',
        behavior_assertions: ['按右方向键→光标 x 坐标增加'],
        priority: 'P0',
      },
    ])
    syncDocuments({ request_id: 'req-sync', session_id: 's', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
    // canvas 实现：无 translate/transform/left 等关键词（合法实现不落关键词）
    writeFileSync(join(project.root_path, 'index.html'), '<canvas id="board"></canvas><button>clear</button>', 'utf8')
    mkdirSync(join(project.root_path, 'src'), { recursive: true })
    writeFileSync(join(project.root_path, 'src', 'app.js'), "document.addEventListener('keydown', function(e){ if(e.key==='ArrowRight'){ ctx.fillRect(x+=4, y, 2, 2); } })", 'utf8')

    const verdict = runJudge({ project_id: project.project_id, mode: 'quick' })
    expect(verdict.verdict).toBe('pass')
    const constraint = verdict.hard_constraints.find((item) => item.name === 'P0 行为断言可满足性')
    expect(constraint?.passed).toBe(true)
    expect(constraint?.detail).toContain('待评估')
  })
})

describe('GWT 静态兜底 per-assertion（无浏览器环境）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    // 本 describe 验证静态兜底路径：固定禁用浏览器探针（模拟 chromium 不可用）
    setBrowserGwtDisabledForTests(false)
  })

  it('行为断言词表命中产物 → 通过；未命中 → 待评估不计失败', async () => {
    setBrowserGwtDisabledForTests(true)
    const home = mkdtempSync(join(tmpdir(), 'proma-gwt-static-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [
      {
        id: 'F-001',
        description: '赛车模拟器',
        behavior_assertions: ['按右方向键→车辆 x 坐标增加', '按下方向键→画布重绘'], // 后者无效果词表 → 存在性
        priority: 'P0',
      },
    ])
    const server = createServer((req, res) => {
      if (req.url === '/src/app.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' })
        res.end("document.addEventListener('keydown', function(){ car.style.left = '10px'; })")
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><button>go</button></body></html>')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const result = await runGwtScenarios({
        project_id: project.project_id,
        session_id: 'session-1',
        // preview_url 指向本地 server；Playwright 不可用时自动落静态路径
        preview_url: `http://127.0.0.1:${port}`,
      })
      expect(result.failed_count).toBe(0)
      expect(result.failure_summary).toEqual([])
    } finally {
      server.close()
    }
  })

  it('存在性断言在页面无入口时如实失败（语义与改造前同构）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-gwt-static-fail-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    const server = createServer((req, res) => {
      if (req.url === '/src/app.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' })
        res.end('// nothing')
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><h1>空白页</h1></body></html>')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const result = await runGwtScenarios({
        project_id: project.project_id,
        session_id: 'session-1',
        preview_url: `http://127.0.0.1:${port}`,
      })
      expect(result.failed_count).toBe(1)
      expect(result.failure_summary[0].scenario).toContain('F-001')
      expect(result.failure_summary[0].reason).toContain('缺少功能入口')
    } finally {
      server.close()
    }
  })
})

describe('GWT 骨架从行为断言派生 + 精致度软约束', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  it('feature 文件：每条断言一个场景（When=触发、Then=效果），默认断言落存在性骨架', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-gwt-skel-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [
      {
        id: 'F-001',
        description: '赛车模拟器',
        behavior_assertions: ['按右方向键→车辆 x 坐标增加'],
        priority: 'P0',
      },
    ])
    syncDocuments({ request_id: 'req-sync', session_id: 's', project_id: project.project_id, checkpoint: 'mvp_before_generation' })

    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    const feature = readFileSync(join(dir, 'features', 'F-001.feature'), 'utf8')
    // 断言场景：Scenario 名即断言文本，When/Then 来自词表解析
    expect(feature).toContain('Scenario: 按右方向键→车辆 x 坐标增加')
    expect(feature).toContain('When 按下右方向键')
    expect(feature).toContain('Then 目标元素向右位移')
    // 边界/异常鲁棒性场景保留
    expect(feature).toContain('边界输入不崩溃')
    expect(feature).toContain('异常输入不崩溃')
    expect(feature.match(/Scenario:/g)).toHaveLength(3)
  })

  it('精致度软约束：UX 契约存在且产物明显小于草图 → suggest（不退回）', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-refine-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const sketchHtml = `<!doctype html><html><head><style>${'.card-{display:block;}'.repeat(40)}</style></head><body>${'<div class="card-x">占位区块内容</div>'.repeat(80)}</body></html>`
    // 落一份带 ux_contract 的 prd.json（sketch_confirmed 写盘）+ GWT 骨架（mvp_before_generation）
    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'sketch.html'), sketchHtml, 'utf8')
    const thickBackplane: PrdBackplane = {
      project_id: project.project_id,
      name: project.name,
      positioning: '赛车模拟器',
      requirements: [
        {
          id: 'F-001',
          description: '赛车模拟器',
          behavior_assertions: ['按右方向键→车辆 x 坐标增加'],
          priority: 'P0',
          story: '赛车模拟器',
        },
      ],
      acceptance: {},
      out_of_scope: [],
      assumptions: [],
      ux_contract: { sketch_rel_path: 'sketch.html', confirmed_at: new Date().toISOString() },
    }
    syncDocuments(
      { request_id: 'req-sync', session_id: 's', project_id: project.project_id, checkpoint: 'sketch_confirmed' },
      thickBackplane,
    )
    syncDocuments(
      { request_id: 'req-sync', session_id: 's', project_id: project.project_id, checkpoint: 'mvp_before_generation' },
      thickBackplane,
    )
    // 产物：交互入口齐备（硬约束全过）但规模塌缩（远小于草图）
    writeFileSync(join(project.root_path, 'index.html'), '<button>右</button><div class="car">🏎️</div>', 'utf8')
    mkdirSync(join(project.root_path, 'src'), { recursive: true })
    writeFileSync(join(project.root_path, 'src', 'app.js'), "document.addEventListener('keydown', function(e){ if(e.key==='ArrowRight'){ car.style.transform='translateX(8px)'; } })", 'utf8')

    const verdict = runJudge({ project_id: project.project_id, mode: 'quick' })

    // 精致度是软约束：suggest 而非退回
    expect(verdict.verdict).toBe('suggest')
    const refinement = verdict.soft_constraints.find((item) => item.name === '视觉精致度（对照草图）')
    expect(refinement?.passed).toBe(false)
    expect(refinement?.detail).toContain('产物规模明显小于草图')
    expect(verdict.repairable).toBe(false)
  })
})
