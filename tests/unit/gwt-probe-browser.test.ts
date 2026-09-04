import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { restorePromaHome } from '../support/proma-home-guard'
import { createProject, recordSketchGenerated } from '../../main/project-service'
import { runBrowserGwt } from '../../main/gwt-runner'

/**
 * T-8 真浏览器探针集成测试（2026-09-02 对抗审查补证据）：
 * M-4 扩展的 fill/select/dblclick 触发器与 inputValues 状态快照此前只有纯函数测试，
 * 真实 Chromium 上的合成事件（Event dispatch vs 用户手势）、CSS display 过渡、
 * select.value 行为零覆盖。本文件走 runBrowserGwt 全链（playwright 真探针路径）。
 * 环境无 chromium 时整组跳过（CI 缺浏览器不红）。
 */
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

/** 交互测试页：点击/输入/选择/双击各有可断言的联动效果。 */
const INTERACTIVE_HTML = `<!doctype html>
<html><head><style>body{font-family:sans-serif;padding:12px}</style></head><body>
<h1 id="title">任务面板</h1>
<input id="task-input" placeholder="任务输入框">
<select id="month"><option value="1">1月</option><option value="2">2月</option></select>
<button id="start">开始按钮</button>
<ul><li class="item">条目A</li></ul>
<div id="detail" style="display:none">详情内容</div>
<script>
document.getElementById('start').addEventListener('click', function () {
  document.getElementById('title').textContent = '计时启动';
});
document.getElementById('task-input').addEventListener('input', function (e) {
  document.getElementById('title').textContent = '草稿：' + e.target.value;
});
document.getElementById('month').addEventListener('change', function (e) {
  document.getElementById('title').textContent = '汇总数值更新：' + e.target.value;
});
document.querySelector('.item').addEventListener('dblclick', function () {
  document.getElementById('detail').style.display = 'block';
});
</script>
</body></html>`

