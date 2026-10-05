/**
 * 语音服务编排（2026-10-05 语音批；生命周期纪律搬自 DSH recognizer.ts/runtime.ts，去 cordis）。
 *
 * 状态机（对齐 DSH「就绪取决于磁盘内容而非进程存活」）：
 * - 启动即查缓存（不下载不写盘）：完整且校验通过 → ready（worker 待唤醒）；
 * - prepare() 幂等 join：下载缺件（分文件进度）→ 校验 → ready；可取消；
 * - transcribe() 前置 ready 检查（**转写绝不隐式启动下载**，DSH 同款纪律）；
 * - worker 懒唤醒（首次转写才 fork + 加载模型），串行队列（maxPending 4），
 *   推理超时 120s，空闲 300s 回收进程（模型留磁盘缓存）；推理失败回收重建。
 *
 * 进度采用轮询制（渲染端经 IPC 拉 catalog 快照），不新增推送事件通道。
 * worker 进程：utilityProcess 消息协议（见 speech-worker.ts），无网络面。
 */

import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { speechModelPaths, SPEECH_MODEL_MANIFEST } from './model-manifest'
import { DownloadFailure, downloadAsset, inspectCache, type DownloadFailureInfo, type DownloadProgress } from './model-downloader'
import { mainRootDir } from '../paths'

export interface SpeechPreparationSnapshot {
  readonly running: boolean
  readonly currentFile: string | null
  readonly receivedBytes: number
  readonly totalBytes: number
  readonly failure: DownloadFailureInfo | null
}

export interface SpeechCatalog {
  readonly ready: boolean
  readonly preparation: SpeechPreparationSnapshot
}

export interface Transcript {
  readonly text: string
  readonly audioSeconds: number
  readonly inferenceSeconds: number
}

/** worker 进程抽象（测试注入 fake；生产为 Electron utilityProcess）。 */
export interface SpeechWorkerProcess {
  postMessage(message: unknown): void
  once(event: 'message', listener: (message: unknown) => void): void
  on(event: 'exit', listener: (code: number) => void): void
  kill(): void
}

export interface SpeechServiceDeps {
  /** worker 路径解析（缺省 mainRootDir()/platform/speech/worker.mjs）。 */
  workerPath?: string
  /** fork 注入（测试零真实进程）。 */
  forkWorker?: (path: string) => SpeechWorkerProcess
  /** 空闲回收毫秒（默认 300_000；测试可缩短）。 */
  idleTimeoutMs?: number
  /** 单条推理超时毫秒（默认 120_000）。 */
  inferenceTimeoutMs?: number
  /** 下载注入（测试 mock）。 */
  downloadImpl?: typeof downloadAsset
  inspectImpl?: typeof inspectCache
}

const MAX_PENDING = 4
const DEFAULT_THREADS = 2
/** 懒加载 electron（spawn-error 事件收敛先例同款：createRequire 局部遮蔽，__require=0）。 */
const nodeRequire = createRequire(import.meta.url)

interface WorkerLoadRequest { type: 'load'; model: string; tokens: string; vad: string; threads: number }
interface WorkerTranscribeRequest { type: 'transcribe'; id: number; wav: Uint8Array; language: string }
interface WorkerResultMessage { type: 'result'; id: number; ok: boolean; text?: string; message?: string; audioSeconds?: number; inferenceSeconds?: number }

export class SpeechService extends EventEmitter {
  private ready = false
  private inspected = false
  private preparation: SpeechPreparationSnapshot = { running: false, currentFile: null, receivedBytes: 0, totalBytes: 0, failure: null }
  private prepareTask: Promise<void> | undefined
  private prepareAbort: AbortController | undefined

