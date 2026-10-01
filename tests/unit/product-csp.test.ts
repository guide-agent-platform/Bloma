/**
 * 产物 CSP 单一真相源锁（Phase 9 W1.1，2026-09-12）。
 *
 * 背景：B 站播放器案（项目 214397c3）实测 blob 媒体源被 CSP 拦——两处同构的
 * 产物 CSP（沙箱内嵌脚本 + static-server 模板）都没有 media-src，回落
 * default-src 'self' 把 blob: 全灭。本测试锁三件事：
 *   1. PRODUCT_CSP 字段齐全（media-src 'self' blob: 在位、同源边界未放松）；
 *      不是未定义标识符 PRODUCT_CSP——模板字符串裸标识符不会被外层求值）；
 *   3. 沙箱内嵌 STATIC_SERVER_SCRIPT 同样引用真相源（源码文本含插值表达式），
 *      防止任何一侧退回硬编码造成双源漂移。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PRODUCT_CSP } from '../../main/coding/product-csp'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

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

  it('沙箱内嵌脚本同样引用真相源（源码文本含插值表达式）', () => {
    const src = readFileSync(join(repoRoot, 'main/delivery/sandbox.ts'), 'utf8')
    expect(src).toContain("'Content-Security-Policy': ${JSON.stringify(PRODUCT_CSP)}")
    // 防退回硬编码：源码里不应再有第二个完整 CSP 字符串字面量
    const literalCount = (src.match(/default-src 'self'/g) || []).length
    expect(literalCount).toBe(0)
  })
})
