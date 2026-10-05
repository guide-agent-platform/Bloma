/**
 * 浏览器侧麦克风采集与编码（2026-10-05 语音批 A 线；核心机制搬自 DSH MIT 源码
 * packages/experimental/client-ui-voice-input/src/client/audio.ts）。
 *
 * 全部用 Web Audio 原生能力，零外部依赖：
 * - getUserMedia（echoCancellation + noiseSuppression）；
 * - AnalyserNode 实测音量（波形条）；
 * - MediaRecorder 录制 → decodeAudioData → OfflineAudioContext 原生重采样 16kHz 单声道；
 * - 手写 44 字节 WAV 头编码 PCM16 小端 → base64（无 dataURL 前缀）。
 */

/** 采集失败分类（组件本地化提示）。 */
export class RecordingError extends Error {
  constructor(readonly kind: 'unavailable' | 'permission' | 'empty' | 'cancelled' | 'interrupted') {
    super(kind)
    this.name = 'RecordingError'
  }
}

/** Host 侧单条录音上限（约 2 分钟 16kHz PCM16；与内核 maxAudioBytes 对齐）。 */
export const MAX_RECORDING_SECONDS = 120

/** Float32 单声道样本 → 规范 PCM16 WAV 字节。 */
export function encodeWave(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, value: string): void => {
    for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i)
  }
  text(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (const [i, sample] of samples.entries()) {
    const value = Math.max(-1, Math.min(1, sample))
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
  }
  return bytes
}

/** WAV 字节 → base64（JSON IPC 载荷；无 dataURL 前缀）。 */
export function audioBase64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(text)
}

/** 一次麦克风采集会话（start → level 轮询 → stop 返回 WAV 字节）。 */
export class Recording {
  private stream: MediaStream | undefined
  private recorder: MediaRecorder | undefined
  private context: AudioContext | undefined
  private analyser: AnalyserNode | undefined
  private samples = new Float32Array(256)
  private chunks: Blob[] = []
  private readonly lifetime = new AbortController()
  private disposal: Promise<void> | undefined

  /** 是否正在采集（组件状态判定）。 */
  get active(): boolean {
    return !this.lifetime.signal.aborted
  }

  async start(onError?: (error: RecordingError) => void): Promise<void> {
    const devices = (navigator as Partial<Navigator>).mediaDevices
    if (!devices || typeof MediaRecorder === 'undefined') throw new RecordingError('unavailable')
    let stream: MediaStream
    try {
      stream = await devices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotAllowedError') throw new RecordingError('permission')
      throw error
    }
    // 权限弹窗期间用户已取消：立即释放轨道
    if (this.lifetime.signal.aborted) {
      stream.getTracks().forEach((track) => { track.stop() })
      throw new RecordingError('cancelled')
    }
    this.stream = stream
    try {
      this.context = new AudioContext()
      this.analyser = this.context.createAnalyser()
      this.analyser.fftSize = this.samples.length
      this.context.createMediaStreamSource(stream).connect(this.analyser)
      this.recorder = new MediaRecorder(stream)
      this.recorder.ondataavailable = (event) => {
        if (!this.lifetime.signal.aborted && event.data.size > 0) this.chunks.push(event.data)
      }
      this.recorder.onerror = () => {
        if (this.lifetime.signal.aborted) return
        void this.dispose().catch(() => undefined)
        try { onError?.(new RecordingError('interrupted')) } catch { /* 回调异常不外抛 */ }
      }
      this.recorder.start()
    } catch (error) {
      await this.dispose()
      throw error
    }
  }

  /** 当前实测音量 RMS（0~1；波形条高度）。 */
  level(): number {
    if (!this.analyser) return 0
    this.analyser.getByteTimeDomainData(this.samples as unknown as Uint8Array<ArrayBuffer>)
    let sum = 0
    for (const sample of this.samples) sum += sample * sample
    return Math.sqrt(sum / this.samples.length)
  }

  /** 结束采集：解码 → 原生重采样 16kHz → WAV 字节。 */
  async stop(): Promise<Uint8Array<ArrayBuffer>> {
    const recorder = this.recorder
    const context = this.context
    if (!recorder || !context || recorder.state !== 'recording') {
      await this.dispose()
      throw new RecordingError('empty')
    }
    try {
      await new Promise<void>((resolve, reject) => {
        recorder.onstop = () => { resolve() }
        recorder.onerror = () => { reject(new RecordingError('empty')) }
        recorder.stop()
      })
      this.stream?.getTracks().forEach((track) => { track.stop() })
      this.lifetime.signal.throwIfAborted()
      const blob = new Blob(this.chunks, { type: recorder.mimeType })
      if (blob.size === 0) throw new RecordingError('empty')
      const decoded = await context.decodeAudioData(await blob.arrayBuffer())
      this.lifetime.signal.throwIfAborted()
      // 原生重采样（不引音频转码依赖；截断计时器超shoot 到 Host 上限）
      const offline = new OfflineAudioContext(
        1, Math.max(1, Math.floor(Math.min(decoded.duration, MAX_RECORDING_SECONDS) * 16000)), 16000,
      )
      const source = offline.createBufferSource()
      source.buffer = decoded
      source.connect(offline.destination)
      source.start()
      const resampled = await offline.startRendering()
      this.lifetime.signal.throwIfAborted()
      return encodeWave(resampled.getChannelData(0))
    } finally {
      await this.dispose()
    }
  }

  /** 丢弃录音（取消/Escape/页面隐藏）。 */
  async cancel(): Promise<void> {
    this.lifetime.abort()
    if (this.disposal) return this.disposal
    await this.dispose().catch(() => undefined)
  }

  /** 释放全部音频资源（幂等；所有权持续到 AudioContext 关闭）。 */
  async dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.lifetime.abort()
      this.stream?.getTracks().forEach((track) => { track.stop() })
      const recorder = this.recorder
      if (recorder && recorder.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          recorder.onstop = () => { resolve() }
          recorder.stop()
        }).catch(() => undefined)
      }
      await this.context?.close().catch(() => undefined)
    })()
    return this.disposal
  }
}