  private worker: SpeechWorkerProcess | undefined
  private workerLoaded = false
  private workerLoading: Promise<void> | undefined
  private pendingCount = 0
  private nextRequestId = 1
  private idleTimer: NodeJS.Timeout | undefined
  private readonly deps: SpeechServiceDeps & { idleTimeoutMs: number; inferenceTimeoutMs: number }
  private readonly forkWorker: (path: string) => SpeechWorkerProcess
  private readonly downloadImpl: typeof downloadAsset
  private readonly inspectImpl: typeof inspectCache

  constructor(deps: SpeechServiceDeps = {}) {
    super()
    this.deps = {
      ...deps,
      idleTimeoutMs: deps.idleTimeoutMs ?? 300_000,
      inferenceTimeoutMs: deps.inferenceTimeoutMs ?? 120_000,
    }
    this.forkWorker = deps.forkWorker ?? ((path) => {
      const { utilityProcess } = nodeRequire('electron') as typeof import('electron')
      return utilityProcess.fork(path) as unknown as SpeechWorkerProcess
    })
    this.downloadImpl = deps.downloadImpl ?? downloadAsset
    this.inspectImpl = deps.inspectImpl ?? inspectCache
  }

  /** 启动后台缓存检查（不下载；失败静默回 not-ready，下次 prepare 再看）。 */
  async inspect(): Promise<void> {
    if (this.inspected) return
    this.inspected = true
    try {
      this.ready = await this.inspectImpl()
    } catch {
      this.ready = false
    }
    this.emitChanged()
  }

  catalog(): SpeechCatalog {
    return { ready: this.ready, preparation: this.preparation }
  }

  /** 幂等准备：并发调用 join 同一任务；失败保留分类供 UI 重试。 */
  prepare(): Promise<void> {
    if (this.prepareTask) return this.prepareTask
    const abort = new AbortController()
    this.prepareAbort = abort
    this.preparation = { running: true, currentFile: null, receivedBytes: 0, totalBytes: 0, failure: null }
    this.emitChanged()
    const paths = speechModelPaths()
    const root = dirname(paths.model)
    const assets = [
      SPEECH_MODEL_MANIFEST.vad,
      SPEECH_MODEL_MANIFEST.tokens,
      SPEECH_MODEL_MANIFEST.model,
    ]
    this.prepareTask = (async () => {
      try {
        for (const asset of assets) {
          const onProgress = (progress: DownloadProgress): void => {
            this.preparation = { ...this.preparation, currentFile: progress.file, receivedBytes: progress.receivedBytes, totalBytes: progress.totalBytes }
            this.emitChanged()
          }
          await this.downloadImpl(asset, root, abort.signal, onProgress)
        }
        this.ready = true
        this.preparation = { running: false, currentFile: null, receivedBytes: 0, totalBytes: 0, failure: null }
      } catch (error) {
        const failure = error instanceof DownloadFailure ? error.info
          : { file: '', source: '', reason: 'unknown' as const }
        this.preparation = { running: false, currentFile: null, receivedBytes: 0, totalBytes: 0, failure }
      } finally {
        this.prepareTask = undefined
        this.prepareAbort = undefined
        this.emitChanged()
      }
    })()
    return this.prepareTask
  }

  /** 取消进行中的准备（已完成的文件保留复用）。 */
  async cancelPreparation(): Promise<void> {
    this.prepareAbort?.abort()
    if (this.prepareTask) await this.prepareTask.catch(() => undefined)
  }

