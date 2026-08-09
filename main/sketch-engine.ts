import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findProject } from './project-service'

export interface SketchRequirement {
  id: string
  description: string
}

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
    summary: `已生成 ${pages.length} 个核心页面的验证草图。`,
  }
}

function normalizeRequirements(requirements: SketchRequirement[]): SketchRequirement[] {
  if (requirements.length > 0) return requirements
  return [{ id: 'F-001', description: '把用户的想法整理成一个可点击、可验证的软件草图。' }]
}

function renderSketchHtml(projectName: string, requirements: SketchRequirement[]): string {
  const cards = requirements
    .map((requirement, index) => {
      const title = pageTitle(requirement.description, index)
      return `
        <section class="screen${index === 0 ? ' active' : ''}" data-page="${escapeHtml(requirement.id)}">
          <div class="screen-header">
            <span>${escapeHtml(requirement.id)}</span>
            <strong>${escapeHtml(title)}</strong>
          </div>
          <p>${escapeHtml(requirement.description)}</p>
          <div class="mock-list">
            <button>开始使用</button>
            <button class="secondary">调整细节</button>
          </div>
        </section>
      `
    })
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(projectName)} · 验证草图</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; background: #f7f5fb; color: #1d1d1f; }
    .app { max-width: 1120px; margin: 0 auto; padding: 40px 24px; }
    .hero { display: flex; justify-content: space-between; gap: 24px; align-items: end; margin-bottom: 24px; }
    .hero h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.15; }
    .hero p { margin: 0; color: #6e6e73; max-width: 640px; }
    .badge { border: 1px solid #e6e5ee; border-radius: 999px; padding: 8px 12px; background: #fff; color: #7c3aed; font-weight: 700; white-space: nowrap; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
    .screen { background: #fff; border: 1px solid #e6e5ee; border-radius: 14px; padding: 20px; box-shadow: 0 10px 30px rgba(29,29,31,.08); min-height: 260px; }
    .screen-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 18px; color: #7c3aed; }
    .screen-header span { font-size: 12px; font-weight: 800; letter-spacing: .08em; }
    .screen-header strong { color: #1d1d1f; }
    .screen p { color: #4b4b55; line-height: 1.7; min-height: 92px; }
    .mock-list { display: grid; gap: 10px; margin-top: 24px; }
    button { border: 0; border-radius: 10px; padding: 12px 14px; background: linear-gradient(135deg, #7c3aed, #ec4899); color: #fff; font-weight: 700; cursor: pointer; }
    button.secondary { background: #f4f3fa; color: #4b4b55; }
    .screen { display: none; }
    .screen.active { display: block; }
  </style>
</head>
<body>
  <main class="app">
    <div class="hero">
      <div>
        <h1>${escapeHtml(projectName)} · 验证草图</h1>
        <p>这是一个用于确认方向的低保真草图，只覆盖最关键的使用路径。</p>
      </div>
      <span class="badge">Sketch v1</span>
    </div>
    <div class="grid">${cards}</div>
  </main>
  <script>
    (function () {
      var screens = document.querySelectorAll('.screen');
      screens.forEach(function (screen, index) {
        if (index === 0) screen.classList.add('active');
      });
      document.querySelectorAll('.mock-list button').forEach(function (button) {
        button.addEventListener('click', function () {
          var current = document.querySelector('.screen.active');
          if (!current) return;
          var next = current.nextElementSibling;
          if (next && next.classList.contains('screen')) {
            current.classList.remove('active');
            next.classList.add('active');
          }
        });
      });
    })();
  </script>
</body>
</html>
`
}

function pageTitle(description: string, index: number): string {
  const trimmed = description.replace(/\s+/g, ' ').trim()
  if (!trimmed) return `核心页面 ${index + 1}`
  return trimmed.length > 14 ? `${trimmed.slice(0, 14)}...` : trimmed
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
