import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fetchModels, listChannels, updateChannel } from '../../main/channel-manager'

/**
 * 渠道模型刷新（走 Bloma 自身能力，非自造 HTTP）：
 *   fetchModels()  = 产品「拉取模型」按钮的实现
 *   updateChannel() = 产品「保存渠道」的实现（不传 api_key 则保留原加密密钥）
 *
 * 用法（真实 PROMA_HOME，不动测试临时 home）：
 *   GS_KEY_FILE=<electron reader 产物> GS_CHANNEL=ds [GS_APPLY=1] \
 *     npx vitest run tests/experiments/channel-models-refresh.test.ts
 * GS_APPLY=1 才写回真实配置（写前自动备份 bloma-channels.json）。
 */
const KEY_FILE = process.env.GS_KEY_FILE || ''
const CHANNEL_NAME = process.env.GS_CHANNEL || 'ds'
const APPLY = process.env.GS_APPLY === '1'

describe('渠道模型刷新（产品自身 fetchModels/updateChannel）', () => {
  it(`${CHANNEL_NAME} 拉取可用模型${APPLY ? '并写回可选模型' : '（dry-run）'}`, async () => {
    expect(existsSync(KEY_FILE)).toBe(true)
    const keys = JSON.parse(readFileSync(KEY_FILE, 'utf8')) as Record<string, { baseUrl?: string; apiKey?: string; provider?: string }>
    const entry = keys[CHANNEL_NAME]
    expect(entry?.apiKey, `key 文件无渠道 ${CHANNEL_NAME}`).toBeTruthy()

    const channels = listChannels()
    const ch = channels.find((c) => c.name === CHANNEL_NAME)
    expect(ch, `真实配置里没有渠道 ${CHANNEL_NAME}`).toBeTruthy()
    const before = (ch!.models || []).map((m) => m.id)

    const res = await fetchModels({
      provider_type: ch!.provider_type,
      base_url: entry!.baseUrl || ch!.base_url,
      api_key: entry!.apiKey,
    })
    console.log(`[拉取] success=${res.success} | ${res.message}`)
    console.log(`[拉取] 模型(${res.models.length}): ${res.models.map((m) => m.id).join(', ')}`)
    console.log(`[现配] 模型(${before.length}): ${before.join(', ')}`)
    expect(res.success, `拉取失败：${res.message}`).toBe(true)

    if (!APPLY) {
      console.log('[dry-run] 未写回；设 GS_APPLY=1 执行更新')
      return
    }
    const cfgPath = join(process.env.PROMA_HOME || join(homedir(), '.proma'), 'bloma-channels.json')
    if (existsSync(cfgPath)) {
      const bak = `${cfgPath}.bak-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`
      copyFileSync(cfgPath, bak)
      console.log('[备份]', bak)
    }
    const updated = updateChannel(ch!.id, { models: res.models })
    expect(updated).toBeTruthy()
    console.log(`[写回] 可选模型(${updated!.models.length}): ${updated!.models.map((m) => `${m.id}${m.enabled === false ? '(禁用)' : ''}`).join(', ')}`)
  }, 120_000)
})
