/**
 * 录音态输入行面板（2026-10-06 波形批；ChatPanel 录音态整体替换 textarea 区）。
 *
 * 布局：[呼吸红点 + 计时] —— 波形（占满剩余）—— [取消] [完成]。
 * 视觉沿用 Bloma 输入行胶囊容器（由 ChatPanel 外层提供），本组件只填内容。
 */

import React from 'react'
import type { VoiceRecorder } from './useVoiceRecorder'
import { Waveform } from './Waveform'

function formatElapsed(seconds: number): string {
  const minute = Math.floor(seconds / 60)
  const second = seconds % 60
  return `${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
}

export const VoiceRecordingBar: React.FC<{ voice: VoiceRecorder; maxSeconds: number }> = ({ voice, maxSeconds }) => {
  const overLimit = voice.elapsedSeconds >= maxSeconds
  return (
    <div
      data-ai-id="voice-recording-bar"
      style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, height: 36 }}
    >
      {/* 呼吸红点 + 计时 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span
          aria-hidden
          style={{
            width: 9, height: 9, borderRadius: '50%', background: 'var(--color-danger, #dc2626)',
            animation: 'voice-breathe 1.6s ease-in-out infinite',
          }}
        />
        <span
          style={{
            fontSize: 'var(--font-size-sm, 13px)', fontVariantNumeric: 'tabular-nums',
            color: overLimit ? 'var(--color-danger, #dc2626)' : 'var(--color-text, #111)',
            fontWeight: 600, minWidth: 44,
          }}
        >
          {formatElapsed(voice.elapsedSeconds)}
        </span>
      </div>

      {/* 波形 */}
      <div style={{ flex: 1, height: '100%', minWidth: 60 }}>
        <Waveform recording={voice.recordingRef.current} />
      </div>

      {/* 软上限提示（120s 硬截断前 10s 变红提示） */}
      {overLimit && (
        <span style={{ fontSize: 11, color: 'var(--color-danger, #dc2626)', flexShrink: 0 }}>
          接近上限，将自动截断
        </span>
      )}

      {/* 取消（Esc 同效） */}
      <button
        onClick={() => { void voice.discard() }}
        aria-label="取消录音"
        title="取消录音（Esc）"
        data-ai-id="voice-recording-cancel"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 30, height: 30, borderRadius: 'var(--radius-full, 50%)',
          border: '1px solid var(--gray-200, #e5e7eb)', background: 'transparent',
          color: 'var(--gray-500, #6b7280)', cursor: 'pointer', flexShrink: 0, fontSize: 16,
        }}
      >
        ✕
      </button>

      {/* 完成（停止并转写） */}
      <button
        onClick={() => { void voice.finish() }}
        aria-label="停止录音并转写"
        title="停止录音并转写"
        data-ai-id="voice-recording-done"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 36, height: 36, borderRadius: 'var(--radius-full, 50%)', border: 'none',
          background: 'linear-gradient(135deg, var(--color-quick, #7c3aed), var(--color-quick-bright, #a78bfa))',
          color: 'var(--white, #fff)', cursor: 'pointer', flexShrink: 0,
          boxShadow: '0 4px 12px -2px rgba(124,58,237,0.45)',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
          <path d="M4 12.5 9.5 18 20 6.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <style>{'@keyframes voice-breathe { 0%,100% { opacity: 0.35; transform: scale(0.85) } 50% { opacity: 1; transform: scale(1.15) } }'}</style>
    </div>
  )
}
