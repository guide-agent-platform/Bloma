#!/usr/bin/env node
/**
 * seed-channel.cjs — 渠道配置 seed 脚本（dev 工具，A2-17 临时解锁用）
 *
 * 在 Electron main 进程内运行，借助 safeStorage（OS 级加密）把渠道 key 加密写入
 * ~/.proma/channels.json。key 只从环境变量 MINIMAX_API_KEY 读取：
 *   - 不落任何明文文件（仅写 safeStorage 加密后的 hex）
 *   - 不打印 key 本体（日志只显示 api_key=***）
 *
 * 用法（git-bash，Windows 下环境变量前缀写法）：
 *   MINIMAX_API_KEY=sk-xxxx npm run seed:channel
 *   自定义渠道参数：
 *   MINIMAX_API_KEY=sk-xxxx MINIMAX_BASE_URL=https://api.minimaxi.com/anthropic \
 *   MINIMAX_MODEL=MiniMax-M3 MINIMAX_CHANNEL_NAME=MiniMax npm run seed:channel
 *
 * 注意：本脚本自包含（不依赖 esbuild 产物），Channel 结构与
 *   main/channel-manager.ts / shared/types.ts 保持一致；改动时需同步。
 */

const { app, safeStorage } = require('electron')
const { randomUUID } = require('node:crypto')
const { mkdirSync, readFileSync, writeFileSync, existsSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

const PROMA_HOME = process.env.PROMA_HOME || join(homedir(), '.proma')
const CHANNELS_PATH = join(PROMA_HOME, 'channels.json')

// 渠道参数（可用环境变量覆盖；默认对齐已核实的 MiniMax M3 配置）
const CHANNEL_NAME = process.env.MINIMAX_CHANNEL_NAME || 'MiniMax'
const BASE_URL = (process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/anthropic').replace(/\/+$/, '')
const MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M3'
const API_KEY = process.env.MINIMAX_API_KEY || ''

function fail(message) {
  console.error(`[seed-channel] 失败：${message}`)
  app.exit(1)
}

async function main() {
  if (!API_KEY) {
    return fail('缺少 MINIMAX_API_KEY 环境变量。用法：MINIMAX_API_KEY=sk-xxx npm run seed:channel')
  }
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
    return fail('Electron safeStorage 不可用（OS 级加密未就绪），无法加密存储渠道 key。')
  }

  const encryptedHex = safeStorage.encryptString(API_KEY).toString('hex')

  // 读取现有渠道配置，按 name 幂等更新（保留其他渠道）
  mkdirSync(PROMA_HOME, { recursive: true })
  const config = existsSync(CHANNELS_PATH)
    ? JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'))
    : { version: 1, channels: [] }
  if (!Array.isArray(config.channels)) config.channels = []

  const channel = {
    id: randomUUID(),
    name: CHANNEL_NAME,
    provider_type: 'minimax',
    base_url: BASE_URL,
    api_key: encryptedHex,
    models: [{ id: MODEL, name: MODEL, enabled: true }],
    enabled: true,
    max_tokens: process.env.MINIMAX_MAX_TOKENS ? Number(process.env.MINIMAX_MAX_TOKENS) : undefined,
  }
  const idx = config.channels.findIndex((c) => c && c.name === CHANNEL_NAME)
  if (idx >= 0) config.channels[idx] = channel
  else config.channels.push(channel)
  writeFileSync(CHANNELS_PATH, JSON.stringify(config, null, 2), 'utf8')

  console.log(`[seed-channel] 渠道已写入：${CHANNELS_PATH}`)
  console.log(`[seed-channel] name=${CHANNEL_NAME} provider=minimax base_url=${BASE_URL} model=${MODEL} api_key=***`)

  // 连通性验证：打 /v1/models（对齐 channel-manager.testChannel）
  console.log('[seed-channel] 正在验证连通性…')
  try {
    const res = await fetch(`${BASE_URL}/v1/models`, {
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) {
      console.log('[seed-channel] ✅ 连通成功：MiniMax 渠道可用（/v1/models 200）')
    } else {
      console.error(
        `[seed-channel] ⚠️ 连通失败：/v1/models 返回 ${res.status}（渠道已保存，可稍后在应用内再测）`,
      )
    }
  } catch (err) {
    console.error(
      `[seed-channel] ⚠️ 连通失败：${err instanceof Error ? err.message : String(err)}（渠道已保存）`,
    )
  }

  app.quit()
}

app.whenReady().then(() => {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
})
