import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import * as T from '../../../main/experience/types'
import { extractPatternText, harvestGap } from '../../../scripts/harvest-references.mjs'

/**
 * G2 批跑流水线（全 seam 注入离线测）：
 * permissive+编译过 → verified + sidecar；weak/unknown → candidate 不带码；
 * strong → 拒绝；沙箱败 → candidate；LLM 坏 JSON → failed；重跑幂等 skipped；
 * dry-run 零写盘。ledger 经 scripts/lib upsertCard（真文件）。
 */

const PAGE = `
<html><head><title>Debounce patterns in JS</title></head><body>
<h1>Function throttling and debouncing</h1><h2>Why debounce</h2>
<pre>function debounce(fn, ms){let t;return(...a)=&gt;{clearTimeout(t);t=setTimeout(()=&gt;fn(...a),ms)}}</pre>
${'body text about debounce timers. '.repeat(20)}
</body></html>`

function llmJson(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    capability: 'Debounce a function call to limit execution rate',
    language_family: 'js',
    api_signature: 'debounce(fn, ms)',
    implementation_summary: 'Wrap target with a timer cleared on each call.',
    reuse_hint: 'Use for search inputs and resize handlers.',
    license: 'MIT',
    minimal_implementation: 'export function debounce(fn, ms){let t;return (...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms)}}',
    ...over,
  })
}

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harvest-'))
})

function deps(over: Partial<Record<string, unknown>> = {}) {
  return {
    T,
    root,
    dryRun: false,
    search: async () => [{ url: 'https://example.com/debounce', title: 'Debounce' }],
    fetchHtml: async () => PAGE,
    llm: async () => llmJson(),
    sandbox: async () => ({ build_pass: true, smoke_test_pass: undefined, executed_at: Date.now() }),
    ...over,
  } as never
}

const gap = { capability: 'debounce', suggested_queries: ['typescript debounce pattern'] }

function ledgerCards() {
  const path = join(root, 'bloma-experience.jsonl')
  if (!existsSync(path)) return []
  const byId = new Map<string, Record<string, unknown>>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const c = JSON.parse(line)
    byId.set(c.id, c)
  }
  return [...byId.values()]
}

describe('harvest-references：流水线判定', () => {
  it('permissive + 编译过 → verified + sidecar（index.js/metadata.json）+ 账本 files 非空', async () => {
    const r = await harvestGap(gap, deps())
    expect(r.verdict).toBe('verified')
    expect(r.license_tier).toBe('permissive')
    const cards = ledgerCards()
    expect(cards).toHaveLength(1)
    expect(cards[0].kind).toBe('pattern')
    expect(cards[0].status).toBe('verified')
    expect(String(cards[0].tag)).toMatch(/^pattern\/js\/[a-z0-9-]+$/) // slug 协议回归锁（首张 live 卡教训）
    expect((cards[0].body as { files: unknown[] }).files).toHaveLength(1)
    const fp = String(cards[0].fingerprint).slice(0, 8)
    expect(existsSync(join(root, 'bloma-ref-code', fp, 'index.js'))).toBe(true)
    expect(existsSync(join(root, 'bloma-ref-code', fp, 'metadata.json'))).toBe(true)
  })

  it('weak_copyleft（LGPL）→ candidate 不携码无 sidecar', async () => {
    const r = await harvestGap(gap, deps({ llm: async () => llmJson({ license: 'LGPL-3.0' }) }))
    expect(r.verdict).toBe('candidate')
    expect(r.license_tier).toBe('weak_copyleft')
    expect(ledgerCards()).toHaveLength(1)
    expect(readdirSync(root).filter((f) => f === 'bloma-ref-code')).toHaveLength(0)
  })

  it('strong_copyleft（GPL-3.0）→ rejected，账本零写入', async () => {
    const r = await harvestGap(gap, deps({ llm: async () => llmJson({ license: 'GPL-3.0' }) }))
    expect(r.verdict).toBe('rejected')
    expect(ledgerCards()).toHaveLength(0)
  })

  it('沙箱编译失败 → candidate（永不注入/物化）', async () => {
    const r = await harvestGap(gap, deps({ sandbox: async () => ({ build_pass: false, executed_at: Date.now(), error: 'Unexpected token' }) }))
    expect(r.verdict).toBe('candidate')
    expect(r.build_pass).toBe(false)
  })

  it('LLM 坏 JSON → failed；无检索 → skipped', async () => {
    expect((await harvestGap(gap, deps({ llm: async () => 'not json' }))).verdict).toBe('failed')
    expect((await harvestGap(gap, deps({ search: async () => [] }))).verdict).toBe('skipped')
  })

  it('同缺口重跑 → 幂等 skipped（fingerprint+seen 命中）', async () => {
    const first = await harvestGap(gap, deps())
    expect(first.verdict).toBe('verified')
    const again = await harvestGap(gap, deps())
    expect(again.verdict).toBe('skipped')
    expect(again.reason).toBe('already_harvested')
  })

  it('dry-run → 报表 verdict 正常但账本/sidecar 零写', async () => {
    const r = await harvestGap(gap, deps({ dryRun: true }))
    expect(r.verdict).toBe('verified')
    expect(ledgerCards()).toHaveLength(0)
  })

  it('缺省编译沙箱（真 esbuild，node_modules junction）：合法码过、语法错码败', async () => {
    const { makeCompileSandbox } = await import('../../../scripts/harvest-references.mjs')
    const sandbox = makeCompileSandbox(process.cwd(), T)
    const good = await sandbox({}, 'export const x = 1')
    expect(good.build_pass).toBe(true)
    const bad = await sandbox({}, 'export const x = ((((')
    expect(bad.build_pass).toBe(false)
    expect(bad.error).toContain('Unexpected')
  })
})

describe('harvest-references：页面提取', () => {
  it('title/headings/code 块都进文本；script/style 剥除', () => {
    const text = extractPatternText('<html><head><title>T</title><script>evil()</script></head><body><h2>H1</h2><pre>code line</pre><p>prose</p></body></html>')
    expect(text).toContain('T')
    expect(text).toContain('H1')
    expect(text).toContain('code line')
    expect(text).toContain('prose')
    expect(text).not.toContain('evil')
  })
})
