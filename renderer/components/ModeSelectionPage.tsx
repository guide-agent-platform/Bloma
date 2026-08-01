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
<<<<<<< HEAD
=======
  const [selectionError, setSelectionError] = React.useState<string>()
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84

  const handleSelect = async (mode: 'quick' | 'longterm') => {
    if (isSelecting) return // 防止双击重复创建
    setIsSelecting(true)
<<<<<<< HEAD
=======
    setSelectionError(undefined)
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84

    try {
      // 通过 IPC 创建项目
      const api = window.electronAPI
      if (api) {
        const result = await api.project.create({
          request_id: crypto.randomUUID(),
          mode,
        })
<<<<<<< HEAD
        if (result.ok) {
          setCurrentProject(result.data)
        }
        // 如果 IPC 失败（如开发环境），仍然进入工作区
=======
        if (!result.ok) {
          setSelectionError(result.error.user_visible_message ?? '项目创建失败，请重试。')
          return
        }
        setCurrentProject(result.data)
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
      }

      setProjectMode(mode)
      setModeSelected(true)
      onModeSelected(mode)
    } catch {
<<<<<<< HEAD
      // 开发/演示模式：无 Electron 环境时直接进入
      setProjectMode(mode)
      setModeSelected(true)
      onModeSelected(mode)
=======
      setSelectionError('项目创建失败，请重试。')
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
    } finally {
      setIsSelecting(false)
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
          helperText="选好后也可以升级为长期维护"
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
<<<<<<< HEAD
=======

      {selectionError && (
        <p
          role="alert"
          style={{
            marginTop: 'var(--space-4)',
            color: 'var(--color-error)',
            fontSize: 'var(--font-size-sm)',
          }}
        >
          {selectionError}
        </p>
      )}
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
    </div>
  )
}
