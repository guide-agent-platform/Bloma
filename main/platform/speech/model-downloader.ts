/**
 * 语音模型下载器（2026-10-05 语音批；下载/校验/原子发布机制搬自 DSH MIT 源码
 * runtime.ts downloadAsset + model-sources.ts orderModelSources，去 cordis 依赖适配 Bloma）。
 *
 * 核心纪律（DSH 同款）：
 * - 双源并发 HEAD 探测（默认 3s 截止），先回 2xx 的源优先下载；全部失败按清单顺序直下；
 * - 下载进 `.part` 临时文件，完整后校验字节 + SHA-256，通过才原子 rename 发布；
 * - 已存在且校验通过的文件直接复用（重试/二次启动零重下）；
 * - 校验失败换下一源重试；网络/HTTP 错误换源；取消立即中止。
 */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { SPEECH_DOWNLOAD_ORIGINS, SPEECH_MODEL_MANIFEST, assetUrlForOrigin, speechModelRoot, type SpeechAsset } from './model-manifest'

/** 下载失败分类（对齐 DSH SpeechDownloadFailure 语义，渲染端本地化提示）。 */
export interface DownloadFailureInfo {
  readonly file: string
  readonly source: string
  readonly reason: 'network' | 'http' | 'integrity' | 'storage' | 'cancelled' | 'unknown'
  readonly status?: number
}

export class DownloadFailure extends Error {
  constructor(readonly info: DownloadFailureInfo) {
    super(`${info.file} from ${info.source}: ${info.reason}${info.status ? ` (${info.status})` : ''}`)
    this.name = 'DownloadFailure'
  }
}

export interface DownloadProgress {
  readonly file: string
  readonly receivedBytes: number
  readonly totalBytes: number
}

export interface DownloadDeps {
  /** 注入 fetch（测试 mock）；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch
  /** HEAD 探测超时毫秒（默认 3000）。 */
  probeTimeoutMs?: number
}

/** 已存在的文件是否与锚定资产完全一致（字节 + SHA-256；ENOENT 视为不匹配）。 */
export async function matchesAsset(path: string, asset: SpeechAsset, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    if (info.size !== asset.bytes) return false
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(path, { signal })) digest.update(chunk as Buffer)
    return digest.digest('hex') === asset.sha256
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    if ((error as Error).name === 'AbortError') throw error
    throw error
  }
}

/** 缓存目录内三件是否全部就绪（不下载、不写盘）。 */
export async function inspectCache(signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  const root = speechModelRoot()
  const entries: Array<[string, SpeechAsset]> = [
    ['model.int8.onnx', SPEECH_MODEL_MANIFEST.model],
    ['tokens.txt', SPEECH_MODEL_MANIFEST.tokens],
    ['silero_vad.onnx', SPEECH_MODEL_MANIFEST.vad],
  ]
  for (const [name, asset] of entries) {
    const ok = await matchesAsset(join(root, name), asset, signal).catch(() => false)
    if (!ok) return false
  }
  return true
}

/** 并发 HEAD 探测源可用性，返回按响应速度排序的源列表（全失败回退清单顺序）。 */
export async function orderSources(assetName: string, deps: DownloadDeps = {}, signal?: AbortSignal): Promise<string[]> {
  const origins = [...SPEECH_DOWNLOAD_ORIGINS]
  const timeout = deps.probeTimeoutMs ?? 3000
  const fetchImpl = deps.fetchImpl ?? fetch
  const probe = async (origin: string): Promise<{ origin: string; ok: boolean }> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await fetchImpl(assetUrlForOrigin(assetName, origin), {
        method: 'HEAD', signal: controller.signal, redirect: 'follow',
      })
      return { origin, ok: response.ok }
    } catch {
      return { origin, ok: false }
    } finally {
      clearTimeout(timer)
    }
  }
  const results = await Promise.all(origins.map((origin) => probe(origin)))
  const alive = results.filter((item) => item.ok).map((item) => item.origin)
  const dead = results.filter((item) => !item.ok).map((item) => item.origin)
  return signal?.aborted ? origins : [...alive, ...dead]
}

/**
 * 下载单个资产到缓存根并校验（.part → 校验 → 原子发布）。
 * 已存在且校验通过时直接返回路径（零下载）。
 */
export async function downloadAsset(
  asset: SpeechAsset, root: string, signal: AbortSignal,
  onProgress: (progress: DownloadProgress) => void, deps: DownloadDeps = {},
): Promise<string> {
  signal.throwIfAborted()
  const fetchImpl = deps.fetchImpl ?? fetch
  const destination = join(root, asset.name)
  await mkdir(root, { recursive: true })
  if (await matchesAsset(destination, asset, signal)) return destination

  const sources = await orderSources(asset.name, deps, signal)
  let lastFailure: DownloadFailure | undefined
  for (const origin of sources) {
    // 取消必须转为分类失败（try 外的 throwIfAborted 会裸抛 AbortError 穿透，探针实锤）。
    if (signal.aborted) throw new DownloadFailure({ file: asset.name, source: origin, reason: 'cancelled' })
    const url = assetUrlForOrigin(asset.name, origin)
    const partial = `${destination}.${randomUUID()}.part`
    try {
      const response = await fetchImpl(url, { signal, redirect: 'follow' })
      if (!response.ok || !response.body) {
        if (response.body) await response.body.cancel().catch(() => undefined)
        throw new DownloadFailure({ file: asset.name, source: origin, reason: 'http', status: response.status })
      }
      const digest = createHash('sha256')
      let received = 0
      const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
      body.on('data', (chunk: Buffer) => {
        digest.update(chunk)
        received += chunk.length
        onProgress({ file: asset.name, receivedBytes: received, totalBytes: asset.bytes })
      })
      await pipeline(body, createWriteStream(partial))
      signal.throwIfAborted()
      const info = await stat(partial)
      if (info.size !== asset.bytes || digest.digest('hex') !== asset.sha256) {
        throw new DownloadFailure({ file: asset.name, source: origin, reason: 'integrity' })
      }
      await rename(partial, destination)
      return destination
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined)
      if (error instanceof DownloadFailure) { lastFailure = error; continue }
      if ((error as Error).name === 'AbortError' || signal.aborted) {
        throw new DownloadFailure({ file: asset.name, source: origin, reason: 'cancelled' })
      }
      lastFailure = new DownloadFailure({ file: asset.name, source: origin, reason: classify(error) })
      continue
    }
  }
  throw lastFailure ?? new DownloadFailure({ file: asset.name, source: sources[0] ?? '', reason: 'unknown' })
}

function classify(error: unknown): DownloadFailureInfo['reason'] {
  const code = (error as NodeJS.ErrnoException)?.code
  if (typeof code === 'string' && ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'CERT_HAS_EXPIRED'].includes(code)) return 'network'
  if (code !== undefined && code.startsWith('ERR_')) return 'network'
  if ((error as Error).message?.includes('certificate')) return 'network'
  return 'unknown'
}
