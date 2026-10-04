/**
 * bloma-file:// 预览协议测试（2026-10-05 方案 A）——URL 铸造边界 + handler 请求路径。
 *
 * mock 面：electron（net.fetch/protocol/registerSchemesAsPrivileged 桩；node 22 自带
 * Response/Request）；project-service（真实临时目录做项目根）。
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  net: {
    fetch: vi.fn(async (fileUrl: string) => {
      const path = decodeURIComponent(fileUrl.replace('file:///', 'C:/')).replace(/\//g, '\\')
      // 简化桩：只按扩展名回内容类型，正文用固定占位
      const isHtml = /\.html?$/i.test(fileUrl)
      return new Response(isHtml ? '<!DOCTYPE html><html><body>stub</body></html>' : 'binary', {
        status: 200,
        headers: { 'Content-Type': isHtml ? 'text/html' : 'application/octet-stream' },
      })
    }),
  },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  session: {},
}))

vi.mock('../../../main/project/project-service', () => ({
  findProject: vi.fn(),
}))

import { findProject } from '../../../main/project/project-service'
import {
  PREVIEW_SCHEME,
  installPreviewProtocolHandler,
  mintProjectPreviewUrl,
  registerPreviewSchemePrivileges,
} from '../../../main/delivery/preview-scheme'

const mockFindProject = vi.mocked(findProject)

let projectRoot: string
let handleFn: ((request: Request) => Promise<Response>) | undefined

beforeEach(() => {
  vi.clearAllMocks()
  projectRoot = mkdtempSync(join(tmpdir(), 'bloma-preview-scheme-'))
  mkdirSync(join(projectRoot, '00_UX'), { recursive: true })
  writeFileSync(join(projectRoot, '00_UX', 'ux-sketch.html'), '<!DOCTYPE html><html><body>草图</body></html>', 'utf8')
  writeFileSync(join(projectRoot, 'app.py'), 'print(1)', 'utf8')
  mockFindProject.mockImplementation(() => ({ project_id: 'p1', root_path: projectRoot }) as never)
  handleFn = undefined
})

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

function captureHandler(): (request: Request) => Promise<Response> {
  const fakeSession = {
    protocol: {
      handle: (_scheme: string, handler: (request: Request) => Promise<Response>) => {
        handleFn = handler
      },
    },
  }
  installPreviewProtocolHandler(fakeSession as never)
  if (!handleFn) throw new Error('handler 未捕获')
  return handleFn
}

describe('registerPreviewSchemePrivileges', () => {
  it('注册 bloma-file 为特权 scheme（standard/secure/supportFetchAPI/corsEnabled/stream）', async () => {
    registerPreviewSchemePrivileges()
    const electron = await import('electron')
    const protocol = vi.mocked(electron.protocol)
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
    ])
  })
})

describe('mintProjectPreviewUrl（入口铸造边界）', () => {
  it('项目内 HTML → bloma-file://<project>/<relpath>', () => {
    const url = mintProjectPreviewUrl('p1', '00_UX/ux-sketch.html')
    expect(url).toBe('bloma-file://p1/00_UX/ux-sketch.html')
  })

  it('非 HTML 入口拒绝（Proma 同款边界）', () => {
    expect(() => mintProjectPreviewUrl('p1', 'app.py')).toThrow('PREVIEW_NOT_HTML')
  })

  it('目录自动找 index.html；无 index 拒绝', () => {
    mkdirSync(join(projectRoot, 'report'), { recursive: true })
    writeFileSync(join(projectRoot, 'report', 'index.html'), '<html></html>', 'utf8')
    expect(mintProjectPreviewUrl('p1', 'report')).toBe('bloma-file://p1/report/index.html')
    mkdirSync(join(projectRoot, 'empty-dir'), { recursive: true })
    expect(() => mintProjectPreviewUrl('p1', 'empty-dir')).toThrow('PREVIEW_NO_INDEX')
  })

  it('越界路径拒绝（../ 逃逸）', () => {
    expect(() => mintProjectPreviewUrl('p1', '../outside.html')).toThrow()
  })

  it('项目不存在拒绝', () => {
    mockFindProject.mockImplementation(() => undefined as never)
    expect(() => mintProjectPreviewUrl('nope', '00_UX/ux-sketch.html')).toThrow('PREVIEW_PROJECT_MISSING')
  })
})

describe('handlePreviewFileRequest（子资源路径）', () => {
  it('HTML 入口 200 且 Content-Type 带 charset=utf-8（陷阱 40）', async () => {
    const handler = captureHandler()
    const response = await handler(new Request(`bloma-file://p1/00_UX/ux-sketch.html`))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
  })

  it('项目不存在 404；路径逃逸拒答；不存在 404', async () => {
    const handler = captureHandler()
    expect((await handler(new Request('bloma-file://ghost/x.html'))).status).toBe(404)
    // URL 标准化已把 ../ 折叠（standard scheme 第一层防御）：落到根外不存在的路径 → 404
    expect((await handler(new Request('bloma-file://p1/../../outside.html'))).status).toBe(404)
    // symlink/junction 逃逸：realpath 解到根外 → 403（isInside 第二层防御）
    const outsideDir = mkdtempSync(join(tmpdir(), 'bloma-preview-outside-'))
    writeFileSync(join(outsideDir, 'secret.html'), '<html></html>', 'utf8')
    symlinkSync(outsideDir, join(projectRoot, 'jlink'), 'junction')
    expect((await handler(new Request('bloma-file://p1/jlink/secret.html'))).status).toBe(403)
    rmSync(outsideDir, { recursive: true, force: true })
    expect((await handler(new Request('bloma-file://p1/nope.html'))).status).toBe(404)
  })

  it('非 HTML 子资源照常服务（产物页图片/样式依赖）', async () => {
    const handler = captureHandler()
    const response = await handler(new Request('bloma-file://p1/app.py'))
    expect(response.status).toBe(200)
  })

  it('安装幂等（同会话重复安装不重复挂 handler）', () => {
    const calls: string[] = []
    const fakeSession = { protocol: { handle: (scheme: string) => calls.push(scheme) } }
    installPreviewProtocolHandler(fakeSession as never)
    installPreviewProtocolHandler(fakeSession as never)
    expect(calls).toHaveLength(1)
  })
})
