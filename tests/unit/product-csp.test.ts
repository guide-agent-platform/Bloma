/**
 * 产物 CSP 单一真相源锁（Phase 9 W1.1，2026-09-12；2026-10-03 删留执行改写规则断言）。
 *
 * 背景：B 站播放器案（项目 214397c3）实测 blob 媒体源被 CSP 拦——产物 CSP 没有
 * media-src，回落 default-src 'self' 把 blob: 全灭。本测试锁两件事：
 *   1. PRODUCT_CSP 字段齐全（media-src 'self' blob: 在位、同源边界未放松）；
 *   2. 实际HTTP消费点统一引用真相源常量，并验证服务器真实响应头。
 *      任何一侧不得退回硬编码造成双源漂移。原「逐字匹配插值表达式片段」断言
 *      已改为按消费点集合的规则断言（消费点增减时同步本清单）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRODUCT_CSP } from '../../main/coding/product-csp'
import { createProject } from '../../main/project/project-service'
import { runSandbox, stopSandbox } from '../../main/delivery/sandbox'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

/** 产物 CSP 消费点清单（新增消费方时在此登记——规则断言而非逐字片段匹配）。 */
const CSP_CONSUMERS = [
  'main/delivery/sandbox.ts',
] as const

describe('PRODUCT_CSP 单一真相源', () => {
  let home: string | undefined
  let projectId: string | undefined
  afterEach(() => {
    if (projectId) stopSandbox({ request_id: 'csp-stop', project_id: projectId })
    vi.unstubAllEnvs()
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    home = undefined; projectId = undefined
  })
  it('serves the canonical policy as an actual preview HTTP response header', async () => {
    home = mkdtempSync(join(tmpdir(), 'bloma-csp-'))
    vi.stubEnv('PROMA_HOME', home)
    const project = createProject({ request_id: 'csp-project', mode: 'quick' })
    projectId = project.project_id
    writeFileSync(join(project.root_path, 'index.html'), '<!doctype html><html><body>test</body></html>')
    const sandbox = await runSandbox({ request_id: 'csp-run', project_id: projectId })
    const response = await fetch(sandbox.preview_url)
    expect(response.headers.get('content-security-policy')).toBe(PRODUCT_CSP)
    await response.arrayBuffer()
  })
  it('字段齐全：同源边界与 blob 媒体放行并存', () => {
    expect(PRODUCT_CSP).toContain("default-src 'self'")
    expect(PRODUCT_CSP).toContain("connect-src 'self'")
    expect(PRODUCT_CSP).toContain("img-src 'self' data: blob:")
    expect(PRODUCT_CSP).toContain("media-src 'self' blob:")
    // 外链媒体仍被拦（default-src 回落），外部流必须走服务端同源代理
    expect(PRODUCT_CSP).not.toContain('media-src https:')
    expect(PRODUCT_CSP).not.toContain('unsafe-eval')
  })

  it('全部消费点引用真相源常量，且无硬编码 CSP 字面量（双源漂移守卫）', () => {
    for (const rel of CSP_CONSUMERS) {
      const src = readFileSync(join(repoRoot, rel), 'utf8')
      // 引用真相源：导入或插值二选一
      const references = src.includes('PRODUCT_CSP')
      expect(references, `${rel} 应引用 PRODUCT_CSP 常量`).toBe(true)
      // 防退回硬编码：源码里不应有完整 CSP 字符串字面量
      const literalCount = (src.match(/default-src 'self'/g) || []).length
      expect(literalCount, `${rel} 不应内嵌硬编码 CSP`).toBe(0)
    }
  })
})
