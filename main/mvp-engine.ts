import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TemplateType } from '../shared/types'
import { findProject } from './project-service'
import { escapeHtml, type SketchRequirement } from './sketch-engine'

/**
 * MvpEngine — 从已确认需求生成正式 MVP 项目目录结构（模板优先，确定性、可测试）。
 *
 * 对齐 api-spec §12.3 `generate_mvp`：输出 `files + run_command + assumptions + risks`。
 * 模板为自包含纯前端应用（表单/列表/本地状态），
 * 通过 `npm start`（静态服务器）在沙箱内启动，不依赖外部依赖安装。
 *
 * ⚠️ 决策 D1：模板优先；LLM 生成型 MVP 由 A2-14b 承接（Sprint 3）。
 */

export interface GenerateMvpInput {
  project_id: string
  prd_path?: string
  requirements?: SketchRequirement[]
  template_type?: TemplateType
}

export interface GeneratedMvpFile {
  path: string
  content: string
}

export interface GenerateMvpResult {
  files: GeneratedMvpFile[]
  run_command: string
  assumptions: string[]
  risks: string[]
}

export function generateMvp(input: GenerateMvpInput): GenerateMvpResult {
  const project = findProject(input.project_id)
  const requirements = normalizeRequirements(input.requirements)
  const projectName = project.name || '未命名项目'

  const files: GeneratedMvpFile[] = [
    { path: 'package.json', content: renderPackageJson(projectName) },
    { path: 'static-server.js', content: renderStaticServer() },
    { path: 'index.html', content: renderIndexHtml(projectName, requirements) },
    { path: 'src/app.js', content: renderAppJs() },
    { path: 'src/styles.css', content: renderStylesCss() },
  ]

  for (const file of files) {
    const fullPath = join(project.root_path, file.path)
    mkdirSync(join(fullPath, '..'), { recursive: true })
    writeFileSync(fullPath, file.content, 'utf8')
  }

  return {
    files,
    run_command: 'npm start',
    assumptions: [
      'MVP 为纯前端本地应用，数据保存在浏览器本地，无需后端服务',
      `已按确认草图的 ${requirements.length} 个功能点生成对应操作区，每个功能点可增删条目`,
    ],
    risks: [
      '当前 MVP 未包含真实后端与数据库，尚不能多人协作或跨设备同步',
      '在安全沙箱的网络隔离（connect-src none）下，应用无法调用外部接口',
    ],
  }
}

function normalizeRequirements(requirements: SketchRequirement[] | undefined): SketchRequirement[] {
  if (requirements && requirements.length > 0) return requirements
  return [{ id: 'F-001', description: '把用户的想法整理成一个可运行、可操作的功能页面。' }]
}

