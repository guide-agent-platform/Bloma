import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * 记忆栈可达性门禁（2026-09-12 记忆栈审计裁定 §1，D0）。
 *
 * 判据（写死）：从 `main/index.ts` 出发的可达模块集**不含** `main/memory-distiller`。
 * L3 蒸馏层已冻结（生产触发点拔除），本用例阻止它被重新接回生产路径。
 *
 * 实现约定（轻量方案，不引入 madge / dependency-cruiser）：
 * - 静态解析 import/export-from/副作用 import，解析相对路径（.ts/.tsx/index 候选）后 BFS；
 * - 动态形态（`import()` / `require()`）另加正则兜底：可达文件里出现指向 memory-distiller 的
 *   动态引用同样判红；
 * - **模块被删层时视为通过**（不存在 → 不可能可达，不报错）；
 * - 自证（变异）：用临时夹具造一条 index → a → memory-distiller 的链，扫描必须能发现；
 *   否则本用例可能是恒绿的假门禁（项目既有教训）。
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const MAIN_ENTRY = join(REPO_ROOT, 'main', 'index.ts')
const TARGET_MODULE = 'main/memory-distiller'

const FROM_RE = /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s*['"]([^'"]+)['"]/g
const SIDE_EFFECT_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function parseSpecifiers(source: string): string[] {
  const out: string[] = []
  for (const re of [FROM_RE, SIDE_EFFECT_IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0
    for (const m of source.matchAll(re)) out.push(m[1])
  }
  return out
}

function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(fromFile), spec)
  const ext = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
  for (const candidate of ext) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/** 从入口出发的可达文件集（相对 repo 根的 POSIX 路径）。 */
export function collectReachableModules(entry: string, repoRoot: string): Set<string> {
  const visited = new Set<string>()
  const queue = [entry]
  const toRel = (abs: string): string => abs.slice(repoRoot.length + 1).replace(/\\/g, '/')
  while (queue.length > 0) {
    const file = queue.shift() as string
    const rel = toRel(file)
    if (visited.has(rel)) continue
    visited.add(rel)
    let source = ''
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const spec of parseSpecifiers(source)) {
      const resolved = resolveRelative(file, spec)
      if (resolved && !visited.has(toRel(resolved))) queue.push(resolved)
    }
  }
  return visited
}

/** 可达文件里指向某个模块的动态引用（兜底通道）。 */
export function findDynamicReferences(repoRoot: string, reachable: Set<string>, needle: string): string[] {
  const hits: string[] = []
  for (const rel of reachable) {
    let source = ''
    try {
      source = readFileSync(join(repoRoot, rel), 'utf8')
    } catch {
      continue
    }
    DYNAMIC_IMPORT_RE.lastIndex = 0
    REQUIRE_RE.lastIndex = 0
    for (const re of [DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
      for (const m of source.matchAll(re)) {
        if (m[1].includes(needle)) hits.push(`${rel} → ${m[1]}`)
      }
    }
  }
  return hits
}

describe('memory-reachability（记忆栈可达性门禁）', () => {
  const fixtures: string[] = []
  afterAll(() => {
    for (const dir of fixtures) rmSync(dir, { recursive: true, force: true })
  })

  it('生产入口 main/index.ts 的可达集不含 memory-distiller（冻结不回接）', () => {
    const reachable = collectReachableModules(MAIN_ENTRY, REPO_ROOT)
    // 模块被删层时视为通过：文件不存在 → 断言自然成立，不报错
    expect([...reachable].some((rel) => rel.startsWith(TARGET_MODULE))).toBe(false)
    expect(findDynamicReferences(REPO_ROOT, reachable, 'memory-distiller')).toEqual([])
  })

  it('可达集覆盖 export * 过渡桩（样例：经桩到达真实实现）', () => {
    const reachable = collectReachableModules(MAIN_ENTRY, REPO_ROOT)
    // main/*.ts 平铺桩 `export * from './coding/...'`：真实实现必须可达，证明解析规则生效
    expect([...reachable].some((rel) => rel === 'main/coding/agent-loop.ts')).toBe(true)
  })

  it('自证（变异）：夹具链 index → a → memory-distiller 必须被判为可达', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bloma-reach-fixture-'))
    fixtures.push(dir)
    mkdirSync(join(dir, 'main'), { recursive: true })
    writeFileSync(join(dir, 'main', 'index.ts'), "export * from './coding/a'\n", 'utf8')
    mkdirSync(join(dir, 'main', 'coding'), { recursive: true })
    writeFileSync(join(dir, 'main', 'coding', 'a.ts'), "import { x } from '../memory-distiller'\n", 'utf8')
    writeFileSync(join(dir, 'main', 'memory-distiller.ts'), 'export const x = 1\n', 'utf8')

    const reachable = collectReachableModules(join(dir, 'main', 'index.ts'), dir)
    expect([...reachable]).toContain('main/memory-distiller.ts')
  })

  it('自证（变异·动态形态）：可达文件里的 import() 指向目标同样判红', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bloma-reach-dynamic-'))
    fixtures.push(dir)
    mkdirSync(join(dir, 'main'), { recursive: true })
    writeFileSync(join(dir, 'main', 'index.ts'), "await import('./memory-distiller')\n", 'utf8')
    writeFileSync(join(dir, 'main', 'memory-distiller.ts'), 'export const x = 1\n', 'utf8')

    const reachable = collectReachableModules(join(dir, 'main', 'index.ts'), dir)
    expect(findDynamicReferences(dir, reachable, 'memory-distiller').length).toBeGreaterThan(0)
  })

  it('自证（负例）：断链夹具不得误报可达', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bloma-reach-negative-'))
    fixtures.push(dir)
    mkdirSync(join(dir, 'main'), { recursive: true })
    writeFileSync(join(dir, 'main', 'index.ts'), "import './other'\n", 'utf8')
    writeFileSync(join(dir, 'main', 'other.ts'), 'export const y = 2\n', 'utf8')
    writeFileSync(join(dir, 'main', 'memory-distiller.ts'), 'export const x = 1\n', 'utf8')

    const reachable = collectReachableModules(join(dir, 'main', 'index.ts'), dir)
    expect([...reachable]).not.toContain('main/memory-distiller.ts')
  })
})
