// @vitest-environment node
/**
 * 语音 IPC 契约测试（2026-10-05 语音批 A 线）。
 *
 * 经真实 registerIpcHandlers 路径捕获 handler（不直接测私有函数）：
 * - SPEECH_CATALOG 快照字段映射（内核 camelCase → IPC snake_case）；
 * - SPEECH_TRANSCRIBE 入参校验：wav_base64 超长 fail-closed、语言白名单；
 * - 未就绪转写不隐式下载（内核纪律经 IPC 层透传）。
 * 内核单例 mock（零磁盘零进程）。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { registerIpcHandlers } from '../../../../main/ipc'
import { IPC_CHANNELS } from '../../../../shared/types'

const { serviceMock } = vi.hoisted(() => ({
  serviceMock: {
    catalog: vi.fn(),
    prepare: vi.fn(async () => undefined),
    cancelPreparation: vi.fn(async () => undefined),
    transcribe: vi.fn(),
  },
}))

vi.mock('../../../../main/platform/speech/speech-service', () => ({
  speechService: () => serviceMock,
}))

type Handler = (_event: unknown, payload: unknown) => Promise<{ ok: boolean; request_id?: string; error?: { code?: string; message?: string }; data?: unknown }>

function captureHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  registerIpcHandlers(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never,
    { webContents: { send: () => undefined } } as never,
  )
  return handlers
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('语音 IPC 契约', () => {
  it('NOTIFICATION_SPEAK：非法入参经真实注册入口拒绝，并保留 request_id', async () => {
    const speak = captureHandlers().get(IPC_CHANNELS.NOTIFICATION_SPEAK)!
    const result = await speak({}, { request_id: 'req-speak', text: '你好', volume: 9 })
    expect(result.ok).toBe(false)
    expect(result.request_id).toBe('req-speak')
    expect(result.error?.code).toBe('VALIDATION_ERROR')
    expect(result.error?.message).toContain('音量')
    expect((await speak({}, { text: '你好', volume: 0.5 })).error?.message).toContain('request_id')
  })
  it('SPEECH_CATALOG：快照字段映射 snake_case（就绪 + 准备进度 + 失败分类）', async () => {
    serviceMock.catalog.mockReturnValue({
      ready: true,
      preparation: {
        running: true, currentFile: 'model.int8.onnx', receivedBytes: 100, totalBytes: 239233841,
        failure: { file: 'tokens.txt', source: 'https://hf-mirror.com', reason: 'http' },
      },
    })
    const catalog = captureHandlers().get(IPC_CHANNELS.SPEECH_CATALOG)!
    const result = await catalog({}, { request_id: 'req-cat' })
    expect(result.ok).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.ready).toBe(true)
    const prep = data.preparation as Record<string, unknown>
    expect(prep.current_file).toBe('model.int8.onnx')
    expect(prep.received_bytes).toBe(100)
    expect(prep.total_bytes).toBe(239233841)
    expect((prep.failure as Record<string, string>).reason).toBe('http')
  })

  it('SPEECH_TRANSCRIBE：合法输入透传内核并映射结果字段', async () => {
    serviceMock.transcribe.mockResolvedValue({ text: '你好', audioSeconds: 2.5, inferenceSeconds: 0.3 })
    const transcribe = captureHandlers().get(IPC_CHANNELS.SPEECH_TRANSCRIBE)!
    const result = await transcribe({}, { request_id: 'req-tr', wav_base64: Buffer.from('x').toString('base64'), language: 'auto' })
    expect(result.ok).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.text).toBe('你好')
    expect(data.audio_seconds).toBe(2.5)
    expect(data.inference_seconds).toBe(0.3)
    expect(serviceMock.transcribe).toHaveBeenCalledTimes(1)
  })

  it('SPEECH_TRANSCRIBE：base64 超长（>4MB WAV）fail-closed', async () => {
    const transcribe = captureHandlers().get(IPC_CHANNELS.SPEECH_TRANSCRIBE)!
    const oversized = 'A'.repeat(Math.ceil(4 * 1024 * 1024 * 4 / 3) + 1)
    const result = await transcribe({}, { request_id: 'req-big', wav_base64: oversized, language: 'auto' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('超长')
    expect(serviceMock.transcribe).not.toHaveBeenCalled()
  })

  it('SPEECH_TRANSCRIBE：语言白名单外拒绝', async () => {
    const transcribe = captureHandlers().get(IPC_CHANNELS.SPEECH_TRANSCRIBE)!
    const result = await transcribe({}, { request_id: 'req-lang', wav_base64: Buffer.from('x').toString('base64'), language: 'fr' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('语言')
    expect(serviceMock.transcribe).not.toHaveBeenCalled()
  })

  it('SPEECH_TRANSCRIBE：未就绪（内核 not ready）错误透传为 ok:false（不隐式下载）', async () => {
    serviceMock.transcribe.mockRejectedValue(new Error('speech model not ready (call prepare first)'))
    const transcribe = captureHandlers().get(IPC_CHANNELS.SPEECH_TRANSCRIBE)!
    const result = await transcribe({}, { request_id: 'req-nr', wav_base64: Buffer.from('x').toString('base64'), language: 'auto' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('not ready')
    expect(serviceMock.prepare).not.toHaveBeenCalled()
  })

  it('SPEECH_PREPARE：启动准备并立即返回（进度走轮询）', async () => {
    const prepare = captureHandlers().get(IPC_CHANNELS.SPEECH_PREPARE)!
    const result = await prepare({}, { request_id: 'req-prep' })
    expect(result.ok).toBe(true)
    expect(serviceMock.prepare).toHaveBeenCalledTimes(1)
  })

  it('SPEECH_CANCEL_PREPARATION：取消透传内核', async () => {
    const cancel = captureHandlers().get(IPC_CHANNELS.SPEECH_CANCEL_PREPARATION)!
    const result = await cancel({}, { request_id: 'req-cancel' })
    expect(result.ok).toBe(true)
    expect(serviceMock.cancelPreparation).toHaveBeenCalledTimes(1)
  })
})
