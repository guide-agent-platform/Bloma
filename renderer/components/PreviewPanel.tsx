import React from 'react'
import { useAtomValue } from 'jotai'
import { RotateCw, Maximize2, Minimize2, Camera, LayoutTemplate, AlertTriangle } from './icons'
import { hasActiveStreamAtom, workflowStageAtom, globalUserErrorAtom } from './atoms'
import type { DomCollectContextResult } from '../../shared/types'

export type PreviewStatus = 'empty' | 'loading' | 'running' | 'error' | 'timeout'

export interface CorrectionPayload {
  elementSelector?: string
  textContent?: string
  position: { x: number; y: number }
  userNote: string
  fallbackMode: boolean
  /** 点击时已收集的 DOM 上下文（真实包围盒 + selector/text），供后端复用、避免二次收集 */
  domContext?: DomCollectContextResult
}

export interface PreviewPanelProps {
  status?: PreviewStatus
  previewUrl?: string
  loadingLabel?: string
  errorLabel?: string
  onRefresh?: () => void
  onToggleFullscreen?: () => void
  onScreenshot?: () => void
  isFullscreen?: boolean
  onCorrectionSubmit?: (payload: CorrectionPayload) => void
  /** 点击预览元素时向主进程收集该元素的 DOM 上下文（用于高亮被选区域，R-CORR-01） */
  onCollectDomContext?: (click: { x: number; y: number }) => Promise<DomCollectContextResult | undefined>
  /** 草图已就绪时的「确认草图 → 生成完整功能」回调（问题 A / P0-1） */
  onConfirmSketch?: () => void
  /** 正在生成 MVP（禁用确认按钮，避免重复提交） */
  confirming?: boolean
  /** iframe 加载失败（沙箱端口失效/进程已死）时回调，供上层进入 error/重连态 */
  onPreviewError?: () => void
  /** U6：ready 阶段的「标记为完成」回调（产品闭环最后一步） */
  onMarkComplete?: () => void
}

/**
 * 预览磁贴（Bento 架构）— 玻璃磁贴内嵌白色"舞台"
 *
 * 包含：玻璃外壳 + 控制栏 + 白色圆角舞台（iframe/状态/点选纠错）
 * 状态：空 / 加载 / 运行 / 错误 / 超时
 */
