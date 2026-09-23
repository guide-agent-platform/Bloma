import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureVendorNodeModules,
  getVendorNodeModulesDir,
  readRealScaffoldVariant,
  resolveRealScaffoldSpawn,
  STATIC_FILE_SERVER_SCRIPT,
  writeRealScaffoldMarker,
} from '../../../main/coding/preview-runtime'
import { SNAPSHOT_PRESERVED_TOPLEVEL } from '../../../main/delivery/snapshots' /* PR3a-UNKNOWN 需人工确认 */
import { restorePromaHome } from '../../support/proma-home-guard'

/**
 * W2 预览引擎（真实脚手架改造，2026-09-18）。
 *
 * 锁四件事：
 * 1. 产物标记分流：server.js→fullstack spawn；static-server.js→null（旧路径字节级回退）；
 *    皆无→零约定 file server；
 * 2. 零约定 file server 真实可用：起进程→serve 文件→404 如实（GWT 探针的地基）；
 * 3. vendor 供货幂等：项目已有 express 跳过、vendor 缺失 fail-open false、有则逐文件复制；
 * 4. 快照排除集含 node_modules（vendor 确定性可重建，不进归档）。
 */

function nodeExec(): string {
  return process.env.npm_node_execpath || process.env.NODE || 'node'
}

async function waitHealthy(url: string, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok || res.status === 404) return true
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

describe('W2 预览引擎 preview-runtime', () => {
  const originalPromaHome = process.env.PROMA_HOME
  beforeEach(() => {
    // 干净临时 PROMA_HOME：vendor 目录缺席走 fail-open 分支（全局 guard 只清污染值）
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'w2-home-'))
  })
  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  let children: ChildProcess[] = []
  afterEach(async () => {
    for (const child of children) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
    children = []
  })

  it('标记文件：写入/读回往返；非法内容/缺席 → null；旧路径 loop 期（无标记无 static-server.js）也回 null（W3 回归锁——文件存在性启发会误伤）', () => {
    const root = mkdtempSync(join(tmpdir(), 'w2-marker-'))
    expect(readRealScaffoldVariant(root)).toBeNull()
    writeRealScaffoldMarker(root, 'real-fullstack')
    expect(readRealScaffoldVariant(root)).toBe('real-fullstack')
    writeRealScaffoldMarker(root, 'real-static')
    expect(readRealScaffoldVariant(root)).toBe('real-static')
    writeFileSync(join(root, '.bloma-real-variant'), 'garbage', 'utf8')
    expect(readRealScaffoldVariant(root)).toBeNull()
    // 旧路径 loop 期：无标记、无 static-server.js（交付链才注入）→ 必须回 null 走旧预览
    const oldLoopRoot = mkdtempSync(join(tmpdir(), 'w2-oldloop-'))
    expect(resolveRealScaffoldSpawn(oldLoopRoot, 0)).toBeNull()
  })

  it('产物标记分流：real-fullstack 标记→spawn；旧路径 static-server.js 在→null；real-static 标记→file server', async () => {
    const fullstackRoot = mkdtempSync(join(tmpdir(), 'w2-full-'))
    writeFileSync(join(fullstackRoot, 'server.js'), 'console.log("no-listen")', 'utf8')
    writeRealScaffoldMarker(fullstackRoot, 'real-fullstack')
    const full = resolveRealScaffoldSpawn(fullstackRoot, 0)
    expect(full).not.toBeNull()
    children.push(full!)
    await new Promise((r) => setTimeout(r, 300))
    expect(full!.exitCode).not.toBe(null) // no-listen 脚本自然退出；spawn 姿势正确即可

    const oldRoot = mkdtempSync(join(tmpdir(), 'w2-old-'))
    writeFileSync(join(oldRoot, 'static-server.js'), '// old path', 'utf8')
    expect(resolveRealScaffoldSpawn(oldRoot, 0)).toBeNull()

    const staticRoot = mkdtempSync(join(tmpdir(), 'w2-static-'))
    writeRealScaffoldMarker(staticRoot, 'real-static')
    expect(resolveRealScaffoldSpawn(staticRoot, 0)).not.toBeNull()
  })

  it('零约定只读 file server：真实起进程 serve 文件、MIME 正确、404 如实、目录回落 index.html', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w2-files-'))
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'index.html'), '<html><body>real-static</body></html>', 'utf8')
    writeFileSync(join(root, 'dist', 'app.js'), 'console.log("hi")', 'utf8')
    // （src/ 目录故意不存在——后续 /src/x.js 探测 404 如实）

    const port = 39000 + Math.floor(Math.random() * 500)
    const child = spawn(nodeExec(), ['-e', STATIC_FILE_SERVER_SCRIPT, String(port), root], {
      cwd: tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    children.push(child)
    expect(await waitHealthy(`http://127.0.0.1:${port}/missing.txt`, 8_000)).toBe(true)

    const index = await fetch(`http://127.0.0.1:${port}/`)
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toContain('text/html')
    expect(await index.text()).toContain('real-static')

    const js = await fetch(`http://127.0.0.1:${port}/dist/app.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('text/javascript')

    const missing = await fetch(`http://127.0.0.1:${port}/src/x.js`)
    expect(missing.status).toBe(404)

    // 路径穿越防护：..%2f 不允许读到根外
    const escape = await fetch(`http://127.0.0.1:${port}/..%2f..%2fetc%2fhosts`)
    expect([403, 404]).toContain(escape.status)
  })

  it('vendor 供货幂等：vendor 缺席 fail-open false；伪造 vendor 后逐文件复制成功且二次调用跳过', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'w2-vendor-'))
    // ① PROMA_HOME 干净（restorePromaHome 建了空目录）→ vendor 缺失
    expect(ensureVendorNodeModules(projectRoot)).toBe(false)

    // ② 伪造 vendor 库（无需网络）：express + 一个传递依赖目录验证递归复制
    const vendorModules = getVendorNodeModulesDir()
    mkdirSync(join(vendorModules, 'express', 'lib'), { recursive: true })
    mkdirSync(join(vendorModules, 'dep-a'), { recursive: true })
    writeFileSync(join(vendorModules, 'express', 'index.js'), 'module.exports = 1', 'utf8')
    writeFileSync(join(vendorModules, 'express', 'lib', 'x.js'), 'module.exports = 2', 'utf8')
    writeFileSync(join(vendorModules, 'dep-a', 'y.js'), 'module.exports = 3', 'utf8')

    expect(ensureVendorNodeModules(projectRoot)).toBe(true)
    expect(existsSync(join(projectRoot, 'node_modules', 'express', 'lib', 'x.js'))).toBe(true)
    expect(existsSync(join(projectRoot, 'node_modules', 'dep-a', 'y.js'))).toBe(true)

    // ③ 幂等：已供货后再次调用不重拷（删除 vendor 源后仍 true 证明走跳过分支）
    rmSync(join(vendorModules, 'dep-a'), { recursive: true, force: true })
    expect(ensureVendorNodeModules(projectRoot)).toBe(true)
    expect(existsSync(join(projectRoot, 'node_modules', 'dep-a'))).toBe(true)
  })

  it('快照排除集含 node_modules（vendor 确定性可重建，归档不膨胀；旧项目无此目录零影响）', () => {
    expect(SNAPSHOT_PRESERVED_TOPLEVEL).toContain('node_modules')
    expect(SNAPSHOT_PRESERVED_TOPLEVEL).toContain('.git')
    expect(SNAPSHOT_PRESERVED_TOPLEVEL).toContain('data-backups')
  })
})
