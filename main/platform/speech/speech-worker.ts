/**
 * 语音推理 worker（utilityProcess 入口；2026-10-05 语音批）。
 *
 * 推理核心搬自 DSH MIT 源码 packages/experimental/speech-to-text-sensevoice/src/inference.ts
 * （SenseVoice OfflineRecognizer + Silero VAD 分段，约 70 行核心逻辑）；
 * 传输层从 DSH 的「环回 HTTP + Bearer token」简化为 utilityProcess 消息协议
 * （无网络面、无端口、结构化克隆直传，父进程持有生命周期——安全性同构且更简）。
 *
 * 协议（父 → 子）：
 * - { type: 'load', model, tokens, vad, threads }  加载模型（唯一一次，加载完才回话）
 * - { type: 'transcribe', id, wav: Uint8Array, language }  转写一段完整 WAV
 * 协议（子 → 父）：
 * - { type: 'loaded' } | { type: 'load-error', message }
 * - { type: 'result', id, ok: true, text, audioSeconds, inferenceSeconds } | { type: 'result', id, ok: false, message }
 *
 * 与 DSH 相同的纪律：串行执行（一次一条）；语言提示逐条设置；VAD 每条录音 reset；
 * VAD 输出复制缓冲（Electron V8 内存笼不接受 external buffer，front(false)）。
 */

import { createRequire } from 'node:module'

/** 入参类型（与父进程 speech-service 的消息构造保持同步）。 */
interface LoadMessage { type: 'load'; model: string; tokens: string; vad: string; threads: number }
interface TranscribeMessage { type: 'transcribe'; id: number; wav: Uint8Array; language: string }
type Inbound = LoadMessage | TranscribeMessage

interface Stream { acceptWaveform(audio: { samples: Float32Array; sampleRate: number }): void }
interface Recognizer {
  createStream(): Stream
  setConfig(config: object): void
  decode(stream: Stream): void
  getResult(stream: Stream): { text: string }
}
interface Detector {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  front(externalBuffer: false): { samples: Float32Array }
  pop(): void
  reset(): void
  flush(): void
}
interface Sherpa {
  OfflineRecognizer: new (config: object) => Recognizer
  Vad: new (config: object, bufferSeconds: number) => Detector
}

/** 分段参数（对齐 DSH config 默认值：段长 30s / 阈值 0.5 / 最短语音 0.25s / 最短静音 0.5s）。 */
const SEGMENT_SECONDS = 30
const VAD_THRESHOLD = 0.5
const MIN_SPEECH_SECONDS = 0.25
const MIN_SILENCE_SECONDS = 0.5

/** WAV 输入校验（44 字节 PCM16 单声道 16kHz 头 + 语言枚举；无效输入不加载模型即拒）。 */
function validateInput(wav: Uint8Array, language: string): number {
  const languages = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']
  if (!languages.includes(language)) throw new Error(`unsupported language: ${language}`)
  if (wav.byteLength < 46 || wav.byteLength % 2 !== 0) throw new Error(`invalid WAV length: ${wav.byteLength}`)
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  if (view.getUint32(0, true) !== 0x46464952 /* RIFF */ || view.getUint32(8, true) !== 0x45564157 /* WAVE */) {
    throw new Error('not a RIFF/WAVE file')
  }
  return (wav.byteLength - 44) / 2 / 16000
}

function createTranscriber(config: { model: string; tokens: string; vad: string; threads: number }) {
  // sherpa-onnx-node 是 CJS Node-API 包且无类型声明；与 DSH 相同用 createRequire 桥接。
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node') as Sherpa
  const nativeConfig = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: config.model, language: 'auto', useInverseTextNormalization: 1 },
      tokens: config.tokens, numThreads: config.threads, provider: 'cpu', debug: 0,
    },
  }
  const recognizer = new sherpa.OfflineRecognizer(nativeConfig)
  const detector = new sherpa.Vad({
    sileroVad: {
      model: config.vad, threshold: VAD_THRESHOLD,
      minSilenceDuration: MIN_SILENCE_SECONDS, minSpeechDuration: MIN_SPEECH_SECONDS,
      maxSpeechDuration: SEGMENT_SECONDS, windowSize: 512,
    },
    sampleRate: 16000, numThreads: config.threads, provider: 'cpu', debug: 0,
  }, SEGMENT_SECONDS + MIN_SILENCE_SECONDS + 1)

  return (wav: Uint8Array, language: string) => {
    const audioSeconds = validateInput(wav, language)
    const pcm = new DataView(wav.buffer, wav.byteOffset + 44, wav.byteLength - 44)
    const samples = Float32Array.from({ length: pcm.byteLength / 2 }, (_, i) => pcm.getInt16(i * 2, true) / 32768)
    nativeConfig.modelConfig.senseVoice.language = language
    recognizer.setConfig(nativeConfig)
    detector.reset()
    const started = performance.now()
    const texts: string[] = []
    const drain = (): void => {
      while (!detector.isEmpty()) {
        // Electron V8 内存笼要求复制缓冲（DSH 同款，front(false) 即复制语义）。
        const segment = detector.front(false)
        const stream = recognizer.createStream()
        stream.acceptWaveform({ sampleRate: 16000, samples: segment.samples })
        recognizer.decode(stream)
        texts.push(recognizer.getResult(stream).text.trim())
        detector.pop()
      }
    }
    for (let offset = 0; offset < samples.length; offset += 512) {
      detector.acceptWaveform(samples.subarray(offset, offset + 512))
      drain()
    }
    detector.flush()
    drain()
    return {
      text: texts.filter(Boolean).join(' ').trim(),
      audioSeconds,
      inferenceSeconds: (performance.now() - started) / 1000,
    }
  }
}

let transcriber: ((wav: Uint8Array, language: string) => { text: string; audioSeconds: number; inferenceSeconds: number }) | undefined
let loaded = false

process.parentPort.on('message', (event: { data: unknown }) => {
  const message = event.data as Inbound
  if (message.type === 'load') {
    if (loaded) return
    try {
      transcriber = createTranscriber(message)
      loaded = true
      process.parentPort.postMessage({ type: 'loaded' })
    } catch (error) {
      process.parentPort.postMessage({ type: 'load-error', message: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (message.type === 'transcribe') {
    if (!transcriber) {
      process.parentPort.postMessage({ type: 'result', id: message.id, ok: false, message: 'worker not loaded' })
      return
    }
    try {
      const result = transcriber(message.wav, message.language)
      process.parentPort.postMessage({ type: 'result', id: message.id, ok: true, ...result })
    } catch (error) {
      // 推理失败按 DSH 纪律回收进程：父进程收到 ok:false 后会 kill 重建。
      process.parentPort.postMessage({ type: 'result', id: message.id, ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  }
})
