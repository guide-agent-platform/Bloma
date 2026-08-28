#!/usr/bin/env node
/**
 * vision-diagnose.mjs — 前端截图视觉诊断工具
 *
 * 用途：把前端页面截图发送给已配置的视觉模型（默认 DeepSeek V4 Flash Vision Exp），
 * 输出结构化 UI/交互诊断 JSON，供 Agent 自动化工作流使用。
 *
 * 数据源：读取 proma 应用渠道配置（C:\Users\23968\.proma\channels.json），
 * 自动选择第一个启用且包含视觉模型候选的渠道（优先 deepseek-v4-flash-vision-exp）。
 * 不硬编码任何密钥；密钥仅在本进程内使用，不外发、不落盘。
 *
 * 用法：
 *   node scripts/vision-diagnose.mjs <imagePath> [--instruction "诊断要求"] [--model 模型ID] [--out out.json]
 *
 * 输出（默认 stdout，JSON）：
 *   {
 *     ok: true,
 *     model: "deepseek-v4-flash-vision-exp",
 *     provider: "deepseek",
 *     summary: "总体结论",
 *     issues: [ { severity, area, description, suggestion, screenshotHint } ],
 *     strengths: [ "做得好的点" ],
 *     refSuggestions: [ "可参考的实现方向" ]
 *   }
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import os from 'node:os'

const PROMA_HOME = process.env.PROMA_HOME || join(os.homedir(), '.proma')
const CHANNELS_PATH = process.env.CHANNELS_PATH || join(PROMA_HOME, 'channels.json')
const CLOUD_AUTH_PATH = process.env.CLOUD_AUTH_PATH || join(PROMA_HOME, 'cloud-auth.json')

// Proma Cloud 通道（优先）：登录态凭据，无需单独配置渠道
const CLOUD_API_ROOT = process.env.CLOUD_API_ROOT || 'https://api.proma.cool'
const CLOUD_BASE_URL_OVERRIDE = process.env.CLOUD_BASE_URL || ''
// 运行时注入凭据：自动化会话中 Agent 可先调 mcp__proma-cloud__get_credentials 拿到
// apiKey（pk_xxx），设置 PROMA_CLOUD_API_KEY 环境变量后调用本脚本。
// 手动调用时也可用 --api-key 参数直接传入。
const CLOUD_API_KEY_ENV = process.env.PROMA_CLOUD_API_KEY || ''
// 白名单：messages 协议 + 支持视觉的模型（按性价比排序）
const CLOUD_VISION_MODELS = [
  'glm-5.3',
  'glm-5.3-flash',
  'claude-sonnet-5',
  'kimi-k3',
  'claude-opus-5',
]

const VISION_MODEL_CANDIDATES = [
  'deepseek-v4-flash-vision-exp',
  'glm-5.3',
  'glm-5.2',
  'gpt-5.6-terra',
  'gpt-5.6-sol',
  'claude-sonnet-5',
  'claude-opus-5',
]

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const DEFAULT_INSTRUCTION =
  '你是一位资深前端 UI/UX 评审。请仔细查看这张页面截图，从用户视角诊断显示与交互问题。' +
  '输出 JSON：summary（总体结论）、issues（数组，每项含 severity=high|medium|low、area=布局|颜色|对比度|间距|文字|交互|响应式|状态反馈、description、suggestion、screenshotHint（图中位置描述））、' +
  'strengths（做得好的点数组）、refSuggestions（可参考的业界实现方向数组）。只输出合法 JSON。'

function fail(code, message) {
  return { ok: false, code, message }
}

function parseArgs(argv) {
  const args = { imagePath: undefined, instruction: DEFAULT_INSTRUCTION, model: undefined, out: undefined, apiKey: undefined, baseUrl: undefined }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--instruction') args.instruction = argv[++i]
    else if (a === '--model') args.model = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--api-key') args.apiKey = argv[++i]
    else if (a === '--base-url') args.baseUrl = argv[++i]
    else rest.push(a)
  }
  args.imagePath = rest[0]
  return args
}

function loadChannels() {
  if (!existsSync(CHANNELS_PATH)) return { error: `渠道配置文件不存在: ${CHANNELS_PATH}` }
  try {
    const raw = JSON.parse(readFileSync(CHANNELS_PATH, 'utf-8'))
    const root = raw && typeof raw === 'object' && Array.isArray(raw.channels) ? raw.channels : raw
    return Array.isArray(root) ? root : []
  } catch (e) {
    return { error: `渠道配置解析失败: ${e.message}` }
  }
}

function loadCloudAuth() {
  if (!existsSync(CLOUD_AUTH_PATH)) return { error: `Proma Cloud 凭据不存在: ${CLOUD_AUTH_PATH}` }
  try {
    const raw = JSON.parse(readFileSync(CLOUD_AUTH_PATH, 'utf-8'))
    if (!raw?.accessToken) return { error: 'cloud-auth.json 缺少 accessToken' }
    return { accessToken: raw.accessToken }
  } catch (e) {
    return { error: `cloud-auth.json 解析失败: ${e.message}` }
  }
}

function pickVisionChannel(channels, preferredModel) {
  const enabled = (channels || []).filter((c) => c && c.enabled !== false)
  const score = (c) => {
    const models = (c.models || []).map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)
    const has = (id) => models.includes(id)
    let s = 0
    if (has('deepseek-v4-flash-vision-exp')) s += 100
    if (has('glm-5.3')) s += 80
    for (const m of VISION_MODEL_CANDIDATES) if (has(m)) s += 10
    return s
  }
  // 必须包含可用 apiKey 的渠道（Proma 官方/OAuth 登录渠道无 apiKey，无法直连调用）
  const usable = enabled.filter((c) => c && typeof c.apiKey === 'string' && c.apiKey.length > 0)
  const pool = usable.length ? usable : enabled
  const sorted = [...pool].sort((a, b) => score(b) - score(a))
  if (!sorted.length) return { error: '没有启用的渠道' }

  const top = sorted[0]
  const models = (top.models || []).map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)
  const pick = preferredModel && models.includes(preferredModel)
    ? preferredModel
    : models.find((m) => VISION_MODEL_CANDIDATES.includes(m)) || models[0]

  return { channel: top, model: pick, models }
}

function resolveMessagesUrl(channel) {
  let base = channel.baseUrl || ''
  if (base.endsWith('/messages')) return base
  return `${base.replace(/\/+$/, '')}/v1/messages`
}

async function diagnoseViaCloud(imagePath, model, instruction, apiKeyOverride, baseUrlOverride) {
  const apiKey = apiKeyOverride || CLOUD_API_KEY_ENV
  if (!apiKey) {
    throw new Error('未提供 Proma Cloud 凭据：请设置 PROMA_CLOUD_API_KEY 环境变量或传入 --api-key，或由 Agent 先调 mcp__proma-cloud__get_credentials 获取')
  }

  const data = readFileSync(imagePath)
  if (data.length > MAX_IMAGE_BYTES) {
    throw new Error(`图片过大: ${(data.length / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`)
  }
  const ext = extname(imagePath).toLowerCase()
  const mediaType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
    : ext === '.gif' ? 'image/gif'
    : 'image/png'

  const url = baseUrlOverride || CLOUD_BASE_URL_OVERRIDE || `${CLOUD_API_ROOT}/v1/messages`
  const body = {
    model,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } },
        { type: 'text', text: instruction },
      ],
    }],
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Proma Cloud 视觉 API ${resp.status}: ${text.slice(0, 500)}`)
  }

  const json = await resp.json()
  const blocks = json.content || []
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')

  try {
    const match = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/)
    if (match) {
      const parsed = JSON.parse(match[1] || match[0])
      if (parsed && typeof parsed === 'object') return parsed
    }
  } catch { /* 落到文本返回 */ }

  return { summary: text, issues: [], strengths: [], refSuggestions: [], _raw: true }
}

