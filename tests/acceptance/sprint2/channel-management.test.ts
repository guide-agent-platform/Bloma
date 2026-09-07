import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiResult } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/types'
import { setSafeStorageAdapter } from '../../../main/safe-storage'
import { createIpcHarness } from '../support/ipc-harness'
import { useTemporaryPromaHome, type TemporaryPromaHome } from '../support/test-environment'

/**
 * Sprint 2 · A2-17 渠道管理 IPC 四层契约
 *
 * 覆盖 `channel:list / channel:create / channel:test / channel:delete`：
 * - main 侧 handler 注册 + preload 暴露 + shared 类型（docs-check 与 S0-IPC-006 已校验引用）
 * - 本测试聚焦行为契约：创建渠道加密落盘、列表脱敏、删除幂等、缺字段拒绝。
 */

describe('Sprint 2 channel management IPC', () => {
  let environment: TemporaryPromaHome | undefined

  afterEach(() => {
    environment?.cleanup()
    environment = undefined
  })

  function useEnv(): TemporaryPromaHome {
    environment = useTemporaryPromaHome('bloma-a2-17-channel-')
    setSafeStorageAdapter({
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (value: Buffer) => value.toString('utf8').replace(/^enc:/, ''),
    })
    return environment
  }

  it('[A2-17-001] 通过 IPC 创建渠道：key 加密落盘，列表返回脱敏值', async () => {
    useEnv()
    const harness = createIpcHarness()

    const created = await harness.invoke(IPC_CHANNELS.CHANNEL_CREATE, {
      request_id: 'a2-17-create',
      name: 'MiniMax',
      provider_type: 'minimax',
      base_url: 'https://api.minimaxi.com/anthropic',
      api_key: 'plain-secret-key',
    }) as ApiResult<{ id: string; api_key: string }>

    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('expected create to succeed')
    expect(created.data.api_key).toBe('***')

    const persisted = readFileSync(join(environment!.home, 'bloma-channels.json'), 'utf8')
    expect(persisted).toContain(Buffer.from('enc:plain-secret-key', 'utf8').toString('hex'))
    expect(persisted).not.toContain('plain-secret-key')

    const listed = await harness.invoke(IPC_CHANNELS.CHANNEL_LIST, {
      request_id: 'a2-17-list',
    }) as ApiResult<Array<{ id: string; name: string; api_key: string }>>
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error('expected list to succeed')
    expect(listed.data).toHaveLength(1)
    expect(listed.data[0]!.api_key).toBe('***')
    expect(listed.data[0]!.name).toBe('MiniMax')
  })

  it('[A2-17-002] 渠道创建缺字段时返回 VALIDATION_ERROR', async () => {
    useEnv()
    const harness = createIpcHarness()

    const response = await harness.invoke(IPC_CHANNELS.CHANNEL_CREATE, {
      request_id: 'a2-17-missing',
      name: 'MiniMax',
    }) as ApiResult<unknown>

    expect(response.ok).toBe(false)
    if (response.ok) throw new Error('expected failure')
    expect(response.error.code).toBe('VALIDATION_ERROR')
  })

  it('[A2-17-003] testChannel 对不可达地址返回可读失败而非抛错', async () => {
    useEnv()
    const harness = createIpcHarness()

    const created = await harness.invoke(IPC_CHANNELS.CHANNEL_CREATE, {
      request_id: 'a2-17-create-test',
      name: 'Unreachable',
      provider_type: 'custom',
      base_url: 'http://127.0.0.1:9',
      api_key: 'unreachable-key',
    }) as ApiResult<{ id: string }>
    if (!created.ok || !created.data) throw new Error('expected create to succeed')

    const tested = await harness.invoke(IPC_CHANNELS.CHANNEL_TEST, {
      request_id: 'a2-17-test',
      channel_id: created.data.id,
    }) as ApiResult<{ ok: boolean; message: string }>

    expect(tested.ok).toBe(true)
    if (!tested.ok) throw new Error('expected test to resolve')
    expect(tested.data.ok).toBe(false)
    expect(tested.data.message).toMatch(/连接失败|模型配置/)
  })

  it('[A2-17-004] 渠道删除成功与删除不存在渠道返回 CHANNEL_NOT_FOUND', async () => {
    useEnv()
    const harness = createIpcHarness()

    const created = await harness.invoke(IPC_CHANNELS.CHANNEL_CREATE, {
      request_id: 'a2-17-create-del',
      name: 'ToDelete',
      provider_type: 'anthropic',
      base_url: 'https://example.invalid',
      api_key: 'delete-me',
    }) as ApiResult<{ id: string }>
    if (!created.ok || !created.data) throw new Error('expected create to succeed')

    const deleted = await harness.invoke(IPC_CHANNELS.CHANNEL_DELETE, {
      request_id: 'a2-17-del',
      channel_id: created.data.id,
    }) as ApiResult<{ deleted: boolean }>
    expect(deleted.ok).toBe(true)
    if (deleted.ok) expect(deleted.data.deleted).toBe(true)

    const missing = await harness.invoke(IPC_CHANNELS.CHANNEL_DELETE, {
      request_id: 'a2-17-del-missing',
      channel_id: 'does-not-exist',
    }) as ApiResult<unknown>
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('CHANNEL_NOT_FOUND')
  })
})
