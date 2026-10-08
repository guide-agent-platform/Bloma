#!/usr/bin/env node
/**
 * probe-glm.cjs — glm 渠道 anthropic 端点 + 思考档位形态实测（dev 工具，2026-09-03）
 *
 * 背景：渠道 base_url 修正为 /api/anthropic 后需实测连通性；同时回填挂账
 * 「glm-5.3 anthropic 端点对 output_config.effort 的接受度未实测」（P2-⑥）。
 *
 * 探测四形态：
 *  A 基础 ping（无 thinking 字段）
 *  B thinking off（{type:'disabled'}，Bloma 缺省现状）
 *  C thinking low 双写法：C1 output_config.effort / C2 thinking.effort（哪形 200 哪形定稿）
 *  D tools + thinking low（loop 实际组合：tool_use 与思考并存）
 *
 * 用法：npx electron scripts/probe-glm.cjs（PROMA_HOME 可覆盖）
 * 安全：不打印明文 api_key。
 */
const { app, safeStorage } = require('electron')
const { readFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

const PROMA_HOME = process.env.PROMA_HOME || join(homedir(), '.proma')
const CHANNELS_PATH = join(PROMA_HOME, 'bloma-channels.json')
const TARGET = 'glm'

const base = readFileSync(CHANNELS_PATH, 'utf8')
const cfg = JSON.parse(base)
const ch = (cfg.channels || []).find((c) => c.name === TARGET)
if (!ch) { console.error('未找到 glm 渠道'); app.exit(1) }

const url = `${ch.base_url.replace(/\/+$/, '')}/v1/messages`
const model = (ch.models || []).find((m) => m.enabled)?.name

const TOOLS = [{ name: 'list_files', description: '列出项目文件', input_schema: { type: 'object', properties: {} } }]

async function probe(key, label, extra) {
  const body = { model, max_tokens: 48, stream: false, messages: [{ role: 'user', content: '回复两个字：好的' }], ...extra }
  const t0 = Date.now()
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key },
      body: JSON.stringify(body),
    })
    const text = await r.text()
    let brief = text.slice(0, 300).replace(/\s+/g, ' ')
    let thinkMark = ''
    if (r.ok) {
      try {
        const j = JSON.parse(text)
        const types = (j.content || []).map((b) => b.type).join(',')
        const textOut = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('') || '(无 text)'
        thinkMark = ` | blocks=[${types}] text="${textOut.slice(0, 40)}"`
      } catch { /* 保留 brief */ }
    }
    console.log(`[${label}] ${r.status} ${Date.now() - t0}ms${thinkMark}\n  ${r.ok ? '' : brief}\n`)
    return r.status
  } catch (e) {
    console.log(`[${label}] 异常 ${Date.now() - t0}ms ${String(e).slice(0, 200)}\n`)
    return -1
  }
}

// safeStorage 密文与 userData 作用域绑定（陷阱 15）：狗粮跑的 Bloma 主进程
// userData 是 %APPDATA%\bloma（package.json name 生效），探针脚本文件模式默认
// Roaming\Electron 会解密失败——跑之前先对齐 Bloma 的真实 userData。
app.setPath('userData', join(homedir(), 'AppData', 'Roaming', 'bloma'))
app.whenReady().then(async () => {
  const key = safeStorage.decryptString(Buffer.from(ch.api_key, 'hex'))
  if (!key) { console.error('api_key 解密失败（safeStorage）'); app.exit(1) }
  console.log(`端点: ${url}\n模型: ${model}（key 长度 ${key.length}）\n`)
  await probe(key, 'A 基础 ping', {})
  await probe(key, 'B thinking off', { thinking: { type: 'disabled' } })
  const c1 = await probe(key, 'C1 output_config.effort=low', { thinking: { type: 'enabled' }, output_config: { effort: 'low' } })
  if (c1 !== 200) await probe(key, 'C2 thinking.effort=low（备选写法）', { thinking: { type: 'enabled', effort: 'low' } })
  else console.log('[C2] 跳过（C1 已 200，output_config 形态定稿）\n')
  await probe(key, 'D tools+thinking low', { thinking: { type: 'enabled' }, output_config: { effort: 'low' }, tools: TOOLS })
  app.exit(0)
})
