import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createChannel, getFirstEnabledChannel } from '../../main/channel-manager'
import { setSafeStorageAdapter } from '../../main/safe-storage'

/**
 * 渠道自动回退的密钥解密守卫（getFirstEnabledChannel）。
 *
 * 背景：~/.proma/channels.json 里的项目渠道 api_key 用 safeStorage 加密。
 * 若 ciphertext 来自另一平台（macOS 的 "v10" 前缀在 Windows DPAPI 下解不开）
 * 或 safeStorage 密钥已变更，decryptSecret 会抛错。getFirstEnabledChannel
 * 必须跳过这类损坏渠道，否则自动选中后 runAgent 解密崩溃。
 */
describe('channel auto-fallback decrypt guard', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  it('密钥无法解密的渠道被跳过，返回 undefined 而不是抛错', () => {
    const home = mkdtempSync(join(tmpdir(), 'bloma-fallback-'))
    process.env.PROMA_HOME = home
    // safeStorage 可用但读出的 ciphertext 解不开（模拟跨平台迁移的损坏密钥）
    setSafeStorageAdapter({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: () => {
        throw new Error('Error while decrypting the ciphertext')
      },
    })

    createChannel({ name: 'broken', provider_type: 'anthropic', base_url: 'https://x', api_key: 'secret' })

    expect(getFirstEnabledChannel()).toBeUndefined()
  })

  it('密钥可解密的第一个启用渠道被选中', () => {
    const home = mkdtempSync(join(tmpdir(), 'bloma-fallback-'))
    process.env.PROMA_HOME = home
    setSafeStorageAdapter({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
    })

    const first = createChannel({ name: 'a', provider_type: 'anthropic', base_url: 'https://a', api_key: 'key-a' })
    createChannel({ name: 'b', provider_type: 'anthropic', base_url: 'https://b', api_key: 'key-b' })

    expect(getFirstEnabledChannel()?.id).toBe(first.id)
  })

  it('损坏渠道在前、可用渠道在后时跳过损坏项选中可用项', () => {
    const home = mkdtempSync(join(tmpdir(), 'bloma-fallback-'))
    process.env.PROMA_HOME = home

    setSafeStorageAdapter({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (value) => {
        const text = value.toString('utf8')
        if (text === 'enc:bad') throw new Error('Error while decrypting the ciphertext')
        return text.replace(/^enc:/, '')
      },
    })

    createChannel({ name: 'broken', provider_type: 'anthropic', base_url: 'https://x', api_key: 'bad' })
    const good = createChannel({ name: 'good', provider_type: 'anthropic', base_url: 'https://y', api_key: 'good-key' })

    expect(getFirstEnabledChannel()?.id).toBe(good.id)
  })
})
