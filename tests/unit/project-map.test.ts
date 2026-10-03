import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PROJECT_MAP_MAX_CHARS,
  appendProjectMapToSystem,
  generateProjectMap,
  loadProjectMapBlock,
  scheduleProjectMapRefresh,
} from '../../main/project/project-map'
import { restorePromaHome } from '../support/proma-home-guard'

/**
 * project-map（Graft 模式 Bloma 化，r69 转正）：
 * 用户项目的代码结构语义地图——agent loop 每轮从零探索上轮自己写的代码（Graft「冷漫游」），
 * 预计算紧凑地图（≤1200 字符，对齐 DIGEST_MAX_CHARS 纪律）注入 system 尾部 +
 * 工程产物写盘后 fire-and-forget 更新（Graft PostToolUse 等效，无 hook 基建）。
 * Graft SWE-bench 162 runs 数据：token -42% / tool calls -46% / 正确率 +12。
 *
 * 落盘位置：{PROMA_HOME}/agent-workspaces/{slug}/documents/{projectId}/project-map.md
 * （与 prd/backplane 同级——需求侧记忆已有，代码侧记忆补位）。
 */

let root: string

function newRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'pmap-proj-'))
  return root
}
let savedHome: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pmap-proj-'))
  savedHome = process.env.PROMA_HOME
  process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'pmap-home-'))
})

afterEach(() => {
  restorePromaHome(savedHome)
})

