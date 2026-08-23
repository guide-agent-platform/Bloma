import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiResult, PromptSlotDetail, PromptSlotInfo } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/types'
import { createIpcHarness } from '../support/ipc-harness'
import { useTemporaryPromaHome, type TemporaryPromaHome } from '../support/test-environment'

/**
 * Sprint 2 · 提示词配置界面化的 IPC 四层契约（prompt:list / prompt:read / prompt:save / prompt:reset）
 *
 * 背景：PRD 引擎提示词已支持外置覆盖（{PROMA_HOME}/prompts/prd-system.md 存在即覆盖内置默认、
 * 改完即时生效），现需把该配置能力界面化。本文档验证主进程 prompt:* 通道的行为契约：
 * - list 返回全部预留槽位（prd-system 已启用，sketch/mvp/guide 预留未启用）
 * - read 无覆盖时返回内置默认；有覆盖时返回自定义内容
 * - save 写入覆盖文件并即时生效；reset 删除覆盖文件恢复内置默认
 * - 空白内容 / 未启用槽位 / 非法 id 一律 VALIDATION_ERROR
 */
describe('Sprint 2 prompt settings IPC', () => {
  let environment: TemporaryPromaHome | undefined

  afterEach(() => {
    environment?.cleanup()
    environment = undefined
  })

  function useEnv(): TemporaryPromaHome {
    environment = useTemporaryPromaHome('bloma-a2-18-prompt-')
    return environment
  }

  it('[PROMPT-SETTINGS-001] list 返回全部六槽位，全部已接线启用（五引擎接入后契约）', async () => {
    useEnv()
    const harness = createIpcHarness()

    const result = await harness.invoke(IPC_CHANNELS.PROMPT_LIST, {
      request_id: 'a2-18-list',
    }) as ApiResult<PromptSlotInfo[]>

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected list to succeed')
    const ids = result.data.map((s) => s.id)
    expect(ids).toEqual([
      'prd-system',
      'sketch-system',
      'mvp-system',
      'guide-system',
      'enricher-system',
      'normalizer-system',
    ])
    // 五引擎接入（TDD）后全部槽位 enabled=true——不再是「预留未启用」
    for (const slot of result.data) {
      expect(slot.enabled).toBe(true)
      expect(slot.label.length).toBeGreaterThan(0)
      expect(slot.description.length).toBeGreaterThan(0)
    }
  })

  it('[PROMPT-SETTINGS-002] read 无覆盖时返回内置默认（含需求分析师）且 has_override=false', async () => {
    useEnv()
    const harness = createIpcHarness()

    const result = await harness.invoke(IPC_CHANNELS.PROMPT_READ, {
      request_id: 'a2-18-read-default',
      prompt_id: 'prd-system',
    }) as ApiResult<PromptSlotDetail>

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected read to succeed')
    expect(result.data.id).toBe('prd-system')
    expect(result.data.has_override).toBe(false)
    expect(result.data.content).toContain('需求分析师')
    // 提示词增强质量标准仍在（防回归单行简陋版）
    expect(result.data.content).toContain('2~4 条')
  })

  it('[PROMPT-SETTINGS-003] save 写入覆盖文件后 read 返回自定义内容，文件落盘且即时生效', async () => {
    useEnv()
    const harness = createIpcHarness()
    const custom = '自定义 PRD 提示词：CUSTOM-MARKER-67890'

    const saved = await harness.invoke(IPC_CHANNELS.PROMPT_SAVE, {
      request_id: 'a2-18-save',
      prompt_id: 'prd-system',
      content: custom,
    }) as ApiResult<{ saved: boolean; prompt_id: string }>
    expect(saved.ok).toBe(true)
    if (!saved.ok) throw new Error('expected save to succeed')

    // 覆盖文件确实写入 PROMA_HOME/prompts/ 下
    const filePath = join(environment!.home, 'prompts', 'prd-system.md')
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf8')).toBe(custom)

    // read 返回自定义内容 + has_override=true
    const read = await harness.invoke(IPC_CHANNELS.PROMPT_READ, {
      request_id: 'a2-18-read-override',
      prompt_id: 'prd-system',
    }) as ApiResult<PromptSlotDetail>
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error('expected read to succeed')
    expect(read.data.has_override).toBe(true)
    expect(read.data.content).toBe(custom)
  })

  it('[PROMPT-SETTINGS-004] reset 删除覆盖文件后 read 回到内置默认', async () => {
    useEnv()
    const harness = createIpcHarness()

    // 先写入覆盖
    await harness.invoke(IPC_CHANNELS.PROMPT_SAVE, {
      request_id: 'a2-18-save-reset',
      prompt_id: 'prd-system',
      content: '临时自定义提示词',
    })

    const reset = await harness.invoke(IPC_CHANNELS.PROMPT_RESET, {
      request_id: 'a2-18-reset',
      prompt_id: 'prd-system',
    }) as ApiResult<{ reset: boolean; prompt_id: string }>
    expect(reset.ok).toBe(true)
    if (!reset.ok) throw new Error('expected reset to succeed')
    expect(reset.data.reset).toBe(true)

    // 覆盖文件已删除
    expect(existsSync(join(environment!.home, 'prompts', 'prd-system.md'))).toBe(false)

    // read 回到内置默认
    const read = await harness.invoke(IPC_CHANNELS.PROMPT_READ, {
      request_id: 'a2-18-read-after-reset',
      prompt_id: 'prd-system',
    }) as ApiResult<PromptSlotDetail>
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error('expected read to succeed')
    expect(read.data.has_override).toBe(false)
    expect(read.data.content).toContain('需求分析师')
  })

  it('[PROMPT-SETTINGS-005] 非法输入一律 VALIDATION_ERROR：空白内容/缺字段/非法 id', async () => {
    useEnv()
    const harness = createIpcHarness()
    const invoke = (channel: string, payload: Record<string, unknown>): Promise<ApiResult<unknown>> =>
      harness.invoke(channel, payload) as Promise<ApiResult<unknown>>

    // 注：五引擎接入后全部槽位 enabled=true，原「未启用槽位 save 报错」场景不复存在，
    // 改为「缺 content 字段」与「空白内容」两类非法输入。
    const cases: Array<{ channel: string; payload: Record<string, unknown> }> = [
      { channel: IPC_CHANNELS.PROMPT_SAVE, payload: { request_id: 'e1', prompt_id: 'prd-system', content: '   ' } },
      { channel: IPC_CHANNELS.PROMPT_SAVE, payload: { request_id: 'e2', prompt_id: 'prd-system', content: '' } },
      { channel: IPC_CHANNELS.PROMPT_SAVE, payload: { request_id: 'e3', prompt_id: 'mvp-system' } },
      { channel: IPC_CHANNELS.PROMPT_SAVE, payload: { request_id: 'e4', prompt_id: 'not-exist', content: '自定义' } },
      { channel: IPC_CHANNELS.PROMPT_READ, payload: { request_id: 'e5', prompt_id: 'not-exist' } },
      { channel: IPC_CHANNELS.PROMPT_RESET, payload: { request_id: 'e6', prompt_id: 'not-exist' } },
    ]

    for (const { channel, payload } of cases) {
      const response = await invoke(channel, payload)
      expect(response.ok).toBe(false)
      if (response.ok) throw new Error('expected failure')
      expect(response.error.code).toBe('VALIDATION_ERROR')
    }
  })
})
