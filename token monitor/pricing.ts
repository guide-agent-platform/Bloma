import { join } from 'node:path'
import { readJsonFile, writeJsonFile } from '../storage/json-store'
import type { Counts, ModelRate, MonitorPrices, PriceBook, PriceSource } from '../shared/token-monitor'
import bundled from './pricing.json'

const sources = {
  OpenAI: 'https://developers.openai.com/api/docs/pricing.md',
  Anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing.md',
  DeepSeek: 'https://api-docs.deepseek.com/quick_start/pricing/',
  Google: 'https://aistudio.google.com/docs/pricing.md',
} as const
type Provider = keyof typeof sources
type Models = PriceBook['models']

export function officialPricingUrl(provider: string): string | undefined {
  return Object.hasOwn(sources, provider) ? sources[provider as Provider] : undefined
}

const price = (cell: string) => {
  const match = /^\s*\$([0-9]+(?:\.[0-9]+)?)\b/.exec(cell)
  return match ? Number(match[1]) : null
}
const rates = (uncached: number | null, read: number | null, write: number | null, output: number | null): Counts =>
  ({ uncached, read, write, output })

function openai(markdown: string): Models {
  const section = /^### Standard pricing data\s*\n([\s\S]*?)(?=^Batch\s*$|^### Batch|(?![\s\S]))/m.exec(markdown)?.[1] ?? ''
  const models: Models = {}
  let columns = new Map<string, number>()
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue
    const [label, ...cells] = line.trim().slice(1, -1).split('|').map(cell => cell.trim())
    if (label === 'Model') {
      columns = new Map(cells.map((cell, index) => [cell.toLowerCase(), index]))
      continue
    }
    const model = label.replace(/\s*\(.*\)$/, '')
    if (!/^(?:gpt-[\w.-]+|o[134](?:-[\w.-]+)?|chat-latest)$/.test(model)) continue
    const cell = (name: string) => price(cells[columns.get('short context ' + name) ?? columns.get(name) ?? -1] ?? '')
    const row = rates(cell('input'), cell('cached input'), cell('30m write'), cell('output'))
    if (row.uncached !== null && row.output !== null) models[model] = row
  }
  return models
}

function anthropic(markdown: string): Models {
  const section = /^## Model pricing\s*\n([\s\S]*?)(?=^##|(?![\s\S]))/m.exec(markdown)?.[1] ?? ''
  const models: Models = {}
  for (const line of section.split('\n')) {
    const match = /^\|\s*Claude (\w+)(?: ([\d.]+))?[^|]*\|(.+)/.exec(line)
    if (!match) continue
    const name = ['claude', match[1].toLowerCase(), match[2]?.replaceAll('.', '-')].filter(Boolean).join('-')
    const cells = match[3].trim().replace(/\|$/, '').split('|').map(price)
    if (cells.length === 5 && cells.every(cell => cell !== null)) {
      const [input, write, , read, output] = cells
      models[name] = rates(input, read, write, output)
    }
  }
  return models
}

function deepseek(html: string): Models {
  const table = [...html.matchAll(/<table\b[^>]*>(.*?)<\/table>/gis)]
    .find(match => match[1].includes('CACHE HIT') && match[1].includes('CACHE MISS'))?.[1] ?? ''
  const rows = [...table.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/gis)].map(match =>
    [...match[1].matchAll(/<t[hd]\b[^>]*>(.*?)<\/t[hd]>/gis)].map(cell => cell[1].replace(/<[^>]+>/g, ' ').trim()))
  const names = rows.find(row => row[0]?.toUpperCase() === 'MODEL')?.slice(1).map(cell => /^deepseek-[\w.-]+/i.exec(cell)?.[0].toLowerCase())
  if (!names?.length || names.some(name => !name)) return {}
  const groups = new Map<string, Array<number | null>>()
  let metric: keyof Counts | undefined
  for (const row of rows) {
    const label = row.join(' ').toUpperCase()
    if (label.includes('CACHE HIT')) metric = 'read'
    else if (label.includes('CACHE MISS')) metric = 'uncached'
    else if (label.includes('OUTPUT TOKENS')) metric = 'output'
    const tier = row.map(cell => cell.toUpperCase()).find(cell => cell === 'PEAK' || cell === 'OFF-PEAK')
    if (metric && tier) groups.set(tier + metric, row.slice(-names.length).map(price))
  }
  const models: Models = {}
  for (const [index, name] of names.entries()) {
    if (!name) continue
    const tier = (label: string) => rates(...(['uncached', 'read', 'write', 'output'] as const).map(metric =>
      groups.get(label + metric)?.[index] ?? null) as [number | null, number | null, number | null, number | null])
    const off = tier('OFF-PEAK')
    const peak = tier('PEAK')
    if ([off, peak].every(row => row.uncached !== null && row.read !== null && row.output !== null)) models[name] = { ...off, peak }
  }
  return models
}

