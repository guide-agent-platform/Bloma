#!/usr/bin/env node
/**
 * diagnose-channels.cjs — 渠道密钥诊断脚本（dev 工具）
 *
 * 在 Electron main 进程内运行，用真实 safeStorage 逐个尝试解密渠道 api_key，
 * 输出哪些渠道「本项目可识别（isOursChannel）」「可解密/损坏」「会被 getFirstEnabledChannel 选中」，
 * 用于定位「后台从未真正向模型发请求」的根因（渠道密钥跨平台不可解密 → 全链路降级）。
 *
 * 用法（项目根目录）：npx electron scripts/diagnose-channels.cjs
 * 自定义数据目录：PROMA_HOME=/path npx electron scripts/diagnose-channels.cjs
 *
 * 安全：不打印任何明文 api_key（只显示密文前缀、明文长度与首尾掩码）。
 */

const { app, safeStorage } = require('electron')
const { readFileSync, existsSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

const PROMA_HOME = process.env.PROMA_HOME || join(homedir(), '.proma')
const CHANNELS_PATH = join(PROMA_HOME, 'channels.json')

/** 密文前 8 字节解码为可见 ASCII（'.' 替换不可见字符），用于识别 macOS "v10" 前缀特征。 */
function hexPrefixAscii(hex) {
  try {
    const buf = Buffer.from(hex, 'hex')
    return buf.slice(0, 8).toString('latin1').replace(/[^\x20-\x7e]/g, '.')
  } catch {
    return '(非法 hex)'
  }
}

/** 与 main/channel-manager.ts isOursChannel 一致：本项目渠道 = snake_case provider_type + api_key。 */
function isOursChannel(raw) {
  if (!raw || typeof raw !== 'object') return false
  return typeof raw.provider_type === 'string' && typeof raw.api_key === 'string'
}

function maskPlain(plain) {
  if (plain.length <= 8) return `(短密钥, len=${plain.length})`
  return `${plain.slice(0, 6)}…${plain.slice(-2)} (len=${plain.length})`
}

function main() {
  if (!existsSync(CHANNELS_PATH)) {
    console.log(`[diagnose] 未找到 channels.json：${CHANNELS_PATH}`)
    app.exit(1)
    return
  }
  const config = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'))
  const channels = Array.isArray(config.channels) ? config.channels : []

  console.log(`[diagnose] PROMA_HOME=${PROMA_HOME}`)
  console.log(`[diagnose] safeStorage.isEncryptionAvailable()=${safeStorage.isEncryptionAvailable()}`)
  console.log(`[diagnose] 渠道总数=${channels.length}`)
  console.log('')

  let firstUsable = null

  channels.forEach((c, i) => {
    const name = c && c.name ? c.name : '(unnamed)'
    console.log(`#${i} ${name}`)
    console.log(`  id=${c && c.id ? c.id : '(none)'}`)
    console.log(`  enabled=${c && c.enabled !== false ? 'true' : 'false'}`)

    if (!isOursChannel(c)) {
      console.log(`  isOursChannel=false → 被本项目跳过（外部渠道 / camelCase 契约）`)
      console.log(`  keys=${c ? Object.keys(c).join(',') : '(none)'}`)
      console.log('')
      return
    }

    const prefix = hexPrefixAscii(c.api_key)
    const isV10 = prefix.startsWith('v10')
    console.log(`  provider_type=${c.provider_type}  base_url=${c.base_url || '(空)'}`)
    console.log(`  api_key 密文前缀=${prefix}${isV10 ? '  ← macOS v10 特征' : ''}`)

    let decryptOk = false
    let decryptErr = ''
    try {
      const plain = safeStorage.decryptString(Buffer.from(c.api_key, 'hex'))
      decryptOk = true
      console.log(`  decryptString=成功  明文=${maskPlain(plain)}`)
    } catch (err) {
      decryptErr = err && err.message ? err.message : String(err)
      console.log(`  decryptString=失败  ${decryptErr}`)
    }

    const usable = c.enabled !== false && decryptOk
    if (usable && !firstUsable) firstUsable = { name, id: c.id }
    const why = isV10 && !decryptOk ? '（跨平台 v10 密文，Windows DPAPI 解不开）' : ''
    console.log(`  结论=${usable ? '✅ 可用（会被 getFirstEnabledChannel 选中）' : '❌ 不可用'}${why}`)
    console.log('')
  })

  console.log('--- getFirstEnabledChannel 最终结果 ---')
  if (firstUsable) {
    console.log(`✅ 选中渠道：${firstUsable.name} (${firstUsable.id})`)
  } else {
    console.log('❌ 无可选渠道 → 返回 undefined → 引导走规则路由 / MVP 走模板兜底（模型从未被调用）')
  }

  app.quit()
}

app.whenReady().then(() => {
  try {
    main()
  } catch (err) {
    console.error('[diagnose] 失败：', err && err.message ? err.message : err)
    app.exit(1)
  }
})
