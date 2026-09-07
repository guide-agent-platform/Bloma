import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listRefPatternModules } from '../../../main/experience/ref-source'
import { buildModuleMapInjection, renderOfficialModulesToProject, REF_MODULES_DIR } from '../../../main/module-library'
import type { OfficialModule } from '../../../main/module-library'

/**
 * G4 正向参考消费（C-1 约束落点）：账本 verified pattern + sidecar → ref 模块列表，
 * 经官方模块同一渲染/地图管道消费（Agent 侧零新逻辑）。
 * - BLOMA_REF_LIBRARY 缺省 off → 空列表（地图/渲染字节级现状，回归由既有模块库测试保证）；
 * - permissive 且 sidecar 存在 → README+index.js；weak/unknown → 仅 README（不带码）；
 * - candidate/编译未过/ts/py 语言/无 sidecar 的 permissive → 排除；
 * - 地图 ref 行带 `ref:` 前缀与许可纪律；README 懒生成含出处。
 */

function patternCard(fp: string, over: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: `pid-${fp}`, schema_version: 1, kind: 'pattern', tag: over.tag ?? `pattern/js/${over.slug ?? 'debounce'}`,
    status: over.status ?? 'verified', created_at: 1, updated_at: 1, recurrence: 1,
    source: { type: 'web_reference', project_hash: 'harvest', timestamp: 1 },
    fingerprint: fp.padEnd(16, '0'),
    seen_projects: ['harvest'],
    body: {
      capability: over.capability ?? 'Debounce a function call',
      language_family: over.lang ?? 'js',
      api_signature: 'debounce(fn, ms)',
      implementation_summary: 'timer cleared on each call',
      files: [],
      license: over.license ?? 'MIT',
      license_tier: over.tier ?? 'permissive',
      source_url: over.url ?? 'https://example.com/debounce',
      sandbox_result: over.build_pass === false ? { build_pass: false, executed_at: 1 } : { build_pass: true, executed_at: 1 },
      reuse_hint: 'use for search inputs',
    },
  })
}

let home: string
const originalEnv = process.env.BLOMA_REF_LIBRARY
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'refhome-'))
  process.env.BLOMA_REF_LIBRARY = '1'
})
afterEach(() => {
  if (originalEnv === undefined) delete process.env.BLOMA_REF_LIBRARY
  else process.env.BLOMA_REF_LIBRARY = originalEnv
})

function writeLedger(lines: string[]) {
  writeFileSync(join(home, 'bloma-experience.jsonl'), lines.join('\n') + '\n', 'utf8')
}
function seedSidecar(fp16: string, code: string) {
  const dir = join(home, 'bloma-ref-code', fp16.slice(0, 8))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.js'), code, 'utf8')
  return dir
}

describe('ref-source：账本→ref 模块', () => {
  it('开关缺省 off → 空列表', () => {
    delete process.env.BLOMA_REF_LIBRARY
    writeLedger([patternCard('a'.repeat(16))])
    seedSidecar('a'.repeat(16), 'export function debounce(){}')
    expect(listRefPatternModules('personal_tool')).toEqual([])
  })

  it('permissive+编译过+有 sidecar → README+index.js 两文件；README 含出处与许可', () => {
    writeLedger([patternCard('a'.repeat(16), { slug: 'debounce' })])
    seedSidecar('a'.repeat(16), 'export function debounce(fn, ms){return fn}')
    const mods = listRefPatternModules('personal_tool', home)
    expect(mods).toHaveLength(1)
    const m = mods[0]
    expect(m.slug).toBe('debounce')
    expect(m.source).toBe('ref')
    expect(m.files.map((f) => f.path).sort()).toEqual(['README.md', 'index.js'])
    const readme = readFileSync(join(home, 'bloma-ref-code', 'a'.repeat(8), 'README.md'), 'utf8')
    expect(readme).toContain('Debounce a function call')
    expect(readme).toContain('https://example.com/debounce')
    expect(readme).toContain('MIT')
  })

  it('weak_copyleft → 仅 README 不带码；permissive 缺 sidecar → 排除；candidate/ts 语言/编译败 → 排除', () => {
    writeLedger([
      patternCard('b'.repeat(16), { slug: 'throttle', tier: 'weak_copyleft', license: 'LGPL-3.0' }),
      patternCard('c'.repeat(16), { slug: 'missing-sidecar' }),
      patternCard('d'.repeat(16), { slug: 'not-verified', status: 'candidate' }),
      patternCard('e'.repeat(16), { slug: 'ts-only', lang: 'ts' }),
      patternCard('f'.repeat(16), { slug: 'build-failed', build_pass: false }),
    ])
    const mods = listRefPatternModules('personal_tool', home)
    const slugs = mods.map((m) => m.slug)
    expect(slugs).toContain('throttle')
    expect(slugs).not.toContain('missing-sidecar')
    expect(slugs).not.toContain('not-verified')
    expect(slugs).not.toContain('ts-only')
    expect(slugs).not.toContain('build-failed')
    const throttle = mods.find((m) => m.slug === 'throttle')!
    expect(throttle.files.map((f) => f.path)).toEqual(['README.md'])
  })

  it('同 slug 双卡去重（保更新时间新者）', () => {
    writeLedger([
      patternCard('a1'.padEnd(16, '0'), { slug: 'debounce', capability: 'old' }),
      patternCard('b2'.padEnd(16, '0'), { slug: 'debounce', capability: 'new' }),
    ])
    seedSidecar('a1'.padEnd(16, '0'), 'export const x=1')
    seedSidecar('b2'.padEnd(16, '0'), 'export const y=1')
    const mods = listRefPatternModules('personal_tool', home)
    expect(mods).toHaveLength(1)
  })
})

