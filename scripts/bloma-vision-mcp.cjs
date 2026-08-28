/**
 * bloma-vision-mcp.cjs — Bloma 前端视觉诊断 MCP Server（stdio）
 *
 * 暴露两个工具给 Agent/Chat 会话：
 *  1. vision_diagnose(imagePath, instruction?, model?) — 调视觉模型诊断前端截图
 *  2. ui_screenshot(url, outPath?, viewport?) — 用 Playwright 截取页面
 *
 * 凭据策略（按优先级）：
 *  - 环境变量 PROMA_CLOUD_API_KEY（Agent 先调 proma-cloud get_credentials 再注入）
 *  - 环境变量 BLOMA_VISION_API_KEY + BLOMA_VISION_BASE_URL（直连渠道）
 *  - 参数 apiKey / baseUrl
 * 不读取也不解密 proma channels.json（safeStorage 密文，Node 侧无法解密）。
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const BLOMA_ROOT = process.env.BLOMA_ROOT || path.resolve(__dirname, '..', '..')
const NODE_BIN = process.env.NODE_BIN || 'node'
const VISION_SCRIPT = path.join(BLOMA_ROOT, 'scripts', 'vision-diagnose.mjs')
const MAX_BUFFER = 1024 * 1024 * 4

function runVisionScript(imagePath, instruction, model, apiKey, baseUrl) {
  return new Promise((resolve, reject) => {
    const args = [VISION_SCRIPT, imagePath, '--instruction', instruction || '']
    if (model) args.push('--model', model)
    if (apiKey) args.push('--api-key', apiKey)
    if (baseUrl) args.push('--base-url', baseUrl)
    const child = spawn(NODE_BIN, args, {
      cwd: BLOMA_ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > MAX_BUFFER) child.kill() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('close', (code) => {
      if (code === 0) {
        try { resolve(JSON.parse(stdout)) } catch { reject(new Error('脚本输出非 JSON: ' + stdout.slice(0, 300))) }
      } else {
        reject(new Error(stderr.slice(0, 800) || `脚本退出码 ${code}`))
      }
    })
    child.on('error', reject)
  })
}

function runScreenshot(url, outPath, viewportW, viewportH) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, '_screenshot-worker.cjs')
    const args = [script, url, outPath || path.join(os.tmpdir(), `bloma-shot-${Date.now()}.png`), String(viewportW || 1440), String(viewportH || 900)]
    const child = spawn(NODE_BIN, args, {
      cwd: BLOMA_ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('close', (code) => {
      if (code === 0) {
        try { resolve(JSON.parse(stdout)) } catch { reject(new Error('截图输出非 JSON: ' + stdout.slice(0, 300))) }
      } else {
        reject(new Error(stderr.slice(0, 500) || `截图退出码 ${code}`))
      }
    })
    child.on('error', reject)
  })
}

// ---- stdio JSON-RPC (MCP 兼容格式) ----
let buffer = ''
function handleMessage(msg) {
  const id = msg.id
  const respond = (result, error) => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result, error }) + '\n')
  }
  if (msg.method === 'initialize') {
    return respond({
      protocolVersion: msg.params?.protocolVersion || '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'bloma-vision-mcp', version: '1.0.0' },
    })
  }
  if (msg.method === 'notifications/initialized') return
  if (msg.method === 'tools/list') {
    return respond({
      tools: [
        {
          name: 'vision_diagnose',
          description: '用视觉模型诊断前端页面截图，返回结构化 UI/交互问题 JSON。输入为本地截图绝对路径；可用 --api-key 传入凭据。',
          inputSchema: {
            type: 'object',
            properties: {
              imagePath: { type: 'string', description: '截图绝对路径（PNG/JPG/WebP）' },
              instruction: { type: 'string', description: '诊断要求，默认资深 UI/UX 评审视角' },
              model: { type: 'string', description: '视觉模型 ID（默认 glm-5.3）' },
              apiKey: { type: 'string', description: '视觉渠道明文 key（优先于环境变量）' },
              baseUrl: { type: 'string', description: 'OpenAI 兼容 baseUrl（配合 apiKey）' },
            },
            required: ['imagePath'],
          },
        },
        {
          name: 'ui_screenshot',
          description: '用 Playwright 截取本地或远程页面，返回截图路径。用于自动化工作流先截图再视觉诊断。',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: '页面 URL（如 http://127.0.0.1:5173/）' },
              outPath: { type: 'string', description: '截图保存路径（默认系统临时目录）' },
              viewportW: { type: 'number', description: '视口宽度，默认 1440' },
              viewportH: { type: 'number', description: '视口高度，默认 900' },
            },
            required: ['url'],
          },
        },
      ],
    })
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params || {}
    if (name === 'vision_diagnose') {
      const envKey = process.env.PROMA_CLOUD_API_KEY || process.env.BLOMA_VISION_API_KEY
      runVisionScript(args.imagePath, args.instruction, args.model || 'glm-5.3', args.apiKey || envKey, args.baseUrl || process.env.BLOMA_VISION_BASE_URL)
        .then((r) => respond({ content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }))
        .catch((e) => respond(null, { code: -32000, message: e.message }))
      return
    }
    if (name === 'ui_screenshot') {
      runScreenshot(args.url, args.outPath, args.viewportW, args.viewportH)
        .then((r) => respond({ content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }))
        .catch((e) => respond(null, { code: -32000, message: e.message }))
      return
    }
    return respond(null, { code: -32601, message: `未知工具: ${name}` })
  }
  respond(null, { code: -32601, message: `未知方法: ${msg.method}` })
}

process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    try { handleMessage(JSON.parse(line)) } catch (e) { /* 忽略坏消息 */ }
  }
})
process.stdin.on('end', () => process.exit(0))
