import React, { useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { currentProjectAtom, desktopArtifactsAtom } from '../agent-atoms'
import { DocumentContent } from './DocumentContent'
import type { DesktopArtifactItemDto } from '../../shared/types'

/**
 * 桌面线产物预览条（刀3 呈现层最小版，2026-10-02 确认协议与呈现层战役）。
 *
 * 用户验收盲区根治：门禁全绿 ≠ 用户看得见程序——调度员叙述里没有一张图。
 * 显示条件：桌面线激活（desktop_tool 品类且已进入桌面阶段）且有产物清单。
 *
 * 数据面：desktopArtifactsAtom（SUBSCRIBE 快照 + onArtifactEvent version 信号重拉）；
 * 展示面三类（实施稿拍板第一版）：png 截图缩略直显（点击放大，data URL 读取）、
 * md/json 文件条目（点击展开只读文本前 500 字）。不做实时预览。
 */
export const DesktopArtifactStrip: React.FC = () => {
  const project = useAtomValue(currentProjectAtom)
  const artifacts = useAtomValue(desktopArtifactsAtom)
  const setArtifacts = useSetAtom(desktopArtifactsAtom)

  const desktopLineActive = project?.template_type === 'desktop_tool' && typeof project.desktop_phase === 'string'

  // 订阅：项目进入桌面线/切换/变更信号（version）→ SUBSCRIBE 拉清单快照
  useEffect(() => {
    if (!desktopLineActive || !project?.project_id) return
    let cancelled = false
    window.electronAPI?.desktopArtifacts
      ?.subscribe({ request_id: `artifact-sub-${project.project_id}-${artifacts.version}`, project_id: project.project_id })
      .then((result) => {
        if (cancelled || !result.ok) return
        setArtifacts({ projectId: project.project_id, items: result.data.items, version: artifacts.version })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [desktopLineActive, project?.project_id, artifacts.version, setArtifacts])

  if (!desktopLineActive || artifacts.projectId !== project?.project_id || artifacts.items.length === 0) return null

  return (
    <div
      data-ai-id="desktop-artifact-strip"
      aria-label="产物预览"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        padding: '6px var(--space-5)',
        flexShrink: 0,
        overflowX: 'auto',
        borderTop: '1px solid var(--color-border)',
        borderBottom: '1px solid var(--color-border)',
        background: 'var(--glass-bg-soft)',
      }}
    >
      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', flexShrink: 0 }}>
        产物预览（{artifacts.items.length}）
      </span>
      {artifacts.items.map((item) =>
        item.kind === 'image' ? (
          <ArtifactThumb key={item.path} item={item} projectId={project.project_id} />
        ) : (
          <ArtifactDocChip key={item.path} item={item} projectId={project.project_id} />
        ),
      )}
    </div>
  )
}

/** png 截图缩略（点击放大预览；悬停显示路径）。 */
const ArtifactThumb: React.FC<{ item: DesktopArtifactItemDto; projectId: string }> = ({ item, projectId }) => {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [enlarged, setEnlarged] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    // 惰性读取：可见清单可能含多张图，逐张拉 data URL（2MB 上限内）
    void window.electronAPI?.desktopArtifacts?.image({
      request_id: `artifact-img-${item.path}`,
      project_id: projectId,
      path: item.path,
    }).then((result) => {
      if (cancelled) return
      if (result?.ok) setDataUrl(result.data.data_url)
      else setFailed(true)
    }).catch(() => setFailed(true))
    return () => {
      cancelled = true
    }
  }, [item.path, projectId])

  if (failed) {
    return (
      <span title={item.path} style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', flexShrink: 0 }}>
        🖼 {item.path.split('/').pop()}（读取失败）
      </span>
    )
  }
  if (!dataUrl) {
    return (
      <span title={item.path} style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', flexShrink: 0 }}>
        ⏳ {item.path.split('/').pop()}
      </span>
    )
  }
  return (
    <>
      <img
        data-ai-id={`artifact-image-${item.path}`}
        src={dataUrl}
        alt={item.path}
        title={item.path}
        onClick={() => setEnlarged(true)}
        style={{
          height: 44,
          maxWidth: 120,
          objectFit: 'cover',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--color-border)',
          cursor: 'zoom-in',
          flexShrink: 0,
        }}
      />
      {enlarged && (
        <div
          role="dialog"
          aria-label="截图放大预览"
          onClick={() => setEnlarged(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.72)',
            cursor: 'zoom-out',
          }}
        >
          <img
            src={dataUrl}
            alt={item.path}
            style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 'var(--radius-sm)' }}
          />
        </div>
      )}
    </>
  )
}

/** md/json 文档条目（点击展开只读前 500 字——复用 PROJECT_FILE_READ 文本通道）。 */
const ArtifactDocChip: React.FC<{ item: DesktopArtifactItemDto; projectId: string }> = ({ item, projectId }) => {
  const [expanded, setExpanded] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const toggle = () => {
    setExpanded((v) => !v)
    if (content === null && !failed) {
      void window.electronAPI?.project
        ?.fileRead({ request_id: `artifact-doc-${item.path}`, project_id: projectId, path: item.path })
        .then((result) => {
          if (result.ok) setContent(result.data.content.slice(0, 500))
          else setFailed(true)
        })
        .catch(() => setFailed(true))
    }
  }

  return (
    <span style={{ flexShrink: 0 }}>
      <button
        data-ai-id={`artifact-doc-${item.path}`}
        onClick={toggle}
        title={item.path}
        style={{
          fontSize: 'var(--font-size-xs)',
          color: 'var(--color-text)',
          padding: '4px var(--space-3)',
          borderRadius: 'var(--radius-full)',
          background: expanded ? 'var(--glass-bg-strong)' : 'var(--glass-bg-soft)',
          border: '1px solid var(--glass-border-subtle)',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        📄 {item.path.split('/').pop()}
      </button>
      {expanded && (
        <div
          style={{
            position: 'absolute',
            maxWidth: 420,
            maxHeight: 180,
            overflow: 'auto',
            margin: '4px 0 0',
            padding: 'var(--space-2) var(--space-3)',
            fontSize: 'var(--font-size-xs)',
            background: 'var(--white)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
            zIndex: 20,
          }}
        >
          {failed ? '（读取失败——文件可能已变化）' : content === null ? '读取中…' : <DocumentContent source={item.path} content={content} variant="compact" />}
        </div>
      )}
    </span>
  )
}

export default DesktopArtifactStrip