describe('module-library：ref 渲染分目录 + 地图标记', () => {
  it('render 按 source 分目录：builtin→official、ref→ref-modules；幂等 skip', () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'proj-'))
    const baseB = mkdtempSync(join(tmpdir(), 'srcB-'))
    const baseR = mkdtempSync(join(tmpdir(), 'srcR-'))
    writeFileSync(join(baseB, 'mod.js'), 'builtin')
    writeFileSync(join(baseR, 'index.js'), 'refcode')
    writeFileSync(join(baseR, 'README.md'), 'readme')
    const mods: OfficialModule[] = [
      { slug: 'game-loop', name: 'n', categories: ['game'], version: 1, summary: 's', whenToUse: 'w', whenNotToUse: 'x', files: [{ path: 'mod.js' }], baseDir: baseB, source: 'builtin' },
      { slug: 'debounce', name: 'Debounce a function call', categories: ['personal_tool'], version: 1, summary: 'timer', whenToUse: 'inputs', whenNotToUse: 'n/a', files: [{ path: 'index.js' }, { path: 'README.md' }], baseDir: baseR, source: 'ref' },
    ]
    const r = renderOfficialModulesToProject(mods, rootPath)
    expect(r.written).toHaveLength(3)
    expect(existsSync(join(rootPath, 'src/official-modules/game-loop/mod.js'))).toBe(true)
    expect(existsSync(join(rootPath, 'src/ref-modules/debounce/index.js'))).toBe(true)
    expect(r.written.some((w) => w.startsWith(`${REF_MODULES_DIR}/`))).toBe(true)
    const again = renderOfficialModulesToProject(mods, rootPath)
    expect(again.written).toHaveLength(0)
    expect(again.skipped).toHaveLength(3)
  })

  it('地图：ref 行带 ref: 前缀与许可纪律；纯 builtin 地图与现状同构（无前缀无新纪律行）', () => {
    const rendered = { written: ['a'], skipped: [] }
    const builtinOnly: OfficialModule[] = [{ slug: 'game-loop', name: '游戏主循环', categories: ['game'], version: 1, summary: 'rAF 主循环', whenToUse: 'canvas 游戏', whenNotToUse: '静态页', files: [], baseDir: 'x', source: 'builtin' }]
    const mapBuiltin = buildModuleMapInjection(builtinOnly, rendered) ?? ''
    expect(mapBuiltin).not.toContain('ref:')
    expect(mapBuiltin).not.toContain('外部参考')
    const withRef: OfficialModule[] = [...builtinOnly, { slug: 'debounce', name: 'Debounce a function call', categories: ['personal_tool'], version: 1, summary: 'timer', whenToUse: 'inputs', whenNotToUse: 'x', files: [], baseDir: 'y', source: 'ref' }]
    const mapRef = buildModuleMapInjection(withRef, { written: ['a', 'b'], skipped: [] }) ?? ''
    expect(mapRef).toContain('- ref:debounce')
    expect(mapRef).toContain('外部参考')
    expect(mapRef).toContain('README')
  })
})
