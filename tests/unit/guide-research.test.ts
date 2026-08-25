import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseDdgResults,
  researchMarketSimilar,
  resetGuideResearchFetchForTests,
  setGuideResearchFetchForTests,
} from '../../main/guide-research'

/** 构造 DDG html 结果页（含 uddg 跳转链 / 直链 / 广告位三种形态）。 */
function ddgPage(results: Array<{ title: string; href: string; snippet: string; ad?: boolean }>): string {
  const blocks = results
    .map(
      (result) => `
      <div class="result results_links${result.ad ? ' result--ad' : ''} result_web">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="${result.href}">${result.title}</a>
        </h2>
        <a class="result__snippet" href="${result.href}">${result.snippet}</a>
      </div>`,
    )
    .join('\n')
  return `<html><body><div class="links_main">${blocks}</div></body></html>`
}

const htmlResponse = (body: string): Response =>
  ({ ok: true, status: 200, text: async () => body }) as unknown as Response

describe('guide-research 市调（DDG 免 key）', () => {
  afterEach(() => {
    resetGuideResearchFetchForTests()
    vi.unstubAllGlobals()
  })

  it('解析结果块：uddg 跳转解码为真实 URL，广告位剔除，标题/摘要剥标签', () => {
    const page = ddgPage([
      { title: '记账本 <b>App</b> 精选', href: '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fledger&rut=abc', snippet: '十款流行的<b>记账</b>应用对比' },
      { title: '推广位', href: 'https://ads.example.com/x', snippet: '广告', ad: true },
      { title: 'Best Budget Apps', href: 'https://www.github.com/topics/budget', snippet: 'open source budget apps' },
    ])
    const results = parseDdgResults(page)
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ title: '记账本 App 精选', url: 'https://example.com/ledger', snippet: '十款流行的记账应用对比' })
    expect(results[1]?.url).toBe('https://www.github.com/topics/budget')
  })

  it('正常搜索：合并去重、summary 含域名与摘要', async () => {
    setGuideResearchFetchForTests(async () =>
      htmlResponse(
        ddgPage([{ title: '番茄钟工具盘点', href: 'https://a.example.com/pomodoro', snippet: '25 分钟循环的流行实现' }]),
      ),
    )
    const research = await researchMarketSimilar(['番茄钟 应用', 'pomodoro app'])
    expect(research.available).toBe(true)
    expect(research.results[0]).toMatchObject({ url: 'https://a.example.com/pomodoro' })
    expect(research.summary).toContain('番茄钟工具盘点')
    expect(research.summary).toContain('a.example.com')
  })

  it('同 URL 跨查询去重，总数上限截断', async () => {
    let call = 0
    setGuideResearchFetchForTests(async (url: string | URL | Request) => {
      call += 1
      const same = ddgPage([{ title: `结果 ${call}`, href: 'https://same.example.com/x', snippet: 's' }])
      const distinct = Array.from({ length: 4 }, (_, i) => ({
        title: `独有 ${i}`,
        href: `https://q${call}.example.com/${i}`,
        snippet: 's',
      }))
      return htmlResponse(String(url).includes('pomodoro') ? ddgPage(distinct) : same)
    })
    const research = await researchMarketSimilar(['番茄钟', 'pomodoro'])
    expect(research.available).toBe(true)
    // 两条查询共 5 条去重后结果，未超 MAX_RESULTS=6
    expect(research.results).toHaveLength(5)
    const urls = research.results.map((result) => result.url)
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('网络失败 / HTTP 异常 / 空结果 均降级 available:false，绝不抛错', async () => {
    setGuideResearchFetchForTests(async () => {
      throw new Error('fetch failed')
    })
    const networkDown = await researchMarketSimilar(['番茄钟'])
    expect(networkDown.available).toBe(false)
    expect(networkDown.reason).toBe('network')

    setGuideResearchFetchForTests(async () => ({ ok: false, status: 503, text: async () => '' }) as unknown as Response)
    const serverDown = await researchMarketSimilar(['番茄钟'])
    expect(serverDown.reason).toBe('http_503')

    setGuideResearchFetchForTests(async () => htmlResponse('<html><body>challenge page</body></html>'))
    const empty = await researchMarketSimilar(['番茄钟'])
    expect(empty.available).toBe(false)
    expect(empty.reason).toBe('empty')

    // 空查询列表直接降级
    const noQuery = await researchMarketSimilar(['  '])
    expect(noQuery.available).toBe(false)
  })
})
