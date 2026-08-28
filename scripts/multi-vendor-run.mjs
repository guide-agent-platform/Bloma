#!/usr/bin/env node
/**
 * multi-vendor-run.mjs — 多厂商模型测试编排工具（硬性三模型）
 *
 * 用 DeepSeek / 智谱 / 阿里云 三家模型执行测试手段：
 *  1. test-gen     — 多厂商生成测试用例（互相补充，输出合并测试计划）
 *  2. test-review  — 多厂商独立审查已有测试（找缺口/盲区）
 *  3. verdict      — 多厂商对同一实现/测试结果独立裁决（多数决）
 *
 * 【硬性模型约束】只使用以下三个模型，绝不使用其它模型：
 *   - deepseek: deepseek-v4-flash
 *   - zhipu:    glm-5.3-flash
 *   - aliyun:   qwen3.8-flash
 * 任何模型替换/fallback 都会被拒绝（见 resolveVendorCall）。
 *
 * 【共享初始上下文】与 proma collaboration 的 sharedContext 同理：
 * 传 `--shared <文件>` 时，三家模型都会收到同一段「共享初始上下文」，
 * 之后才拼接各自独立的任务指令。共享上下文默认按字节限长（见
 * SHARED_MAX_CHARS），超限提前截断并标注。
 *
 * 【提前压缩】输入上下文按 token 预算估算，达到 COMPACT_EARLY_RATIO（0.6）
 * 即提前压缩（保留共享上下文 + 头部，截断中部/尾部并标注），而不是等接近
 * 模型上限才压缩；输出始终预留 COMPACT_RESERVE_OUTPUT_TOKENS。
 *
 * 密钥来源：Electron 解密渠道（scripts/channel-key-reader.cjs），
 * 或环境变量注入 MULTI_VENDOR_KEYS_JSON。不硬编码任何密钥。
 *
 * 用法：
 *   node scripts/multi-vendor-run.mjs test-gen --context <文件> [--shared <共享上下文文件>] --out <输出>
 *   node scripts/multi-vendor-run.mjs test-review --target <测试文件> [--shared <文件>] --out <输出>
 *   node scripts/multi-vendor-run.mjs verdict --prompt <问题> --evidence <文件> [--shared <文件>] --out <输出>
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const BLOMA_ROOT = process.env.BLOMA_ROOT || process.cwd()
const ELECTRON_BIN = join(BLOMA_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const KEY_READER = join(BLOMA_ROOT, 'scripts', 'channel-key-reader.cjs')
const PROMA_CHANNELS = process.env.PROMA_CHANNELS || join(os.homedir(), '.proma', 'channels.json')
const PROMA_USER_DATA = process.env.PROMA_USER_DATA || join(os.homedir(), 'AppData', 'Roaming', '@proma', 'electron')
const KEYS_CACHE = join(os.tmpdir(), 'bloma-multi-vendor-keys.json')

// ── 硬性三模型（唯一允许）─────────────────────────────
// ⚠️ 2026-08-28 应急：DeepSeek 官方渠道 402（Insufficient Balance），
// deepseek-v4-flash 暂由阿里云云工渠道承载（同款模型，OpenAI 协议）。
// DeepSeek 充值后改回：channel:'DeepSeek', api:'anthropic'。
const HARD_MODELS = {
  deepseek: { channel: '阿里云云工', model: 'deepseek-v4-flash', api: 'openai' },
  zhipu: { channel: '智谱 Coding Plan', model: 'glm-5.3-flash', api: 'anthropic' },
  aliyun: { channel: '阿里云云工', model: 'qwen3.8-flash', api: 'openai' },
}

// ── 角色 → 模型映射（多模型承担多角色）──────────────────
// Attacker（挑刺/严格派）= DeepSeek；Defender（辩护/建设派）= 智谱；Reviewer（中立裁决）= 阿里云
const ROLE_TO_VENDOR = {
  attacker: 'deepseek',
  defender: 'zhipu',
  reviewer: 'aliyun',
}
const ROLE_SYSTEM = {
  attacker: '你是攻击者（Attacker）角色：以严格、挑剔、破坏性的视角审查，找出必须修的缺陷，只输出 JSON：{verdict:"fail|pass",issues:[{severity,description,suggestion}],risks:[]}。',
  defender: '你是辩护者（Defender）角色：以建设性视角评估攻击者发现，逐条 accept/refute/clarify，给出最小修复方案，只输出 JSON：{verdict:"pass|fail",responses:[{issue,verdict,reason,fix_suggestion}]}。',
  reviewer: '你是中立裁决者（Reviewer）角色：综合双方证据独立裁决，只输出 JSON：{verdict:"pass|fail|uncertain",reason,keyPoints:[],risks:[]}。',
}

// ── 共享上下文与压缩策略 ──────────────────────────────
const SHARED_MAX_CHARS = 6000          // 共享上下文最大字符数（超限提前截断）
const CONTEXT_TOKEN_BUDGET = 24000     // 输入上下文 token 预算（估算）
const COMPACT_EARLY_RATIO = 0.6        // 达到预算 60% 即提前压缩（proma 接近上限才触发，我们更早）
const COMPACT_RESERVE_OUTPUT_TOKENS = 4096  // 输出预留

/** 粗略 token 估算：中文按 ~1 token/1.6 字符，英文按 ~1 token/4 字符 */
function estimateTokens(text) {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  const other = text.length - cjk
  return Math.ceil(cjk / 1.6 + other / 4)
}