export const PreviewPanel: React.FC<PreviewPanelProps> = ({
  status = 'empty',
  previewUrl,
  loadingLabel,
  errorLabel,
  onRefresh,
  onToggleFullscreen,
  onScreenshot,
  isFullscreen = false,
  onCorrectionSubmit,
  onCollectDomContext,
  onConfirmSketch,
  confirming = false,
  onPreviewError,
  onMarkComplete,
}) => {
  const hasStream = useAtomValue(hasActiveStreamAtom)
  const stage = useAtomValue(workflowStageAtom)
  const globalError = useAtomValue(globalUserErrorAtom)
  const [showControls, setShowControls] = React.useState(false)
  const [correctionActive, setCorrectionActive] = React.useState(false)
  const [correctionMode, setCorrectionMode] = React.useState(false)
  const [correctionPos, setCorrectionPos] = React.useState({ x: 0, y: 0 })
  const [correctionNote, setCorrectionNote] = React.useState('')
  const [correctionDomContext, setCorrectionDomContext] = React.useState<DomCollectContextResult | null>(null)
  const iframeRef = React.useRef<HTMLIFrameElement>(null)

  const effectiveStatus: PreviewStatus =
    status === 'empty' && (hasStream || ['generating_sketch', 'generating_mvp'].includes(stage))
      ? 'loading'
      : status

  const displayStatus: PreviewStatus =
    effectiveStatus !== 'error' && globalError ? 'error' : effectiveStatus

  const shellStyle: React.CSSProperties = isFullscreen
    ? {
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        padding: 'var(--space-3)',
        background: 'var(--color-surface)',
      }
    : {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
        padding: 'var(--space-3)',
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(var(--glass-blur))',
        WebkitBackdropFilter: 'blur(var(--glass-blur))',
        border: '1px solid var(--glass-border)',
        borderRadius: 'var(--radius-tile)',
        boxShadow: 'var(--shadow-glass)',
      }

  const controlsVisible =
    showControls || displayStatus === 'error' || displayStatus === 'running' || stage === 'sketch_ready'

  return (
    <div
      data-ai-id="preview-panel"
      style={shellStyle}
      onMouseEnter={() => setShowControls(true)}
      onMouseLeave={() => setShowControls(false)}
    >
      {/* 控制栏 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: 'var(--space-1) var(--space-2) var(--space-3)',
          flexShrink: 0,
          opacity: controlsVisible ? 1 : 0,
          pointerEvents: controlsVisible ? 'auto' : 'none',
          height: controlsVisible ? undefined : 0,
          overflow: 'hidden',
          transition: 'opacity var(--transition-fast)',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text-muted)' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-success)', display: 'inline-block' }} />
          预览 · 安全环境
        </span>
        <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
          {stage === 'sketch_ready' && onConfirmSketch && (
            <button
              data-ai-id="confirm-sketch-button"
              onClick={onConfirmSketch}
              disabled={confirming}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-1)',
                height: 30,
                padding: '0 var(--space-4)',
                marginRight: 'var(--space-2)',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 700,
                color: 'var(--white)',
                background: confirming
                  ? 'var(--gray-400)'
                  : 'linear-gradient(135deg, var(--color-quick), var(--color-quick-bright))',
                border: 'none',
                borderRadius: 'var(--radius-full)',
                boxShadow: confirming ? 'none' : '0 4px 12px -2px rgba(124,58,237,0.45)',
                cursor: confirming ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {confirming ? '生成中…' : '生成完整功能'}
            </button>
          )}
          {stage === 'ready' && onMarkComplete && (
            <button
              data-ai-id="mark-complete-button"
              onClick={onMarkComplete}
              title="标记为完成"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-1)',
                height: 30,
                padding: '0 var(--space-4)',
                marginRight: 'var(--space-2)',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 700,
                color: 'var(--white)',
                background: 'linear-gradient(135deg, #10B981, #059669)',
                border: 'none',
                borderRadius: 'var(--radius-full)',
                boxShadow: '0 4px 12px -2px rgba(16,185,129,0.45)',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              标记为完成
            </button>
          )}
          {displayStatus === 'running' && onRefresh && (
            <ControlButton label="刷新" onClick={onRefresh}><RotateCw size={15} /></ControlButton>
          )}
          {/* 点选纠错：默认关闭，开启后才拦截 iframe 点击；否则预览可正常交互 */}
          {displayStatus === 'running' && onCorrectionSubmit && (
            <ControlButton
              label={correctionMode ? '退出点选纠错（预览恢复正常交互）' : '点选纠错：标记预览里不满意的地方'}
              onClick={() => {
                setCorrectionMode((prev) => {
                  if (prev) setCorrectionActive(false)
                  return !prev
                })
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 700, color: correctionMode ? 'var(--color-quick)' : 'var(--color-text-muted)' }}>纠错</span>
            </ControlButton>
          )}
          {onScreenshot && (
            <ControlButton label="截图" onClick={onScreenshot}><Camera size={15} /></ControlButton>
          )}
          {onToggleFullscreen && (
            <ControlButton label={isFullscreen ? '退出全屏' : '全屏'} onClick={onToggleFullscreen}>
              {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </ControlButton>
          )}
        </div>
      </div>

      {/* 白色舞台 */}
      <div
        style={{
          flex: 1,
          position: 'relative',
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden',
          background: 'var(--white)',
          boxShadow: 'inset 0 0 0 1px var(--color-border)',
          minHeight: 0,
        }}
      >
        {displayStatus === 'empty' && <EmptyState />}
        {displayStatus === 'loading' && <LoadingState label={loadingLabel} />}
        {displayStatus === 'running' && previewUrl && (
          <>
            <iframe
              ref={iframeRef}
              src={previewUrl}
              title="软件预览"
              sandbox="allow-scripts allow-forms allow-same-origin"
              onError={onPreviewError}
              style={{ width: '100%', height: '100%', border: 'none', background: 'var(--white)', pointerEvents: correctionActive ? 'none' : 'auto' }}
            />
            {/* 点选纠错透明捕获层：仅在纠错模式开启时盖在 iframe 上方拦截点击 */}
            {correctionMode && onCorrectionSubmit && (
              <div
                data-ai-id="correction-capture-layer"
                title="点击标记不满意的地方"
                style={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: 5,
                  cursor: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><circle cx='12' cy='12' r='10' fill='none' stroke='%23DC2626' stroke-width='2' stroke-dasharray='4 2'/></svg>") 12 12, crosshair`,
                }}
                onClick={(e) => {
                  if (correctionActive) return
                  const stage = e.currentTarget.parentElement
                  if (!stage) return
                  const rect = stage.getBoundingClientRect()
                  const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top }
                  setCorrectionPos(pos)
                  setCorrectionNote('')
                  setCorrectionDomContext(null)
                  setCorrectionActive(true)
                  // R-CORR-01：点击即收集 DOM 上下文用于高亮被选区域；异步回填，失败保持红点回退
                  if (onCollectDomContext) {
                    void onCollectDomContext(pos).then((ctx) => {
                      if (ctx) setCorrectionDomContext(ctx)
                    })
                  }
                }}
              />
            )}
          </>
        )}
        {displayStatus === 'running' && !previewUrl && <LoadingState label="正在准备预览…" />}
        {displayStatus === 'error' && <ErrorState label={errorLabel ?? globalError ?? undefined} onRetry={onRefresh} />}
        {displayStatus === 'timeout' && <TimeoutState onContinueWaiting={onRefresh} />}

        {correctionActive && onCorrectionSubmit && (
          <CorrectionOverlay
            position={correctionPos}
            domContext={correctionDomContext ?? undefined}
            note={correctionNote}
            onNoteChange={setCorrectionNote}
            onSubmit={() => {
              onCorrectionSubmit({
                position: correctionPos,
                userNote: correctionNote.trim(),
                fallbackMode: correctionDomContext ? correctionDomContext.fallback_mode : true,
                domContext: correctionDomContext ?? undefined,
              })
              setCorrectionActive(false)
            }}
            onGuess={() => {
              onCorrectionSubmit({
                position: correctionPos,
                userNote: '',
                fallbackMode: correctionDomContext ? correctionDomContext.fallback_mode : true,
                domContext: correctionDomContext ?? undefined,
              })
              setCorrectionActive(false)
            }}
            onClose={() => setCorrectionActive(false)}
          />
        )}
      </div>
    </div>
  )
}

