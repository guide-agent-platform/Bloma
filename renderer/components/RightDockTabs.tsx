import React, { useEffect, useRef, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import {
  currentProjectAtom,
  previewUrlsAtom,
  rightDockActiveTabAtom,
  rightDockFileAtom,
  rightDockOpenAtom,
  type RightDockTab,
} from '../agent-atoms'

/**
 * W4 右侧弹出标签容器（2026-09-18 真实脚手架改造）。
 *
 * 形态（拍板：不动现有 UI 布局）：
 * - 不弹不占位：右缘一个竖向小把手（fixed），点击滑出 dock 覆盖层（fixed，不参与文档流）；
 * - 三标签：预览（iframe，双入口——聊天流内 PreviewPanel 照旧）/ 服务日志（轮询
 *   preview.logs，真实服务器的一手调试证据）/ 文件（只读查看产物文件）；
 * - 关闭即收起，把手常驻（有活跃项目时）。
 *
 * 「沙箱」概念在本组件零出现——预览即呈现，隔离机制全部隐性化（实施稿 W4 口径）。
 */

const TAB_LABELS: Array<{ id: RightDockTab; label: string }> = [
  { id: 'preview', label: '预览' },
  { id: 'logs', label: '服务日志' },
  { id: 'files', label: '文件' },
]

export function RightDockTabs(): React.ReactElement | null {
  const project = useAtomValue(currentProjectAtom)
  const [open, setOpen] = useAtom(rightDockOpenAtom)
  const [activeTab, setActiveTab] = useAtom(rightDockActiveTabAtom)
  const previewUrls = useAtomValue(previewUrlsAtom)

  if (!project) return null
  const preview = previewUrls[project.project_id] ?? null

  return (
    <>
      {/* 右缘把手：不弹不占位（fixed 竖条），有活跃项目即常驻 */}
      <button
        type="button"
        data-ai-id="right-dock-handle"
        aria-label={open ? '收起右侧面板' : '展开右侧面板（预览/服务日志/文件）'}
        onClick={() => setOpen(!open)}
        style={{
          position: 'fixed',
          right: 0,
          top: '40%',
          zIndex: 90,
          transform: 'translateY(-50%)',
          writingMode: 'vertical-rl',
          padding: 'var(--space-3) 4px',
          fontSize: 12,
          color: 'var(--text-secondary, #888)',
          background: 'var(--bg-elevated, #2a2a2e)',
          border: '1px solid var(--border-subtle, #444)',
          borderRight: 'none',
          borderRadius: 'var(--radius-md) 0 0 var(--radius-md)',
          cursor: 'pointer',
        }}
      >
        {open ? '收起 ›' : '‹ 面板'}
      </button>

      {open ? (
        <section
          data-ai-id="right-dock-panel"
          aria-label="右侧面板"
          style={{
            position: 'fixed',
            top: 0,
            right: 0,
            bottom: 0,
            width: 'min(480px, 44vw)',
            zIndex: 89,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--bg-elevated, #232327)',
            borderLeft: '1px solid var(--border-subtle, #444)',
            boxShadow: '-8px 0 24px rgba(0,0,0,0.25)',
          }}
        >
          {/* 标签栏 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-2) var(--space-3)', borderBottom: '1px solid var(--border-subtle, #444)' }}>
            {TAB_LABELS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                data-ai-id={`right-dock-tab-${tab.id}`}
                aria-pressed={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  padding: 'var(--space-1) var(--space-3)',
                  fontSize: 13,
                  fontWeight: activeTab === tab.id ? 600 : 400,
                  color: activeTab === tab.id ? 'var(--text-primary, #eee)' : 'var(--text-secondary, #999)',
                  background: activeTab === tab.id ? 'var(--bg-active, #333338)' : 'transparent',
                  border: '1px solid var(--border-subtle, #444)',
                  borderRadius: 'var(--radius-md)',
                  cursor: 'pointer',
                }}
              >
                {tab.label}
              </button>
            ))}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              data-ai-id="right-dock-close"
              aria-label="关闭右侧面板"
              onClick={() => setOpen(false)}
              style={{ padding: 'var(--space-1) var(--space-2)', cursor: 'pointer', background: 'transparent', color: 'var(--text-secondary, #999)', border: 'none', fontSize: 14 }}
            >
              ✕
            </button>
          </div>

          {/* 标签内容 */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {activeTab === 'preview' ? <PreviewTab url={preview?.url ?? null} /> : null}
            {activeTab === 'logs' ? <LogsTab projectId={project.project_id} active={open} /> : null}
            {activeTab === 'files' ? <FilesTab projectId={project.project_id} /> : null}
          </div>
        </section>
      ) : null}
    </>
  )
}

/** 预览标签：iframe 直渲（双入口第二入口；无预览地址时如实空态，不假装可用）。 */
function PreviewTab({ url }: { url: string | null }): React.ReactElement {
  if (!url) {
    return (
      <div data-ai-id="right-dock-preview-empty" style={{ padding: 'var(--space-4)', color: 'var(--text-secondary, #999)', fontSize: 13 }}>
        还没有可用的预览地址——生成或恢复预览后这里会展示渲染结果。
      </div>
    )
  }
  return <iframe data-ai-id="right-dock-preview-frame" src={url} title="产物预览" style={{ flex: 1, border: 'none', background: '#fff' }} />
}

/** 日志标签：活跃时每 2s 轮询 preview.logs（32KB 环形缓冲的快照，W2 已截尾）。 */
function LogsTab({ projectId, active }: { projectId: string; active: boolean }): React.ReactElement {
  const [logs, setLogs] = useState('')
  const preRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    const pull = async () => {
      try {
        const api = window.electronAPI
        if (!api?.preview?.logs) return
        const result = await api.preview.logs({ request_id: `dock-logs-${Date.now()}`, project_id: projectId })
        if (!cancelled && result.ok) setLogs(result.data.logs)
      } catch {
        /* 轮询失败静默（面板还开着，下轮再试） */
      }
    }
    void pull()
    const timer = window.setInterval(pull, 2_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [projectId, active])

  useEffect(() => {
    // 跟随滚动到底（日志是追加语义）
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [logs])

  return (
    <pre
      data-ai-id="right-dock-logs"
      ref={preRef}
      style={{ flex: 1, margin: 0, padding: 'var(--space-3)', overflow: 'auto', fontSize: 12, lineHeight: 1.5, color: 'var(--text-primary, #ddd)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
    >
      {logs || '（暂无服务日志——预览启动后出现；静态产物无服务进程，日志为空是正常态）'}
    </pre>
  )
}

/** 文件标签：产物文件只读查看（v0 手输路径 + 打开；只读，拒绝基础设施目录由主进程校验）。 */
function FilesTab({ projectId }: { projectId: string }): React.ReactElement {
  const [path, setPath] = useState('')
  const [file, setFile] = useAtom(rightDockFileAtom)
  const [error, setError] = useState('')

  const openFile = async () => {
    const trimmed = path.trim()
    if (!trimmed) return
    setError('')
    try {
      const api = window.electronAPI
      if (!api?.project?.fileRead) {
        setError('当前环境不支持文件查看（preload 桥未就绪）。')
        return
      }
      const result = await api.project.fileRead({ request_id: `dock-file-${Date.now()}`, project_id: projectId, path: trimmed })
      if (result.ok) {
        setFile({ path: result.data.path, content: result.data.content, truncated: result.data.truncated })
      } else {
        setFile(null)
        setError(result.error?.message ?? '读取失败')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 'var(--space-3)', gap: 'var(--space-2)' }}>
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <input
          data-ai-id="right-dock-file-input"
          value={path}
          placeholder="产物文件相对路径，如 server.js / src/app.js"
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void openFile()
          }}
          style={{ flex: 1, padding: 'var(--space-1) var(--space-2)', fontSize: 13, background: 'var(--bg-input, #1c1c20)', color: 'var(--text-primary, #eee)', border: '1px solid var(--border-subtle, #444)', borderRadius: 'var(--radius-md)' }}
        />
        <button
          type="button"
          data-ai-id="right-dock-file-open"
          onClick={() => void openFile()}
          style={{ padding: 'var(--space-1) var(--space-3)', fontSize: 13, cursor: 'pointer', background: 'var(--bg-active, #333338)', color: 'var(--text-primary, #eee)', border: '1px solid var(--border-subtle, #444)', borderRadius: 'var(--radius-md)' }}
        >
          打开
        </button>
      </div>
      {error ? (
        <div data-ai-id="right-dock-file-error" style={{ color: 'var(--text-danger, #e5484d)', fontSize: 12 }}>
          {error}
        </div>
      ) : null}
      {file ? (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-secondary, #999)' }}>
            {file.path}
            {file.truncated ? '（超过 256KB，已截断）' : ''} · 只读
          </div>
          <pre data-ai-id="right-dock-file-content" style={{ flex: 1, minHeight: 0, margin: 0, padding: 'var(--space-2)', overflow: 'auto', fontSize: 12, lineHeight: 1.5, background: 'var(--bg-input, #1c1c20)', color: 'var(--text-primary, #ddd)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {file.content}
          </pre>
        </>
      ) : null}
    </div>
  )
}
