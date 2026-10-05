/**
 * 语音输入按钮（2026-10-06 波形批重构：录音生命周期移入 useVoiceRecorder hook，
 * 录音态 UI 由 ChatPanel 层的 VoiceRecordingBar 承担；本组件只剩按钮/准备卡/错误）。
 */

import React from 'react'
import type { SpeechCatalogResult } from '../../../shared/types'
import { IconMic } from '../icons'
import type { VoiceRecorder } from './useVoiceRecorder'

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

export const VoiceInput: React.FC<{ voice: VoiceRecorder }> = ({ voice }) => {
  const transcribing = voice.phase === 'transcribing'
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => { void voice.begin() }}
        disabled={transcribing}
        data-ai-id="voice-input-toggle"
        aria-label={transcribing ? '正在识别语音' : '语音输入'}
        title={transcribing ? '正在识别语音…' : '语音输入'}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 36, height: 36, borderRadius: 'var(--radius-full, 50%)',
          border: 'none', flexShrink: 0, background: 'transparent',
          color: 'var(--gray-400, #9ca3af)',
          cursor: transcribing ? 'default' : 'pointer',
          opacity: transcribing ? 0.6 : 1,
          transition: 'all var(--transition-fast, 150ms)',
        }}
      >
        <IconMic size={16} />
      </button>
      {transcribing && (
        <span
          aria-label="语音识别中"
          style={{
            position: 'absolute', inset: 0, borderRadius: 'var(--radius-full, 50%)',
            border: '2px solid transparent', borderTopColor: 'var(--color-quick, #7c3aed)',
            animation: 'voice-spin 0.8s linear infinite', pointerEvents: 'none',
          }}
        />
      )}
      {(voice.error || voice.prepOpen) && (
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
          {voice.error && <div style={{ marginBottom: voice.prepOpen ? 8 : 0, color: 'var(--color-danger, #dc2626)' }}>{voice.error}</div>}
          {voice.prepOpen && voice.catalog && (
            <PreparationCard catalog={voice.catalog} onRetry={voice.retryPrepare} onClose={voice.closePrep} />
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