/* =========================================================================
   ControlButton
   ========================================================================= */

const ControlButton: React.FC<{ label: string; onClick: () => void; children: React.ReactNode }> = ({
  label, onClick, children,
}) => (
  <button
    title={label}
    onClick={onClick}
    style={{
      width: 30, height: 30,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      borderRadius: 'var(--radius-sm)',
      color: 'var(--color-text-muted)',
      transition: 'all var(--transition-fast)',
      cursor: 'pointer',
    }}
    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-muted)'; e.currentTarget.style.color = 'var(--color-text)' }}
    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--color-text-muted)' }}
  >
    {children}
  </button>
)

/* =========================================================================
   States
   ========================================================================= */

const stateWrap: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
  padding: 'var(--space-8)',
  background: 'linear-gradient(135deg, var(--gray-50), var(--violet-50))',
}

const EmptyState: React.FC = () => (
  <div style={stateWrap}>
    <span aria-hidden style={{ width: 68, height: 68, borderRadius: 'var(--radius-md)', background: 'var(--white)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 'var(--space-5)', color: 'var(--color-quick)', boxShadow: 'var(--shadow-md)' }}>
      <LayoutTemplate size={28} />
    </span>
    <p style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--color-text)', marginBottom: 'var(--space-1)' }}>这里将展示你的软件预览</p>
    <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)' }}>告诉我你的想法，我来帮你在右边做出来</p>
  </div>
)

const LoadingState: React.FC<{ label?: string }> = ({ label }) => (
  <div style={stateWrap}>
    <div style={{ width: 42, height: 42, border: '3px solid var(--color-border)', borderTopColor: 'var(--color-quick)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', marginBottom: 'var(--space-5)' }} />
    <p style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--color-text)' }}>{label ?? '正在生成预览…'}</p>
    <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)', marginTop: 'var(--space-1)' }}>这个过程只发生在安全环境里</p>
  </div>
)

const ErrorState: React.FC<{ label?: string; onRetry?: () => void }> = ({ label, onRetry }) => (
  <div style={stateWrap}>
    <span aria-hidden style={{ width: 68, height: 68, borderRadius: 'var(--radius-md)', background: 'var(--color-danger-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 'var(--space-5)', color: 'var(--color-danger)' }}>
      <AlertTriangle size={28} />
    </span>
    <p style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--color-text)', marginBottom: 'var(--space-1)' }}>预览加载失败</p>
    <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)', maxWidth: 320, marginBottom: 'var(--space-5)' }}>{label ?? '我正在换个方式修复，你的内容没有丢失。'}</p>
    {onRetry && (
      <button onClick={onRetry} style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-1)',
        height: 34, padding: '0 var(--space-4)',
        fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--white)',
        background: 'linear-gradient(135deg, var(--color-quick), var(--color-quick-bright))',
        borderRadius: 'var(--radius-full)',
        boxShadow: '0 4px 12px -2px rgba(124,58,237,0.4)',
        cursor: 'pointer', transition: 'all var(--transition-fast)',
      }}>
        重新连接沙箱
      </button>
    )}
  </div>
)

