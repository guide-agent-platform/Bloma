/**
 * 录音波形可视化（2026-10-06 波形批；Canvas 滚动包络柱，VU 表式平滑）。
 *
 * 设计（业界听写反馈的成熟模式）：
 * - 48 根圆头对称竖条从右往左推进，每 60ms 采一帧麦克风 RMS；
 * - 包络平滑用「快攻慢放」（attack 0.5 / release 0.15，VU 表同款）——
 *   出声瞬间跟手、停顿缓慢回落，无 byte 抖动毛刺；
 * - 活跃区（右侧 1/4）紫色实色，历史柱随位置渐隐；静音时收敛为中线细条；
 * - 全程 rAF + Canvas 直绘（不进 React state，60fps 零重渲染）。
 * 仅在录音态挂载（VoiceRecordingBar 独占），无需冻结/恢复分支。
 */

import React, { useEffect, useRef } from 'react'
import type { Recording } from '../../lib/speech/audio'

const BAR_COUNT = 48
const SAMPLE_INTERVAL_MS = 60
const ATTACK = 0.5
const RELEASE = 0.15
/** 显示增益：安静说话也要有明显起伏（RMS 典型 0.05~0.3，映射到 0.15~1）。 */
const GAIN = 3.2
const ACTIVE_FRACTION = 0.25

export const Waveform: React.FC<{ recording: Recording | undefined }> = ({ recording }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const recordingRef = useRef(recording)
  recordingRef.current = recording

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const bars = new Array<number>(BAR_COUNT).fill(0)
    let envelope = 0
    let frame = 0
    let previousSample = -Infinity

    const resolveStyle = (): { color: string; muted: string } => {
      const styles = getComputedStyle(canvas)
      return {
        color: styles.getPropertyValue('--color-quick').trim() || '#7c3aed',
        muted: styles.getPropertyValue('--gray-300').trim() || '#d1d5db',
      }
    }
    let style = resolveStyle()

    const draw = (now: number): void => {
      // 采样（固定间隔，与帧率解耦）
      if (now - previousSample >= SAMPLE_INTERVAL_MS) {
        previousSample = now
        const raw = recordingRef.current?.amplitude() ?? 0
        const target = Math.min(1, raw * GAIN)
        // 快攻慢放：出声立即响应，停顿平滑回落
        envelope += (target - envelope) * (target > envelope ? ATTACK : RELEASE)
        bars.push(envelope)
        if (bars.length > BAR_COUNT) bars.shift()
        // 尺寸/样式低频自检（容器宽度变化、主题切换）
        if (bars.length % 32 === 0) {
          style = resolveStyle()
          fitCanvas()
        }
      }
      render()
      frame = requestAnimationFrame(draw)
    }

    const fitCanvas = (): void => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const width = Math.max(1, Math.round(rect.width * dpr))
      const height = Math.max(1, Math.round(rect.height * dpr))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const render = (): void => {
      const rect = canvas.getBoundingClientRect()
      const width = rect.width
      const height = rect.height
      const middle = height / 2
      ctx.clearRect(0, 0, width, height)
      const slot = width / BAR_COUNT
      const barWidth = Math.max(2, slot * 0.55)
      for (let index = 0; index < BAR_COUNT; index++) {
        const value = bars[index] ?? 0
        const x = index * slot + (slot - barWidth) / 2
        // 基线最小高度 2px（静音时可见的虚线感）
        const barHeight = Math.max(2, value * (height - 4))
        const recency = index / (BAR_COUNT - 1)
        const isActive = recency >= 1 - ACTIVE_FRACTION
        const opacity = isActive ? 1 : 0.25 + recency * 0.55
        ctx.globalAlpha = opacity
        ctx.fillStyle = value <= 0.02 ? style.muted : style.color
        roundRect(ctx, x, middle - barHeight / 2, barWidth, barHeight, barWidth / 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    const roundRect = (context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void => {
      const radius = Math.min(r, h / 2, w / 2)
      context.beginPath()
      context.moveTo(x + radius, y)
      context.arcTo(x + w, y, x + w, y + h, radius)
      context.arcTo(x + w, y + h, x, y + h, radius)
      context.arcTo(x, y + h, x, y, radius)
      context.arcTo(x, y, x + w, y, radius)
      context.closePath()
    }

    fitCanvas()
    frame = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(frame) }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-label="录音音量波形"
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  )
}
