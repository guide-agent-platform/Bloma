/**
 * bloma-file:// 本地预览协议（2026-10-05 确认门批，方案 A——对齐 Proma 的 proma-file 实现）。
 *
 * 动机：沙箱静态服务器是 web 线遗产（子进程/端口/探活/node 解析四个故障域），为渲染
 * 静态草图等产物付出的成本与风险不成比例（10-04 两起真机事故均源自探活语义）。改为
 * 主进程内 protocol.handle 直接把磁盘文件回流给 Chromium：零子进程、零端口、零探活，
 * URL 即文件（应用重启后仍有效）。
 *
 * 安全模型（照搬 Proma createAuthorizedPreviewUrl/handlePromaFileRequest）：
 * - scheme 注册为特权（standard/secure/supportFetchAPI/corsEnabled/stream）；
 * - URL 形态 bloma-file://<project_id>/<相对路径>——host 位是项目 id（UUID），不泄露绝对路径；
 * - handler 对目标做 realpath + 项目根边界校验，越界 403、项目不存在 404；
 * - 入口 URL 铸造（mintProjectPreviewUrl）只放行 .html/.htm（目录自动找 index.html）；
 *   handler 对根内其余文件按子资源放行（产物页的图片/样式依赖）；
 * - 出站网络守卫按 URL 模式只拦 http/https/ws/wss，本协议请求不进拦截器（同 Proma）。
 */
import { net, protocol, session } from 'electron'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findProject } from '../project/project-service'
import { injectSketchViewport } from '../../shared/sketch-viewport'

export const PREVIEW_SCHEME = 'bloma-file'

/** 启动早期（app ready 前）调用：特权 scheme 注册。 */
export function registerPreviewSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ])
}

function isInsideDirectory(target: string, root: string): boolean {
  const rel = target.substring(root.length)
  return rel === '' || rel.startsWith(sep)
}

const installedSessions = new WeakSet<object>()

/** 会话级安装（幂等）：bloma-file 请求 → 项目根内文件。 */
export function installPreviewProtocolHandler(target = session.defaultSession): void {
  if (installedSessions.has(target)) return
  installedSessions.add(target)
  target.protocol.handle(PREVIEW_SCHEME, (request) => handlePreviewFileRequest(request))
}

async function handlePreviewFileRequest(request: Request): Promise<Response> {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return new Response('Bad Request', { status: 400 })
  }
  const projectId = url.hostname
  const project = findProject(projectId)
  if (!project?.root_path) return new Response('Not Found', { status: 404 })
  let root: string
  try {
    root = realpathSync(project.root_path)
  } catch {
    return new Response('Not Found', { status: 404 })
  }
  const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  let target = root
  if (relativePath) {
    try {
      target = realpathSync(resolve(root, relativePath))
    } catch {
      return new Response('Not Found', { status: 404 })
    }
    if (!isInsideDirectory(target, root)) {
      return new Response('Forbidden', { status: 403 })
    }
    try {
      if (statSync(target).isDirectory()) {
        const indexCandidates = ['index.html', 'index.htm']
          .map((name) => join(target, name))
          .find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
        if (!indexCandidates) return new Response('Not Found', { status: 404 })
        target = indexCandidates
      }
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  }
  // HTML 入口补 charset（陷阱 40：无 charset 头时 Latin-1 解码乱码；meta 标签兜底但显式更稳）
  const response = await net.fetch(pathToFileURL(target).toString())
  if (/^\.(html|htm)$/i.test(extname(target))) {
    const headers = new Headers(response.headers)
    headers.set('Content-Type', 'text/html; charset=utf-8')
    if (url.searchParams.get('bloma-viewport') === '1') {
      headers.delete('Content-Length')
      return new Response(injectSketchViewport(await response.text()), { status: response.status, headers })
    }
    return new Response(response.body, { status: response.status, headers })
  }
  return response
}

/**
 * 入口 URL 铸造（对齐 Proma createAuthorizedPreviewUrl 的边界语义）：
 * 项目内相对路径 → 必须存在且为 .html/.htm（目录自动找 index）→ bloma-file URL。
 * 供生成侧（UX 草图门等）产出可直接进 iframe 的预览地址。
 */
export function mintProjectPreviewUrl(projectId: string, relativeHtmlPath: string): string {
  const project = findProject(projectId)
  if (!project?.root_path) throw new Error('PREVIEW_PROJECT_MISSING: 项目不存在或根目录缺失')
  const root = realpathSync(project.root_path)
  const target = realpathSync(resolve(root, relativeHtmlPath))
  if (!isInsideDirectory(target, root)) throw new Error('PREVIEW_PATH_ESCAPE: 预览路径越过项目根')
  if (statSync(target).isDirectory()) {
    const indexCandidates = ['index.html', 'index.htm']
      .map((name) => join(target, name))
      .find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
    if (!indexCandidates) throw new Error('PREVIEW_NO_INDEX: 目录内无 index.html')
    return mintProjectPreviewUrl(projectId, relativePathJoin(relativeHtmlPath, 'index.html'))
  }
  const extension = extname(target).toLowerCase()
  if (!['.html', '.htm'].includes(extension)) {
    throw new Error(`PREVIEW_NOT_HTML: 入口只支持 HTML，当前为 ${extname(target) || '无扩展名'}`)
  }
  const relative = target.substring(root.length + 1).split(sep).map(encodeURIComponent).join('/')
  return `${PREVIEW_SCHEME}://${projectId}/${relative}`
}

function relativePathJoin(dir: string, name: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '')
  return `${trimmed}/${name}`
}
