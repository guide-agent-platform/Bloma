/**
 * 向导市调（guide-research）——需求确认前的「市面上类似话题」调查。
 *
 * 数据源：DuckDuckGo HTML 端点（免 key）。用户 2026-08-26 拍板：
 * 免 key 优先、稳定性待线上验证，搜索失败时弹窗照常出（市调降级标注，绝不阻断）。
 *
 * 语义边界（v1）：只取搜索结果页的标题/链接/摘要做归纳上下文，不抓取目标页正文
 * ——目标页抓取留给编程 agent 的 web_fetch，向导市调保持轻量、低失败面。
 * SSRF 防护对固定 DDG 端点不构成风险面（不自拼用户 URL）；结果链接仅展示不请求。
 */

import { NET_FETCH_TIMEOUT_MS, htmlToText } from '../platform/net/net-guard'

/** 单条市调结果：标题 / 链接 / 摘要（均来自搜索结果页，未抓取目标页）。 */
export interface MarketResult {
  title: string
  url: string
  snippet: string
}

/** 市调产物：available=false 时弹窗仍可出，仅标注「市调不可用」。 */
export interface MarketResearch {
  available: boolean
  queries: string[]
  results: MarketResult[]
  /** 直接注入弹窗与向导上下文的汇总文本（编号列表，≤4000 字符） */
  summary: string
  /** R1（2026-09-11 狗粮 dd6ba98d 复盘）：dictionary_junk = 引擎返回的全部结果都被
 *  词典/百科过滤拦截（大陆网络 cn.bing 反爬罐头页实测形态）——与 network/empty
 *  同级如实降级，字典页绝不进弹窗与向导上下文。 */
  reason?: 'network' | 'empty' | 'dictionary_junk' | `http_${number}`
}

/** 结果条数与摘要长度上限（弹窗上下文体积控制）。 */
const MAX_RESULTS = 6
const MAX_RESULTS_PER_QUERY = 4
const MAX_SUMMARY_CHARS = 4000
const MAX_QUERIES = 2

/** 搜索端点（固定公网主机，无用户可控 URL 片段）。 */
const DDG_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/'
/** 回退端点：必应（2026-08-29 线上实测：DDG 在部分网络环境（如大陆）直连必超时，
 * 必应同环境 0.6s 可达；DDG 失败（网络/HTTP/解析空）时逐查询回退必应）。 */
const BING_ENDPOINT = 'https://www.bing.com/search'

/** fetch 注入 seam（单测不打真实网络）。 */
let researchFetch: typeof fetch = fetch

export function setGuideResearchFetchForTests(fetcher: typeof fetch): void {
  researchFetch = fetcher
}

export function resetGuideResearchFetchForTests(): void {
  researchFetch = fetch
}

/**
 * 市调查询词清洗（2026-08-29：线上案例查询词为需求原文「帮我做一个计算机模拟器」，
 * 口语话术导致搜索结果不相关）。剥离常见对话前缀与尾语气词，保留核心主题词。
 */
export function normalizeResearchQuery(raw: string): string {
  let query = String(raw ?? '').trim()
  if (!query) return ''
  // 第一层：祈使/请求主谓（帮我/请你/我想/我需要 等；「请帮我」必须在「请」之前）
  query = query.replace(
    /^(?:请帮我|帮我|请你|麻烦你|麻烦|请|我想要一个|我想要|我想做一个|我想做|我想弄|我想搞|我想写|我想|我需要|给我|希望你能|能帮我|可不可以|可以帮我|能不能帮我|能不能)/,
    '',
  )
  // 第二层：制作动词（做一个/制作/搞一个 等）
  query = query.replace(
    /^(?:做一个|做个|制作一个|制作|搞一个|写一个|开发一个|设计一个|弄一个|整一个|来一个|做一个简单的|做|搞|写|开发|设计|弄|整|来)/,
    '',
  )
  query = query.trim()
  // 去尾部语气词/句尾填充
  while (query.length > 0 && /[吧啊呢哦呀吗么哈哇的]/.test(query.charAt(query.length - 1))) {
    query = query.slice(0, -1).trim()
  }
  // 截断到 40 字（超长原始需求只取主题头部）
  query = query.slice(0, 40).trim()
  return query
}

/**
 * 按向导给出的市调查询（≤2 条）并发搜索并合并去重。
 * 任何失败（网络/HTTP/解析为空）降级为 available:false——市调是增强，不是依赖。
 */
