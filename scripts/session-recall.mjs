#!/usr/bin/env node
// session-recall.mjs — 跨会话内容检索原型（BM25 + CJK bigram，零依赖）
//
// 定位（2026-08-28 r48 现状调研结论）：Bloma 已有 memory-distiller（项目内偏好蒸馏，
// T4-L3 兜底层）与 readPrimaryIntent（单会话主题锚点），但**没有跨会话内容检索**——
// 用户「上次那个 XX 在哪 / 按上次的做法」只能靠人肉翻会话列表。本原型验证：
// 对 {PROMA_HOME}/agent-sessions/*.jsonl 全量建 BM25 索引，query 秒回 top-k 会话+片段。
//
// 用法:
//   node scripts/session-recall.mjs --index            # 建索引（全量扫，写缓存）
//   node scripts/session-recall.mjs --query "fs-retry" # 查询（无缓存先自动建）
//   node scripts/session-recall.mjs --query "渠道" --top 10 --verbose
//
// 设计要点:
//   - 中文无空格 → CJK bigram 切词 + ASCII 词元；BM25 (k1=1.2, b=0.75)
//   - 只索引对话文本（user 提问 + assistant text 回复），跳过 thinking/tool_use_result
//     —— 检索面是「说过什么」，不是「怎么想的」（思考流噪音大且体积 3-5x）
//   - 片段级打分：会话内按消息粒度切 chunk，返回最相关 chunk 而非全会话
//   - 索引缓存落 {PROMA_HOME}/.session-recall-index.json，mtime+size 未变的会话复用（增量索引）

import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join as pjoin } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = pjoin(__dirname, '..')

// ---- 参数 ----
const args = process.argv.slice(2)
let mode = ''
let query = ''
let topK = 5
let verbose = false
let forceFull = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--index') mode = 'index'
  else if (args[i] === '--query') { query = args[++i]; mode = 'query' }
  else if (args[i] === '--top') topK = Number(args[++i]) || 5
  else if (args[i] === '--verbose') verbose = true
  else if (args[i] === '--rebuild') { mode = 'index'; forceFull = true }
}
if (!mode) { console.error('用法: session-recall.mjs --index | --query "<text>" [--top N] [--verbose]'); process.exit(2) }

const PROMA_HOME = (process.env.PROMA_HOME || pjoin(homedir(), '.proma')).replace(/\\/g, '/')
const SESS_DIR = pjoin(PROMA_HOME, 'agent-sessions')
const INDEX_PATH = pjoin(PROMA_HOME, '.session-recall-index.json')

// ---- 分词（CJK bigram + ASCII word）----
function tokenize(text) {
  const out = []
  const cleaned = text.replace(/[\r\n\t]+/g, ' ')
  for (const m of cleaned.matchAll(/[A-Za-z_][A-Za-z0-9_-]{1,30}/g)) out.push(m[0].toLowerCase())
  const cjkRuns = cleaned.match(/[\u4e00-\u9fff]+/g) || []
  for (const run of cjkRuns) {
    if (run.length === 1) out.push(run)
    else for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2))
  }
  return out
}

// ---- 提取一行 JSONL 的对话文本 ----
function extractTexts(line) {
  let j
  try { j = JSON.parse(line) } catch { return null }
  if (j.type !== 'user' && j.type !== 'assistant') return null
  const content = j.message?.content
  if (!Array.isArray(content)) {
    if (typeof content === 'string' && j.type === 'user') return { role: 'user', text: content.slice(0, 2000), at: j._createdAt || j.timestamp }
    return null
  }
  const texts = content.filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim()).map((b) => b.text)
  if (!texts.length) return null
  return { role: j.type, text: texts.join('\n').slice(0, 3000), at: j._createdAt || j.timestamp }
}

