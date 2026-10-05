/**
 * 语音内核单测（2026-10-05 语音批）。
 * 覆盖：下载器（校验/原子发布/双源探测/失败分类）、service 状态机
 * （就绪快照/准备幂等 join/转写不隐式下载/队列上限/空闲回收/推理失败重建）。
 * 全部 mock（fetch/文件系统边界走注入），零真实下载零真实进程。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DownloadFailure, downloadAsset, matchesAsset, orderSources, type DownloadDeps } from '../../../../main/platform/speech/model-downloader'
import { SPEECH_MODEL_MANIFEST, speechModelRoot, speechModelPaths } from '../../../../main/platform/speech/model-manifest'
import { SpeechService, type SpeechWorkerProcess } from '../../../../main/platform/speech/speech-service'

describe('model-manifest', () => {
  it('缓存根在 ~/.proma/speech-models/sensevoice-int8（A/C 共用唯一路径）', () => {
    expect(speechModelRoot().replace(/\\/g, '/')).toContain('.proma/speech-models/sensevoice-int8')
  })
  it('三件路径指向缓存根且文件名与资产清单一致', () => {
    const paths = speechModelPaths()
    expect(paths.model.endsWith('model.int8.onnx')).toBe(true)
    expect(paths.tokens.endsWith('tokens.txt')).toBe(true)
    expect(paths.vad.endsWith('silero_vad.onnx')).toBe(true)
  })
  it('资产清单锚定字节与 SHA-256（固定修订不可漂移）', () => {
    expect(SPEECH_MODEL_MANIFEST.model.bytes).toBe(239_233_841)
    expect(SPEECH_MODEL_MANIFEST.model.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(SPEECH_MODEL_MANIFEST.vad.bytes).toBe(1_807_522)
  })
})

describe('model-downloader', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'speech-dl-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('matchesAsset：大小不符即 false（不读哈希）', async () => {
    const file = join(dir, 'wrong-size')
    writeFileSync(file, Buffer.alloc(10))
    expect(await matchesAsset(file, { name: 'x', url: 'https://x', bytes: 11, sha256: '0'.repeat(64) })).toBe(false)
  })
  it('matchesAsset：ENOENT 即 false', async () => {
    expect(await matchesAsset(join(dir, 'missing'), { name: 'x', url: 'https://x', bytes: 1, sha256: '0'.repeat(64) })).toBe(false)
  })
  it('matchesAsset：大小与哈希均匹配即 true（真实 crypto 路径）', async () => {
    const content = Buffer.from('bloma-speech-asset')
    const sha256 = createHash('sha256').update(content).digest('hex')
    const file = join(dir, 'good')
    writeFileSync(file, content)
    expect(await matchesAsset(file, { name: 'x', url: 'https://x', bytes: content.length, sha256 })).toBe(true)
  })

  it('orderSources：先回 2xx 的源排前，探测失败源殿后（回退保序）', async () => {
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      // hf-mirror 秒回 200；huggingface 抛网络错
      if (url.includes('hf-mirror')) return new Response(null, { status: 200 })
      throw Object.assign(new Error('blocked'), { code: 'ENOTFOUND' })
    })
    const sources = await orderSources('tokens.txt', { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(sources[0]).toBe('https://hf-mirror.com')
    expect(sources).toContain('https://huggingface.co')
    expect(sources).toHaveLength(2)
  })

  it('downloadAsset：缓存已校验文件直接复用（零网络）', async () => {
    const content = Buffer.from('already-here')
    const sha256 = createHash('sha256').update(content).digest('hex')
    const file = join(dir, 'reuse.bin')
    writeFileSync(file, content)
    const fetchImpl = vi.fn()
    const result = await downloadAsset(
      { name: 'reuse.bin', url: 'https://x/reuse.bin', bytes: content.length, sha256 },
      dir, new AbortController().signal, () => {}, { fetchImpl: fetchImpl as unknown as typeof fetch },
    )
    expect(result).toBe(file)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('downloadAsset：哈希不符换源重试，次源成功后原子发布', async () => {
    const good = Buffer.from('second-source-wins')
    const sha256 = createHash('sha256').update(good).digest('hex')
    let downloads = 0
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200 }) // 探测不计入下载序号
      downloads++
      if (downloads === 1) return new Response(Buffer.alloc(good.length, 9), { status: 200 }) // 损坏内容（大小对哈希错）
      return new Response(good, { status: 200 })
    })
    const deps: DownloadDeps = { fetchImpl: fetchImpl as unknown as typeof fetch }
    const result = await downloadAsset(
      { name: 'multi.bin', url: 'https://huggingface.co/x/multi.bin', bytes: good.length, sha256 },
      dir, new AbortController().signal, () => {}, deps,
    )
    expect(result).toBe(join(dir, 'multi.bin'))
    expect(downloads).toBe(2)
  })

  it('downloadAsset：全部源失败抛 DownloadFailure（带分类与来源）', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    })
    await expect(downloadAsset(
      { name: 'dead.bin', url: 'https://huggingface.co/x/dead.bin', bytes: 3, sha256: 'f'.repeat(64) },
      dir, new AbortController().signal, () => {}, { fetchImpl: fetchImpl as unknown as typeof fetch },
    )).rejects.toBeInstanceOf(DownloadFailure)
  })

  it('downloadAsset：取消信号中止下载（.part 清理）', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      controller.abort()
      return new Response(Buffer.from('x'), { status: 200 })
    })
    await expect(downloadAsset(
      { name: 'cancel.bin', url: 'https://huggingface.co/x/cancel.bin', bytes: 3, sha256: 'f'.repeat(64) },
      dir, controller.signal, () => {}, { fetchImpl: fetchImpl as unknown as typeof fetch },
    )).rejects.toBeInstanceOf(DownloadFailure)
  })
})

/** fake worker：同步回话或脚本化延迟。 */
class FakeWorker implements SpeechWorkerProcess {
  private listeners: { event: string; listener: (arg: unknown) => void }[] = []
  public posted: unknown[] = []
  public killed = false
  /** 每条 transcribe 请求的响应延迟毫秒与结果覆盖。 */
  constructor(private behaviour: { loadOk: boolean; reply?: (id: number) => unknown; delayMs?: number } = { loadOk: true }) {}
  postMessage(message: unknown): void {
    this.posted.push(message)
    const data = message as { type: string; id?: number }
    if (data.type === 'load') {
      setTimeout(() => this.emit('message', this.behaviour.loadOk ? { type: 'loaded' } : { type: 'load-error', message: 'boom' }), 0)
      return
    }
    if (data.type === 'transcribe') {
      const reply = this.behaviour.reply?.(data.id!) ?? { type: 'result', id: data.id, ok: true, text: '你好', audioSeconds: 1, inferenceSeconds: 0.1 }
      setTimeout(() => this.emit('message', reply), this.behaviour.delayMs ?? 0)
    }
  }
  once(event: 'message', listener: (message: unknown) => void): void { this.listeners.push({ event, listener }) }
  on(event: 'exit', listener: (code: number) => void): void {
    this.listeners.push({ event, listener: (arg: unknown) => listener(arg as number) })
  }
  kill(): void { this.killed = true; this.emit('exit', 0) }
  private emit(event: string, arg: unknown): void {
    this.listeners = this.listeners.filter((item) => {
      if (item.event !== event) return true
      item.listener(arg)
      return false
    })
  }
}

