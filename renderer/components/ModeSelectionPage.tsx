import React from 'react'
import { useAtom } from 'jotai'
import { ModeCard } from './ModeCard'
import { Sparkles } from './icons'
import { projectModeAtom, modeSelectedAtom, currentProjectAtom } from './atoms'

export interface ModeSelectionPageProps {
  /** 从历史项目列表进入时提供返回回调；首次启动时为 undefined */
  onBackToHistory?: () => void
  /** 选择模式后的回调 */
  onModeSelected: (mode: 'quick' | 'longterm') => void
}

export const ModeSelectionPage: React.FC<ModeSelectionPageProps> = ({
  onBackToHistory,
  onModeSelected,
}) => {
  const [, setProjectMode] = useAtom(projectModeAtom)
  const [, setModeSelected] = useAtom(modeSelectedAtom)
  const [, setCurrentProject] = useAtom(currentProjectAtom)
  const [isSelecting, setIsSelecting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // 双建竞态根治（2026-09-19 实证：projects.json 里 42 个未命名 quick 项目成对出现、
  // 同对时间差仅 70-90ms）：state 守卫是异步更新，两次快速触发都在重渲染前读到
  // isSelecting=false 而双双过闸——同步 ref 拦面。仅成功路径不复位（已进入工作区，
  // 组件即将卸载）；失败/异常路径复位允许重试。
  const selectingRef = React.useRef(false)

  const handleSelect = async (mode: 'quick' | 'longterm') => {
    if (selectingRef.current) return // 同步闸：防双击/双触发重复建项目（state 版拦不住）
    selectingRef.current = true
    setIsSelecting(true)
    setError(null)

    try {
      // 通过 IPC 创建项目
      const api = window.electronAPI
      if (!api?.project?.create) {
        setError('当前环境无法创建项目，请通过桌面应用启动。')
        return
      }
      const result = await api.project.create({
        request_id: crypto.randomUUID(),
        mode,
      })
      if (result.ok) {
        setCurrentProject(result.data)
      } else {
        // 项目创建失败：展示用户可见错误，不进入工作区
        const message = result.error?.user_visible_message ?? '项目创建失败，请重试。'
        setError(message)
        return
      }

      setProjectMode(mode)
      setModeSelected(true)
      onModeSelected(mode)
    } catch {
      setError('项目创建失败，请重试。')
    } finally {
      setIsSelecting(false)
      // 同步闸只在创建在途期间拦截（污染对时间差 70-90ms = 在途双触发窗口）；
      // 完成即复位——成功后真实路径已跳转工作区，同页二次触发仅存在于测试/异常场景
      selectingRef.current = false
    }
  }

  return (
    <div
      data-ai-id="mode-selection-page"
      style={{
        position: 'relative',
        zIndex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: 'var(--space-8) var(--space-6)',
        background: 'transparent',
        overflow: 'hidden',
      }}
    >
      {/* 返回按钮 */}
      {onBackToHistory && (
        <button
          onClick={onBackToHistory}
          style={{
            position: 'absolute',
            top: 'var(--space-4)',
            left: 'var(--space-4)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            fontSize: 'var(--font-size-sm)',
            color: 'var(--color-text-muted)',
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-sm)',
            transition: 'background var(--transition-fast)',
            zIndex: 2,
          }}
        >
          ← 返回项目列表
        </button>
      )}

      {/* 错误提示 */}
      {error && (
        <div
          role="alert"
          style={{
            position: 'absolute',
            top: 'var(--space-4)',
            maxWidth: 460,
            padding: 'var(--space-3) var(--space-4)',
            fontSize: 'var(--font-size-sm)',
            color: 'var(--color-danger)',
            background: 'var(--danger-soft, #FEF2F2)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-danger)',
            zIndex: 3,
          }}
        >
          {error}
        </div>
      )}

      {/* Hero */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginBottom: 'var(--space-10)' }}>
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 64,
            fontWeight: 400,
            letterSpacing: 1,
            lineHeight: 1.1,
            padding: '6px 0',
            background: 'linear-gradient(135deg, var(--violet-600), var(--pink-500))',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            marginBottom: 'var(--space-5)',
            animation: 'tile-enter 0.5s ease both',
          }}
        >
          BLOMA
        </span>
        <span
          aria-hidden
          style={{
            width: 64,
            height: 64,
            borderRadius: 'var(--radius-lg)',
            background: 'linear-gradient(135deg, var(--violet-600), var(--pink-500))',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--white)',
            marginBottom: 'var(--space-5)',
            boxShadow: '0 12px 32px -8px rgba(124,58,237,0.5)',
            animation: 'tile-enter 0.5s ease both',
          }}
        >
          <Sparkles size={30} />
        </span>
        <h1
          style={{
            fontSize: 'var(--font-size-3xl)',
            fontWeight: 700,
            marginBottom: 'var(--space-3)',
            letterSpacing: '-0.6px',
            lineHeight: 'var(--line-height-heading)',
            background: 'linear-gradient(135deg, var(--gray-900) 30%, var(--violet-600))',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            animation: 'tile-enter 0.5s ease 0.05s both',
          }}
        >
          你想做什么样的软件？
        </h1>
        <p
          style={{
            fontSize: 'var(--font-size-md)',
            color: 'var(--color-text-muted)',
            maxWidth: 460,
            lineHeight: 'var(--line-height-base)',
            animation: 'tile-enter 0.5s ease 0.1s both',
          }}
        >
          告诉我你的想法，我来帮你做出来。选一个适合你的方式开始吧。
        </p>
      </div>

      {/* 两张模式磁贴 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 'var(--space-5)',
          maxWidth: 780,
          width: '100%',
        }}
      >
        <ModeCard
          mode="quick"
          title="快速做一个试试"
          description="适合一次性小工具、试试想法。AI 自动搞定大部分细节，你只管看最终效果满不满意。"
          helperText="以后也能转为长期维护"
          badge="新手推荐"
          onSelect={handleSelect}
          disabled={isSelecting}
        />
        <ModeCard
          mode="longterm"
          title="认真打磨一个产品"
          description="适合想长期使用、持续改进的项目。AI 会在关键节点跟你确认计划，每一步都稳。"
          helperText="完整工程方法论，适合长期项目"
          onSelect={handleSelect}
          disabled={isSelecting}
        />
      </div>
    </div>
  )
}
