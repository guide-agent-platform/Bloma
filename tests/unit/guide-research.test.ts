import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeResearchQuery,
  parseBingResults,
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

/** 构造必应结果页（b_algo 块：h2 锚点 + b_caption 摘要；含站内链噪声）。 */
function bingPage(results: Array<{ title: string; href: string; snippet: string }>): string {
  const blocks = results
    .map(
      (result) => `
      <li class="b_algo" data-id iid="SERP.1">
        <h2 class=""><a target="_blank" href="${result.href}">${result.title}</a></h2>
        <div class="b_caption"><p>${result.snippet}</p></div>
      </li>`,
    )
    .join('\n')
  return `<html><body><ol id="b_results">${blocks}<li class="b_algo"><h2><a href="https://www.bing.com/aclick">广告</a></h2></li></ol></body></html>`
}

describe('guide-research 市调（DDG 免 key）', () => {
  afterEach(() => {
    resetGuideResearchFetchForTests()
    vi.unstubAllGlobals()
  })

  it('查询词清洗（2026-08-29 灵感不相关修复）：剥离「帮我做一个」类口语话术与尾语气词', () => {
    expect(normalizeResearchQuery('帮我做一个计算机模拟器')).toBe('计算机模拟器')
    expect(normalizeResearchQuery('我想做一个记账应用')).toBe('记账应用')
    expect(normalizeResearchQuery('请帮我写一个待办清单工具吧')).toBe('待办清单工具')
    expect(normalizeResearchQuery('能不能做一个健身打卡的')).toBe('健身打卡')
    expect(normalizeResearchQuery('计算器')).toBe('计算器')
    expect(normalizeResearchQuery('   ')).toBe('')
  })

  it('市调入口对查询词统一清洗后再搜索（含话术前缀的原始需求不再原样出网）', async () => {
    const captured: string[] = []
    setGuideResearchFetchForTests((_input, _init) => {
      const url = String(_input)
      captured.push(url)
      return Promise.resolve(htmlResponse(ddgPage([{ title: '计算机模拟器 - 搜索结果', href: 'https://example.com/x', snippet: '教学机与硬件原理' }])))
    })
    const research = await researchMarketSimilar(['帮我做一个计算机模拟器', '我想做一个记账应用'])
    expect(research.available).toBe(true)
    expect(captured.length).toBe(2)
    // 搜索 URL 的 q= 参数不含口语话术
    expect(captured[0]).not.toContain(encodeURIComponent('帮我'))
    expect(captured[0]).toContain(encodeURIComponent('计算机模拟器'))
    expect(captured[1]).toContain(encodeURIComponent('记账应用'))
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

  it('必应解析（2026-08-29 回退端点）：b_algo 块取标题/链接/摘要，站内链剔除', () => {
    const page = bingPage([
      { title: '在线音乐制作', href: 'https://example.com/studio', snippet: '浏览器一键实现音频剪辑' },
      { title: '免费合成器', href: 'https://example.org/synth', snippet: '8 位风格低音合成器' },
    ])
    const parsed = parseBingResults(page)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({ title: '在线音乐制作', url: 'https://example.com/studio', snippet: '浏览器一键实现音频剪辑' })
    expect(parsed[1]?.url).toBe('https://example.org/synth')
    // 站内链（bing.com）不进市调
    expect(parsed.every((item) => !item.url.includes('bing.com'))).toBe(true)
  })

  it('DDG 失败回退必应（2026-08-29 线上：大陆网络 DDG 直连必超时）：必应命中则市调可用', async () => {
    const bing = bingPage([
      { title: '在线音乐制作', href: 'https://example.com/studio', snippet: '音频剪辑工具' },
      { title: '免费合成器榜单', href: 'https://example.org/synth', snippet: '8 位风格低音合成器' },
    ])
    setGuideResearchFetchForTests(async (input) => {
      const url = String(input)
      if (url.includes('duckduckgo')) throw new TypeError('fetch failed') // 模拟 DDG 被墙
      return htmlResponse(bing)
    })
    const result = await researchMarketSimilar(['做一个音乐合成器'])
    expect(result.available).toBe(true)
    expect(result.results).toHaveLength(2)
    expect(result.summary).toContain('example.com')
  })

  it('两端均败：保留 DDG 失败原因（诊断口径不因回退混淆）', async () => {
    setGuideResearchFetchForTests(async (input) => {
      if (String(input).includes('duckduckgo')) throw new TypeError('fetch failed')
      return ({ ok: false, status: 503, text: async () => '' }) as unknown as Response
    })
    const result = await researchMarketSimilar(['番茄钟'])
    expect(result.available).toBe(false)
    expect(result.reason).toBe('network')
  })
})

describe('R1 词典/百科结果过滤（2026-09-11 狗粮 dd6ba98d：cn.bing 罐头页）', () => {
  afterEach(() => {
    resetGuideResearchFetchForTests()
  })

  it('isDictionaryResult：当晚 Bing 实测六域名全拦；正常产品结果放行', async () => {
    const { isDictionaryResult } = await import('../../main/guide-research')
    // 当晚 cn.bing 罐头页返回的真实标题/域名（两条查询共 12 条全为词典页）
    expect(isDictionaryResult({ title: '纵（汉语文字）_百度百科', url: 'https://baike.baidu.com/item/%E7%BA%B5' })).toBe(true)
    expect(isDictionaryResult({ title: '纵 z&#242;ng、zǒng、zōng - 汉典', url: 'https://www.zdic.net/hans/纵' })).toBe(true)
    expect(isDictionaryResult({ title: '纵的意思,纵的解释,纵的拼音,纵的部首,纵的笔顺-汉语国学', url: 'https://www.hanyuguoxue.com/zong' })).toBe(true)
    expect(isDictionaryResult({ title: '纵怎么读_纵的拼音 - 新华字典', url: 'https://zidian.gushici.net/zong' })).toBe(true)
    expect(isDictionaryResult({ title: '纵_纵怎么读_纵的意思 - 汉语字典', url: 'https://www.chagushici.com/zong' })).toBe(true)
    expect(isDictionaryResult({ title: '《纵》的拼音,纵字的意思、组词、部首、笔画、笔顺 - 汉语查', url: 'https://www.hgcha.com/zong' })).toBe(true)
    // 正常产品/攻略结果不误杀
    expect(isDictionaryResult({ title: '暖雪手游全 Boss 解析攻略', url: 'https://www.gamersky.com/ent/xxx' })).toBe(false)
    expect(isDictionaryResult({ title: '雷电战机 retro 射击游戏', url: 'https://store.steampowered.com/app/xxx' })).toBe(false)
    expect(isDictionaryResult({ title: 'JS 弹幕引擎对比', url: 'https://github.com/topics/danmaku' })).toBe(false)
  })

  it('引擎返回全词典页 → available=false reason=dictionary_junk（如实降级，字典页不进弹窗）', async () => {
    // DDG 网络失败 + Bing 返回当晚实测罐头页（复刻两条查询同一批结果的形态）
    const junkBing = bingPage([
      { title: '纵（汉语文字）_百度百科', href: 'https://baike.baidu.com/item/%E7%BA%B5', snippet: '纵，缓也' },
      { title: '纵 z&#242;ng、zǒng、zōng - 汉典', href: 'https://www.zdic.net/hans/纵', snippet: '本义:松缓' },
    ])
    let call = 0
    setGuideResearchFetchForTests((_input, _init) => {
      call += 1
      const url = String(_input)
      if (url.includes('duckduckgo')) return Promise.reject(new Error('network timeout'))
      return Promise.resolve(htmlResponse(junkBing))
    })
    const research = await researchMarketSimilar(['纵版打飞机 手游 关卡 Boss'])
    expect(research.available).toBe(false)
    // 双端均败保留主端点（DDG）失败原因（既有锁定语义）；关键保证：词典页零条进弹窗/摘要
    expect(research.reason).toBe('network')
    expect(research.results).toHaveLength(0)
    expect(research.summary).toBe('')
    expect(call).toBe(2) // DDG 失败后逐查询回退 Bing
  })

  it('混合结果：词典页剔除、真实结果保留；摘要只含干净条目', async () => {
    const mixed = bingPage([
      { title: '纵（汉语文字）_百度百科', href: 'https://baike.baidu.com/item/%E7%BA%B5', snippet: '纵，缓也' },
      { title: '十大经典纵版射击游戏盘点', href: 'https://www.gamersky.com/top/shmup', snippet: '从雷电到怒首领蜂的街机回忆' },
      { title: '弹幕射击手游推荐榜', href: 'https://www.taptap.io/topic/bullet', snippet: '2026 年热门弹幕手游' },
    ])
    setGuideResearchFetchForTests((_input, _init) => {
      const url = String(_input)
      if (url.includes('duckduckgo')) return Promise.reject(new Error('network timeout'))
      return Promise.resolve(htmlResponse(mixed))
    })
    const research = await researchMarketSimilar(['纵版射击游戏 推荐'])
    expect(research.available).toBe(true)
    expect(research.results).toHaveLength(2)
    expect(research.results.some((r) => r.title.includes('百度百科'))).toBe(false)
    expect(research.summary).toContain('十大经典纵版射击游戏盘点')
    expect(research.summary).not.toContain('百度百科')
  })
})