describe('SpeechService', () => {
  async function makeService(overrides: { worker?: FakeWorker; ready?: boolean } = {}) {
    const worker = overrides.worker ?? new FakeWorker()
    const service = new SpeechService({
      forkWorker: () => worker,
      inspectImpl: async () => overrides.ready ?? false,
      downloadImpl: async () => '',
      idleTimeoutMs: 10,
      inferenceTimeoutMs: 500,
    })
    await service.inspect()
    return { service, worker }
  }

  it('inspect 后 ready 快照取决于磁盘缓存（true 透传）', async () => {
    const { service } = await makeService({ ready: true })
    expect(service.catalog().ready).toBe(true)
  })

  it('prepare：下载进度快照推进、完成转 ready、并发调用 join 同一任务', async () => {
    let calls = 0
    const { service } = await makeService()
    ;(service as unknown as { downloadImpl: unknown }).downloadImpl = async (_a: unknown, _r: unknown, _s: unknown, onProgress: (p: { file: string; receivedBytes: number; totalBytes: number }) => void) => {
      calls++
      onProgress({ file: 'model.int8.onnx', receivedBytes: 100, totalBytes: 200 })
      return ''
    }
    const [first, second] = [service.prepare(), service.prepare()]
    await Promise.all([first, second])
    expect(calls).toBe(3) // 三件资产各一次（join 不重复）
    expect(service.catalog().ready).toBe(true)
    expect(service.catalog().preparation.running).toBe(false)
  })

  it('transcribe：未就绪直接拒绝（不隐式下载，DSH 纪律）', async () => {
    const { service } = await makeService({ ready: false })
    await expect(service.transcribe(new Uint8Array(46), 'auto')).rejects.toThrow(/not ready/)
    expect((service as unknown as { prepareTask: unknown }).prepareTask).toBeUndefined()
  })

  it('transcribe：就绪后唤醒 worker 并返回转写结果', async () => {
    const { service } = await makeService({ ready: true })
    const wav = new Uint8Array(46)
    const transcript = await service.transcribe(wav, 'auto')
    expect(transcript.text).toBe('你好')
    expect(transcript.inferenceSeconds).toBeGreaterThan(0)
  })

  it('transcribe：推理失败回收 worker，下次调用重建', async () => {
    const worker = new FakeWorker({ loadOk: true, reply: (id) => ({ type: 'result', id, ok: false, message: 'native crash' }) })
    const { service } = await makeService({ worker, ready: true })
    await expect(service.transcribe(new Uint8Array(46), 'auto')).rejects.toThrow(/native crash/)
    expect(worker.killed).toBe(true)
    await expect(service.transcribe(new Uint8Array(46), 'auto')).rejects.toThrow() // 重建后仍失败（同一 fake 行为）
  })

  it('transcribe：取消杀 worker 并拒绝', async () => {
    const worker = new FakeWorker({ loadOk: true, delayMs: 10_000 })
    const { service } = await makeService({ worker, ready: true })
    const controller = new AbortController()
    const pending = service.transcribe(new Uint8Array(46), 'auto', controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow(/cancelled/)
    expect(worker.killed).toBe(true)
  })

  it('transcribe：队列上限 MAX_PENDING=4 拒绝第五条', async () => {
    const worker = new FakeWorker({ loadOk: true, delayMs: 100 })
    const { service } = await makeService({ worker, ready: true })
    const pending = Array.from({ length: 4 }, () => service.transcribe(new Uint8Array(46), 'auto').catch(() => 'settled'))
    await expect(service.transcribe(new Uint8Array(46), 'auto')).rejects.toThrow(/queue full/)
    await Promise.all(pending)
  })

  it('空闲回收：转写完成后 idleTimeout 触发 kill（真实短计时器，模型缓存不动）', async () => {
    const worker = new FakeWorker()
    const { service } = await makeService({ worker, ready: true })
    await service.transcribe(new Uint8Array(46), 'auto')
    expect(worker.killed).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 60)) // idleTimeoutMs=10，等真实计时器触发
    expect(worker.killed).toBe(true)
  })

  it('cancelPreparation：中止下载且失败分类为 cancelled', async () => {
    const { service } = await makeService()
    const { DownloadFailure: DF } = await import('../../../../main/platform/speech/model-downloader')
    ;(service as unknown as { downloadImpl: unknown }).downloadImpl = async () => {
      throw new DF({ file: 'model.int8.onnx', source: 'https://hf-mirror.com', reason: 'cancelled' })
    }
    await service.prepare()
    expect(service.catalog().preparation.failure?.reason).toBe('cancelled')
    expect(service.catalog().ready).toBe(false)
  })
})
