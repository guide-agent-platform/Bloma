/**
 * 草图引擎（确定性模板生成）。
 *
 * 2026-09-03 模块化 R1：PRD 域类型/守卫 helper/背板/长文本兜底已迁出至 model/prd-backplane.ts
 * （契约层独立，依赖倒置）。此处全量 re-export 保持既有 import 兼容——过渡一个 sprint 后
 * 各群改直连 model 层，re-export 移除。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findProject } from './project-service'

export * from './model/prd-backplane'
import type { SketchRequirement } from './model/prd-backplane'

export interface GenerateSketchInput {
  project_id: string
  requirements: SketchRequirement[]
  max_pages?: number
}

export interface GeneratedSketchFile {
  path: string
  content: string
}

export interface GenerateSketchResult {
  files: GeneratedSketchFile[]
  run_command: string
  summary: string
}

export function generateSketch(input: GenerateSketchInput): GenerateSketchResult {
  const project = findProject(input.project_id)
  const requirements = normalizeRequirements(input.requirements)
  const maxPages = Math.min(Math.max(input.max_pages ?? 3, 1), 3)
  const pages = requirements.slice(0, maxPages)
  const html = renderSketchHtml(project.name, pages)
  const relativePath = 'index.html'

  writeFileSync(join(project.root_path, relativePath), html, 'utf8')

  return {
    files: [{ path: relativePath, content: html }],
    run_command: 'node static-server',
    summary: `已生成 ${pages.length} 个功能区块的外观草图。`,
  }
}

function normalizeRequirements(requirements: SketchRequirement[]): SketchRequirement[] {
  if (requirements.length > 0) return requirements
  return [{ id: 'F-001', description: '把用户的想法整理成一个软件。' }]
}

/**
 * 渲染草图——无交互的纯外观界面（低保真静态原型）。
 *
 * - 不再产出「需求卡片列表 + 点击切换」，而是按功能项描述推断 UI 形态（表单/列表/
 *   统计/搜索/通用卡片），拼成一个像真实产品的静态外观。
 * - 无交互：不输出任何 `<script>`/事件绑定，整页 `pointer-events: none`，控件只看不动，
 *   让用户在「确认方向」阶段聚焦"看起来像什么"，而不是"能不能点"。
 */