function writeFile(rel: string, content: string, base = root): void {
  const abs = join(base, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

function mapPath(slug: string, pid: string): string {
  return join(process.env.PROMA_HOME!, 'agent-workspaces', slug, 'documents', pid, 'project-map.md')
}

// 【挂账 2026-10-03 删留执行】[S4-PMAP-003/003b] 两例锁的 appendProjectMapToSystem/
// loadProjectMapBlock 注入半链生产零调用（生成链活于 tool-handlers）；接线或裁撤
// 裁决前保留，其余 9 例为活链独占。

describe('generateProjectMap 生成器（S4-PMAP-001/002）', () => {
  it('[S4-PMAP-001] 跳过依赖目录 + 预算 ≤1200 字符（注入纪律，超出丢最小模块）', () => {
    writeFile('src/big-service.ts', `// 主服务\nexport function mainService() {}\n${'const pad = 1\n'.repeat(200)}`)
    // 20 个中等文件：地图总量超 1200，裁剪路径必须触发（变异 M1 的杀死前提）
    for (let i = 0; i < 40; i++) {
      writeFile(`src/module-${i}.ts`, `// 模块 ${i}\nexport function mod${i}() {}\n${'const pad = 1\n'.repeat(80)}`)
    }
    // 依赖目录：应被跳过，不进地图
    writeFile('node_modules/pkg/index.js', 'export function dep() {}\n' + 'x\n'.repeat(500))
    writeFile('dist/bundle.js', 'var a=1\n' + 'x\n'.repeat(500))

    const result = generateProjectMap(root)
    expect(result.map.length).toBeLessThanOrEqual(PROJECT_MAP_MAX_CHARS)
    expect(PROJECT_MAP_MAX_CHARS).toBe(1200)
    expect(result.map).not.toContain('node_modules')
    expect(result.map).not.toContain('dist/')
    expect(result.map).toContain('src/big-service.ts')
    // 裁剪发生时带省略标记（证明预算纪律真实执行而非 fixture 恰好小于预算）
    expect(result.map).toMatch(/\+\d+ 小文件省略/)
  })

  it('[S4-PMAP-002] 锚点行号与真实文件一致（含 export default/{ 形态，R1 deepseek P1 修复）', () => {
    const src = [
      '// 服务层',
      'import { x } from "x"',
      '',
      'export function firstFn() {}',
      '',
      'export class Second {}',
      'export default function defaultMain() {}',
      'const namedA = 1',
      'export { namedA, Second as S2 }',
    ].join('\n')
    writeFile('src/anchors.ts', src)
    const result = generateProjectMap(root)
    // firstFn 在第 4 行、Second 在第 6 行（1-based，与编辑器/read_file 行号一致）
    expect(result.map).toContain('firstFn:4')
    expect(result.map).toContain('Second:6')
    // R1 修复：export default 与 export { } 形态也产锚点（漏报修复）
    expect(result.map).toContain('defaultMain:7')
    expect(result.map).toContain('namedA:9')
  })

  it('[S4-PMAP-002b] LOC 降序：大模块优先展示（大文件在前）', () => {
    writeFile('src/tiny.ts', 'export const a = 1\n')
    writeFile(
      'src/huge.ts',
      `// 最大模块\nexport function huge() {}\n${'const pad = 1\n'.repeat(150)}`,
    )
    const result = generateProjectMap(root)
    const hugeIdx = result.map.indexOf('src/huge.ts')
    const tinyIdx = result.map.indexOf('src/tiny.ts')
    expect(hugeIdx).toBeGreaterThanOrEqual(0)
    expect(tinyIdx).toBeGreaterThanOrEqual(0)
    expect(hugeIdx).toBeLessThan(tinyIdx)
  })

  it('[S4-PMAP-009] P2-14：index.html/styles.css 进地图（web 产物不再只记 app.js）', () => {
    writeFile(
      'index.html',
      '<!doctype html><html><head><link rel="stylesheet" href="src/styles.css"></head><body><div id="app"></div><script src="src/app.js"></script></body></html>',
    )
    writeFile('src/app.js', 'document.getElementById("app").textContent = "hi"\n')
    writeFile('src/styles.css', 'body { margin: 0 }\n.app { color: red }\n')
    const result = generateProjectMap(root)
    expect(result.map).toContain('index.html')
    expect(result.map).toContain('src/styles.css')
    expect(result.map).toContain('src/app.js')
  })
})

describe('注入契约（S4-PMAP-003）', () => {
  it('[S4-PMAP-003] appendProjectMapToSystem：地图块追加在 system 尾部；空块透传（不注入空节）', () => {
    const system = '基础系统提示词'
    const withMap = appendProjectMapToSystem(system, '# 项目地图（2 文件）\n- src/a.ts (10行)')
    expect(withMap.startsWith(system)).toBe(true)
    expect(withMap.indexOf('# 项目地图')).toBeGreaterThan(system.length - 1)
    expect(withMap.endsWith('- src/a.ts (10行)')).toBe(true)
    // 空 block：原样透传（不追加空节污染 prompt）
    expect(appendProjectMapToSystem(system, '')).toBe(system)
  })

  it('[S4-PMAP-003b] loadProjectMapBlock：无地图文件返回空串；有则含地图头', () => {
    expect(loadProjectMapBlock('p1', 'slug1')).toBe('')
    const docDir = join(process.env.PROMA_HOME!, 'agent-workspaces', 'slug1', 'documents', 'p1')
    mkdirSync(docDir, { recursive: true })
    writeFileSync(join(docDir, 'project-map.md'), '# 项目地图（5 文件）\n- src/x.ts', 'utf8')
    const block = loadProjectMapBlock('p1', 'slug1')
    expect(block).toContain('# 项目地图（5 文件）')
  })
})

describe('scheduleProjectMapRefresh 异步更新（S4-PMAP-004/005）', () => {
  it('[S4-PMAP-004] 写盘后刷新：documents/project-map.md 落盘且调用立即返回（不阻塞主流程）', async () => {
    writeFile('src/app.ts', 'export function app() {}\n')
    const t0 = Date.now()
    scheduleProjectMapRefresh('slug9', 'p9', root)
    const syncReturnMs = Date.now() - t0
    expect(syncReturnMs).toBeLessThan(500) // fire-and-forget：同步路径不等待扫描
    // 异步落盘完成（poll 等待）
    const target = mapPath('slug9', 'p9')
    const deadline = Date.now() + 5000
    while (!existsSync(target) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toContain('src/app.ts')
  })

  it('[S4-PMAP-005] 故障注入：rootPath 不存在 → 不抛错静默降级（主流程零感知，不落坏地图）', async () => {
    expect(() => scheduleProjectMapRefresh('slugx', 'px', join(root, 'not-exist-dir'))).not.toThrow()
    await new Promise((r) => setTimeout(r, 200))
    expect(existsSync(mapPath('slugx', 'px'))).toBe(false)
  })
})

describe('审查收敛修复（R1 fail/high，r69）', () => {
  it('[S4-PMAP-007] 预算硬纪律（aliyun P1）：≤3 个超长模块也 ≤1200，永不超预算', () => {
    newRoot()
    // 3 个模块（旧裁剪条件 list.length > 3 不触发）+ 超长单条目（长 note + 满额导出）
    for (let i = 0; i < 3; i++) {
      const longNote = `备注${'很'.repeat(60)}`
      writeFile(
        `src/deep/nested/very-long-directory-name/fat-module-number-${i}.ts`,
        `// ${longNote}\n${['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']
          .map((n) => `export function veryLongFunctionNameForAnchorTesting_${n}_${i}() {}`)
          .join('\n')}\n`,
      )
    }
    const result = generateProjectMap(root)
    expect(result.map.length).toBeLessThanOrEqual(PROJECT_MAP_MAX_CHARS)
  })

  it('[S4-PMAP-008] 防抖/并发合并（aliyun P1）：防抖窗口内重复刷新不产生第二次写盘', async () => {
    newRoot()
    writeFile('src/app.ts', 'export function app() {}\n')
    const target = mapPath('slug-d', 'pd')
    scheduleProjectMapRefresh('slug-d', 'pd', root)
    const deadline = Date.now() + 5000
    while (!existsSync(target) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(existsSync(target)).toBe(true)
    const m1 = (await import('node:fs')).statSync(target).mtimeMs
    // 防抖窗口内的后续刷新应被合并：窗口内不产生第二次写盘
    scheduleProjectMapRefresh('slug-d', 'pd', root)
    await new Promise((r) => setTimeout(r, 300))
    const m2 = (await import('node:fs')).statSync(target).mtimeMs
    expect(m2).toBe(m1) // 无防抖时立即重扫写盘 → mtime 变化 → 此断言红
  })
})

describe('fuzz：畸形项目结构（S4-PMAP-006）', () => {
  it('[S4-PMAP-006] 空目录/二进制文件/无导出文件/超深嵌套 → 不崩且输出合法结构', () => {
    // 空目录
    expect(() => generateProjectMap(mkdtempSync(join(tmpdir(), 'pmap-empty-')))).not.toThrow()
    // 二进制 + 无导出 + 深嵌套
    writeFile('bin/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('binary'))
    writeFile('src/no-exports.ts', 'const hidden = 1\nconsole.log(hidden)\n')
    let deep = root
    for (let i = 0; i < 12; i++) {
      deep = join(deep, `level${i}`)
    }
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, 'deep.ts'), 'export function deepFn() {}\n', 'utf8')

    const result = generateProjectMap(root)
    expect(result.map.length).toBeGreaterThan(0)
    expect(result.map.length).toBeLessThanOrEqual(PROJECT_MAP_MAX_CHARS)
    expect(result.files).toBeGreaterThanOrEqual(2)
  })
})
