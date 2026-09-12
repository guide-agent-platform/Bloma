import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSkeletonDirPath } from '../../storage/config-paths'
import { loadSkeletonTemplate } from '../../main/project-templates'
import { renderSkeletonToProject, scaffoldEnabled } from '../../main/project-scaffold'
import { buildLoopInjection, buildSkeletonMapInjection } from '../../main/template-injection'

/**
 * PR-1 骨架先行（2026-09-03）：骨架包加载（内置/外置/fail-closed）、确定性渲染幂等、
 * 骨架内容自检（沙箱口径）、注入⑥骨架地图（活真相源替代 tech_skeleton 文本）。
 * 陷阱 42 三锁对应：渲染幂等（已存在跳过）、决策行落盘（mock 断言）、内容自检。
 */

vi.mock('../../main/decision-log', () => ({
  recordDecision: vi.fn(),
}))

import { recordDecision } from '../../main/decision-log'

/** 递归列出目录下全部相对路径文件（同源校验：目录实际文件 ⊆ manifest 清单）。 */
function listFilesRecursive(root: string, subDir = ''): string[] {
  const out: string[] = []
  const base = subDir ? join(root, subDir) : root
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const rel = subDir ? `${subDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listFilesRecursive(root, rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out.sort()
}

describe('project-skeleton（PR-1：骨架包 + 渲染 + 注入⑥骨架地图）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalScaffold = process.env.BLOMA_SCAFFOLD

  beforeEach(() => {
    vi.mocked(recordDecision).mockClear()
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-skel-'))
  })

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    if (originalScaffold === undefined) delete process.env.BLOMA_SCAFFOLD
    else process.env.BLOMA_SCAFFOLD = originalScaffold
  })

  describe('加载（loadSkeletonTemplate）', () => {
    it('web_fullstack：内置加载成功，结构齐全（baseDir 文件可读、source=builtin）', () => {
      const skeleton = loadSkeletonTemplate('web_fullstack')
      expect(skeleton).not.toBeNull()
      expect(skeleton!.type).toBe('web_fullstack')
      expect(skeleton!.version).toBeGreaterThanOrEqual(1)
      expect(skeleton!.source).toBe('builtin')
      expect(skeleton!.files.length).toBeGreaterThanOrEqual(4)
      for (const entry of skeleton!.files) {
        expect(existsSync(join(skeleton!.baseDir, entry.path))).toBe(true)
      }
    })

    it('v1 仅 web_fullstack 提供骨架：personal_tool / desktop_tool / ai_app 均为 null（现状从零写）', () => {
      expect(loadSkeletonTemplate('personal_tool')).toBeNull()
      expect(loadSkeletonTemplate('desktop_tool')).toBeNull()
      expect(loadSkeletonTemplate('ai_app')).toBeNull()
    })

    it('P1-9：game 复用 web_fullstack 骨架（type 修正为 game、files 与 web_fullstack 同源）', () => {
      const game = loadSkeletonTemplate('game')
      const web = loadSkeletonTemplate('web_fullstack')
      expect(game).not.toBeNull()
      expect(game!.type).toBe('game')
      expect(web).not.toBeNull()
      // 骨架文件清单与 web_fullstack 同源（复用，非独立骨架包）
      expect(game!.files.map((f) => f.path)).toEqual(web!.files.map((f) => f.path))
      expect(game!.source).toBe('builtin')
    })

    it('manifest 与骨架目录同源：目录实际文件（除 manifest.json）全部在 manifest 清单内', () => {
      const skeleton = loadSkeletonTemplate('web_fullstack')!
      const declared = new Set(skeleton.files.map((entry) => entry.path))
      const actual = listFilesRecursive(skeleton.baseDir).filter((path) => path !== 'manifest.json')
      for (const path of actual) expect(declared.has(path)).toBe(true)
      // 反向：manifest 声明的文件都真实存在（加载校验已保证，显式断言防回归）
      expect(actual.length).toBe(skeleton.files.length)
    })

    it('外置合法骨架生效（source=override），文件内容以外置为准', () => {
      const dir = getSkeletonDirPath('web-fullstack')
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
        type: 'web_fullstack',
        version: 7,
        files: [{ path: 'index.html', role: '外置入口' }],
      }), 'utf8')
      writeFileSync(join(dir, 'index.html'), '<html><body>override</body></html>', 'utf8')

      const skeleton = loadSkeletonTemplate('web_fullstack')
      expect(skeleton!.source).toBe('override')
      expect(skeleton!.version).toBe(7)
      expect(readFileSync(join(skeleton!.baseDir, 'index.html'), 'utf8')).toContain('override')
      rmSync(dir, { recursive: true, force: true })
    })

    it.each([
      ['manifest 坏 JSON', (dir: string) => writeFileSync(join(dir, 'manifest.json'), '{bad json', 'utf8')],
      ['type 不匹配', (dir: string) => writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ type: 'personal_tool', files: [{ path: 'index.html' }] }), 'utf8')],
      ['声明文件不存在', (dir: string) => writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ type: 'web_fullstack', files: [{ path: 'missing.html' }] }), 'utf8')],
      ['路径越界（../）', (dir: string) => writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ type: 'web_fullstack', files: [{ path: '../escape.html' }] }), 'utf8')],
    ])('外置非法（%s）→ fail-closed 回退内置 + 决策日志 skeleton_override_rejected', (_name, corrupt) => {
      const dir = getSkeletonDirPath('web-fullstack')
      mkdirSync(dir, { recursive: true })
      corrupt(dir)

      const skeleton = loadSkeletonTemplate('web_fullstack', { project_id: 'p1', session_id: 's1' })
      expect(skeleton).not.toBeNull()
      expect(skeleton!.source).toBe('builtin_fallback')
      expect(recordDecision).toHaveBeenCalledTimes(1)
      const entry = vi.mocked(recordDecision).mock.calls[0][0].entry
      expect(entry.type).toBe('skeleton_override_rejected')
      rmSync(dir, { recursive: true, force: true })
    })
  })

  describe('渲染（renderSkeletonToProject，确定性 + 幂等）', () => {
    it('首次渲染：全部写入且内容与骨架包逐字一致', () => {
      const skeleton = loadSkeletonTemplate('web_fullstack')!
      const target = mkdtempSync(join(tmpdir(), 'skel-render-'))
      const result = renderSkeletonToProject(skeleton, target)
      expect(result.written.sort()).toEqual(skeleton.files.map((entry) => entry.path).sort())
      expect(result.skipped).toEqual([])
      for (const entry of skeleton.files) {
        expect(readFileSync(join(target, entry.path), 'utf8')).toBe(readFileSync(join(skeleton.baseDir, entry.path), 'utf8'))
      }
    })

    it('幂等：二次渲染全部跳过；agent 改过的文件不被覆盖（陷阱 42：迭代重跑不破坏既有产物）', () => {
      const skeleton = loadSkeletonTemplate('web_fullstack')!
      const target = mkdtempSync(join(tmpdir(), 'skel-render-'))
      renderSkeletonToProject(skeleton, target)
      // 模拟编程 Agent 已填充业务内容
      writeFileSync(join(target, 'index.html'), '<html><body>filled by agent</body></html>', 'utf8')

      const second = renderSkeletonToProject(skeleton, target)
      expect(second.written).toEqual([])
      expect(second.skipped.sort()).toEqual(skeleton.files.map((entry) => entry.path).sort())
      expect(readFileSync(join(target, 'index.html'), 'utf8')).toContain('filled by agent')
    })
  })

  describe('开关（BLOMA_SCAFFOLD）', () => {
    it.each(['0', 'off', 'false'])('BLOMA_SCAFFOLD=%s → 关闭（现状从零写）', (value) => {
      process.env.BLOMA_SCAFFOLD = value
      expect(scaffoldEnabled()).toBe(false)
    })

    it('缺省/显式开 → 启用', () => {
      delete process.env.BLOMA_SCAFFOLD
      expect(scaffoldEnabled()).toBe(true)
      process.env.BLOMA_SCAFFOLD = '1'
      expect(scaffoldEnabled()).toBe(true)
    })
  })

  describe('骨架内容自检（工程链口径：骨架源文件零依赖可直接加载；产物经 esbuild 打包后加载）', () => {
    it('index.html：以 </html> 结尾、含 <style>（isHtmlDocument 判据）、结构标签配平', () => {
      const skeleton = loadSkeletonTemplate('web_fullstack')!
      const html = readFileSync(join(skeleton.baseDir, 'index.html'), 'utf8')
      expect(html.trimEnd().endsWith('</html>')).toBe(true)
      expect(html).toContain('<style>')
      for (const tag of ['html', 'head', 'body', 'script']) {
        const open = (html.match(new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi')) ?? []).length
        const close = (html.match(new RegExp(`</${tag}>`, 'gi')) ?? []).length
        expect(open).toBe(close)
      }
      // 引用必须是本地相对路径（外部 CDN 引用会被工具层拦截，骨架自身先合规）
      expect(html).not.toMatch(/<script[^>]+src\s*=\s*["']https?:\/\//i)
      expect(html).not.toMatch(/<link[^>]+href\s*=\s*["']https?:\/\//i)
    })

    it('A1 script 承接位：index.html 预置构建产物引用 dist/app.js（不再直接引源文件）', () => {
      const skeleton = loadSkeletonTemplate('web_fullstack')!
      const html = readFileSync(join(skeleton.baseDir, 'index.html'), 'utf8')
      expect(html).toContain('<script src="./dist/app.js" defer></script>')
      expect(html).not.toContain('<script src="src/app.js">')
    })

    it.each(['src/app.js', 'src/examples/data-module.js'])('%s：无 fetch/XHR/import/外链（骨架源文件自身零依赖，可直接加载）', (path) => {
      const skeleton = loadSkeletonTemplate('web_fullstack')!
      const js = readFileSync(join(skeleton.baseDir, path), 'utf8')
      expect(js).not.toMatch(/\bfetch\s*\(/)
      expect(js).not.toMatch(/XMLHttpRequest/)
      expect(js).not.toMatch(/^\s*import\s/m)
      expect(js).not.toMatch(/https?:\/\//)
    })

    it('A1 口径对齐：app.js 头部注释不再禁 ESM/localStorage 唯一化，改为构建链 + server/routes 口径', () => {
      const skeleton = loadSkeletonTemplate('web_fullstack')!
      const js = readFileSync(join(skeleton.baseDir, 'src/app.js'), 'utf8')
      // 旧矛盾注释（禁 ESM / 禁网络 / localStorage 内联）必须清除——审计案 35c1a633 根因①
      expect(js).not.toContain('不使用 import/ESM 模块语法')
      expect(js).not.toContain('不发起任何网络请求')
      expect(js).not.toContain('数据一律内联或 localStorage')
      // 新口径：构建链与后端持久化显影
      expect(js).toContain('dist/app.js')
      expect(js).toContain('server/routes')
    })

    it('A2 路由样例：server/routes/_example.js 在骨架清单内，CJS 格式（module.exports，无 ESM 语法）且不挂真实路由', () => {
      const skeleton = loadSkeletonTemplate('web_fullstack')!
      const entry = skeleton.files.find((file) => file.path === 'server/routes/_example.js')
      expect(entry).toBeDefined()
      expect(entry?.readonly).toBe(true)
      const js = readFileSync(join(skeleton.baseDir, 'server/routes/_example.js'), 'utf8')
      expect(js).toContain("module.exports = {}")
      expect(js).toContain("'GET /'")
      // 真实路由代码全部在注释里（样例不挂载任何端点，require 零副作用）
      expect(js.replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, '')).not.toMatch(/module\.exports\s*=\s*\{[^}]/)
      // CJS 契约关键词（static-server require 加载 / 禁 ESM）必有一数
      expect(js).toContain('CommonJS')
      expect(js).toContain('禁用 ESM')
    })

    it('examples 中性：不含业务化中文词条（防照抄业务内容）', () => {
      const skeleton = loadSkeletonTemplate('web_fullstack')!
      const example = readFileSync(join(skeleton.baseDir, 'src/examples/data-module.js'), 'utf8')
      for (const word of ['记账', '订单', '商品', '购物车', 'todo', 'Todo', '博客']) {
        expect(example).not.toContain(word)
      }
    })
  })

  describe('注入⑥骨架地图（活真相源替代 tech_skeleton 文本）', () => {
    it('buildSkeletonMapInjection：含文件清单 / 只读声明 / 渲染计数', () => {
      const skeleton = loadSkeletonTemplate('web_fullstack')!
      const map = buildSkeletonMapInjection(skeleton, { written: ['index.html'], skipped: ['src/app.js'] })
      expect(map).toContain('工程骨架已就位')
      expect(map).toContain('index.html')
      expect(map).toContain('src/examples/data-module.js')
      expect(map).toContain('只读')
      expect(map).toContain('新写入 1 个')
      expect(map).toContain('跳过 1 个')
    })

    it('buildLoopInjection(skeletonMap)：地图替代 tech_skeleton 文本段（防双口径漂移）', () => {
      const skeleton = loadSkeletonTemplate('web_fullstack')!
      const map = buildSkeletonMapInjection(skeleton, { written: [], skipped: [] })!
      const injected = buildLoopInjection('web_fullstack', map)!
      expect(injected).toContain('工程骨架已就位')
      // md 模板 tech_skeleton 段的独特字样不应再出现（被活地图替代）
      expect(injected).not.toContain('可选拆分')
      // 依赖白名单段保留（与骨架无关的口径）
      expect(injected).toContain('依赖白名单')
    })

    it('buildLoopInjection()（无骨架）：维持现状文本（tech_skeleton 段照旧）', () => {
      const injected = buildLoopInjection('web_fullstack')
      expect(injected).not.toContain('工程骨架已就位')
      expect(injected).toContain('可选拆分')
    })
  })
})