async function diagnose(imagePath, channel, model, instruction) {
  const apiKey = channel.apiKey
  if (!apiKey) throw new Error('渠道缺少 apiKey')

  const data = readFileSync(imagePath)
  if (data.length > MAX_IMAGE_BYTES) {
    throw new Error(`图片过大: ${(data.length / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`)
  }
  const ext = extname(imagePath).toLowerCase()
  const mediaType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
    : ext === '.gif' ? 'image/gif'
    : 'image/png'

  const url = resolveMessagesUrl(channel)
  const body = {
    model,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } },
        { type: 'text', text: instruction },
      ],
    }],
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`视觉模型 API ${resp.status}: ${text.slice(0, 500)}`)
  }

  const json = await resp.json()
  const blocks = json.content || []
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')

  try {
    const match = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/)
    if (match) {
      const parsed = JSON.parse(match[1] || match[0])
      if (parsed && typeof parsed === 'object') return parsed
    }
  } catch { /* 落到文本返回 */ }

  return { summary: text, issues: [], strengths: [], refSuggestions: [], _raw: true }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.imagePath) {
    console.error(JSON.stringify(fail('MISSING_IMAGE', '用法: node scripts/vision-diagnose.mjs <imagePath> [--instruction ...] [--model ...] [--out out.json]'), null, 2))
    process.exit(1)
  }
  if (!existsSync(args.imagePath)) {
    console.error(JSON.stringify(fail('IMAGE_NOT_FOUND', `图片不存在: ${args.imagePath}`), null, 2))
    process.exit(1)
  }

  const channels = loadChannels()
  if (channels.error) {
    console.error(JSON.stringify(fail('CHANNELS_ERROR', channels.error), null, 2))
    process.exit(1)
  }

  const picked = pickVisionChannel(channels, args.model)
  if (picked.error) {
    console.error(JSON.stringify(fail('NO_VISION_CHANNEL', picked.error), null, 2))
    process.exit(1)
  }

  try {
    let result, modelUsed, providerUsed
    // 优先 Proma Cloud（凭据来自 env/--api-key 或 cloud-auth 的 accessToken）；渠道直连作为备选
    const hasExplicitKey = !!(args.apiKey || CLOUD_API_KEY_ENV)
    if (hasExplicitKey || !args.model) {
      try {
        modelUsed = args.model || CLOUD_VISION_MODELS[0]
        providerUsed = 'proma-cloud'
        result = await diagnoseViaCloud(args.imagePath, modelUsed, args.instruction, args.apiKey, args.baseUrl)
      } catch (cloudErr) {
        // 渠道直连备选（仅当未指定 model 且渠道可读时）
        if (args.model) throw cloudErr
        const targetModel = picked.model
        providerUsed = picked.channel.provider || picked.channel.provider_type || 'channel'
        result = await diagnose(args.imagePath, picked.channel, targetModel, args.instruction)
        modelUsed = targetModel
      }
    } else {
      const targetModel = args.model
      providerUsed = picked.channel.provider || picked.channel.provider_type || 'channel'
      result = await diagnose(args.imagePath, picked.channel, targetModel, args.instruction)
      modelUsed = targetModel
    }
    const out = { ok: true, model: modelUsed, provider: providerUsed, image: basename(args.imagePath), ...result }
    if (args.out) {
      writeFileSync(args.out, JSON.stringify(out, null, 2), 'utf-8')
      console.log(JSON.stringify({ ok: true, wrote: args.out }, null, 2))
    } else {
      console.log(JSON.stringify(out, null, 2))
    }
  } catch (e) {
    console.error(JSON.stringify(fail('VISION_CALL_FAILED', e.message), null, 2))
    process.exit(1)
  }
}

main()
