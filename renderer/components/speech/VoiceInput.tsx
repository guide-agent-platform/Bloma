/**
 * 语音输入按钮（2026-10-05 语音批 A 线；录音/波形/转写/准备卡，独立组件不增 ChatPanel 行数）。
 *
 * 状态机：idle → recording（实测波形）→ transcribing → idle；模型未就绪时弹准备卡
 * （首次下载 239MB INT8，进度轮询制 SPEECH_CATALOG 500ms；失败分类 + 重试）。
 * 语义对齐 DSH：转写结果只回填输入框草稿（onInsertText），不自动发送；
 * 录音中 Escape / 组件卸载即丢弃；识别不启动会话事件。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { SpeechCatalogResult } from '../../../shared/types'
import { IconMic, IconStop } from '../icons'
import { MAX_RECORDING_SECONDS, Recording, RecordingError, audioBase64 } from '../../lib/speech/audio'

type Phase = 'idle' | 'recording' | 'transcribing'

interface VoiceInputProps {
  /** 转写文字回填（ChatPanel setInputValue；不自动发送）。 */
  onInsertText: (text: string) => void
  disabled?: boolean
}

const FAILURE_HINTS: Record<string, string> = {
  network: '网络问题，请检查网络后重试',
  http: '下载源暂时不可用，可重试',
  integrity: '文件校验失败，已自动换源重试仍失败，可重试',
  cancelled: '已取消准备',
  storage: '磁盘空间或权限问题',
  unknown: '未知错误，可重试',
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

/** 麦克风按钮主体。 */
export const VoiceInput: React.FC<VoiceInputProps> = ({ onInsertText, disabled }) => {
  const [phase, setPhase] = useState<Phase>('idle')
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [prepOpen, setPrepOpen] = useState(false)
  const [catalog, setCatalog] = useState<SpeechCatalogResult | null>(null)
  const recordingRef = useRef<Recording | undefined>(undefined)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    return () => {
      // 卸载即丢弃录音并释放资源（所有权到 AudioContext 关闭为止）
      cancelAnimationFrame(rafRef.current)
      void recordingRef.current?.cancel()
    }
  }, [])

  const pullLevel = useCallback(() => {
    const recording = recordingRef.current
    if (!recording) return
    setLevel(recording.level())
    rafRef.current = requestAnimationFrame(pullLevel)
  }, [])

  const refreshCatalog = useCallback(async (): Promise<SpeechCatalogResult | null> => {
    const api = window.electronAPI?.speech
    if (!api) return null
    const response = await api.catalog({ request_id: `speech-catalog-${Date.now()}` })
    if (!response.ok) return null
    setCatalog(response.data)
    return response.data
  }, [])

  const beginRecording = useCallback(async () => {
    setError(null)
    const snapshot = await refreshCatalog()
    if (!snapshot) { setError('语音服务不可用'); return }
    if (!snapshot.ready) { setPrepOpen(true); void startPrepare(); return }
    const recording = new Recording()
    recordingRef.current = recording
    try {
      await recording.start((recordingError: RecordingError) => { setError(humanizeError(recordingError)) })
      setPhase('recording')
      rafRef.current = requestAnimationFrame(pullLevel)
    } catch (startError) {
      recordingRef.current = undefined
      setError(humanizeError(startError))
    }
  }, [pullLevel, refreshCatalog])

  const startPrepare = useCallback(async () => {
    await window.electronAPI?.speech?.prepare({ request_id: `speech-prepare-${Date.now()}` }).catch(() => undefined)
  }, [])

  const finishRecording = useCallback(async (mode: 'transcribe' | 'discard') => {
    cancelAnimationFrame(rafRef.current)
    const recording = recordingRef.current
    recordingRef.current = undefined
    if (!recording) { setPhase('idle'); return }
    if (mode === 'discard') {
      setPhase('idle')
      await recording.cancel()
      return
    }
    setPhase('transcribing')
    try {
      const wav = await recording.stop()
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
      setError(humanizeError(stopError))
    } finally {
      setPhase('idle')
      setLevel(0)
    }
  }, [onInsertText])

  // 录音中 Escape 丢弃（对齐 DSH：取消/隐藏页面丢弃录音）
  useEffect(() => {
    if (phase !== 'recording') return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); void finishRecording('discard') }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [phase, finishRecording])

  // 准备卡打开时轮询进度（500ms；关闭即停）
  useEffect(() => {
    if (!prepOpen) return
    let alive = true
    const timer = setInterval(async () => {
      const snapshot = await refreshCatalog()
      if (alive && snapshot?.ready === true) setPrepOpen(false)
    }, 500)
    return () => { alive = false; clearInterval(timer) }
  }, [prepOpen, refreshCatalog])

  const handleClick = (): void => {
    if (phase === 'recording') void finishRecording('transcribe')
    else if (phase === 'idle') void beginRecording()
  }

  const barHeight = phase === 'recording' ? 4 + Math.min(level * 220, 22) : 0

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={handleClick}
        disabled={disabled || phase === 'transcribing'}
        data-ai-id="voice-input-toggle"
        aria-label={phase === 'recording' ? '停止录音并转写' : '语音输入'}
        title={
          phase === 'recording' ? '点击停止并转写（Esc 取消）'
          : phase === 'transcribing' ? '正在识别语音…'
          : '语音输入'
        }
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 36, height: 36, borderRadius: 'var(--radius-full)',
          border: 'none', flexShrink: 0,
          background: phase === 'recording' ? 'var(--color-danger, #dc2626)' : 'transparent',
          color: phase === 'recording' ? 'var(--white, #fff)' : 'var(--gray-400, #9ca3af)',
          cursor: disabled || phase === 'transcribing' ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : phase === 'transcribing' ? 0.6 : 1,
          transition: 'all var(--transition-fast, 150ms)',
        }}
      >
        {phase === 'recording'
          ? (
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
              <span style={{ width: 12, height: Math.max(3, Math.round(barHeight / 2)), borderRadius: 2, background: 'currentColor', transition: 'height 80ms linear' }} />
            </span>
          )
          : <IconMic size={16} />}
      </button>
      {phase === 'transcribing' && (
        <span
          aria-label="语音识别中"
          style={{
            position: 'absolute', inset: 0, borderRadius: 'var(--radius-full, 50%)',
            border: '2px solid transparent', borderTopColor: 'var(--color-quick, #7c3aed)',
            animation: 'voice-spin 0.8s linear infinite',
          }}
        />
      )}
      {(error || prepOpen) && (
        <div
          data-ai-id="voice-input-popover"
          style={{
            position: 'absolute', bottom: 44, right: 0, zIndex: 40,
            width: 268, padding: 'var(--space-3, 12px)',
            borderRadius: 'var(--radius-lg, 12px)',
            background: 'var(--color-surface, #fff)',
            boxShadow: '0 12px 32px -8px rgba(0,0,0,0.25)',
            border: '1px solid var(--gray-200, #e5e7eb)',
            fontSize: 'var(--font-size-sm, 13px)', color: 'var(--color-text, #111)',
          }}
        >
          {error && <div style={{ marginBottom: prepOpen ? 8 : 0, color: 'var(--color-danger, #dc2626)' }}>{error}</div>}
          {prepOpen && catalog && (
            <PreparationCard catalog={catalog} onRetry={() => { setError(null); void startPrepare() }} onClose={() => setPrepOpen(false)} />
          )}
        </div>
      )}
      <style>{'@keyframes voice-spin { to { transform: rotate(360deg) } }'}</style>
    </div>
  )
}