export async function researchMarketSimilar(queriesInput: string[]): Promise<MarketResearch> {
  const queries = queriesInput
    .map((query) => normalizeResearchQuery(query))
    .filter((query) => query.length > 0)
    .slice(0, MAX_QUERIES)
  if (queries.length === 0) {
    return { available: false, queries, results: [], summary: '', reason: 'empty' }
  }

  const settled = await Promise.all(queries.map((query) => searchOnce(query)))
  const merged = new Map<string, MarketResult>()
  let failure: MarketResearch | undefined
  for (const outcome of settled) {
    if (!outcome.available) {
      failure ??= outcome
      continue
    }
    for (const result of outcome.results) {
      // R1：合并层二次过滤（防御深度——引擎结构变化时单点拦截失效的兑底）
      if (!isDictionaryResult(result) && !merged.has(result.url)) merged.set(result.url, result)
    }
  }
  const results = [...merged.values()].slice(0, MAX_RESULTS)
  if (results.length === 0) {
    return failure ?? { available: false, queries, results: [], summary: '', reason: 'empty' }
  }
  return { available: true, queries, results, summary: renderSummary(results) }
}

/** 单条查询：DDG html 端点优先，失败回退必应（2026-08-29；两端均败才降级）。 */
async function searchOnce(query: string): Promise<MarketResearch> {
  const viaDdg = await searchViaEngine(query, DDG_HTML_ENDPOINT, parseDdgResults, {
    // DDG html 端点对无 UA 请求可能返回异常页，补常规浏览器头
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BlomaResearch/1.0',
    accept: 'text/html',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.5',
  })
  if (viaDdg.available) return viaDdg
  const viaBing = await searchViaEngine(query, `${BING_ENDPOINT}?setlang=zh-hans`, parseBingResults, {
    // 必应对非标准 UA 可能触发风控/验证页，用完整浏览器 UA
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    accept: 'text/html',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.5',
  })
  if (viaBing.available) return viaBing
  return viaDdg // 两端均败：保留首选端点的失败原因（诊断口径一致）
}

/** 单引擎搜索：请求 + 解析 + 结果条数上限，失败语义（network/http_N/empty）学一不做二不改。 */
async function searchViaEngine(
  query: string,
  endpoint: string,
  parse: (html: string) => MarketResult[],
  headers: Record<string, string>,
): Promise<MarketResearch> {
  let response: Response
  try {
    response = await researchFetch(`${endpoint}${endpoint.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`, {
      method: 'GET',
      signal: AbortSignal.timeout(NET_FETCH_TIMEOUT_MS),
      headers,
      redirect: 'follow',
    })
  } catch {
    return { available: false, queries: [query], results: [], summary: '', reason: 'network' }
  }
  if (!response.ok) {
    return { available: false, queries: [query], results: [], summary: '', reason: `http_${response.status}` as `http_${number}` }
  }
  const html = await response.text()
  const parsed = parse(html)
  // R1（2026-09-11）：词典/百科结果过滤（cn.bing 罐头页实测：不同查询返回同一批
  // 「纵（汉语文字）_百度百科」类结果）。全部被拦 → dictionary_junk 如实降级。
  const clean = parsed.filter((result) => !isDictionaryResult(result))
  if (clean.length === 0) {
    return {
      available: false,
      queries: [query],
      results: [],
      summary: '',
      reason: parsed.length > 0 ? 'dictionary_junk' : 'empty',
    }
  }
  const results = clean.slice(0, MAX_RESULTS_PER_QUERY)
  return { available: true, queries: [query], results, summary: renderSummary(results) }
}

// ---------------------------------------------------------------------------
// R1（2026-09-11 狗粮 dd6ba98d）：词典/百科结果过滤（经验库 P2b 同款判定，
// 经验库已于 2026-10-02 退役，本处为其唯一存活副本）——市调搜索
// 引擎（大陆网络 cn.bing 反爬降级/查询词分词）会把中文查询首字当词返回字典页，
// 这类结果无任何市调价值且会污染灵感参考区与经验库。
// ---------------------------------------------------------------------------

/** 百科/词典站域名清单（狗粮实测：cn.bing 罐头页返回的全部域名）。 */
const DICTIONARY_RESULT_DOMAINS = [
  'baike.baidu.com',
  'zh.wikipedia.org',
  'zh.wiktionary.org',
  'baike.sogou.com',
  'dict.baidu.com',
  'zidian.gushiwen.cn',
  'zidian.gushici.com',
  'zidian.gushici.net',
  'chagushici.com',
  'www.hgcha.com',
  'www.guoxuedashi.net',
  'xh.5156edu.com',
  'cd.hwxnet.com',
  'zdic.net',
  'hanyuguoxue.com',
  'kmcha.com',
  'yuwenmi.com',
]
/** 词典站域名模式（zidian./cidian./baike./guoxue./wiki 前缀站，防清单追不全）。 */
const DICTIONARY_DOMAIN_RE = /(^|\.)(zidian|cidian|baike|guoxue|wiktionary)\./i
/** 标题词典学特征（百科后缀/词典括注/查字典内容标记）。 */
const ENCYCLOPEDIA_TITLE_RE = /_(百度百科|维基百科|搜狗百科|快百科|头条百科|萌娘百科|词典)$/i
const DICTIONARY_TITLE_RE = /[（(](汉语文字|汉字|词语|多音字|方言|姓氏|汉语词汇)[）)]/
const DICTIONARY_CONTENT_RE = /(怎么读|怎么念|新华字典|汉语词典|康熙字典|说文解字|组词|笔顺)|拼音.{0,10}部首|部首.{0,10}拼音/