function renderSketchHtml(projectName: string, requirements: SketchRequirement[]): string {
  const positioning = requirements[0]?.description ?? projectName
  const blocks = requirements
    .map((requirement) => {
      const kind = inferUiKind(requirement.description)
      return `
        <section class="block" data-page="${escapeHtml(requirement.id)}">
          <div class="block-head">
            <span class="block-id">${escapeHtml(requirement.id)}</span>
            <h2>${escapeHtml(blockTitle(requirement.description))}</h2>
          </div>
          ${renderUiBody(kind)}
        </section>
      `
    })
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(projectName)} · 外观草图</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f2f9; --ink: #1d1d1f; --muted: #6e6e73; --card: #ffffff; --line: #e7e4f0;
      --accent: #7c3aed; --accent-2: #ec4899; --radius: 16px;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; }
    body { min-height: 100vh; background: var(--bg); color: var(--ink); -webkit-font-smoothing: antialiased; pointer-events: none; user-select: none; }
    .topbar { display: flex; align-items: center; gap: 24px; padding: 16px 28px; background: rgba(255,255,255,.85); border-bottom: 1px solid var(--line); backdrop-filter: blur(8px); position: sticky; top: 0; }
    .brand { font-weight: 800; font-size: 15px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .nav { display: flex; gap: 18px; margin-left: auto; color: var(--muted); font-size: 13px; }
    .nav span:first-child { color: var(--accent); font-weight: 700; }
    .page { max-width: 960px; margin: 0 auto; padding: 40px 24px 64px; }
    .hero { text-align: center; padding: 24px 0 36px; }
    .hero h1 { margin: 0 0 10px; font-size: 32px; letter-spacing: -0.02em; }
    .hero p { margin: 0 auto 22px; color: var(--muted); max-width: 560px; line-height: 1.7; }
    .cta { display: inline-block; padding: 12px 26px; border-radius: 999px; color: #fff; font-weight: 700; background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 10px 24px rgba(124,58,237,.28); }
    .blocks { display: grid; gap: 18px; }
    .block { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 22px; box-shadow: 0 8px 24px rgba(29,29,31,.05); }
    .block-head { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
    .block-id { font-size: 11px; font-weight: 800; letter-spacing: .06em; color: var(--accent); background: #f1edfd; padding: 4px 8px; border-radius: 6px; }
    .block-head h2 { margin: 0; font-size: 16px; }
    .ui-form { display: grid; gap: 12px; }
    .field { display: grid; gap: 6px; }
    .field label { font-size: 12px; color: var(--muted); }
    .field .input { height: 40px; border: 1px solid var(--line); border-radius: 10px; background: #faf9fd; padding: 0 12px; display: flex; align-items: center; color: #c2bfd0; font-size: 13px; }
    .btn { display: inline-flex; justify-content: center; align-items: center; height: 40px; padding: 0 18px; border-radius: 10px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff; font-weight: 700; font-size: 14px; }
    .btn.ghost { background: #f4f2fa; color: #4b4b55; }
    .ui-list { display: grid; gap: 10px; }
    .li { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; }
    .li .dot { width: 34px; height: 34px; border-radius: 10px; background: linear-gradient(135deg, #e0d8ff, #fbd5e8); flex: none; }
    .li strong { font-size: 14px; display: block; }
    .li small { color: var(--muted); }
    .li .amount { margin-left: auto; font-weight: 800; color: var(--accent); }
    .ui-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
    .stat { padding: 16px; border: 1px solid var(--line); border-radius: 12px; background: #fbfaff; }
    .stat small { color: var(--muted); display: block; margin-bottom: 6px; }
    .stat strong { font-size: 20px; }
    .search-bar { display: flex; align-items: center; gap: 10px; height: 42px; border: 1px solid var(--line); border-radius: 12px; padding: 0 14px; background: #faf9fd; color: #c2bfd0; }
    .ui-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .mini-card { border: 1px solid var(--line); border-radius: 12px; padding: 16px; background: #fbfaff; min-height: 80px; }
    .mini-card .bar { height: 8px; border-radius: 999px; background: linear-gradient(90deg, #e0d8ff, #fbd5e8); width: 70%; margin-top: 12px; }
    .btn-row { display: flex; gap: 10px; margin-top: 14px; }
    .foot { text-align: center; color: #b6b3c4; font-size: 12px; padding: 24px 0; }
  </style>
</head>
<body>
  <header class="topbar">
    <span class="brand">${escapeHtml(projectName)}</span>
    <nav class="nav"><span>首页</span><span>功能</span><span>设置</span></nav>
  </header>
  <main class="page">
    <section class="hero">
      <h1>${escapeHtml(projectName)}</h1>
      <p>${escapeHtml(positioning)}</p>
      <span class="cta">开始使用</span>
    </section>
    <div class="blocks">${blocks}</div>
  </main>
  <footer class="foot">外观草图 · 仅供确认方向，交互在「生成完整功能」后可用</footer>
</body>
</html>
`
}

/** 根据功能项描述推断 UI 形态（纯启发式，不调 LLM），让草图外观贴合功能。 */
type UiKind = 'dashboard' | 'search' | 'form' | 'list' | 'generic'

function inferUiKind(description: string): UiKind {
  if (/(结余|统计|概览|报表|图表|总数|合计|仪表|汇总|趋势|余额|分析)/.test(description)) return 'dashboard'
  if (/(搜索|查询|检索|查找)/.test(description)) return 'search'
  if (/(输入|填写|添加|新增|记录|录入|登记|记账|创建|发布|提交)/.test(description)) return 'form'
  if (/(列表|展示|查看|浏览|历史|明细|看板|清单|日志)/.test(description)) return 'list'
  return 'generic'
}

/** 按 UI 形态渲染静态外观区块（无交互，纯视觉占位）。 */
function renderUiBody(kind: UiKind): string {
  switch (kind) {
    case 'dashboard':
      return `
        <div class="ui-stats">
          <div class="stat"><small>本月收入</small><strong>¥0</strong></div>
          <div class="stat"><small>本月支出</small><strong>¥0</strong></div>
          <div class="stat"><small>结余</small><strong>¥0</strong></div>
        </div>
      `
    case 'search':
      return `
        <div class="search-bar">🔍&nbsp;&nbsp;搜索…</div>
        <div class="ui-list" style="margin-top:12px;">
          <div class="li"><span class="dot"></span><div><strong>结果项</strong><small>匹配内容占位</small></div></div>
        </div>
      `
    case 'form':
      return `
        <div class="ui-form">
          <div class="field"><label>名称</label><div class="input">请输入名称…</div></div>
          <div class="field"><label>金额</label><div class="input">请输入金额…</div></div>
          <div class="btn-row"><span class="btn">保存</span><span class="btn ghost">取消</span></div>
        </div>
      `
    case 'list':
      return `
        <div class="ui-list">
          <div class="li"><span class="dot"></span><div><strong>项目 A</strong><small>描述占位</small></div><span class="amount">¥0</span></div>
          <div class="li"><span class="dot"></span><div><strong>项目 B</strong><small>描述占位</small></div><span class="amount">¥0</span></div>
          <div class="li"><span class="dot"></span><div><strong>项目 C</strong><small>描述占位</small></div><span class="amount">¥0</span></div>
        </div>
      `
    default:
      return `
        <div class="ui-cards">
          <div class="mini-card"><strong>卡片一</strong><div class="bar"></div></div>
          <div class="mini-card"><strong>卡片二</strong><div class="bar"></div></div>
        </div>
        <div class="btn-row"><span class="btn">主要操作</span><span class="btn ghost">次要操作</span></div>
      `
  }
}

function blockTitle(description: string): string {
  const trimmed = description.replace(/\s+/g, ' ').trim()
  if (!trimmed) return '功能'
  return trimmed.length > 20 ? `${trimmed.slice(0, 20)}…` : trimmed
}

/** HTML 转义工具（导出供 mvp-engine 等复用，避免各模板各自实现一份）。 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