/**
 * 提前压缩：估算输入 token，若超过 COMPACT_EARLY_RATIO * 预算则压缩。
 * 压缩策略：保留共享上下文 + 头部（前 1/3），截断中部并标注。
 * 返回 { text, compressed, estimateBefore, estimateAfter }
 */
function compactContext(text, { preserveHead } = {}) {
  const estimateBefore = estimateTokens(text)
  const limit = Math.floor(CONTEXT_TOKEN_BUDGET * COMPACT_EARLY_RATIO)
  if (estimateBefore <= limit) {
    return { text, compressed: false, estimateBefore, estimateAfter: estimateBefore }
  }
  const head = preserveHead || text.slice(0, Math.floor(text.length / 3))
  const tail = text.slice(-Math.floor(text.length / 6))
  const compressedText = `${head}\n\n[……上下文已提前压缩：原 ${estimateBefore} tokens 超预算 ${limit}，已省略中部内容，请基于保留部分继续……]\n\n${tail}`
  const estimateAfter = estimateTokens(compressedText)
  return { text: compressedText, compressed: true, estimateBefore, estimateAfter }
}

function fail(code, message) {
  return { ok: false, code, message }
}

function loadKeys() {
  if (process.env.MULTI_VENDOR_KEYS_JSON) {
    return JSON.parse(process.env.MULTI_VENDOR_KEYS_JSON)
  }
  if (existsSync(KEYS_CACHE)) {
    try { return JSON.parse(readFileSync(KEYS_CACHE, 'utf-8')) } catch { /* fallthrough */ }
  }
  try {
    const out = join(os.tmpdir(), 'bloma-mv-keys-tmp.json')
    execFileSync(ELECTRON_BIN, [KEY_READER, PROMA_CHANNELS, out, PROMA_USER_DATA], { stdio: 'pipe', windowsHide: true, timeout: 60_000 })
    const keys = JSON.parse(readFileSync(out, 'utf-8'))
    writeFileSync(KEYS_CACHE, JSON.stringify(keys), 'utf-8')
    return keys
  } catch (e) {
    throw new Error('无法读取渠道密钥: ' + e.message)
  }
}

function resolveVendorCall(vendorKey, requestedModel) {
  const vendor = HARD_MODELS[vendorKey]
  if (!vendor) throw new Error(`未知厂商: ${vendorKey}`)
  // 硬性约束：只允许该厂商的固定模型，拒绝任何其它模型/fallback
  if (requestedModel && requestedModel !== vendor.model) {
    throw new Error(`模型硬性约束：${vendorKey} 只允许 ${vendor.model}，收到 ${requestedModel}（已拒绝）`)
  }
  const keys = loadKeys()
  const ch = keys[vendor.channel]
  if (!ch?.apiKey) throw new Error(`渠道 ${vendor.channel} 无可用 key`)
  return { ...vendor, apiKey: ch.apiKey, baseUrl: ch.baseUrl }
}

/**
 * 统一调用：三家都注入同一段共享初始上下文（shared），
 * 再拼接各自独立任务指令；输入上下文提前压缩。
 */
