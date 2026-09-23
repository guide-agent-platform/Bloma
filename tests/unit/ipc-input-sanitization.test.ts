// @vitest-environment node
/**
 * P2 测试盲区「ipc 入参清洗」（2026-09-02 补测）。
 *
 * 实现位置：main/ipc.ts 三个模块私有校验器，经 registerIpcHandlers 捕获 handler 后
 * 通过真实调用路径触发（不直接测私有函数）：
 *  - validateAgentSend（AGENT_SEND_MESSAGE）：request_id 必填 + images 必须为
 *    {imageId, media_type} 字符串数组（clipboard-paste P1，2026-08-29）；
 *  - validateConfirmRequirements（AGENT_CONFIRM_REQUIREMENTS）：decision 必须
 *    confirm/delegate + adopted_ideas 清洗（非数组删除、非字符串/空串剔除）。
 * 此前测试只覆盖「确认草图→MVP」「纠错→迭代」等正常链路，非法入参的 fail-closed 未锁定。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerIpcHandlers } from '../../main/ipc'
import { IPC_CHANNELS } from '../../shared/types'

const { resolveRequirementConfirmMock } = vi.hoisted(() => ({
  resolveRequirementConfirmMock: vi.fn(async (_input: { adopted_ideas?: string[] }, _signal: AbortSignal) => ({ ok: true })),
}))

vi.mock('../../main/guide/guide-agent-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/guide/guide-agent-service')>()
  return { ...actual, resolveRequirementConfirm: resolveRequirementConfirmMock }
})

type Handler = (_event: unknown, payload: unknown) => Promise<{ ok: boolean; request_id?: string; error?: { code?: string; message?: string } }>

function captureHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  registerIpcHandlers(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never,
    { webContents: { send: () => undefined } } as never,
  )
  return handlers
}

describe('P2 盲区·ipc 入参清洗（validateAgentSend / validateConfirmRequirements）', () => {
  afterEach(() => {
    resolveRequirementConfirmMock.mockClear()
  })

  // ── validateAgentSend：images 结构校验 ────────────────────────────────

  it('images 非数组 → VALIDATION_ERROR（PASTED_IMAGE_BAD_REFS）', async () => {
    const send = captureHandlers().get(IPC_CHANNELS.AGENT_SEND_MESSAGE)!
    const result = await send({}, {
      request_id: 'req-img-arr',
      session_id: 's-img-arr',
      project_id: 'p-img-arr',
      content: 'hi',
      mode: 'quick',
      current_stage: 'ready',
      images: 'not-an-array',
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('VALIDATION_ERROR')
    expect(result.error?.message).toContain('PASTED_IMAGE_BAD_REFS')
  })

  it('images 元素缺 imageId → VALIDATION_ERROR', async () => {
    const send = captureHandlers().get(IPC_CHANNELS.AGENT_SEND_MESSAGE)!
    const result = await send({}, {
      request_id: 'req-img-elem',
      session_id: 's-img-elem',
      project_id: 'p-img-elem',
      content: 'hi',
      mode: 'quick',
      current_stage: 'ready',
      images: [{ media_type: 'image/png' }],
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('VALIDATION_ERROR')
    expect(result.error?.message).toContain('PASTED_IMAGE_BAD_REFS')
  })

  it('images 元素缺 media_type → VALIDATION_ERROR', async () => {
    const send = captureHandlers().get(IPC_CHANNELS.AGENT_SEND_MESSAGE)!
    const result = await send({}, {
      request_id: 'req-img-media',
      session_id: 's-img-media',
      project_id: 'p-img-media',
      content: 'hi',
      mode: 'quick',
      current_stage: 'ready',
      images: [{ imageId: 'img-1' }],
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('VALIDATION_ERROR')
    expect(result.error?.message).toContain('PASTED_IMAGE_BAD_REFS')
  })

  // ── validateAgentSend / requireFields：request_id 必填 ─────────────────

  it('request_id 缺失 → VALIDATION_ERROR（防 undefined 被 message-queue 误判重复丢消息）', async () => {
    const send = captureHandlers().get(IPC_CHANNELS.AGENT_SEND_MESSAGE)!
    const result = await send({}, {
      session_id: 's-no-reqid',
      project_id: 'p-no-reqid',
      content: 'hi',
      mode: 'quick',
      current_stage: 'ready',
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('VALIDATION_ERROR')
    expect(result.error?.message).toContain('request_id')
  })

  // ── validateConfirmRequirements：decision 白名单 ───────────────────────

  it('decision 非法（非 confirm/delegate）→ VALIDATION_ERROR', async () => {
    const confirm = captureHandlers().get(IPC_CHANNELS.AGENT_CONFIRM_REQUIREMENTS)!
    const result = await confirm({}, {
      request_id: 'req-decision',
      session_id: 's-decision',
      project_id: 'p-decision',
      decision: 'maybe',
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('VALIDATION_ERROR')
    expect(result.error?.message).toContain('decision')
    // 校验在注册后台运行之前失败，不触发下游
    expect(resolveRequirementConfirmMock).not.toHaveBeenCalled()
  })

  // ── validateConfirmRequirements：adopted_ideas 清洗 ────────────────────

  it('adopted_ideas 非字符串项/空串剔除后透传给 resolveRequirementConfirm', async () => {
    const confirm = captureHandlers().get(IPC_CHANNELS.AGENT_CONFIRM_REQUIREMENTS)!
    await confirm({}, {
      request_id: 'req-adopted',
      session_id: 's-adopted',
      project_id: 'p-adopted',
      decision: 'confirm',
      adopted_ideas: ['想法A', '', '   ', 42, '想法B'],
    })
    expect(resolveRequirementConfirmMock).toHaveBeenCalledTimes(1)
    const input = resolveRequirementConfirmMock.mock.calls[0]?.[0]
    expect(input?.adopted_ideas).toEqual(['想法A', '想法B'])
  })

  it('adopted_ideas 非数组 → 整体删除（透传 undefined，不坏下游）', async () => {
    const confirm = captureHandlers().get(IPC_CHANNELS.AGENT_CONFIRM_REQUIREMENTS)!
    await confirm({}, {
      request_id: 'req-adopted-arr',
      session_id: 's-adopted-arr',
      project_id: 'p-adopted-arr',
      decision: 'delegate',
      adopted_ideas: 'not-an-array',
    })
    expect(resolveRequirementConfirmMock).toHaveBeenCalledTimes(1)
    const input = resolveRequirementConfirmMock.mock.calls[0]?.[0]
    expect(input?.adopted_ideas).toBeUndefined()
  })
})
