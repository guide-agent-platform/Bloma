import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createChannel, decryptApiKey, getChannelByIdRaw, listChannels } from '../../../main/channel-manager'
import { setSafeStorageAdapter } from '../../../main/safe-storage'
import { IPC_CHANNELS } from '../../../shared/types'

const root = fileURLToPath(new URL('../../..', import.meta.url))

describe('Sprint 0 Proma core security regression', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string | undefined

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  it('[S0-IPC-001] 每个共享 IPC channel 都应由 main 注册并由 preload 白名单暴露', () => {
    const mainIpc = readFileSync(join(root, 'main', 'ipc.ts'), 'utf8')
    const preload = readFileSync(join(root, 'preload', 'bridge.ts'), 'utf8')

    for (const name of Object.keys(IPC_CHANNELS)) {
      expect(mainIpc, `main/ipc.ts missing ${name}`).toContain(`IPC_CHANNELS.${name}`)
      expect(preload, `preload/bridge.ts missing ${name}`).toContain(`IPC_CHANNELS.${name}`)
    }
  })

  it('[S0-SECRET-001] 渠道密钥应加密落盘且对 Renderer 契约保持脱敏', () => {
    home = mkdtempSync(join(tmpdir(), 'bloma-s0-secret-'))
    process.env.PROMA_HOME = home
    setSafeStorageAdapter({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
      decryptString: (value) => value.toString('utf8').replace(/^encrypted:/, ''),
    })

    const created = createChannel({
      name: 'acceptance-channel',
      provider_type: 'anthropic',
      base_url: 'https://example.invalid',
      api_key: 'acceptance-secret',
    })
    const raw = getChannelByIdRaw(created.id)

    expect(created.api_key).toBe('***')
    expect(listChannels()[0]?.api_key).toBe('***')
    expect(raw?.api_key).not.toContain('acceptance-secret')
    expect(decryptApiKey(raw!.api_key)).toBe('acceptance-secret')
    expect(readFileSync(join(home, 'channels.json'), 'utf8')).not.toContain('acceptance-secret')
  })

  it('[S0-SECRET-002] Electron 窗口应启用隔离并关闭 Renderer 的 Node 集成', () => {
    const source = readFileSync(join(root, 'main', 'index.ts'), 'utf8')
    expect(source).toMatch(/contextIsolation:\s*true/)
    expect(source).toMatch(/nodeIntegration:\s*false/)
    expect(source).toMatch(/sandbox:\s*true/)
  })
})