function renderPackageJson(projectName: string): string {
  const slug = slugify(projectName) || 'bloma-mvp'
  return `${JSON.stringify(
    {
      name: slug,
      version: '0.1.0',
      private: true,
      scripts: { start: 'node static-server' },
    },
    null,
    2,
  )}\n`
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/** 自包含静态服务器：读取 PORT 环境变量（沙箱注入），带路径穿越防护与 CSP 网络隔离。 */
function renderStaticServer(): string {
  return `// 自包含静态服务器（Bloma MVP 模板）
const { createReadStream, existsSync, statSync } = require('node:fs');
const { createServer } = require('node:http');
const { extname, join, normalize, resolve, sep } = require('node:path');
const root = process.cwd();
const port = Number(process.env.PORT) || 3000;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = createServer((req, res) => {
  const rawUrl = new URL(req.url || '/', 'http://localhost');
  const requested = rawUrl.pathname === '/' ? '/index.html' : decodeURIComponent(rawUrl.pathname);
  const normalized = normalize(requested).replace(/^([/\\\\])+/, '');
  const filePath = resolve(join(root, normalized));
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  const finalPath = existsSync(filePath) && statSync(filePath).isDirectory() ? join(filePath, 'index.html') : filePath;
  if (!existsSync(finalPath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': types[extname(finalPath)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; font-src 'self'",
  });
  createReadStream(finalPath).pipe(res);
});
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') process.exit(10);
  throw err;
});
server.listen(port, '127.0.0.1', () => {
  console.log('MVP static server listening on ' + port);
});
`
}

function renderIndexHtml(projectName: string, requirements: SketchRequirement[]): string {
  const cards = requirements
    .map((requirement) => {
      const title = requirement.description.length > 24
        ? `${requirement.description.slice(0, 24)}…`
        : requirement.description
      return `
        <section class="feature" data-feature="${escapeHtml(requirement.id)}">
          <header>
            <span class="feature-id">${escapeHtml(requirement.id)}</span>
            <h2>${escapeHtml(title)}</h2>
          </header>
          <p>${escapeHtml(requirement.description)}</p>
          <form class="add-form" data-feature="${escapeHtml(requirement.id)}">
            <input name="text" placeholder="添加一项内容…" autocomplete="off" />
            <button type="submit">添加</button>
          </form>
          <ul class="items" data-feature="${escapeHtml(requirement.id)}"></ul>
        </section>
      `
    })
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(projectName)} · MVP</title>
  <link rel="stylesheet" href="/src/styles.css" />
</head>
<body>
  <main class="app">
    <div class="hero">
      <div>
        <h1>${escapeHtml(projectName)}</h1>
        <p>这是根据你确认的方向生成的可运行 MVP，改动会保存在本地。</p>
      </div>
      <span class="badge">MVP v1</span>
    </div>
    <div class="grid">${cards}</div>
  </main>
  <script src="/src/app.js"></script>
</body>
</html>
`
}

function renderAppJs(): string {
  return `// MVP 交互逻辑：按功能点增删条目，数据存本地（localStorage）
(function () {
  var KEY_PREFIX = 'bloma-mvp:';
  var forms = document.querySelectorAll('.add-form');

  function loadItems(featureId) {
    try { return JSON.parse(localStorage.getItem(KEY_PREFIX + featureId) || '[]'); }
    catch (e) { return []; }
  }
  function saveItems(featureId, items) {
    localStorage.setItem(KEY_PREFIX + featureId, JSON.stringify(items));
  }
  function renderList(featureId) {
    var list = document.querySelector('ul.items[data-feature="' + featureId + '"]');
    if (!list) return;
    list.textContent = '';
    loadItems(featureId).forEach(function (item, index) {
      var li = document.createElement('li');
      var span = document.createElement('span');
      span.textContent = item;
      var remove = document.createElement('button');
      remove.textContent = '删除';
      remove.className = 'remove';
      remove.addEventListener('click', function () {
        var items = loadItems(featureId);
        items.splice(index, 1);
        saveItems(featureId, items);
        renderList(featureId);
      });
      li.appendChild(span);
      li.appendChild(remove);
      list.appendChild(li);
    });
  }

  forms.forEach(function (form) {
    var featureId = form.getAttribute('data-feature');
    renderList(featureId);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var input = form.querySelector('input[name="text"]');
      var value = (input && input.value ? input.value : '').trim();
      if (!value) return;
      var items = loadItems(featureId);
      items.push(value);
      saveItems(featureId, items);
      renderList(featureId);
      if (input) input.value = '';
    });
  });
})();
`
}

function renderStylesCss(): string {
  return `:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
body { margin: 0; min-height: 100vh; background: #f7f5fb; color: #1d1d1f; }
.app { max-width: 1120px; margin: 0 auto; padding: 40px 24px; }
.hero { display: flex; justify-content: space-between; align-items: end; gap: 24px; margin-bottom: 24px; }
.hero h1 { margin: 0 0 8px; font-size: 30px; line-height: 1.15; }
.hero p { margin: 0; color: #6e6e73; max-width: 640px; }
.badge { border: 1px solid #e6e5ee; border-radius: 999px; padding: 8px 12px; background: #fff; color: #7c3aed; font-weight: 700; white-space: nowrap; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.feature { background: #fff; border: 1px solid #e6e5ee; border-radius: 14px; padding: 20px; box-shadow: 0 10px 30px rgba(29,29,31,.08); }
.feature header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.feature-id { font-size: 12px; font-weight: 800; letter-spacing: .08em; color: #7c3aed; }
.feature h2 { margin: 0; font-size: 18px; }
.feature p { color: #4b4b55; line-height: 1.7; min-height: 48px; margin: 8px 0 16px; }
.add-form { display: flex; gap: 8px; }
.add-form input { flex: 1; border: 1px solid #e6e5ee; border-radius: 10px; padding: 10px 12px; font-size: 14px; }
.add-form button { border: 0; border-radius: 10px; padding: 10px 16px; background: linear-gradient(135deg, #7c3aed, #ec4899); color: #fff; font-weight: 700; cursor: pointer; }
ul.items { list-style: none; margin: 16px 0 0; padding: 0; }
ul.items li { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid #f0eef7; border-radius: 10px; margin-bottom: 8px; background: #faf9fd; }
.remove { border: 0; background: transparent; color: #e5484d; cursor: pointer; font-size: 13px; }
`
}
