/**
 * 产物 CSP 单一真相源锁（Phase 9 W1.1，2026-09-12；2026-10-03 删留执行改写规则断言）。
 *
 * 背景：B 站播放器案（项目 214397c3）实测 blob 媒体源被 CSP 拦——产物 CSP 没有
 * media-src，回落 default-src 'self' 把 blob: 全灭。本测试锁两件事：
 *   1. PRODUCT_CSP 字段齐全（media-src 'self' blob: 在位、同源边界未放松）；
 *   2. 全部消费点（sandbox / snapshots / track-analytics）统一引用真相源常量，
 *      任何一侧不得退回硬编码造成双源漂移。原「逐字匹配插值表达式片段」断言
 *      已改为按消费点集合的规则断言（消费点增减时同步本清单）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PRODUCT_CSP } from '../../main/coding/product-csp'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

/** 产物 CSP 消费点清单（新增消费方时在此登记——规则断言而非逐字片段匹配）。 */
const CSP_CONSUMERS = [
  'main/delivery/sandbox.ts',
  'main/delivery/snapshots.ts',
  'main/delivery/track-analytics.ts',
] as const

describe('PRODUCT_CSP 单一真相源', () => {
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