/** 首次模型下载卡（进度条 + 失败重试）。 */
const PreparationCard: React.FC<{ catalog: SpeechCatalogResult; onRetry: () => void; onClose: () => void }> = ({ catalog, onRetry, onClose }) => {
  const prep = catalog.preparation
  const percent = prep.total_bytes > 0 ? Math.min(100, Math.round((prep.received_bytes / prep.total_bytes) * 100)) : 0
  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        {prep.running ? '正在准备语音模型（仅首次）…' : catalog.ready ? '语音模型已就绪' : '语音模型未就绪'}
      </div>
      {prep.running && (
        <>
          <div style={{ marginBottom: 4, color: 'var(--gray-500, #6b7280)' }}>
            {prep.current_file ?? '检查缓存'}：{formatBytes(prep.received_bytes)} / {formatBytes(prep.total_bytes)}（{percent}%）
          </div>
          <div style={{ height: 6, borderRadius: 3, background: 'var(--gray-200, #e5e7eb)', overflow: 'hidden', marginBottom: 8 }}>
            <div style={{ width: `${percent}%`, height: '100%', background: 'var(--color-quick, #7c3aed)', transition: 'width 300ms linear' }} />
          </div>
        </>
      )}
      {prep.failure && !prep.running && (
        <div style={{ marginBottom: 8, color: 'var(--color-danger, #dc2626)' }}>
          {FAILURE_HINTS[prep.failure.reason] ?? FAILURE_HINTS.unknown}
        </div>
      )}
      {!prep.running && !catalog.ready && (
        <button
          onClick={onRetry}
          data-ai-id="voice-prepare-retry"
          style={{
            padding: '6px 12px', borderRadius: 'var(--radius-full, 999px)', border: 'none',
            background: 'var(--color-quick, #7c3aed)', color: '#fff', cursor: 'pointer', fontSize: 12,
          }}
        >
          {prep.failure ? '重试下载' : '下载模型（约 239MB）'}
        </button>
      )}
      <button
        onClick={onClose}
        style={{
          marginLeft: 8, padding: '6px 10px', borderRadius: 'var(--radius-full, 999px)',
          border: '1px solid var(--gray-200, #e5e7eb)', background: 'transparent',
          cursor: 'pointer', fontSize: 12,
        }}
      >
        收起
      </button>
    </div>
  )
}

function humanizeError(error: unknown): string {
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

function friendlyIpcError(error: { message?: string; code?: string }): string {
  if (error.message?.includes('not ready')) return '语音模型还没准备好，请先点击下载模型'
  if (error.message?.includes('queue full')) return '识别排队已满，请稍候再试'
  if (error.message?.includes('timeout')) return '识别超时，请缩短录音后重试'
  return `语音识别失败：${error.message ?? '未知错误'}`
}

/** 转写中长录音的软提示（超过 110s 建议停止——Host 硬上限 120s 截断）。 */
export const RECORDING_SOFT_LIMIT_SECONDS = MAX_RECORDING_SECONDS - 10
