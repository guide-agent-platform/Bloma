/** web 线拆除刀3：点选纠错通道退役，类型本地最小化（UI 降级红点模式） */
type DomCollectContextResult = { fallback_mode: boolean; element_selector?: string; text_content?: string; bounding_rect?: { x: number; y: number; width: number; height: number } }
import React from 'react'
import { useAtomValue } from 'jotai'
import { RotateCw, Maximize2, Minimize2, Camera, LayoutTemplate, AlertTriangle } from './icons'
import { hasActiveStreamAtom, workflowStageAtom, globalUserErrorAtom } from './atoms'

export type PreviewStatus = 'empty' | 'loading' | 'running' | 'error'

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

  // 纠错模式下转发滚轮/中键拖拽滚动到跨域预览 iframe：捕获层盖在 iframe 上方会挡住滚动，
  // 这里把增量累积后按帧 flush 给主进程，由主进程 executeJavaScript(window.scrollBy) 越过同源限制滚动预览。
  const scrollPendingRef = React.useRef({ x: 0, y: 0 })
  const scrollRafRef = React.useRef<number | null>(null)
  const middleDragRef = React.useRef({ active: false, lastX: 0, lastY: 0 })
  // 点选时 iframe 的滚动位置（锚点）：弹窗/标记按「当前滚动 - 锚点」反向偏移，跟随内容滚动、相对元素位置不变
  const anchorScrollRef = React.useRef({ x: 0, y: 0 })
  const iframeScrollRef = React.useRef({ x: 0, y: 0 })
  // 滚动请求序号：只应用最新一次结果，避免并发 IPC 乱序返回导致 scrollOffset 回跳
  const scrollSeqRef = React.useRef(0)
  const [scrollOffset, setScrollOffset] = React.useState({ x: 0, y: 0 })

  const flushPreviewScroll = React.useCallback(async () => {
    scrollRafRef.current = null
    const { x, y } = scrollPendingRef.current
    scrollPendingRef.current = { x: 0, y: 0 }
    if (x === 0 && y === 0) return
    // web 线拆除刀3：滚动捕获转发通道退役（旧项目预览随线下线）
    const seq = ++scrollSeqRef.current
    void seq
  }, [])

  const queuePreviewScroll = React.useCallback(
    (dx: number, dy: number) => {
      scrollPendingRef.current.x += dx
      scrollPendingRef.current.y += dy
      if (scrollRafRef.current == null) {
        scrollRafRef.current = requestAnimationFrame(flushPreviewScroll)
      }
    },
    [flushPreviewScroll],
  )

  // 卸载时取消未 flush 的滚动帧，避免在已销毁组件上继续触发
  React.useEffect(() => {
    return () => {
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = null
      }
    }
  }, [])

  // 预览区显示由「是否有可渲染 URL」与「是否活跃生成」驱动，不再信任 status='running'：
  // 历史遗留的 running 无 URL 会抢占初始空态，误显示「正在准备预览」。
  // 空态只在「无 URL 且无活跃生成」时出现；其余准备中状态统一显示「正在准备预览」。
  const effectiveStatus: PreviewStatus = previewUrl
    ? 'running'
    : status === 'error'
      ? 'error'
      : status === 'loading' || hasStream || ['generating_sketch', 'generating_mvp'].includes(stage)
        ? 'loading'
        : 'empty'

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
                onWheel={(e) => {
                  // 滚轮滚动转发：deltaMode 0=像素 / 1=行 / 2=页，统一换算成像素后转给预览；
                  // 弹窗/标记经 scrollOffset 反向偏移跟随滚动，滚轮在纠错模式下始终正常工作。
                  const factor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1
                  queuePreviewScroll(e.deltaX * factor, e.deltaY * factor)
                }}
                onPointerDown={(e) => {
                  // 中键拖拽滚动（替代被捕获层挡住的浏览器原生 autoscroll）
                  if (e.button !== 1) return
                  e.preventDefault()
                  middleDragRef.current = { active: true, lastX: e.clientX, lastY: e.clientY }
                  e.currentTarget.setPointerCapture?.(e.pointerId)
                }}
                onPointerMove={(e) => {
                  if (!middleDragRef.current.active) return
                  const dx = e.clientX - middleDragRef.current.lastX
                  const dy = e.clientY - middleDragRef.current.lastY
                  middleDragRef.current.lastX = e.clientX
                  middleDragRef.current.lastY = e.clientY
                  queuePreviewScroll(dx, dy)
                }}
                onPointerUp={(e) => {
                  if (e.button !== 1) return
                  middleDragRef.current.active = false
                  e.currentTarget.releasePointerCapture?.(e.pointerId)
                }}
                onPointerCancel={() => {
                  middleDragRef.current.active = false
                }}
                onClick={(e) => {
                  // 连续点选：弹窗已打开时再点别处，直接重新锚定弹窗位置，无需先关闭（修复「只能点选一次」）
                  const stage = e.currentTarget.parentElement
                  if (!stage) return
                  const rect = stage.getBoundingClientRect()
                  const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top }
                  setCorrectionPos(pos)
                  setCorrectionNote('')
                  setCorrectionDomContext(null)
                  setCorrectionActive(true)
                  // 锚定：先用最近已知的 iframe 滚动位置归零偏移，再异步读一次精确 scrollY 校准
                  // （覆盖「进入纠错模式前已用原生滚动滚过 iframe」的情况）
                  anchorScrollRef.current = iframeScrollRef.current
                  setScrollOffset({ x: 0, y: 0 })
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
        {displayStatus === 'error' && <ErrorState label={errorLabel ?? globalError ?? undefined} onRetry={onRefresh} />}

        {correctionActive && onCorrectionSubmit && (
          <CorrectionOverlay
            position={correctionPos}
            scrollOffset={scrollOffset}
            domContext={correctionDomContext ?? undefined}
            note={correctionNote}
            onNoteChange={setCorrectionNote}
            onWheelScroll={(dx, dy) => queuePreviewScroll(dx, dy)}
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
    <p style={{ fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--color-text)' }}>{label ?? '正在准备预览…'}</p>
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

/* =========================================================================
   CorrectionOverlay
   ========================================================================= */

const CorrectionOverlay: React.FC<{
  position: { x: number; y: number }
  /** 点选后 iframe 的累计滚动量，弹窗/标记据此反向偏移，跟随内容滚动、相对点选元素位置不变 */
  scrollOffset: { x: number; y: number }
  domContext?: DomCollectContextResult
  note: string
  onNoteChange: (value: string) => void
  /** 弹窗上的滚轮转发（滚动预览 iframe，与捕获层滚轮共用同一滚动链路） */
  onWheelScroll: (dx: number, dy: number) => void
  onSubmit: () => void
  onGuess: () => void
  onClose: () => void
}> = ({ position, scrollOffset, domContext, note, onNoteChange, onWheelScroll, onSubmit, onGuess, onClose }) => {
  const markerSize = 24
  const popoverWidth = 260
  const popoverLeft = Math.max(8, Math.min(position.x - popoverWidth / 2, typeof window !== 'undefined' ? window.innerWidth - popoverWidth - 16 : 260))
  const popoverTop = position.y + 36 > (typeof window !== 'undefined' ? window.innerHeight - 190 : 380) ? position.y - 160 : position.y + 22

  // R-CORR-01：命中真实元素（bounding_rect 有效）则高亮该区域；否则回退红点标记
  const region = domContext && !domContext.fallback_mode
    && domContext.bounding_rect && domContext.bounding_rect.width > 0 && domContext.bounding_rect.height > 0
    ? domContext.bounding_rect
    : undefined

  return (
    <>
      {region && (
        <div data-ai-id="selected-preview-element-highlight" style={{
          position: 'absolute', left: region.x - scrollOffset.x, top: region.y - scrollOffset.y, width: region.width, height: region.height,
          border: '2px solid var(--color-danger)', background: 'rgba(220, 38, 38, 0.10)',
          borderRadius: 2, pointerEvents: 'none', zIndex: 10,
          boxShadow: '0 0 0 4px rgba(220, 38, 38, 0.12)',
        }} />
      )}
      {!region && (
        <div data-ai-id="point-correction-popover" style={{
          position: 'absolute', left: position.x - markerSize / 2 - scrollOffset.x, top: position.y - markerSize / 2 - scrollOffset.y,
          width: markerSize, height: markerSize, borderRadius: '50%',
          border: '2px solid var(--color-danger)', background: 'rgba(220, 38, 38, 0.14)',
          animation: 'pulse-ring 1.5s ease-in-out infinite', pointerEvents: 'none', zIndex: 10,
        }} />
      )}
      <div role="dialog" aria-modal="true" aria-label="点选纠错"
        onWheel={(e) => {
          // 弹窗上的滚轮同样转发为预览滚动（弹窗在捕获层之上，不冒泡到捕获层），
          // 阻止默认行为防止外层工作区被滚动。
          e.preventDefault()
          e.stopPropagation()
          const factor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1
          onWheelScroll(e.deltaX * factor, e.deltaY * factor)
        }}
        style={{
        position: 'absolute', left: popoverLeft - scrollOffset.x, top: popoverTop - scrollOffset.y, width: popoverWidth,
        padding: 'var(--space-3)',
        background: 'var(--glass-bg-strong)', backdropFilter: 'blur(var(--glass-blur))', WebkitBackdropFilter: 'blur(var(--glass-blur))',
        border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)', zIndex: 20, animation: 'tile-enter 0.2s ease both',
      }}>
        <p style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 'var(--space-2)', color: 'var(--color-text)' }}>这里有什么问题？</p>
        <textarea
          value={note} onChange={(e) => onNoteChange(e.target.value)}
          placeholder="描述你想要怎么改（也可以不填）" rows={2} autoFocus
          onWheel={(e) => e.stopPropagation()}
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
          <button onClick={onClose} style={{
            height: 34, padding: '0 var(--space-4)', fontSize: 'var(--font-size-sm)', fontWeight: 600,
            color: 'var(--color-text)', background: 'var(--white)', border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-full)', cursor: 'pointer',
          }}>取消</button>
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
