/**
 * 语音输入 IPC（2026-10-05 语音批 A 线；四层链路第 2 层）。
 *
 * 语音输入四通道（invoke，轮询制无推送）与本地通知播报：
 *   SPEECH_CATALOG —— 就绪快照 + 准备进度（渲染端 500ms 轮询）；
 *   SPEECH_PREPARE —— 启动/加入模型准备（幂等 join，239MB INT8 首次下载）；
 *   SPEECH_CANCEL_PREPARATION —— 取消准备（已校验文件保留）；
 *   SPEECH_TRANSCRIBE —— base64 WAV → 文本（内核纪律：未就绪即拒，绝不隐式下载）。
 *   NOTIFICATION_SPEAK —— 受限文字/音量 → Windows 本地中文播报，无需识别模型。
 *
 * 复用内核单例 speechService()；音频字节只在内存中流转（对齐 DSH 隐私语义，
 * 识别不写 session 事件，提交与否由用户拥有）。
 */
import type { BrowserWindow, IpcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/types'
import type { SpeechCancelPreparationResult, SpeechCatalogResult, SpeechPrepareResult, SpeechTranscribeInput, SpeechTranscribeResult } from '../../shared/types'
import { extractRequestId, requireFields, safeInvoke } from './shared'
import { speechService } from '../platform/speech/speech-service'
import { speakNotification } from '../platform/speech/notification-speech'

/** 单条录音上限（对齐内核 maxAudioBytes 4MB；base64 膨胀 4/3 后的字符上限）。 */
const MAX_WAV_BASE64_CHARS = Math.ceil(4 * 1024 * 1024 * 4 / 3)
const LANGUAGE_WHITELIST = new Set(['auto', 'zh', 'en', 'yue', 'ja', 'ko'])

export function registerSpeechIpc(ipcMain: IpcMain, _mainWindow: BrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_SPEAK, async (_event, payload: unknown) => safeInvoke(extractRequestId(payload), async () => {
    const input = requireFields<{ request_id: string; text: unknown; volume: unknown }>(payload, ['text', 'volume'])
    return speakNotification(input.text, input.volume)
  }))
  ipcMain.handle(IPC_CHANNELS.SPEECH_CATALOG, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const snapshot = speechService().catalog()
      const result: SpeechCatalogResult = {
        ready: snapshot.ready,
        preparation: {
          running: snapshot.preparation.running,
          current_file: snapshot.preparation.currentFile,
          received_bytes: snapshot.preparation.receivedBytes,
          total_bytes: snapshot.preparation.totalBytes,
          failure: snapshot.preparation.failure === null ? null : {
            file: snapshot.preparation.failure.file,
            source: snapshot.preparation.failure.source,
            reason: snapshot.preparation.failure.reason,
          },
        },
      }
      return result
    })
  })

  ipcMain.handle(IPC_CHANNELS.SPEECH_PREPARE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      void speechService().prepare()
      const result: SpeechPrepareResult = { started: true }
      return result
    })
  })

  ipcMain.handle(IPC_CHANNELS.SPEECH_CANCEL_PREPARATION, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      await speechService().cancelPreparation()
      const result: SpeechCancelPreparationResult = { cancelled: true }
      return result
    })
  })

  ipcMain.handle(IPC_CHANNELS.SPEECH_TRANSCRIBE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SpeechTranscribeInput>(payload, ['wav_base64', 'language'])
      if (typeof input.wav_base64 !== 'string' || input.wav_base64.length > MAX_WAV_BASE64_CHARS) {
        throw new Error('录音超长（上限约 2 分钟）')
      }
      if (!LANGUAGE_WHITELIST.has(input.language)) throw new Error(`不支持的语言: ${input.language}`)
      const bytes = Buffer.from(input.wav_base64, 'base64')
      const transcript = await speechService().transcribe(new Uint8Array(bytes), input.language)
      const result: SpeechTranscribeResult = {
        text: transcript.text,
        audio_seconds: transcript.audioSeconds,
        inference_seconds: transcript.inferenceSeconds,
      }
      return result
    })
  })
}