  /**
   * 转写一段完整 WAV（PCM16 单声道 16kHz）。串行；不隐式下载；取消即杀 worker。
   */
  async transcribe(wav: Uint8Array, language: string, signal?: AbortSignal): Promise<Transcript> {
    if (!this.ready) throw new Error('speech model not ready (call prepare first)')
    if (this.pendingCount >= MAX_PENDING) throw new Error('speech queue full')
    this.pendingCount++
    this.stopIdleTimer()
    try {
      await this.ensureWorker()
      return await new Promise<Transcript>((resolve, reject) => {
        // abort 可能发生在 ensureWorker 等待期（监听器尚未挂上）——补一次性检查防事件丢失。
        if (signal?.aborted) {
          this.recycleWorker()
          reject(new Error('speech transcription cancelled'))
          return
        }
        const id = this.nextRequestId++
        const request: WorkerTranscribeRequest = { type: 'transcribe', id, wav, language }
        const timer = setTimeout(() => {
          cleanup()
          this.recycleWorker()
          reject(new Error('speech inference timeout'))
        }, this.deps.inferenceTimeoutMs)
        const onAbort = (): void => {
          clearTimeout(timer)
          cleanup()
          this.recycleWorker()
          reject(new Error('speech transcription cancelled'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        const cleanup = (): void => { signal?.removeEventListener('abort', onAbort) }
        const onMessage = (message: unknown): void => {
          const result = message as WorkerResultMessage
          if (result.type !== 'result' || result.id !== id) return
          clearTimeout(timer)
          cleanup()
          if (!result.ok) {
            this.recycleWorker()
            reject(new Error(result.message ?? 'speech inference failed'))
            return
          }
          this.scheduleIdleRecycle()
          resolve({ text: result.text ?? '', audioSeconds: result.audioSeconds ?? 0, inferenceSeconds: result.inferenceSeconds ?? 0 })
        }
        this.worker?.once('message', onMessage)
        this.worker?.postMessage(request)
      })
    } finally {
      this.pendingCount--
      if (this.pendingCount === 0) this.scheduleIdleRecycle()
    }
  }

  /** 应用退出时释放（不杀磁盘缓存）。 */
  dispose(): void {
    this.prepareAbort?.abort()
    this.stopIdleTimer()
    this.recycleWorker()
  }

  private ensureWorker(): Promise<void> {
    if (this.worker && this.workerLoaded) return Promise.resolve()
    if (this.workerLoading) return this.workerLoading
    const workerPath = this.deps.workerPath ?? join(mainRootDir(), 'platform', 'speech', 'worker.mjs')
    const worker = this.forkWorker(workerPath)
    this.worker = worker
    worker.on('exit', () => {
      if (this.worker === worker) { this.worker = undefined; this.workerLoaded = false; this.workerLoading = undefined }
    })
    const paths = speechModelPaths()
    this.workerLoading = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.recycleWorker(); reject(new Error('speech worker load timeout')) }, this.deps.inferenceTimeoutMs)
      worker.once('message', (message) => {
        clearTimeout(timer)
        const data = message as { type: string; message?: string }
        if (data.type === 'loaded') { this.workerLoaded = true; resolve() }
        else { this.recycleWorker(); reject(new Error(data.message ?? 'speech worker load failed')) }
      })
    })
    const load: WorkerLoadRequest = { type: 'load', model: paths.model, tokens: paths.tokens, vad: paths.vad, threads: DEFAULT_THREADS }
    worker.postMessage(load)
    return this.workerLoading
  }

  private recycleWorker(): void {
    this.stopIdleTimer()
    const worker = this.worker
    this.worker = undefined
    this.workerLoaded = false
    this.workerLoading = undefined
    try { worker?.kill() } catch { /* 已退出 */ }
  }

  private scheduleIdleRecycle(): void {
    this.stopIdleTimer()
    if (this.pendingCount > 0) return
    this.idleTimer = setTimeout(() => { this.recycleWorker(); this.emitChanged() }, this.deps.idleTimeoutMs)
    this.idleTimer.unref?.()
  }

  private stopIdleTimer(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined }
  }

  private emitChanged(): void {
    this.emit('changed', this.catalog())
  }
}

/** 进程级单例（main/ipc/speech.ts 消费；测试不经过此单例）。 */
let singleton: SpeechService | undefined

export function speechService(): SpeechService {
  if (!singleton) {
    singleton = new SpeechService()
    void singleton.inspect()
  }
  return singleton
}
