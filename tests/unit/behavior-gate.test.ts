import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { describeEffect, describeTrigger, parseBehaviorAssertion } from '../../main/verification/behavior-assertions'
import { parseEarsAssertion, renderTriggerVocabularyForPrompt } from '../../main/guide/ears-vocabulary'
import { planScenarios, scenarioName, setBrowserGwtDisabledForTests } from '../../main/verification/gwt-runner'
import { runGwtScenarios } from '../../main/verification/gwt-service'
import { runJudge } from '../../main/review/judge-engine'
import { syncDocuments } from '../../main/project/document-engine'
import type { PrdBackplane } from '../../main/coding/sketch-engine'
import { createProject, recordSketchGenerated } from '../../main/project/project-service'
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

describe('对抗审查修复回归（B-1 链 M-3/M-4/M-5，2026-09-02）', () => {
  it('M-3：「按下保存按钮」解析为 click 而非 ArrowDown（与词表 click 条目「按下」口径一致）', () => {
    const plan = parseBehaviorAssertion('WHEN 按下保存按钮 → 弹出确认框')
    expect(plan.presenceFallback).toBe(false)
    expect(plan.trigger?.kind).toBe('click')
    expect(plan.trigger?.target).toBe('保存')
    // 「按下回车键」的「下」不得误判方向键（命名键优先）
    const enter = parseBehaviorAssertion('按下回车键 → 列表新增一条记录')
    expect(enter.trigger).toEqual({ kind: 'key', key: 'Enter' })
  })

  it('M-5：显式箭头优先切分，「计时」词内单字不截断（此前双侧在「计时」的「时」处错位）', () => {
    const ears = parseEarsAssertion('WHEN 计时中点暂停 → 计时停止')
    expect(ears.trigger).toBe('计时中点暂停')
    expect(ears.response).toBe('计时停止')
    expect(ears.wellFormed).toBe(true)
    // 效果段「计时启动/停止」入 text-change 词表（M-4）：earsifier prompt 自带示例可走通探针
    const plan = parseBehaviorAssertion('WHEN 点击开始按钮 → 计时启动')
    expect(plan.presenceFallback).toBe(false)
    expect(plan.trigger?.kind).toBe('click')
    expect(plan.effect?.kind).toBe('text-change')
  })

  it('M-5：无显式箭头时语义词兑底仍工作（存量格式，trigger ≥2 字防词内截断）', () => {
    const ears = parseEarsAssertion('点击保存按钮后列表新增一条记录')
    expect(ears.trigger).toBe('点击保存按钮')
    expect(ears.response).toBe('列表新增一条记录')
    const wordy = parseEarsAssertion('计时中点暂停后计时停止')
    expect(wordy.trigger).toBe('计时中点暂停')
    expect(wordy.response).toBe('计时停止')
  })

  it('a8c7d17d 回溯漏洞（2026-09-04 修复）：复合框名形态 target 不再吃介词/丢语义', () => {
    // 旧正则：懒惰 capture≥1 + 可选介词组无锚定→回溯后 capture='在'（target='在'）致 fill 探针全 MISS
    const searchBox = parseBehaviorAssertion('WHEN 在搜索框输入关键词 → 显示匹配的历史想法')
    expect(searchBox.trigger?.kind).toBe('fill')
    expect(searchBox.trigger?.target).toBe('搜索') // 复合框名「搜索框」→ 语义前缀，非「在」
    expect(searchBox.trigger?.value).toBe('关键词') // fill 值从触发器语义提取（次级发现①）

    // 回归：T-8 已修形态不受影响
    expect(parseBehaviorAssertion('WHEN 在任务输入框输入内容 → 输入框内容更新').trigger?.target).toBe('任务')
    expect(parseBehaviorAssertion('WHEN 在搜索输入框输入 → 结果刷新').trigger?.target).toBe('搜索')
    // 无介词复合框名：旧版 null（回退泛化），新版直接命中语义前缀
    expect(parseBehaviorAssertion('WHEN 搜索框输入关键词 → 显示匹配结果').trigger?.target).toBe('搜索')
    // 裸动词（无框名）：泛化 input + value 提取（不含点击——点击类优先于输入类是既有口径）
    const bare = parseBehaviorAssertion('WHEN 输入关键词 → 状态更新')
    expect(bare.trigger?.kind).toBe('fill')
    expect(bare.trigger?.target).toBe('input')
    expect(bare.trigger?.value).toBe('关键词')
  })

  it('fill 值策略：框名词里的「输入」不是动词（取第二个动词的宾语），连接词尾巴清洗', () => {
    // 「在输入框输入内容并提交」：第一个「输入」属于框名词，value 取「内容」
    const chained = parseBehaviorAssertion('WHEN 在输入框输入内容并提交 → 状态更新')
    expect(chained.trigger?.kind).toBe('fill')
    expect(chained.trigger?.target).toBe('input') // 无 label 前缀的「输入框」泛化
    expect(chained.trigger?.value).toBe('内容') // 「并提交」尾巴已清洗，不会带进值

    // value 与 target 同词时不设 value（回退固定「测试输入」，避免同词自匹配假阳性）
    const same = parseBehaviorAssertion('WHEN 在搜索框输入搜索 → 状态更新')
    expect(same.trigger?.value).toBeUndefined()
  })

  it('M-4 互查：词表可探针子集的典型句式全部解析为行为探针（不退化 presenceFallback）', () => {
    const samples: Array<[string, string]> = [
      ['WHEN 点击保存按钮 → 列表新增一条记录', 'click'],
      ['WHEN 按右方向键 → 车辆 x 坐标增加', 'key'],
      ['WHEN 按下保存按钮 → 弹出确认框', 'click'],
      ['WHEN 双击列表条目 → 显示详情弹层', 'dblclick'],
      ['WHEN 在任务输入框输入内容 → 输入框内容更新', 'fill'],
      ['WHEN 选择月份 → 汇总数值更新', 'select'],
    ]
    for (const [assertion, kind] of samples) {
      const plan = parseBehaviorAssertion(assertion)
      expect(plan.presenceFallback, assertion).toBe(false)
      expect(plan.trigger?.kind, assertion).toBe(kind)
    }
  })

  it('M-4：prompt 只渲染探针可执行子集（不可执行动词不诱导 EARS 化产出探针 MISS 形态）', () => {
    const rendered = renderTriggerVocabularyForPrompt()
    expect(rendered).toContain('点击')
    expect(rendered).toContain('按键')
    expect(rendered).toContain('输入')
    expect(rendered).toContain('选择')
    expect(rendered).toContain('双击')
    expect(rendered).not.toContain('悬停')
    expect(rendered).not.toContain('拖拽')
    expect(rendered).not.toContain('滚动')
    expect(rendered).not.toContain('聚焦')
    expect(rendered).not.toContain('上传')
  })

  it('m-7：「当处于空列表」识别为 while（while 前缀先于 when 匹配）', () => {
    const parsed = parseEarsAssertion('当处于空列表 → 显示空状态提示')
    expect(parsed.kind).toBe('while')
    expect(parsed.trigger).toBe('空列表')
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

  it('静态兜底：canvas 合法实现无关键词 → 待评估；无运行证据时不得冒充行为已满足（审计 P0-02 fail-closed）', () => {
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

    // 无运行验证证据（测试未跑）：待评估不得冒充行为已满足——退回而非放行
    const verdict = runJudge({ project_id: project.project_id, mode: 'quick' })
    expect(verdict.verdict).toBe('return')
    const constraint = verdict.hard_constraints.find((item) => item.name === 'P0 行为断言可满足性')
    expect(constraint?.passed).toBe(false)
    expect(constraint?.detail).toContain('待评估')
    expect(constraint?.detail).toContain('运行验证证据')

    // 有运行验证证据（探针未降级、无失败）：静态待评估不阻断——防 canvas 误杀依旧成立
    const withRuntime = runJudge({
      project_id: project.project_id,
      mode: 'quick',
      test_result: { total_count: 1, passed_count: 1, failed_count: 0, failure_summary: [] },
    })
    const runtimeConstraint = withRuntime.hard_constraints.find((item) => item.name === 'P0 行为断言可满足性')
    expect(runtimeConstraint?.passed).toBe(true)
    expect(runtimeConstraint?.detail).toContain('待评估')
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
      // 审计 P0-02 互斥态锁定：解析失败的真实行为断言 → 待评估（不计通过）；
      // 词表命中 → 通过。passed = total - failed - unverified，绝不冒充全绿。
      expect(result.unverified).toEqual(['F-001 按下方向键→画布重绘'])
      expect(result.passed_count).toBe(1)
      expect(result.total_count).toBe(2)
      expect(result.probe_degraded).toBe(true)
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