function google(markdown: string): Models {
  const models: Models = {}
  for (const section of markdown.split(/^## /m).slice(1)) {
    const name = /\bid="(gemini-[\w.-]+)"/.exec(section.split('\n', 1)[0])?.[1]
    const tab = /{% tab title="Standard" %}(.*?){% \/tab %}/s.exec(section)?.[1]
    if (!name || !tab || /image|tts|live|robotics/.test(name)) continue
    const cell = (label: string) => price(new RegExp('\\* ' + label + '[^\\n]*\\n\\s*\\*[^\\n]*\\n\\s*\\*([^\\n]+)', 'i').exec(tab)?.[1] ?? '')
    const row = rates(cell('Input price'), cell('Context caching price'), null, cell('Output price'))
    if (row.uncached !== null && row.output !== null) models[name] = row
  }
  return models
}

const parsers = { OpenAI: openai, Anthropic: anthropic, DeepSeek: deepseek, Google: google }
const minimum = { OpenAI: 8, Anthropic: 5, DeepSeek: 2, Google: 3 }
const providers = Object.keys(sources) as Provider[]
type Status = Pick<PriceSource, 'state' | 'checked' | 'error'>
type PriceRequest = (url: string, options?: RequestInit) => Promise<Response>

function validBook(book: PriceBook | undefined): book is PriceBook {
  return Boolean(book && typeof book.as_of === 'string' && book.models && Object.keys(book.models).length)
}

export class PricingCatalog {
  private readonly cache: string
  private readonly request: PriceRequest
  private readonly books: Record<Provider, PriceBook> = { ...bundled }
  private readonly status: Partial<Record<Provider, Status>> = {}
  private pending?: Promise<MonitorPrices>
  private checked = false

  constructor(home: string, request: PriceRequest = fetch) {
    this.cache = join(home, 'token-monitor', 'pricing-cache.json')
    this.request = request
    try {
      const saved = readJsonFile<Partial<Record<Provider, PriceBook>>>(this.cache, {})
      for (const provider of providers) {
        const book = saved?.[provider]
        if (validBook(book)) this.books[provider] = book
      }
    } catch { /* A damaged cache falls back to the bundled prices. */ }
  }

  snapshot(): MonitorPrices {
    return Object.fromEntries(providers.map(provider => [provider, {
      ...this.books[provider], ...(this.status[provider] ?? { state: 'cached' }),
    }]))
  }

  refreshOnce(): void {
    if (!this.checked) void this.refresh()
  }

  refresh(): Promise<MonitorPrices> {
    this.checked = true
    this.pending ??= this.update().finally(() => { this.pending = undefined })
    return this.pending
  }

  private async update(): Promise<MonitorPrices> {
    const results = await Promise.all(providers.map(async provider => {
      const checked = new Date().toISOString()
      try {
        const response = await this.request(sources[provider], { signal: AbortSignal.timeout(6500), credentials: 'omit', headers: { 'User-Agent': 'Bloma-Token-Monitor/1.0' } })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        const models = parsers[provider](await response.text())
        if (Object.keys(models).length < minimum[provider]) throw new Error('官网价格表未通过校验')
        const live = Object.fromEntries(Object.entries(models).map(([name, row]) => [name, { ...row, as_of: checked }]))
        const previous = this.books[provider]
        const earlier = Object.fromEntries(Object.entries(previous.models).map(([name, row]) => [name, { ...row, as_of: row.as_of ?? previous.as_of }]))
        this.books[provider] = { as_of: checked, models: { ...earlier, ...live } }
        this.status[provider] = { state: 'live', checked }
        return true
      } catch (error) {
        this.status[provider] = { state: 'cached', checked, error: error instanceof Error ? error.message : String(error) }
        return false
      }
    }))
    if (results.some(Boolean)) {
      try { writeJsonFile(this.cache, this.books) }
      catch (error) { console.warn('[token monitor] 无法保存价格缓存', error) }
    }
    return this.snapshot()
  }
}