// ---- 建索引（mtime+size 增量）----
async function buildIndex(force = false) {
  const files = readdirSync(SESS_DIR).filter((f) => f.endsWith('.jsonl'))
  let prev = null
  if (!force && existsSync(INDEX_PATH)) {
    try { prev = JSON.parse(readFileSync(INDEX_PATH, 'utf8')) } catch { prev = null }
  }
  const prevByFile = new Map((prev?.files || []).map((f) => [f.name, f]))
  const t0 = Date.now()
  const indexed = []
  let reused = 0
  for (const name of files) {
    const full = pjoin(SESS_DIR, name)
    const st = statSync(full)
    const old = prevByFile.get(name)
    if (old && old.mtime === st.mtimeMs && old.size === st.size) { indexed.push(old); reused++; continue }
    const msgs = []
    const rl = createInterface({ input: createReadStream(full, 'utf8'), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.trim()) continue
      const e = extractTexts(line)
      if (e) msgs.push(e)
    }
    const firstUser = msgs.find((m) => m.role === 'user')
    indexed.push({
      name, mtime: st.mtimeMs, size: st.size,
      intent: firstUser ? firstUser.text.slice(0, 120) : '',
      span: msgs.length ? [Math.min(...msgs.map((m) => m.at || 0)), Math.max(...msgs.map((m) => m.at || 0))] : [0, 0],
      msgs: msgs.map((m) => ({ role: m.role, text: m.text })),
    })
  }
  const idx = { builtAt: Date.now(), files: indexed }
  writeFileSync(INDEX_PATH, JSON.stringify(idx))
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const totalMsgs = indexed.reduce((n, f) => n + f.msgs.length, 0)
  console.error(`[session-recall] 索引完成: ${files.length} 会话（复用 ${reused}）/${totalMsgs} 消息/${secs}s → ${INDEX_PATH}`)
  return idx
}

// ---- BM25（会话内消息粒度 chunk；同会话聚合：最高分 chunk + 命中数）----
const K1 = 1.2, B = 0.75
async function search(idx, queryText, k) {
  const docs = []
  for (const f of idx.files) for (const m of f.msgs) docs.push({ file: f.name, intent: f.intent, span: f.span, role: m.role, text: m.text })
  const docToks = docs.map((d) => tokenize(d.text))
  const N = docs.length
  const avgdl = docToks.reduce((n, t) => n + t.length, 0) / (N || 1)
  const df = new Map()
  const tf = docToks.map((toks) => {
    const m = new Map()
    for (const t of toks) m.set(t, (m.get(t) || 0) + 1)
    for (const t of m.keys()) df.set(t, (df.get(t) || 0) + 1)
    return m
  })
  const qToks = [...new Set(tokenize(queryText))]
  const bySession = new Map()
  for (let i = 0; i < N; i++) {
    let s = 0
    const dl = docToks[i].length || 1
    for (const q of qToks) {
      const f = tf[i].get(q)
      if (!f) continue
      const n = df.get(q) || 1
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * dl / avgdl))
    }
    if (s <= 0) continue
    const doc = docs[i]
    const cur = bySession.get(doc.file)
    if (!cur) bySession.set(doc.file, { file: doc.file, intent: doc.intent, span: doc.span, best: { score: +s.toFixed(2), role: doc.role, text: doc.text }, hits: 1 })
    else { cur.hits++; if (s > cur.best.score) cur.best = { score: +s.toFixed(2), role: doc.role, text: doc.text } }
  }
  return [...bySession.values()].sort((a, b) => b.best.score - a.best.score || b.hits - a.hits).slice(0, k)
}

// ---- 主流程 ----
let idx = null
if (mode === 'index') { await buildIndex(forceFull); process.exit(0) }
if (existsSync(INDEX_PATH)) { try { idx = JSON.parse(readFileSync(INDEX_PATH, 'utf8')) } catch { idx = null } }
if (!idx) idx = await buildIndex(true)

if (mode === 'query') {
  const t0 = Date.now()
  const results = await search(idx, query, topK)
  const ms = Date.now() - t0
  console.log(`query="${query}" → ${results.length} 会话命中 (${ms}ms, 索引 ${idx.files.length} 会话)`)
  for (const [i, r] of results.entries()) {
    const date = r.span?.[0] ? new Date(r.span[0]).toISOString().slice(0, 10) : '?'
    console.log(`\n#${i + 1} [${r.best.score}] ${r.file.slice(0, 13)} · ${date} · 片段命中×${r.hits}`)
    console.log(`  意图: ${r.intent.slice(0, 100)}`)
    const qToks = new Set(tokenize(query))
    const text = r.best.text
    let cut = text.slice(0, 160)
    for (let p = 0; p < text.length - 1; p++) {
      const bigram = text.slice(p, p + 2)
      if (qToks.has(bigram) || qToks.has(text.slice(p).match(/[A-Za-z_][A-Za-z0-9_-]*/)?.[0]?.toLowerCase() || '\x00')) { cut = text.slice(Math.max(0, p - 60), p + 100); break }
    }
    console.log(`  [${r.best.role}] …${cut.replace(/\n/g, ' ')}…`)
  }
}
