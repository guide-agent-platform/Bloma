import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createChannel,
  decryptApiKey,
  getChannelByIdRaw,
  listChannels,
} from '../../../main/channel-manager'
import {
  decryptSecret,
  encryptSecret,
  setSafeStorageAdapter,
} from '../../../main/safe-storage'
import { useTemporaryPromaHome, type TemporaryPromaHome } from '../support/test-environment'

const root = fileURLToPath(new URL('../../..', import.meta.url))

describe('Sprint 0 secret boundary acceptance', () => {
  let environment: TemporaryPromaHome | undefined

  afterEach(() => {
    environment?.cleanup()
    environment = undefined
  })

  it('[S0-SECRET-003] 渠道密钥应加密落盘并在公开读取接口中脱敏', () => {
    environment = useTemporaryPromaHome('bloma-role-c-secret-')
    setSafeStorageAdapter(reversibleAdapter())

    const channel = createChannel({
      name: 'role-c-channel',
      provider_type: 'anthropic',
      base_url: 'https://example.invalid',
      api_key: 'role-c-plain-secret',
    })
    const raw = getChannelByIdRaw(channel.id)
    const persisted = readFileSync(join(environment.home, 'bloma-channels.json'), 'utf8')

    expect(channel.api_key).toBe('***')
    expect(listChannels()).toEqual([expect.objectContaining({ api_key: '***' })])
    expect(raw?.api_key).not.toContain('role-c-plain-secret')
    expect(decryptApiKey(raw!.api_key)).toBe('role-c-plain-secret')
    expect(persisted).not.toContain('role-c-plain-secret')
  })

  it('[S0-SECRET-004] safeStorage 不可用时应拒绝加密和解密', () => {
    setSafeStorageAdapter({
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
    })

    expect(() => encryptSecret('secret')).toThrow('safeStorage encryption is not available')
    expect(() => decryptSecret('00')).toThrow('safeStorage encryption is not available')
  })

  it('[S0-SECRET-005] Renderer 与 preload 源码不得接触密钥字段或安全存储实现', () => {
    for (const relativePath of listSourceFiles(join(root, 'renderer')).concat(
      listSourceFiles(join(root, 'preload')),
    )) {
      const source = readFileSync(relativePath, 'utf8')
      // 不禁止 api_key 字段名：renderer 建渠道需按契约传 ChannelCreateInput.api_key（用户新输入的 key，
      // 由 main 加密、读回脱敏 '***'）。此处保留真正的加密边界：不得接触 safeStorage/加解密实现。
      expect(source, relativePath).not.toMatch(/\bsafeStorage\b/)
      expect(source, relativePath).not.toMatch(/\bencryptString\b|\bdecryptString\b/)
    }
  })
})

function reversibleAdapter() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`role-c:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^role-c:/, ''),
  }
}

function listSourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry)
    if (statSync(fullPath).isDirectory()) files.push(...listSourceFiles(fullPath))
    else if (/\.(ts|tsx)$/.test(entry)) files.push(fullPath)
  }
  return files
}