async function callModel(vendorKey, system, userPrompt, shared, maxTokens = COMPACT_RESERVE_OUTPUT_TOKENS) {
  const v = resolveVendorCall(vendorKey)
  const sharedPart = shared ? `【共享初始上下文】\n${shared}\n\n` : ''
  const fullUser = `${sharedPart}${userPrompt}`

  // 提前压缩：共享部分 + 任务指令合并后估算
  const compacted = compactContext(fullUser, { preserveHead: sharedPart || undefined })
  const finalUser = compacted.text

  if (v.api === 'anthropic') {
    const url = (v.baseUrl || '').endsWith('/messages') ? v.baseUrl : `${(v.baseUrl || '').replace(/\/+$/, '')}/v1/messages`
    const body = { model: v.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: finalUser }] }
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': v.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    if (!resp.ok) throw new Error(`${vendorKey}/${v.model} API ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
    const json = await resp.json()
    return { text: (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'), compacted }
  }
  const url = `${(v.baseUrl || '').replace(/\/+$/, '')}/chat/completions`
  const body = { model: v.model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: finalUser }] }
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${v.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  if (!resp.ok) throw new Error(`${vendorKey}/${v.model} API ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
  const json = await resp.json()
  return { text: json.choices?.[0]?.message?.content || '', compacted }
}

function parseJsonLoose(text) {
  try {
    const m = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/)
    if (m) return JSON.parse(m[1] || m[0])
  } catch { /* ignore */ }
  return null
}

function readShared(sharedPath) {
  if (!sharedPath) return undefined
  if (!existsSync(sharedPath)) throw new Error(`共享上下文文件不存在: ${sharedPath}`)
  let text = readFileSync(sharedPath, 'utf-8')
  if (text.length > SHARED_MAX_CHARS) {
    text = text.slice(0, SHARED_MAX_CHARS) + '\n[……共享上下文超长已截断……]'
  }
  return text
}

async function runTestGen(contextFile, outFile, shared) {
  const context = readFileSync(contextFile, 'utf-8')
  const results = {}
  const compactNotes = {}
  for (const vk of Object.keys(HARD_MODELS)) {
    try {
      const r = await callModel(vk,
        '你是资深测试工程师，为 Bloma 项目生成测试用例。只输出 JSON：{testCases:[{id,title,type(unit|gwt|component),domain,scenario,expected}]}',
        `功能上下文：\n${context}\n\n请生成覆盖正常/边界/异常路径的测试用例，突出你视角下最关键的验证点。`,
        shared)
      results[vk] = { model: HARD_MODELS[vk].model, output: parseJsonLoose(r.text) || r.text }
      if (r.compacted.compressed) compactNotes[vk] = r.compacted
    } catch (e) {
      results[vk] = { model: HARD_MODELS[vk].model, error: e.message }
    }
  }
  const out = { ok: true, hardModels: Object.fromEntries(Object.entries(HARD_MODELS).map(([k, v]) => [k, v.model])), sharedContext: !!shared, compactNotes, generatedAt: new Date().toISOString(), vendors: results }
  if (outFile) writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf-8')
  console.log(JSON.stringify(out, null, 2))
}

async function runTestReview(target, outFile, shared) {
  const targetPath = existsSync(target) ? readFileSync(target, 'utf-8') : `(目标不存在: ${target})`
  const results = {}
  const compactNotes = {}
  for (const vk of Object.keys(HARD_MODELS)) {
    try {
      const r = await callModel(vk,
        '你是独立测试审查员。审查以下测试代码，只输出 JSON：{gaps:[{severity,description,suggestion}],blindSpots:[],overallVerdict}',
        `测试代码：\n${targetPath}\n\n找出测试缺口、盲区和可改进点，突出你独立视角的发现。`,
        shared)
      results[vk] = { model: HARD_MODELS[vk].model, output: parseJsonLoose(r.text) || r.text }
      if (r.compacted.compressed) compactNotes[vk] = r.compacted
    } catch (e) {
      results[vk] = { model: HARD_MODELS[vk].model, error: e.message }
    }
  }
  const out = { ok: true, hardModels: Object.fromEntries(Object.entries(HARD_MODELS).map(([k, v]) => [k, v.model])), sharedContext: !!shared, compactNotes, generatedAt: new Date().toISOString(), vendors: results }
  if (outFile) writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf-8')
  console.log(JSON.stringify(out, null, 2))
}

async function runVerdict(prompt, evidenceFile, outFile, shared) {
  const evidence = existsSync(evidenceFile) ? readFileSync(evidenceFile, 'utf-8') : evidenceFile || ''
  const results = {}
  const compactNotes = {}
  for (const vk of Object.keys(HARD_MODELS)) {
    try {
      const r = await callModel(vk,
        '你是独立评审，基于证据回答，只输出 JSON：{verdict:"pass|fail|uncertain",reason,keyPoints:[],risks:[]}',
        `评估问题：${prompt}\n\n证据：\n${evidence}\n\n给出你的独立裁决。`,
        shared)
      results[vk] = { model: HARD_MODELS[vk].model, output: parseJsonLoose(r.text) || r.text }
      if (r.compacted.compressed) compactNotes[vk] = r.compacted
    } catch (e) {
      results[vk] = { model: HARD_MODELS[vk].model, error: e.message }
    }
  }
  const verdicts = Object.values(results).map((r) => r.output?.verdict).filter(Boolean)
  const majority = verdicts.filter((v) => v === 'pass').length >= Math.ceil(verdicts.length / 2) ? 'pass' : verdicts.length ? 'fail' : 'unknown'
  const out = { ok: true, majorityVerdict: majority, hardModels: Object.fromEntries(Object.entries(HARD_MODELS).map(([k, v]) => [k, v.model])), sharedContext: !!shared, compactNotes, generatedAt: new Date().toISOString(), vendors: results }
  if (outFile) writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf-8')
  console.log(JSON.stringify(out, null, 2))
}

async function runRoleTask(role, prompt, evidenceFile, outFile, shared) {
  const vendorKey = ROLE_TO_VENDOR[role]
  if (!vendorKey) throw new Error(`未知角色: ${role}（可用 attacker/defender/reviewer）`)
  const evidence = existsSync(evidenceFile) ? readFileSync(evidenceFile, 'utf-8') : evidenceFile || ''
  const r = await callModel(vendorKey, ROLE_SYSTEM[role],
    `评估问题：${prompt}\n\n证据：\n${evidence}\n\n以你的角色视角给出独立结论。`,
    shared)
  const out = {
    ok: true,
    role,
    vendor: vendorKey,
    model: HARD_MODELS[vendorKey].model,
    compacted: r.compacted,
    output: parseJsonLoose(r.text) || r.text,
    generatedAt: new Date().toISOString(),
  }
  if (outFile) writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf-8')
  console.log(JSON.stringify(out, null, 2))
}

async function runAllRoles(prompt, evidenceFile, outFile, shared) {
  const results = {}
  for (const [role, vendorKey] of Object.entries(ROLE_TO_VENDOR)) {
    try {
      const r = await callModel(vendorKey, ROLE_SYSTEM[role],
        `评估问题：${prompt}\n\n证据：\n${existsSync(evidenceFile) ? readFileSync(evidenceFile, 'utf-8') : (evidenceFile || '')}\n\n以你的角色视角给出独立结论。`,
        shared)
      results[role] = { vendor: vendorKey, model: HARD_MODELS[vendorKey].model, output: parseJsonLoose(r.text) || r.text }
    } catch (e) {
      results[role] = { vendor: vendorKey, model: HARD_MODELS[vendorKey].model, error: e.message }
    }
  }
  const verdicts = Object.values(results).map((r) => r.output?.verdict).filter(Boolean)
  const majority = verdicts.filter((v) => v === 'pass').length >= Math.ceil(verdicts.length / 2) ? 'pass' : verdicts.length ? 'fail' : 'unknown'
  const out = {
    ok: true,
    majorityVerdict: majority,
    roleMapping: Object.fromEntries(Object.entries(ROLE_TO_VENDOR).map(([role, vk]) => [role, HARD_MODELS[vk].model])),
    sharedContext: !!shared,
    generatedAt: new Date().toISOString(),
    roles: results,
  }
  if (outFile) writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf-8')
  console.log(JSON.stringify(out, null, 2))
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  const get = (name) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  try {
    const shared = readShared(get('shared'))
    if (cmd === 'test-gen') return await runTestGen(get('context'), get('out'), shared)
    if (cmd === 'test-review') return await runTestReview(get('target'), get('out'), shared)
    if (cmd === 'verdict') return await runVerdict(get('prompt'), get('evidence'), get('out'), shared)
    if (cmd === 'role') return await runRoleTask(get('role'), get('prompt'), get('evidence'), get('out'), shared)
    if (cmd === 'roles') return await runAllRoles(get('prompt'), get('evidence'), get('out'), shared)
    console.error(JSON.stringify(fail('BAD_COMMAND', '用法: multi-vendor-run.mjs test-gen|test-review|verdict|role|roles ...'), null, 2))
    process.exit(1)
  } catch (e) {
    console.error(JSON.stringify(fail('MULTI_VENDOR_FAILED', e.message), null, 2))
    process.exit(1)
  }
}

main()