const TimeoutState: React.FC<{ onContinueWaiting?: () => void }> = ({ onContinueWaiting }) => (
  <div style={stateWrap}>
    <p style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--color-text)', marginBottom: 'var(--space-1)' }}>这次花的时间比预期更长</p>
    <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-5)' }}>我还在处理中，你可以先看看已经生成的部分</p>
    {onContinueWaiting && (
      <button onClick={onContinueWaiting} style={{
        height: 34, padding: '0 var(--space-4)',
        fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--white)',
        background: 'linear-gradient(135deg, var(--color-quick), var(--color-quick-bright))',
        borderRadius: 'var(--radius-full)',
        boxShadow: '0 4px 12px -2px rgba(124,58,237,0.4)',
        cursor: 'pointer',
      }}>
        继续等待
      </button>
    )}
  </div>
)

/* =========================================================================
   CorrectionOverlay
   ========================================================================= */

const CorrectionOverlay: React.FC<{
  position: { x: number; y: number }
  domContext?: DomCollectContextResult
  note: string
  onNoteChange: (value: string) => void
  onSubmit: () => void
  onGuess: () => void
  onClose: () => void
}> = ({ position, domContext, note, onNoteChange, onSubmit, onGuess, onClose }) => {
  const markerSize = 24
  const popoverWidth = 260
  const popoverLeft = Math.max(8, Math.min(position.x - popoverWidth / 2, typeof window !== 'undefined' ? window.innerWidth - popoverWidth - 16 : 260))
  const popoverTop = position.y + 36 > (typeof window !== 'undefined' ? window.innerHeight - 190 : 380) ? position.y - 160 : position.y + 22

  // R-CORR-01：命中真实元素（bounding_rect 有效）则高亮该区域；否则回退红点标记
  const region = domContext && !domContext.fallback_mode
    && domContext.bounding_rect.width > 0 && domContext.bounding_rect.height > 0
    ? domContext.bounding_rect
    : undefined

  return (
    <>
      {region && (
        <div data-ai-id="selected-preview-element-highlight" style={{
          position: 'absolute', left: region.x, top: region.y, width: region.width, height: region.height,
          border: '2px solid var(--color-danger)', background: 'rgba(220, 38, 38, 0.10)',
          borderRadius: 2, pointerEvents: 'none', zIndex: 10,
          boxShadow: '0 0 0 4px rgba(220, 38, 38, 0.12)',
        }} />
      )}
      {!region && (
        <div data-ai-id="point-correction-popover" style={{
          position: 'absolute', left: position.x - markerSize / 2, top: position.y - markerSize / 2,
          width: markerSize, height: markerSize, borderRadius: '50%',
          border: '2px solid var(--color-danger)', background: 'rgba(220, 38, 38, 0.14)',
          animation: 'pulse-ring 1.5s ease-in-out infinite', pointerEvents: 'none', zIndex: 10,
        }} />
      )}
      <div role="dialog" aria-modal="true" aria-label="点选纠错" style={{
        position: 'absolute', left: popoverLeft, top: popoverTop, width: popoverWidth,
        padding: 'var(--space-3)',
        background: 'var(--glass-bg-strong)', backdropFilter: 'blur(var(--glass-blur))', WebkitBackdropFilter: 'blur(var(--glass-blur))',
        border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)', zIndex: 20, animation: 'tile-enter 0.2s ease both',
      }}>
        <p style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 'var(--space-2)', color: 'var(--color-text)' }}>这里有什么问题？</p>
        <textarea
          value={note} onChange={(e) => onNoteChange(e.target.value)}
          placeholder="描述你想要怎么改（也可以不填）" rows={2} autoFocus
          style={{
            width: '100%', maxWidth: '100%', boxSizing: 'border-box', resize: 'none', padding: 'var(--space-2)',
            fontSize: 'var(--font-size-sm)', fontFamily: 'inherit', color: 'var(--color-text)',
            background: 'var(--white)', border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)', outline: 'none', lineHeight: 'var(--line-height-base)',
            marginBottom: 'var(--space-2)', transition: 'border-color var(--transition-fast), box-shadow var(--transition-fast)',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--color-focus)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(124,58,237,0.15)' }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit() }
            if (e.key === 'Escape') onClose()
          }}
        />
        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
          <button onClick={onGuess} style={{
            height: 34, padding: '0 var(--space-4)', fontSize: 'var(--font-size-sm)', fontWeight: 600,
            color: 'var(--color-text)', background: 'var(--white)', border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-full)', cursor: 'pointer',
          }}>还没想好</button>
          <button onClick={onSubmit} style={{
            height: 34, padding: '0 var(--space-4)', fontSize: 'var(--font-size-sm)', fontWeight: 600,
            color: 'var(--white)', background: 'linear-gradient(135deg, var(--color-quick), var(--color-quick-bright))',
            borderRadius: 'var(--radius-full)', boxShadow: '0 4px 12px -2px rgba(124,58,237,0.4)', cursor: 'pointer',
          }}>提交</button>
        </div>
      </div>
    </>
  )
}
