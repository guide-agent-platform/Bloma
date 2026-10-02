#!/usr/bin/env node
/**
 * probe-glm-stream.cjs — glm 渠道流式增量形态实测（dev 工具，2026-09-03）
 *
 * 复刻 Bloma anthropicMessagesQuery 实际请求形态（stream:true + tools +
 * thinking enabled/effort low，即 MVP loop 的真实组合），逐 SSE 事件统计：
 *   - text_delta / thinking_delta / 其他 delta 的数量与长度分布
 *   - 单一符号增量（len<=2 且非文字）计数——「大量单一符号」现象取证
 *   - 纯空白增量计数（cleaner 已知形态）
 *   - 退行采样检测（2026-10-02 补挂账：判据与 main/coding/output-integrity.ts
 *     的 isDegenerateText 同源——工具协议原文混入 + 连续重复 ≥8 单元 ≤8 字且
 *     覆盖 ≥25% 正文；退行复现时打印触发单元与次数，供采样参数对比）
 * key 从 channel-key-reader 产物读取（不打印明文）。
 */
const { readFileSync } = require('node:fs')

const keys = JSON.parse(readFileSync(process.argv[2] || '/tmp/keys-out2.json', 'utf8'))
const chPath = require('node:path')
const cfg = JSON.parse(readFileSync(require('node:os').homedir() + '/.proma/bloma-channels.json', 'utf8'))
const ch = (cfg.channels || []).find((c) => c.name === 'glm')
const key = keys.glm.apiKey
const url = `${ch.base_url.replace(/\/+$/, '')}/v1/messages`
const model = 'glm-5.3'

const TOOLS = [
  { name: 'write_file', description: '写文件', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
]

async function runStream(label, body) {
  const t0 = Date.now()
  const stats = { text: [], thinking: [], other: 0, blocks: [], raw: [] }
  let firstTextAt = 0, doneAt = 0
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key },
      body: JSON.stringify(body),
    })
    if (!r.ok) { console.log(`[${label}] HTTP ${r.status} ${(await r.text()).slice(0, 200)}`); return }
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const ev = buf.slice(0, i); buf = buf.slice(i + 2)
        const dl = ev.split('\n').find((l) => l.startsWith('data:'))
        if (!dl) continue
        const data = dl.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let p
        try { p = JSON.parse(data) } catch { stats.raw.push(data.slice(0, 60)); continue }
        if (p.type === 'content_block_start') stats.blocks.push(p.content_block?.type)
        if (p.type === 'content_block_delta' && p.delta) {
          if (p.delta.type === 'text_delta' && typeof p.delta.text === 'string') {
            if (!firstTextAt) firstTextAt = Date.now() - t0
            stats.text.push(p.delta.text)
          } else if (p.delta.type === 'thinking_delta' && typeof p.delta.thinking === 'string') {
            stats.thinking.push(p.delta.thinking)
          } else stats.other += 1
        }
        if (p.type === 'message_stop') doneAt = Date.now() - t0
      }
    }
  } catch (e) { console.log(`[${label}] 异常 ${String(e).slice(0, 150)}`); return }

  const lens = (arr) => arr.map((s) => s.length)
  const dist = (arr) => {
    if (!arr.length) return '(无)'
    const ls = lens(arr)
    const buckets = { '1': 0, '2': 0, '3-5': 0, '6-20': 0, '>20': 0 }
    for (const n of ls) { if (n === 1) buckets['1']++; else if (n === 2) buckets['2']++; else if (n <= 5) buckets['3-5']++; else if (n <= 20) buckets['6-20']++; else buckets['>20']++ }
    return JSON.stringify(buckets)
  }
  const sym = (arr) => arr.filter((s) => s.length <= 2 && !/[\u4e00-\u9fa5A-Za-z0-9]/.test(s)).length
  const ws = (arr) => arr.filter((s) => s.trim() === '').length
  const sample = (arr) => arr.slice(0, 6).map((s) => JSON.stringify(s.slice(0, 24))).join(' ')

  console.log(`\n[${label}] ${doneAt}ms | blocks=[${stats.blocks.join(',')}]`)
  console.log(`  text_delta     x${stats.text.length}  长度分布=${dist(stats.text)}  符号增量=${sym(stats.text)}  空白增量=${ws(stats.text)}`)
  console.log(`  样本: ${sample(stats.text)}`)
  console.log(`  thinking_delta x${stats.thinking.length}  长度分布=${dist(stats.thinking)}  符号增量=${sym(stats.thinking)}  空白增量=${ws(stats.thinking)}`)
  console.log(`  样本: ${sample(stats.thinking)}`)
  console.log(`  其他delta=${stats.other}  解析失败=${stats.raw.length}`)
  const fullText = stats.text.join('')
  console.log(`  text 全文(${fullText.length}): ${JSON.stringify(fullText.slice(0, 120))}`)
  // 退行采样检测（挂账清偿，2026-10-02）：判据与 output-integrity.isDegenerateText 同源；
  // 触发时打印单元/次数/占比，方便对比不同 thinking/effort 参数组合的退行复现率。
  const degen = detectDegenerate(fullText)
  if (degen) {
    console.log(`  ⚠ 退行命中: ${degen.kind}${degen.detail ? `（${degen.detail}）` : ''}`)
  } else {
    console.log('  退行检测: 未命中（工具协议原文无混入；无 ≥25% 占比的连续重复运行）')
  }
}

/** 与 main/coding/output-integrity.ts isDegenerateText 同源的 cjs 版（双侧阈值改动须同步）。 */
function detectDegenerate(text) {
  if (!text) return null
  const TOOL_MARKUP_PATTERNS = [/<｜｜DSML｜｜/, /<\/?tool_calls?[^a-z]/, /<\/?invoke\b/i, /<\/?parameter\b/i]
  for (const pattern of TOOL_MARKUP_PATTERNS) {
    if (pattern.test(text)) return { kind: '工具协议原文混入', detail: String(pattern) }
  }
  const MIN_REPEAT = 8, MAX_UNIT = 8, MIN_RUN_RATIO = 0.25
  const n = text.length
  if (n < 32) return null
  for (let start = 0; start < n; start += 1) {
    for (let unitLen = 1; unitLen <= MAX_UNIT; unitLen += 1) {
      if (start + unitLen * MIN_REPEAT > n) break
      const unit = text.slice(start, start + unitLen)
      let count = 1
      while (start + (count + 1) * unitLen <= n && text.startsWith(unit, start + count * unitLen)) count += 1
      if (count >= MIN_REPEAT && count * unitLen >= n * MIN_RUN_RATIO) {
        return { kind: '连续重复运行', detail: `单元=${JSON.stringify(unit)} ×${count}，占比 ${Math.round((count * unitLen * 100) / n)}%` }
      }
    }
  }
  return null
}

const baseMsgs = [{ role: 'user', content: [{ type: 'text', text: '用一句话中文说明你要开始写文件，然后调用 write_file 写入 hello.txt，内容为"hi"。' }] }]

;(async () => {
  // A: Bloma loop 真实组合——tools + thinking enabled + effort low
  await runStream('A tools+thinking low（loop 实况）', {
    model, max_tokens: 1024, stream: true, messages: baseMsgs, tools: TOOLS,
    thinking: { type: 'enabled' }, output_config: { effort: 'low' },
  })
  // B: 对照——tools + thinking disabled
  await runStream('B tools+thinking disabled', {
    model, max_tokens: 1024, stream: true, messages: baseMsgs, tools: TOOLS,
    thinking: { type: 'disabled' },
  })
})()
