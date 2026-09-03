/**
 * ProjectScaffold — 平台托管的系统接管文件（package.json / static-server.js）。
 *
 * Agent Loop 的工具集（write_file/edit_file）无权写这两个「系统接管」文件（agent-tools 拒绝），
 * 因此它们由平台在 loop 结束后补齐。原属 mvp-engine.ts（模板引擎），废旧管道改造后模板引擎
 * 整体删除，仅保留这两个平台托管文件渲染函数——loop 是唯一运行时，产物骨架也由 loop 产出。
 */

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export function renderPackageJson(projectName: string): string {
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

/** 自包含静态服务器：读取 PORT 环境变量（沙箱注入），带路径穿越防护与 CSP 网络隔离。 */
export function renderStaticServer(): string {
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