describe('GWT 真浏览器探针（T-8：M-4 扩展触发器 fill/select/dblclick 实测）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  it('click/fill/select/dblclick 四类触发器在真实 Chromium 上全链通过', { timeout: 60_000 }, async () => {
    if (!(await playwrightAvailable())) {
      console.warn('[t8] playwright chromium 不可用，跳过真浏览器探针验证')
      return
    }
    const home = mkdtempSync(join(tmpdir(), 'proma-t8-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-t8', mode: 'quick' })
    recordSketchGenerated(project.project_id, [
      {
        id: 'F-001',
        description: '交互面板',
        priority: 'P0',
        behavior_assertions: [
          'WHEN 点击开始按钮 → 计时启动',
          'WHEN 在任务输入框输入内容 → 输入框内容更新',
          'WHEN 选择月份 → 汇总数值更新',
          'WHEN 双击条目 → 显示详情弹层',
        ],
      },
    ])

    const server = createServer((_req, res) => {
      // charset=utf-8 对齐真实 static-server（platform-services/project-scaffold 的 MIME 表）：
      // 缺 charset 时 Chromium 按 Latin-1 解码，中文按钮文本全乱码 → 探针 find 全 MISS
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(INTERACTIVE_HTML)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const result = await runBrowserGwt({
        project_id: project.project_id,
        session_id: 'session-t8',
        preview_url: `http://127.0.0.1:${port}`,
      })
      expect(result, '真探针应可用（返回 null = 降级静态兜底，本用例要求真浏览器路径）').not.toBeNull()
      expect(result!.total_count).toBe(4)
      expect(result!.failed_count).toBe(0)
      expect(result!.failure_summary).toEqual([])
    } finally {
      server.close()
    }
  })

  it('探针失败方向如实：断言效果与页面行为不符时该场景失败（防「全绿假象」）', { timeout: 60_000 }, async () => {
    if (!(await playwrightAvailable())) return
    const home = mkdtempSync(join(tmpdir(), 'proma-t8-neg-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-t8n', mode: 'quick' })
    recordSketchGenerated(project.project_id, [
      {
        id: 'F-001',
        description: '交互面板',
        priority: 'P0',
        behavior_assertions: ['WHEN 点击开始按钮 → 计时启动'],
      },
    ])

    // 页面点击后不做任何事（与断言的 text-change 效果不符）
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body><button id="start">开始按钮</button></body></html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const result = await runBrowserGwt({
        project_id: project.project_id,
        session_id: 'session-t8n',
        preview_url: `http://127.0.0.1:${port}`,
      })
      expect(result).not.toBeNull()
      expect(result!.failed_count).toBe(1)
      expect(result!.failure_summary[0]!.scenario).toContain('F-001')
      expect(result!.failure_summary[0]!.reason).toContain('计时启动')
    } finally {
      server.close()
    }
  })

  it('P0-1：click 探针只认真可见控件——隐藏 overlay 的「暂停…」按钮不抢跑命中', { timeout: 60_000 }, async () => {
    if (!(await playwrightAvailable())) return
    const home = mkdtempSync(join(tmpdir(), 'proma-p01-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-p01', mode: 'quick' })
    recordSketchGenerated(project.project_id, [
      { id: 'F-001', description: '暂停菜单', priority: 'P0', behavior_assertions: ['点击暂停→菜单显示'] },
    ])

    // 隐藏 overlay 里的「暂停游戏继续」按钮（display:none）在 DOM 里排在可见「暂停」按钮之前：
    // 修复前 find 命中它（text 含「暂停」），点中 display:none 无效果 → 菜单不显示 → show 假失败。
    // 修复后过滤可见，命中可见「暂停」按钮 → 菜单显示 → show 探针通过。
    const HTML = `<!doctype html><html><head><style>.hidden{display:none}</style></head><body>
<div id="menu" class="hidden"><button>暂停游戏继续</button></div>
<button id="pause">暂停</button>
<script>
document.getElementById('pause').addEventListener('click', function () {
  document.getElementById('menu').classList.remove('hidden');
});
</script></body></html>`

    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(HTML)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const result = await runBrowserGwt({
        project_id: project.project_id,
        session_id: 'session-p01',
        preview_url: `http://127.0.0.1:${port}`,
      })
      expect(result).not.toBeNull()
      expect(result!.failed_count).toBe(0)
      expect(result!.failure_summary).toEqual([])
    } finally {
      server.close()
    }
  })

  it('P0-1：探针视角清单不含 display:none 隐藏按钮（不再误导模型）', { timeout: 60_000 }, async () => {
    if (!(await playwrightAvailable())) return
    const home = mkdtempSync(join(tmpdir(), 'proma-p01b-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-p01b', mode: 'quick' })
    recordSketchGenerated(project.project_id, [
      { id: 'F-001', description: '记录面板', priority: 'P0', behavior_assertions: ['点击保存→列表新增一条记录'] },
    ])

    // 可见「保存」按钮 + 隐藏 overlay「继续/放弃本局」按钮；点击保存无新增（add-item 必败）
    // → 失败 reason 拼「探针视角：可点击控件…」，修复后清单只含可见「保存」，不含隐藏按钮。
    const HTML = `<!doctype html><html><body>
<button id="save">保存</button>
<div style="display:none"><button>继续</button><button>放弃本局</button></div>
<script>document.getElementById('save').addEventListener('click', function () {})</script>
</body></html>`

    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(HTML)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const result = await runBrowserGwt({
        project_id: project.project_id,
        session_id: 'session-p01b',
        preview_url: `http://127.0.0.1:${port}`,
      })
      expect(result).not.toBeNull()
      expect(result!.failed_count).toBe(1)
      expect(result!.failure_summary[0]!.reason).toContain('保存')
      expect(result!.failure_summary[0]!.reason).not.toContain('继续')
      expect(result!.failure_summary[0]!.reason).not.toContain('放弃本局')
    } finally {
      server.close()
    }
  })
})
