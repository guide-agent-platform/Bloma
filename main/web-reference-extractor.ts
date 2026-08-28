/**
 * 网页设计参考提取器（2026-08-28，guidance v5 排队区头名）——
 * 0 基础用户最高频表达「做个像 XX 网站那样的」，本模块把 URL 翻译成 token 友好的
 * 结构化设计参考卡（配色/布局/层级/组件计数，~391B）。
 *
 * 教学项目刻意用零依赖正则解析而非 cheerio/DOM：逐函数可讲（title/palette/layout 各
 * ≤15 行）。预算设计参照 Proma observation-policy「交互优先」思想——每项预算都防失控：
 * headings ≤6 / palette top5（频次）/ textPreview ≤200 字 / HTML 截断 200KB / 序列化 ≤1.2KB。
 * 错误语义参照 Proma browser-cdp「诚实错误」：404 透传、AbortError 归一为可读超时错误。
 *
 * 信源：r15 方向 A 原型 web-reference-extractor-prototype.ts（12/12 断言，真实 HTTP 栈验证）。
 * 安全：只处理 http(s) URL（fetch 层天然拒绝 file://）；渲染进程不得直接 fetch，
 * 产品接线须经 main 进程 IPC（Electron 安全惯例，集成属后续故事）。
 */

// ---------- 数据结构 ----------

export interface DesignReferenceCard {
  url: string
  title: string
  /** h1-h3 文本（层级感），预算 ≤6 条 */
  headings: string[]
  /** 频次 top 颜色（hex/rgb 归一），预算 ≤5 */
  palette: string[]
  /** 'flex' | 'grid' | 'navbar' | 'hero' | 'sidebar' | 'footer' | 'form' 等 */
  layoutHints: string[]
  componentCounts: { buttons: number; links: number; images: number; forms: number }
  /** 正文前 200 字（需求语境） */
  textPreview: string
}

const DEFAULT_MAX_HTML_BYTES = 200_000
const DEFAULT_TIMEOUT_MS = 8_000

// ---------- 提取（纯函数，可单测） ----------

function extractTitle(html: string): string {
  return (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim()
}

function extractHeadings(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)) {
    const text = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (text && out.length < 6) out.push(text)
  }
  return out
}

function normalizeColor(raw: string): string {
  const c = raw.trim().toLowerCase()
  const hex = c.match(/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/)
  if (hex) return hex[0]
  const rgb = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (rgb) return `rgb(${rgb.slice(1, 4).join(',')})`
  return ''
}

function extractPalette(html: string): string[] {
  const counts = new Map<string, number>()
  for (const m of html.matchAll(/(?:^|[{;\s])(?:background(?:-color)?|color)\s*:\s*([^;}">]+)/gi)) {
    const color = normalizeColor(m[1])
    if (!color) continue
    counts.set(color, (counts.get(color) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c]) => c)
}

function extractLayoutHints(html: string): string[] {
  const hints = new Set<string>()
  const lower = html.toLowerCase()
  if (/\bdisplay\s*:\s*(?:flex|inline-flex)\b/.test(lower) || /\bflex\b/.test(lower)) hints.add('flex')
  if (/\bdisplay\s*:\s*grid\b/.test(lower) || /\bgrid\b/.test(lower)) hints.add('grid')
  if (/<nav[\s>]/i.test(html)) hints.add('navbar')
  if (/<(header|section class="hero|[^>]*hero)[\s>]/i.test(html)) hints.add('hero')
  if (/<(aside|sidebar)/i.test(html)) hints.add('sidebar')
  if (/<footer[\s>]/i.test(html)) hints.add('footer')
  if (/<form[\s>]/i.test(html)) hints.add('form')
  return [...hints]
}

function extractTextPreview(html: string): string {
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
  const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return text.slice(0, 200)
}

export function extractReferenceCard(url: string, html: string, maxHtmlBytes = DEFAULT_MAX_HTML_BYTES): DesignReferenceCard {
  const bounded = html.length > maxHtmlBytes ? html.slice(0, maxHtmlBytes) : html
  return {
    url,
    title: extractTitle(bounded),
    headings: extractHeadings(bounded),
    palette: extractPalette(bounded),
    layoutHints: extractLayoutHints(bounded),
    componentCounts: {
      buttons: [...bounded.matchAll(/<button[\s>]/gi)].length,
      links: [...bounded.matchAll(/<a[\s][^>]*href/gi)].length,
      images: [...bounded.matchAll(/<img[\s>]/gi)].length,
      forms: [...bounded.matchAll(/<form[\s>]/gi)].length,
    },
    textPreview: extractTextPreview(bounded),
  }
}

/** 参考卡序列化字节数（token 预算观测用，预算 ≤1.2KB）。 */
export function estimateReferenceCardSize(card: DesignReferenceCard): number {
  return JSON.stringify(card).length
}

// ---------- fetch 层（真实网络栈 + 诚实错误语义） ----------

export class FetchTimeoutError extends Error {
  constructor(url: string, ms: number) {
    super(`网页 ${url} 未在 ${ms}ms 内响应，请稍后重试或换一个链接。`)
    this.name = 'FetchTimeoutError'
  }
}

export async function fetchForReference(url: string, timeoutMs = DEFAULT_TIMEOUT_MS, maxHtmlBytes = DEFAULT_MAX_HTML_BYTES): Promise<DesignReferenceCard> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ac.signal })
    if (!res.ok) throw new Error(`网页返回 ${res.status}（${url}）`)
    const html = await res.text()
    return extractReferenceCard(url, html, maxHtmlBytes)
  } catch (e) {
    // 诚实中止语义：AbortError 归一为可读超时，其余透传
    if (e instanceof Error && e.name === 'AbortError') throw new FetchTimeoutError(url, timeoutMs)
    throw e
  } finally {
    clearTimeout(timer)
  }
}
