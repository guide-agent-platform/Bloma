/**
 * 语音录音生命周期 hook（2026-10-06 波形批：录音态输入行变形的控制器）。
 *
 * 职责：录音启停/取消/转写全流程 + 就绪检查/准备触发（与 prepare 卡协同）；
 * 录音实例留在 ref（rAF 读 amplitude 不触发 React 重渲染），phase/elapsed 走 state。
 * 消费者：ChatPanel（条件渲染录音面板/正常输入行）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpeechCatalogResult } from '../../../shared/types'
import { Recording, RecordingError, audioBase64 } from '../../lib/speech/audio'

export type VoicePhase = 'idle' | 'recording' | 'transcribing'

export interface VoiceRecorder {
  phase: VoicePhase
  /** 录音已进行的秒数（录音态计时显示；1s 粒度）。 */
  elapsedSeconds: number
  /** 错误提示（一次性，展示后可 clear）。 */
  error: string | null
  /** 首次模型下载准备卡开关与快照（500ms 轮询）。 */
  prepOpen: boolean
  catalog: SpeechCatalogResult | null
  /** 当前录音实例（波形组件 rAF 读 amplitude；仅 recording 态非空）。 */
  recordingRef: { current: Recording | undefined }
  begin: () => Promise<void>
  finish: () => Promise<void>
  discard: () => Promise<void>
  clearError: () => void
  closePrep: () => void
  retryPrepare: () => void
}

export function useVoiceRecorder(onInsertText: (text: string) => void): VoiceRecorder {
  const [phase, setPhase] = useState<VoicePhase>('idle')
  const [elapsedSeconds, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [prepOpen, setPrepOpen] = useState(false)
  const [catalog, setCatalog] = useState<SpeechCatalogResult | null>(null)
  const recordingRef = useRef<Recording | undefined>(undefined)
  const startedAtRef = useRef(0)

  // 录音计时（1s interval，仅录音态）
  useEffect(() => {
    if (phase !== 'recording') return
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000))
    }, 1000)
    return () => { clearInterval(timer) }
  }, [phase])

  // 卸载即丢弃录音并释放资源
  useEffect(() => {
    return () => { void recordingRef.current?.cancel() }
  }, [])

  const refreshCatalog = useCallback(async (): Promise<SpeechCatalogResult | null> => {
    const api = window.electronAPI?.speech
    if (!api) return null
    const response = await api.catalog({ request_id: `speech-catalog-${Date.now()}` })
    if (!response.ok) return null
    setCatalog(response.data)
    return response.data
  }, [])

  const startPrepare = useCallback(async () => {
    await window.electronAPI?.speech?.prepare({ request_id: `speech-prepare-${Date.now()}` }).catch(() => undefined)
  }, [])

  const begin = useCallback(async () => {
    setError(null)
    const snapshot = await refreshCatalog()
    if (!snapshot) { setError('语音服务不可用'); return }
    if (!snapshot.ready) { setPrepOpen(true); void startPrepare(); return }
    const recording = new Recording()
    recordingRef.current = recording
    try {
      await recording.start((recordingError: RecordingError) => { setError(humanize(recordingError)) })
      startedAtRef.current = Date.now()
      setElapsed(0)
      setPhase('recording')
    } catch (startError) {
      recordingRef.current = undefined
      setError(humanize(startError))
    }
  }, [refreshCatalog, startPrepare])

  const transcribe = useCallback(async () => {
    setPhase('transcribing')
    try {
      const wav = await recordingRef.current?.stop()
      recordingRef.current = undefined
      if (!wav) return
      const response = await window.electronAPI?.speech?.transcribe({
        request_id: `speech-transcribe-${Date.now()}`,
        wav_base64: audioBase64(wav),
        language: 'auto',
      })
      if (!response) { setError('语音服务不可用'); return }
      if (!response.ok) { setError(friendlyIpcError(response.error)); return }
      const text = response.data.text.trim()
      if (text) onInsertText(text)
      else setError('没有识别到语音内容')
    } catch (stopError) {
      setError(humanize(stopError))
    } finally {
      setPhase('idle')
      setElapsed(0)
    }
  }, [onInsertText])

  const finish = useCallback(async () => {
    if (phase !== 'recording') return
    await transcribe()
  }, [phase, transcribe])

  const discard = useCallback(async () => {
    const recording = recordingRef.current
    recordingRef.current = undefined
    setPhase('idle')
    setElapsed(0)
    await recording?.cancel()
  }, [])

  // 录音中 Escape 丢弃（对齐 DSH 语义）
  useEffect(() => {
    if (phase !== 'recording') return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); void discard() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [phase, discard])

  // 准备卡打开时轮询进度（500ms；就绪即收起）
  useEffect(() => {
    if (!prepOpen) return
    let alive = true
    const timer = setInterval(async () => {
      const snapshot = await refreshCatalog()
      if (alive && snapshot?.ready === true) setPrepOpen(false)
    }, 500)
    return () => { alive = false; clearInterval(timer) }
  }, [prepOpen, refreshCatalog])

  return {
    phase, elapsedSeconds, error, prepOpen, catalog, recordingRef,
    begin, finish, discard,
    clearError: () => { setError(null) },
    closePrep: () => { setPrepOpen(false) },
    retryPrepare: () => { setError(null); void startPrepare() },
  }
}

function humanize(error: unknown): string {
  if (error instanceof RecordingError) {
    const hints: Record<RecordingError['kind'], string> = {
      unavailable: '当前环境不支持麦克风采集',
      permission: '麦克风权限被拒绝（请在系统设置中允许 Bloma 使用麦克风）',
      empty: '没有录到内容，请再试一次',
      cancelled: '已取消录音',
      interrupted: '录音被系统中断，请重试',
    }
    return hints[error.kind]
  }
  return '录音失败，请重试'
}

function friendlyIpcError(error: { message?: string }): string {
  if (error.message?.includes('not ready')) return '语音模型还没准备好，请先点击下载模型'
  if (error.message?.includes('queue full')) return '识别排队已满，请稍候再试'
  if (error.message?.includes('timeout')) return '识别超时，请缩短录音后重试'
  return `语音识别失败：${error.message ?? '未知错误'}`
}