/** 词典/百科结果判定（导出侢单测与经验库对齐校验）。 */
export function isDictionaryResult(result: { title: string; url: string }): boolean {
  const title = result.title.trim()
  let hostname = ''
  try {
    hostname = new URL(result.url).hostname.toLowerCase()
  } catch {
    hostname = ''
  }
  if (ENCYCLOPEDIA_TITLE_RE.test(title)) return true
  if (DICTIONARY_TITLE_RE.test(title)) return true
  if (DICTIONARY_CONTENT_RE.test(title)) return true
  if (DICTIONARY_RESULT_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) return true
  if (DICTIONARY_DOMAIN_RE.test(hostname)) return true
  return false
}

/**
 * 解析必应结果页（2026-08-29 回退端点）：按 <li class="b_algo"> 结果块切分，
 * 逐块取标题锚点（h2>a）与摘要（b_caption）。必应站内链接/无 h2 锚点的块丢弃。
 */
export function parseBingResults(html: string): MarketResult[] {
  const blocks = html.split('<li class="b_algo"').slice(1)
  const out: MarketResult[] = []
  for (const block of blocks) {
    const anchor = /<h2[^>]*><a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    if (!anchor) continue
    let url: URL
    try {
      url = new URL(anchor[1])
    } catch {
      continue
    }
    // 必应站内链（含跳转链）无市调价值
    if (/(^|\.)bing\.com$/i.test(url.hostname)) continue
    const title = htmlToText(anchor[2]).trim()
    if (!title) continue
    const snippetMatch = /class="b_caption"[^>]*>([\s\S]*?)<\/div>/.exec(block)
    const snippet = snippetMatch ? htmlToText(snippetMatch[1]).trim().slice(0, 200) : ''
    out.push({ title, url: url.toString(), snippet })
  }
  return out
}

/**
 * 解析 DDG html 结果页：按结果块切分，逐块取标题锚点（result__a）与摘要
 * （result__snippet）。链接可能是直链，也可能是指向 duckduckgo.com/l/?uddg=<编码>
 * 的跳转——统一解码为真实 URL 后展示。
 */
export function parseDdgResults(html: string): MarketResult[] {
  // 带捕获组的 split：分隔段（结果块开头的 div 及其 class）保留为数组元素，
  // 广告位标记（result--ad）在 class 里，必须连同开段一起检查才不会被吞掉。
  const parts = html.split(/(<div[^>]*class="[^"]*\bresults_links\b[^"]*")/)
  const out: MarketResult[] = []
  for (let index = 1; index + 1 < parts.length; index += 2) {
    const opener = parts[index] ?? ''
    const block = parts[index + 1] ?? ''
    if (/result--ad/.test(opener)) continue // 广告位不进市调
    const anchor = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    if (!anchor) continue
    const url = resolveDdgHref(anchor[1])
    if (!url) continue
    const title = htmlToText(anchor[2]).trim()
    if (!title) continue
    const snippetMatch = /<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    const snippet = snippetMatch ? htmlToText(snippetMatch[1]).trim() : ''
    out.push({ title, url, snippet })
  }
  if (out.length > 0) return out
  // 无标准结果块（页面结构变化/挑战页）：以整页做一次兼容探测，找不到即如实判空
  const anchorAll = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(html)
  if (anchorAll) {
    const url = resolveDdgHref(anchorAll[1])
    const title = htmlToText(anchorAll[2]).trim()
    if (url && title) return [{ title, url, snippet: '' }]
  }
  return out
}

/** DDG href 解码：直链原样；uddg 跳转参数解码；解码失败或残留 DDG 自链则丢弃。 */
function resolveDdgHref(raw: string): string | undefined {
  let href = raw.trim()
  if (href.startsWith('//')) href = `https:${href}`
  if (!/^https?:\/\//i.test(href)) return undefined
  try {
    const url = new URL(href)
    if (url.hostname.includes('duckduckgo.com') && url.pathname.startsWith('/l/')) {
      const target = url.searchParams.get('uddg')
      if (!target) return undefined
      const decoded = decodeURIComponent(target)
      if (!/^https?:\/\//i.test(decoded)) return undefined
      return decoded
    }
    if (url.hostname.includes('duckduckgo.com')) return undefined // 站内链（如 y.js）无市调价值
    return url.toString()
  } catch {
    return undefined
  }
}

/** 汇总文本：编号列表（标题 — 域名 + 摘要），≤4000 字符截断。 */
function renderSummary(results: MarketResult[]): string {
  const lines = results.map((result, index) => {
    const domain = safeDomain(result.url)
    const head = `${index + 1}. ${result.title}${domain ? ` — ${domain}` : ''}`
    return result.snippet ? `${head}\n   ${result.snippet}` : head
  })
  const summary = lines.join('\n')
  return summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS)}…（已截断）` : summary
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
