import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildModuleMapInjection,
  loadOfficialModules,
  renderOfficialModulesToProject,
  type OfficialModule,
} from '../../main/coding/module-library'

/**
 * 官方模块库单元测试（P1 模块侧）：加载（内置资产 + fixture 注入）、坏模块/外链依赖
 * 拒绝、渲染幂等、地图注入文本、开关。
 */

function makeModule(dir: string, slug: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const modDir = join(dir, slug)
  mkdirSync(modDir, { recursive: true })
  writeFileSync(join(modDir, 'module.json'), JSON.stringify(manifest), 'utf8')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(modDir, path).split(/[\\/]/).slice(0, -1).join('/'), { recursive: true })
    writeFileSync(join(modDir, path), content, 'utf8')
  }
  return modDir
}

function validManifest(slug: string, categories: string[], files: string[]): Record<string, unknown> {
  return {
    slug,
    name: `${slug} 模块`,
    categories,
    version: 1,
    summary: '摘要',
    whenToUse: '适用场景',
    whenNotToUse: '不用场景',
    files: files.map((path) => ({ path, role: '源码' })),
  }
}

const TEST_ROOT = () => {
  const root = mkdtempSync(join(tmpdir(), 'bloma-modules-'))
  return root
}

describe('module-library（P1 模块侧）', () => {
  let root = ''
  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true })
  })

  describe('loadOfficialModules：内置资产加载', () => {
    it('game 类型返回游戏模块 + 跨类 storage-state，不含纯 web 模块', () => {
      const { modules, rejected } = loadOfficialModules('game')
      expect(rejected).toEqual([])
      const slugs = modules.map((m) => m.slug)
      expect(slugs).toContain('game-loop')
      expect(slugs).toContain('fsm-state')
      expect(slugs).toContain('input-control')
      expect(slugs).toContain('aabb-collision')
      expect(slugs).toContain('storage-state') // categories 含 game
      expect(slugs).not.toContain('modal-dialog')
      expect(slugs).not.toContain('form-validation')
    })

    it('web_fullstack 类型返回 web 模块，不含 game 模块', () => {
      const { modules } = loadOfficialModules('web_fullstack')
      const slugs = modules.map((m) => m.slug)
      expect(slugs).toContain('storage-state')
      expect(slugs).toContain('modal-dialog')
      expect(slugs).toContain('form-validation')
      expect(slugs).toContain('filter-list')
      expect(slugs).not.toContain('game-loop')
    })

    it('模块字段完整且无外链依赖（全量内置模块自检）', () => {
      for (const type of ['web_fullstack', 'game', 'personal_tool'] as const) {
        const { modules, rejected } = loadOfficialModules(type)
        expect(rejected, type).toEqual([])
        for (const mod of modules) {
          expect(mod.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          expect(mod.name).toBeTruthy()
          expect(mod.summary).toBeTruthy()
          expect(mod.whenToUse).toBeTruthy()
          expect(mod.whenNotToUse).toBeTruthy()
          expect(mod.files.length).toBeGreaterThan(0)
          for (const f of mod.files) {
            expect(existsSync(join(mod.baseDir, f.path))).toBe(true)
            if (f.path.endsWith('.js')) {
              const src = readFileSync(join(mod.baseDir, f.path), 'utf8')
              expect(src).not.toMatch(/import\s+.*from\s*['"]https?:/)
              expect(src).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/)
            }
          }
        }
      }
    })
  })

  describe('loadOfficialModules：fixture 注入', () => {
    it('按 categories 过滤：只有匹配类型的模块被返回', () => {
      root = TEST_ROOT()
      mkdirSync(join(root, 'web'), { recursive: true })
      makeModule(join(root, 'web'), 'alpha', validManifest('alpha', ['web_fullstack'], ['alpha.js']), { 'alpha.js': 'export const x = 1' })
      makeModule(join(root, 'web'), 'beta', validManifest('beta', ['game'], ['beta.js']), { 'beta.js': 'export const y = 2' })

      const web = loadOfficialModules('web_fullstack', root)
      expect(web.modules.map((m) => m.slug)).toEqual(['alpha'])
      const game = loadOfficialModules('game', root)
      expect(game.modules.map((m) => m.slug)).toEqual(['beta'])
    })

    it('坏模块被拒绝并归入 rejected，不阻断其余模块', () => {
      root = TEST_ROOT()
      mkdirSync(join(root, 'web'), { recursive: true })
      makeModule(join(root, 'web'), 'good', validManifest('good', ['web_fullstack'], ['good.js']), { 'good.js': 'export const ok = 1' })
      // 坏：slug 与目录名不一致
      makeModule(join(root, 'web'), 'bad-slug', validManifest('other', ['web_fullstack'], ['a.js']), { 'a.js': 'export const z = 1' })
      // 坏：缺 module.json
      mkdirSync(join(root, 'web', 'no-manifest'), { recursive: true })

      const { modules, rejected } = loadOfficialModules('web_fullstack', root)
      expect(modules.map((m) => m.slug)).toEqual(['good'])
      expect(rejected.length).toBe(2)
      expect(rejected.some((r) => r.slug === 'web/bad-slug')).toBe(true)
      expect(rejected.some((r) => r.slug === 'web/no-manifest')).toBe(true)
    })

    it('源码含外部依赖的模块被拒绝', () => {
      root = TEST_ROOT()
      mkdirSync(join(root, 'web'), { recursive: true })
      makeModule(join(root, 'web'), 'leaky', validManifest('leaky', ['web_fullstack'], ['leaky.js']), {
        'leaky.js': "import x from 'https://cdn.example.com/x.js'\nexport const leak = x",
      })
      const { modules, rejected } = loadOfficialModules('web_fullstack', root)
      expect(modules).toEqual([])
      expect(rejected[0].reason).toContain('外部依赖')
    })

    it('越界路径（../）被拒绝', () => {
      root = TEST_ROOT()
      mkdirSync(join(root, 'web'), { recursive: true })
      makeModule(join(root, 'web'), 'traversal', validManifest('traversal', ['web_fullstack'], ['../evil.js']), {
        'evil.js': 'export const bad = 1',
      })
      const { modules, rejected } = loadOfficialModules('web_fullstack', root)
      expect(modules).toEqual([])
      expect(rejected[0].reason).toContain('路径非法')
    })
  })

  describe('renderOfficialModulesToProject：幂等物化', () => {
    function sampleModules(baseDir: string): OfficialModule[] {
      return [
        {
          slug: 'game-loop',
          name: '游戏主循环',
          categories: ['game'],
          version: 1,
          summary: 's',
          whenToUse: 'u',
          whenNotToUse: 'n',
          files: [{ path: 'game-loop.js', role: '源码' }],
          baseDir,
          source: 'builtin',
        },
      ]
    }

    it('首次写入，第二次跳过（幂等不覆盖）', () => {
      const src = TEST_ROOT()
      const proj = TEST_ROOT()
      mkdirSync(join(src, 'game-loop'), { recursive: true })
      writeFileSync(join(src, 'game-loop', 'game-loop.js'), 'export const v1 = 1', 'utf8')

      const modules = sampleModules(join(src, 'game-loop'))
      const first = renderOfficialModulesToProject(modules, proj)
      expect(first.written).toEqual(['src/official-modules/game-loop/game-loop.js'])
      expect(first.skipped).toEqual([])
      expect(readFileSync(join(proj, 'src/official-modules/game-loop/game-loop.js'), 'utf8')).toContain('v1')

      // 改源后重渲染：目标已存在 → 跳过，不覆盖
      writeFileSync(join(src, 'game-loop', 'game-loop.js'), 'export const v2 = 2', 'utf8')
      const second = renderOfficialModulesToProject(sampleModules(join(src, 'game-loop')), proj)
      expect(second.written).toEqual([])
      expect(second.skipped).toEqual(['src/official-modules/game-loop/game-loop.js'])
      expect(readFileSync(join(proj, 'src/official-modules/game-loop/game-loop.js'), 'utf8')).toContain('v1')
    })
  })

  describe('buildModuleMapInjection：地图文本', () => {
    it('含目录、catalog 行、使用纪律与渲染统计', () => {
      const mod: OfficialModule = {
        slug: 'game-loop',
        name: '游戏主循环',
        categories: ['game'],
        version: 1,
        summary: '摘要',
        whenToUse: '适用',
        whenNotToUse: '不用',
        files: [],
        baseDir: '',
        source: 'builtin',
      }
      const map = buildModuleMapInjection([mod], { written: ['src/official-modules/game-loop/game-loop.js'], skipped: [] })
      expect(map).toContain('官方模块目录已就位')
      expect(map).toContain('src/official-modules/')
      expect(map).toContain('game-loop')
      expect(map).toContain('适用')
      expect(map).toContain('不用')
      expect(map).toContain('只读参考目录')
      expect(map).toContain('新写入 1 个文件')
    })

    it('空模块列表返回 null', () => {
      expect(buildModuleMapInjection([], { written: [], skipped: [] })).toBeNull()
    })
  })
})
