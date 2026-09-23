import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildReferenceSection,
  estimateReferenceCardSize,
  extractReferenceCard,
  fetchForReference,
  FetchTimeoutError,
  type DesignReferenceCard,
} from '../../main/guide/web-reference-extractor'

/**
 * 网页设计参考提取器（2026-08-28，guidance v5 排队区头名，r15 原型 12/12 转正）：
 * 「做个像 XX 网站那样的」→ URL 提取结构化设计参考卡（391B token 友好）。
 * 预算设计（observation-policy 思想）：headings ≤6 / palette top5 / preview ≤200 字 /
 * HTML 截断 200KB / 序列化 ≤1.2KB。诚实错误：404 透传 / AbortError 归一 FetchTimeoutError。
 * 真实网络栈：node:http 本地 server + 真实 fetch（非 mock）。
 * Windows libuv 坑（原型踩过）：closeAllConnections → 等 close 回调，不显式 process.exit。
 */

const SAMPLE = `<!DOCTYPE html><html><head><title>示例商城</title>
<style>.card{display:grid;gap:8px} .row{display:flex} .btn{color:#ff5000} .btn{color:#ff5000} a{color:#1677ff}</style></head>
<body><nav>导航</nav><header class="hero"><h1>品质好物</h1></header>
<section><h2>今日推荐</h2><h3>数码专区</h3><h3>家居专区</h3><h3>美妆专区</h3><h3>运动专区</h3><h3>图书专区</h3><h3>多余标题应被截断</h3>
<p>这是一段介绍文字，用来验证正文预览提取。</p>
<button>加入购物车</button><button>立即购买</button><button>收藏</button>
<a href="/item1">商品一</a><a href="/item2">商品二</a><img alt="banner" src="b.png"><img alt="pro" src="p.png">
<form action="/search"><input name="q"></form></section>
<aside>侧栏</aside><footer>页脚</footer></body></html>`

let server: Server
let base: string

beforeEach(async () => {
  server = createServer((req, res) => {
    if (req.url === '/shop') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(SAMPLE)
      return
    }
    if (req.url === '/slow') return // 挂起不响应，触发真实超时
    if (req.url === '/404') {
      res.writeHead(404)
      res.end('nope')
      return
    }
    res.writeHead(200)
    res.end('<html><body><p>plain</p></body></html>')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
})

describe('extractReferenceCard（纯函数提取与预算）', () => {
  it('[S4-AGENT-057] 全字段提取：标题/层级≤6/配色频次/布局特征/组件计数/正文预览', () => {
    const card = extractReferenceCard('mock://shop', SAMPLE, 200_000)
    expect(card.title).toBe('示例商城')
    // 层级预算：≤6 条，第 7 条「多余标题」被截断
    expect(card.headings).toHaveLength(6)
    expect(card.headings.some((h) => h.includes('多余'))).toBe(false)
    // 配色频次：#ff5000（×2）居首，≤5
    expect(card.palette[0]).toBe('#ff5000')
    expect(card.palette).toContain('#1677ff')
    expect(card.palette.length).toBeLessThanOrEqual(5)
    // 布局特征
    for (const hint of ['navbar', 'hero', 'grid', 'flex', 'form', 'sidebar', 'footer']) {
      expect(card.layoutHints).toContain(hint)
    }
    // 组件计数
    expect(card.componentCounts).toEqual({ buttons: 3, links: 2, images: 2, forms: 1 })
    // 正文预览 ≤200 字、script/style 不进正文
    expect(card.textPreview.length).toBeLessThanOrEqual(200)
    expect(card.textPreview).toContain('介绍文字')
    expect(card.textPreview).not.toContain('display:grid')
  })

  it('[S4-AGENT-058] 超大页面 200KB 截断预算：截断后的深层标题不解析', () => {
    const bigHtml = '<html><head><title>big</title></head><body>' + 'x'.repeat(300_000) + '<h1>深层标题</h1></body></html>'
    const card = extractReferenceCard('mock://big', bigHtml, 200_000)
    expect(card.title).toBe('big')
    expect(card.headings).not.toContain('深层标题')
  })

  it('[S4-AGENT-059] 参考卡序列化 ≤1.2KB（token 友好预算）', () => {
    const card = extractReferenceCard('mock://shop', SAMPLE, 200_000)
    const serialized = JSON.stringify(card)
    expect(serialized.length).toBeLessThanOrEqual(1200)
    expect(estimateReferenceCardSize(card)).toBe(serialized.length)
  })
})

describe('fetchForReference（真实网络栈 + 诚实错误）', () => {
  it('[S4-AGENT-060] 真实 fetch 全字段提取（本地 server）', async () => {
    const card: DesignReferenceCard = await fetchForReference(`${base}/shop`, 3000, 200_000)
    expect(card.url).toBe(`${base}/shop`)
    expect(card.title).toBe('示例商城')
    expect(card.componentCounts.buttons).toBe(3)
  })

  it('[S4-AGENT-061] 404 透传（含状态码与 URL）', async () => {
    await expect(fetchForReference(`${base}/404`, 2000, 100_000)).rejects.toThrow(/404/)
  })

  it('[S4-AGENT-062] 真实超时：AbortError 归一 FetchTimeoutError（含 URL 与毫秒数）', async () => {
    const t0 = Date.now()
    try {
      await fetchForReference(`${base}/slow`, 300, 100_000)
      expect.unreachable('应抛 FetchTimeoutError')
    } catch (e) {
      const dt = Date.now() - t0
      expect(e).toBeInstanceOf(FetchTimeoutError)
      expect((e as Error).message).toContain('/slow')
      expect((e as Error).message).toContain('300')
      expect(dt).toBeGreaterThanOrEqual(280)
    }
  })

  it('[S4-AGENT-063] 素页面优雅空结果（空调色板/布局/零组件，不报错）', async () => {
    const card = await fetchForReference(`${base}/`, 2000, 100_000)
    expect(card.palette).toHaveLength(0)
    expect(card.layoutHints).toHaveLength(0)
    expect(card.componentCounts.buttons).toBe(0)
  })
})


describe('buildReferenceSection（SSRF 门 + 失败降级，2026-08-28 产品接线切片）', () => {
  it('[S4-AGENT-064] 无 url / 非 http(s)（file://、ftp://、纯路径）→ 空串零 IO', async () => {
    expect(await buildReferenceSection(undefined)).toBe('')
    expect(await buildReferenceSection(null)).toBe('')
    expect(await buildReferenceSection('')).toBe('')
    expect(await buildReferenceSection('file:///etc/passwd')).toBe('')
    expect(await buildReferenceSection('ftp://example.com/x')).toBe('')
    expect(await buildReferenceSection('/etc/passwd')).toBe('')
  })

  it('[S4-AGENT-065] 合法 http(s) URL → 设计参考节（含标题与主配色），超时/404 降级空串不抛', async () => {
    const section = await buildReferenceSection(`${base}/shop`, 2000)
    expect(section).toContain('设计参考')
    expect(section).toContain('示例商城')
    expect(section).toContain('#ff5000')
    // 404 → 降级空串（不阻断调用方主流程）
    expect(await buildReferenceSection(`${base}/404`, 2000)).toBe('')
    // 超时 → 降级空串
    expect(await buildReferenceSection(`${base}/slow`, 300)).toBe('')
  })
})
